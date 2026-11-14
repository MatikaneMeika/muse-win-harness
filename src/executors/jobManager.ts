/**
 * Async Job Engine & Dual-Track Execution Manager
 * Supports fast-track inline completion (<=8000ms) and seamless async backgrounding
 * with Win32 Job Object containment, continuous log streaming, and paginated polling.
 *
 * P2 hardening:
 * - cwd fence: every executeCommand working directory must pass checkPathAccess
 *   (EXEC_CWD_OUT_OF_WORKSPACE); danger-full-access skips the check. The active
 *   confinement mode comes from params.confinementMode, the wired provider
 *   (setConfinementModeProvider, wired in P3) or defaults to 'workspace-write'.
 * - assignPid failure is fail-closed: the orphan child is killed immediately
 *   (taskkill /F /T) and JOB_ASSIGN_FAILED is thrown — no uncontained execution.
 * - abort/timeout honesty: TERMINATED is only set when the process tree is
 *   verifiably dead; otherwise the job stays RUNNING and reports
 *   JOB_TERMINATE_FAILED.
 * - jobId validation on every entry point (JOB_INVALID_ID), blocking '..' path
 *   traversal into arbitrary .log files.
 * - poll pages are aligned to UTF-8 character boundaries (max 3-byte lead-byte
 *   backoff) so multi-byte characters are never split into U+FFFD.
 * - memory caps: inline stdout/stderr truncated at 1MB each with a
 *   [MWH_INLINE_TRUNCATED] marker; finished jobs drop child/logStream references
 *   and the jobs Map evicts finished entries FIFO beyond 200.
 */

import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Win32JobObject } from '../pipeline/win32Job.js';
import { checkPathAccess, joinInsideRoot } from '../pipeline/pathGuard.js';
import { buildCleanChildEnv, sanitizeSensitiveCliFlags } from './cliAdapters.js';
import type {
  ApprovalPolicy,
  ConfinementMode,
  JobPollResult,
  JobRecord,
  JobStatus,
  SteerDeliveryReceipt,
  SubagentEvent,
  SubagentEventKind,
  SubagentEventsResult,
  SubagentSummary
} from '../types.js';

interface ActiveJobInternal {
  record: JobRecord;
  /** P2: nulled once the job has finished (see finalizeJob) to release references. */
  child: ChildProcess | null;
  /** Null for subagent jobs: the CLI/ACP child owns its own Win32 Job Object. */
  jobObject: Win32JobObject | null;
  logAbsPath: string;
  /** P2: nulled once the job has finished to release the stream handle. */
  logStream: fs.WriteStream | null;
  inlineStdout: string;
  inlineStderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Subagent jobs: terminates the child's own Win32 Job Object. */
  customAbort?: () => boolean;
  /** Subagent jobs: live steer into the running agent session. */
  customSteer?: (input: string) => boolean | SteerDeliveryReceipt;
  /** Final structured result, surfaced through poll(). */
  subagentResult?: SubagentSummary;
  /** Subagent type backing this job (undefined for plain commands). */
  agentType?: string;
  /** Target workspace root used when dispatching this job. */
  workspaceRoot?: string;
  /** Original prompt text submitted when creating a subagent job. */
  initialPrompt?: string;
  /** Bounded incremental event ring (see MAX_EVENT_RING_*). */
  events: SubagentEvent[];
  eventBytes: number;
  nextEventSeq: number;
  droppedEvents: number;
  lastActivityAt: number;
  /** Idle heartbeat ticker for long-running subagent jobs. */
  heartbeatTimer: NodeJS.Timeout | null;
  /** Long-poll waiters woken on any new event / job finalization. */
  eventWaiters: Set<() => void>;
  /** Safe diagnostic attached by the adapter on failure. */
  diagnostic?: string;
  /** R1-M7: set when abort() is called before bindSubagentProcess attaches pid/abortFn. */
  abortRequested?: boolean;
  /** Effective confinement mode used for this job. */
  childMode?: ConfinementMode;
  /** Effective approval policy used for this job. */
  effectivePolicy?: ApprovalPolicy;
  /** Whether the job ran inside an isolated worktree. */
  isolateWorktree?: boolean;
  /** Isolated worktree path, when applicable. */
  worktreePath?: string;
  /** Pre-dispatch checkpoint id backing this job. */
  checkpointId?: string;
  /** Lazily computes live working-tree changes while the job is running. */
  computeLiveDiff?: () => { filesModified: string[]; gitDiffStat: string };
  /** Short-lived cache for computeLiveDiff (250ms TTL). */
  cachedLiveDiff?: { at: number; filesModified: string[]; gitDiffStat: string };
  /** Ensures exactly one terminal audit entry is appended per job. */
  terminalAudited?: boolean;
}

function computeEventByteSize(ev: SubagentEvent): number {
  let metaBytes = 0;
  if (ev.meta) {
    try {
      metaBytes = Buffer.byteLength(JSON.stringify(ev.meta), 'utf-8');
    } catch {
      metaBytes = 256;
    }
  }
  return Buffer.byteLength(ev.text, 'utf-8') + metaBytes + 64;
}

export const JOB_ID_REGEX = /^job_[A-Za-z0-9_]+$/;
const INLINE_STRING_LIMIT = 1024 * 1024; // 1MB per stream
const INLINE_TRUNCATION_MARKER = '[MWH_INLINE_TRUNCATED]';
const MAX_JOBS_RETAINED = 200; // FIFO eviction of finished entries beyond this
const TERMINATE_VERIFY_TIMEOUT_MS = 1500;

/** Event ring: max retained events per job. */
export const MAX_EVENT_RING_ITEMS = 512;
/** Event ring: max retained event bytes per job (4MB). */
export const MAX_EVENT_RING_BYTES = 4 * 1024 * 1024; // 4MB
/** Idle heartbeat cadence for long-running subagent jobs. */
export const HEARTBEAT_INTERVAL_MS = 5000;
/** Event cursor safety cap for long-poll waits. */
const MAX_EVENT_WAIT_MS = 25000;

/**
 * P2: best-effort PID liveness check (signal 0 does not actually signal).
 * EPERM means the process exists but is owned by someone else -> alive.
 */
function isPidAlive(pid?: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** Synchronous sleep via Atomics.wait (main thread safe in Node). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class JobManager {
  private static instance: JobManager;
  private jobs: Map<string, ActiveJobInternal> = new Map();
  /**
   * P2: confinement mode provider wired by the caller (P3 will connect it to
   * the pipeline context). Until wired, executeCommand falls back to the
   * conservative 'workspace-write' default (documented in the task spec).
   */
  private confinementModeProvider: (() => ConfinementMode) | null = null;
  private outputListeners: Set<(event: { jobId: string; pid?: number; command: string; status: JobStatus; line: string; stream: 'stdout' | 'stderr' }) => void> = new Set();
  private jobEventListeners: Set<(event: { jobId: string; pid?: number; command: string; status: JobStatus; line?: string; exitCode?: number | null }) => void> = new Set();

  public static getInstance(): JobManager {
    if (!JobManager.instance) {
      JobManager.instance = new JobManager();
    }
    return JobManager.instance;
  }

  /**
   * P2: registers the provider that reports the current confinement mode.
   * Pass null to reset to the default 'workspace-write' behavior.
   */
  public setConfinementModeProvider(fn: (() => ConfinementMode) | null): void {
    this.confinementModeProvider = fn;
  }

  /**
   * Subscribes to job lifecycle and output events (start, stdout/stderr lines,
   * RUNNING_ASYNC, completion, failure, forced termination). Returns unsubscribe.
   */
  public onJobEvent(listener: (event: { jobId: string; pid?: number; command: string; status: JobStatus; line?: string; exitCode?: number | null }) => void): () => void {
    this.jobEventListeners.add(listener);
    return () => {
      this.jobEventListeners.delete(listener);
    };
  }

  /** Jobs currently inside a live Win32 Job Object (RUNNING or RUNNING_ASYNC). */
  public getActiveJobs(): JobRecord[] {
    const active: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.record.status === 'RUNNING' || job.record.status === 'RUNNING_ASYNC') {
        active.push(job.record);
      }
    }
    return active;
  }

  /**
   * Aborts every RUNNING / RUNNING_ASYNC job via the existing abort() path
   * (TerminateJobObject + terminateAndVerify). Never throws.
   */
  public abortAll(): { abortedIds: string[]; failedIds: string[] } {
    const abortedIds: string[] = [];
    const failedIds: string[] = [];
    const activeIds = this.getActiveJobs().map((job) => job.id);
    for (const id of activeIds) {
      try {
        const res = this.abort(id);
        if (res.success) {
          abortedIds.push(id);
        } else {
          failedIds.push(id);
        }
      } catch {
        failedIds.push(id);
      }
    }
    return { abortedIds, failedIds };
  }

  private emitJobEvent(event: { jobId: string; pid?: number; command: string; status: JobStatus; line?: string; exitCode?: number | null }): void {
    for (const listener of this.jobEventListeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not break job bookkeeping.
      }
    }
  }

  private emitOutputLines(job: ActiveJobInternal, stream: 'stdout' | 'stderr', text: string): void {
    const parts = text.split(/\r?\n/);
    for (const line of parts) {
      if (!line) continue;
      const payload = {
        jobId: job.record.id,
        pid: job.record.pid,
        command: job.record.command,
        status: job.record.status,
        line,
        stream
      };
      for (const listener of this.outputListeners) {
        try {
          listener(payload);
        } catch {
          // Ignore listener failures.
        }
      }
      this.emitJobEvent(payload);
    }
  }

  /** P2: jobId validation on every entry point (blocks '..' log traversal). */
  private assertValidJobId(jobId: string): void {
    if (typeof jobId !== 'string' || !JOB_ID_REGEX.test(jobId)) {
      throw new Error(`JOB_INVALID_ID: Malformed job id '${jobId}'`);
    }
  }

  /**
   * P2: terminates the job's process tree and honestly verifies the processes
   * actually died. Returns true only when the pid is confirmed dead.
   * P2-R2: works even when the Job Object handle is already closed — the
   * recorded pid is then killed directly via taskkill /F /T (never a silent
   * no-op), with a second direct taskkill attempt before reporting failure.
   */
  private terminateAndVerify(job: ActiveJobInternal, exitCode: number): boolean {
    if (!job.jobObject || job.jobObject.isClosed()) {
      // Job Object already closed (or owned by the subagent adapter): kill the
      // recorded pid tree directly.
      this.killPidTree(job.record.pid);
    } else {
      try {
        job.jobObject.terminate(exitCode);
      } catch {
        // Terminal failure handled by the liveness verification below.
      }
    }

    const deadline = Date.now() + TERMINATE_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isPidAlive(job.record.pid)) {
        return true;
      }
      sleepSync(50);
    }

    // Still alive: one direct taskkill retry before reporting failure.
    this.killPidTree(job.record.pid);
    const retryDeadline = Date.now() + TERMINATE_VERIFY_TIMEOUT_MS;
    while (Date.now() < retryDeadline) {
      if (!isPidAlive(job.record.pid)) {
        return true;
      }
      sleepSync(50);
    }
    return !isPidAlive(job.record.pid);
  }

  /** P2-R2: taskkill /F /T against a pid, best-effort. */
  private killPidTree(pid?: number | null): void {
    if (!pid || pid <= 0) {
      return;
    }
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      // Already dead or access denied; liveness verification decides.
    }
  }

  /**
   * P2: releases process/stream references of a finished job and evicts old
   * finished entries (FIFO) when the Map grows beyond MAX_JOBS_RETAINED.
   */
  private finalizeJob(job: ActiveJobInternal): void {
    job.child = null;
    try {
      job.logStream?.end();
    } catch {}
    job.logStream = null;

    if (job.heartbeatTimer) {
      clearInterval(job.heartbeatTimer);
      job.heartbeatTimer = null;
    }

    // Release every long-poll waiter so no cursor wait outlives the job.
    for (const wake of [...job.eventWaiters]) {
      try {
        wake();
      } catch {}
    }
    job.eventWaiters.clear();

    if (this.jobs.size > MAX_JOBS_RETAINED) {
      for (const [id, entry] of this.jobs) {
        if (this.jobs.size <= MAX_JOBS_RETAINED) {
          break;
        }
        const st = entry.record.status;
        if (st !== 'RUNNING' && st !== 'RUNNING_ASYNC') {
          this.jobs.delete(id);
        }
      }
    }
  }

  /** P2: inline stream memory cap (1MB per stream + truncation marker). */
  private appendInline(target: 'stdout' | 'stderr', job: ActiveJobInternal, str: string): void {
    const isStdout = target === 'stdout';
    const alreadyTruncated = isStdout ? job.stdoutTruncated : job.stderrTruncated;

    // Once truncated the inline buffer stays capped; the full output remains
    // available in the on-disk log and the marker communicates the truncation.
    if (alreadyTruncated) {
      return;
    }

    const current = isStdout ? job.inlineStdout : job.inlineStderr;
    let next = current + str;

    if (next.length > INLINE_STRING_LIMIT) {
      next = next.slice(0, INLINE_STRING_LIMIT) + INLINE_TRUNCATION_MARKER;
      if (isStdout) {
        job.stdoutTruncated = true;
      } else {
        job.stderrTruncated = true;
      }
    }

    if (isStdout) {
      job.inlineStdout = next;
    } else {
      job.inlineStderr = next;
    }
  }

  /**
   * Returns the working-tree diff for a job: final result when available,
   * otherwise a 250ms-throttled live computation.
   */
  private getLiveDiff(job: ActiveJobInternal): { filesModified: string[]; gitDiffStat: string } {
    if (job.subagentResult) {
      return {
        filesModified: job.subagentResult.filesModified || [],
        gitDiffStat: job.subagentResult.gitDiffStat || ''
      };
    }
    if (!job.computeLiveDiff) {
      return { filesModified: [], gitDiffStat: '' };
    }
    const now = Date.now();
    if (job.cachedLiveDiff && now - job.cachedLiveDiff.at < 250) {
      return {
        filesModified: job.cachedLiveDiff.filesModified,
        gitDiffStat: job.cachedLiveDiff.gitDiffStat
      };
    }
    try {
      const computed = job.computeLiveDiff();
      job.cachedLiveDiff = {
        at: now,
        filesModified: Array.isArray(computed.filesModified) ? computed.filesModified : [],
        gitDiffStat: typeof computed.gitDiffStat === 'string' ? computed.gitDiffStat : ''
      };
      return {
        filesModified: job.cachedLiveDiff.filesModified,
        gitDiffStat: job.cachedLiveDiff.gitDiffStat
      };
    } catch {
      return { filesModified: [], gitDiffStat: '' };
    }
  }

  /** Appends exactly one terminal audit record per job (idempotent). */
  private appendTerminalAudit(
    job: ActiveJobInternal,
    terminalStatus: 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'TERMINATED',
    reason?: string
  ): void {
    if (job.terminalAudited) return;
    job.terminalAudited = true;

    const wsRoot = job.workspaceRoot || job.subagentResult?.effectiveCwd || process.cwd();
    const scrub = (val: string | undefined): string | undefined => {
      if (typeof val !== 'string' || !val) return val;
      let out = sanitizeSensitiveCliFlags(val);
      const secrets = [
        process.env.MWH_HMAC_SECRET,
        process.env.TUNNEL_RUNTIME_TOKEN,
        process.env.MWH_CF_TUNNEL_TOKEN
      ].filter((s): s is string => typeof s === 'string' && s.length >= 8);
      for (const sec of secrets) {
        if (out.includes(sec)) out = out.split(sec).join('[REDACTED]');
      }
      return out;
    };

    const diag = scrub(job.diagnostic || job.subagentResult?.diagnostic);
    const entry = {
      id: `audit_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: new Date().toISOString(),
      jobId: job.record.id,
      toolName: job.agentType ? 'subagent_dispatch' : 'exec_command',
      actor: job.agentType || 'job_manager',
      decision: terminalStatus === 'COMPLETED' ? 'ALLOW' : 'BLOCK',
      commandOrPath: scrub(job.record.command) || job.record.command,
      mode: job.childMode || 'workspace-write',
      confinementMode: job.childMode || 'workspace-write',
      status: terminalStatus,
      terminalStatus,
      exitCode: job.record.exitCode ?? null,
      reason:
        scrub(
          reason ||
            job.subagentResult?.error ||
            job.subagentResult?.summary ||
            job.record.command
        ) || '',
      ...(diag ? { diagnostic: diag } : {})
    };

    try {
      // Sanctioned joins (pathGuard): wsRoot-derived log paths never hit bare
      // path-module sinks; audit.jsonl is a server-side constant.
      const logDir = joinInsideRoot(wsRoot, '.mwh', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(joinInsideRoot(logDir, 'audit.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Never block job finalization on audit write errors.
    }
  }

  /**
   * Executes a command with Fast/Slow Dual-Track:
   * Completes inline if finished within yieldTimeMs (default 8000ms),
   * otherwise seamlessly backgrounds and returns RUNNING_ASYNC.
   *
   * P2: cwd is fenced via checkPathAccess; a working directory outside the
   * workspace (in non danger-full-access modes) is rejected with
   * EXEC_CWD_OUT_OF_WORKSPACE before any process is spawned.
   */
  public async executeCommand(params: {
    command: string;
    cwd?: string;
    workspaceRoot: string;
    yieldTimeMs?: number;
    timeoutMs?: number;
    /** P2: optional explicit confinement mode; provider or 'workspace-write' default otherwise. */
    confinementMode?: ConfinementMode;
  }): Promise<{
    completedInline: boolean;
    data: any;
  }> {
    const { command, cwd, workspaceRoot } = params;
    // Cloud-safe display string: privilege-escalation flags computed locally for
    // the child must never be echoed back in job records / events / poll output.
    const displayCommand = sanitizeSensitiveCliFlags(command);
    const fastTrackMs = typeof params.yieldTimeMs === 'number' ? params.yieldTimeMs : 8000;
    const totalTimeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 600000; // 10 mins

    // P2: resolve the effective confinement mode (explicit param > provider >
    // conservative default) and fence the working directory.
    const effectiveMode: ConfinementMode =
      params.confinementMode ||
      (this.confinementModeProvider ? this.confinementModeProvider() : 'workspace-write');
    const workingDir = path.resolve(cwd || workspaceRoot);

    if (effectiveMode !== 'danger-full-access') {
      const cwdCheck = checkPathAccess(workingDir, 'read', effectiveMode, workspaceRoot);
      if (!cwdCheck.allowed) {
        throw new Error(
          `EXEC_CWD_OUT_OF_WORKSPACE: Working directory '${workingDir}' rejected by the path fence (${cwdCheck.reason || 'unknown'})`
        );
      }
    }

    const jobId = `job_${Date.now()}_${crypto.randomUUID().slice(0, 8).replace(/-/g, '_')}`;
    if (!/^job_[0-9]+_[a-z0-9]+$/.test(jobId)) {
      throw new Error('JOB_ID_INVALID');
    }
    const logRelPath = `.mwh/logs/${jobId}.log`;
    const logAbsPath = joinInsideRoot(workspaceRoot, '.mwh', 'logs', `${jobId}.log`);

    fs.mkdirSync(path.dirname(logAbsPath), { recursive: true });
    const logStream = fs.createWriteStream(logAbsPath, { flags: 'a', encoding: 'utf-8' });

    let jobObject: Win32JobObject;
    try {
      jobObject = new Win32JobObject();
    } catch (err: any) {
      logStream.end();
      throw new Error(`JOB_OBJECT_INIT_FAILED: ${err.message}`);
    }

    // G7: Pass command via -EncodedCommand (UTF-16LE Base64) with $ProgressPreference='SilentlyContinue'
    // so Win32 CreateProcessW / PowerShell CLI parsing never strips inner quotes (e.g. git log --format="%H %D")
    // and cmd.exe never performs %VAR% environment expansion on %D / %H format specifiers.
    const psScript = `$ProgressPreference = 'SilentlyContinue'; ${command}`;
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      {
        cwd: workingDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // R1-M2: Always strip MWH internal credential variables from child shell env
        env: buildCleanChildEnv(workingDir, effectiveMode)
      }
    );

    const pid = child.pid;
    if (pid) {
      // P2: fail-closed — an unassigned process must never keep running
      // outside the Job Object containment.
      const assigned = jobObject.assignPid(pid);
      if (!assigned) {
        // P2-R2: kill, verify, retry once, verify again — only after the pid
        // is confirmed dead is the Job Object handle cleaned up.
        this.killPidTree(pid);
        const firstDeadline = Date.now() + TERMINATE_VERIFY_TIMEOUT_MS;
        while (Date.now() < firstDeadline && isPidAlive(pid)) {
          sleepSync(50);
        }
        if (isPidAlive(pid)) {
          this.killPidTree(pid);
          const secondDeadline = Date.now() + TERMINATE_VERIFY_TIMEOUT_MS;
          while (Date.now() < secondDeadline && isPidAlive(pid)) {
            sleepSync(50);
          }
        }
        const terminated = !isPidAlive(pid);
        try {
          if (terminated) {
            jobObject.terminate(1);
          }
          // If it could not be terminated, keep the Job handle open so the
          // KILL_ON_JOB_CLOSE backstop still applies at process exit.
        } catch {}
        logStream.end();
        if (!terminated) {
          throw new Error(
            `JOB_ASSIGN_FAILED: Could not assign child pid ${pid} to the Win32 Job Object and the process could not be killed`
          );
        }
        throw new Error(
          `JOB_ASSIGN_FAILED: Could not assign child pid ${pid} to the Win32 Job Object; the process was killed to prevent uncontained execution`
        );
      }
    }

    const jobRecord: JobRecord = {
      id: jobId,
      command: displayCommand,
      pid,
      status: 'RUNNING',
      startTime: Date.now(),
      exitCode: null,
      logFile: logRelPath
    };

    const activeJob: ActiveJobInternal = {
      record: jobRecord,
      child,
      jobObject,
      logAbsPath,
      logStream,
      inlineStdout: '',
      inlineStderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      events: [],
      eventBytes: 0,
      nextEventSeq: 1,
      droppedEvents: 0,
      lastActivityAt: Date.now(),
      heartbeatTimer: null,
      eventWaiters: new Set(),
      workspaceRoot,
      childMode: effectiveMode
    };

    this.jobs.set(jobId, activeJob);

    // Stream process output to disk log file (with inline memory caps)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const str = chunk.toString();
      this.appendInline('stdout', activeJob, str);
      try {
        logStream.write(str);
      } catch {}
      this.emitOutputLines(activeJob, 'stdout', str);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const str = chunk.toString();
      this.appendInline('stderr', activeJob, str);
      try {
        logStream.write(str);
      } catch {}
      this.emitOutputLines(activeJob, 'stderr', str);
    });

    this.emitJobEvent({
      jobId,
      pid,
      command: displayCommand,
      status: 'RUNNING'
    });

    // Handle overall execution timeout with activity-aware sliding window + hard wall-clock ceiling
    const startedAt = Date.now();
    const baseTimeoutMs = Math.max(50, totalTimeoutMs);
    const hardMaxTimeoutMs =
      baseTimeoutMs >= 30000 || process.env.MWH_ENABLE_SLIDING_TIMEOUT === '1'
        ? Math.min(baseTimeoutMs * 3, 1800000)
        : baseTimeoutMs;
    let overallTimer: NodeJS.Timeout;
    const armOverallWatchdog = (delayMs: number) => {
      overallTimer = setTimeout(() => {
        if (activeJob.record.status !== 'RUNNING' && activeJob.record.status !== 'RUNNING_ASYNC') {
          return;
        }
        const now = Date.now();
        const elapsed = now - startedAt;
        const idleSilenceMs = now - activeJob.lastActivityAt;
        if (idleSilenceMs < Math.floor(baseTimeoutMs * 0.6) && elapsed < hardMaxTimeoutMs) {
          const nextSliceMs = Math.max(
            50,
            Math.min(baseTimeoutMs - idleSilenceMs, hardMaxTimeoutMs - elapsed)
          );
          try {
            activeJob.logStream?.write(
              `\n[MWH_JOB_WATCHDOG_EXTENDED elapsed=${elapsed}ms next=${nextSliceMs}ms hardCap=${hardMaxTimeoutMs}ms]\n`
            );
          } catch {}
          armOverallWatchdog(nextSliceMs);
          return;
        }
        try {
          activeJob.logStream?.write('\n[MWH_JOB_TIMEOUT_TERMINATED]\n');
        } catch {}
        const dead = this.terminateAndVerify(activeJob, 1);
        if (dead) {
          activeJob.record.status = 'TERMINATED';
          activeJob.record.endTime = Date.now();
          activeJob.diagnostic = `Command timed out after ${elapsed}ms (idleWindow=${baseTimeoutMs}ms, hardCap=${hardMaxTimeoutMs}ms)`;
          this.appendTerminalAudit(activeJob, 'TIMEOUT', activeJob.diagnostic);
          this.finalizeJob(activeJob);
          this.emitJobEvent({
            jobId,
            pid: activeJob.record.pid,
            command: displayCommand,
            status: 'TERMINATED',
            exitCode: activeJob.record.exitCode
          });
        } else {
          // Honest state: the process tree survived termination, keep RUNNING.
          try {
            activeJob.logStream?.write('[MWH_JOB_TERMINATE_FAILED]\n');
          } catch {}
        }
      }, delayMs);
    };
    armOverallWatchdog(baseTimeoutMs);

    return new Promise<{ completedInline: boolean; data: any }>((resolve) => {
      let isSettled = false;

      // Fast-track timer (default 8000ms)
      const fastTrackTimer = setTimeout(() => {
        if (!isSettled && (activeJob.record.status === 'RUNNING')) {
          isSettled = true;
          activeJob.record.status = 'RUNNING_ASYNC';
          this.emitJobEvent({
            jobId,
            pid,
            command: displayCommand,
            status: 'RUNNING_ASYNC'
          });
          resolve({
            completedInline: false,
            data: {
              status: 'RUNNING_ASYNC',
              jobId,
              pid,
              logFile: logRelPath,
              message:
                'Command moved to background. Use job_control(action="poll", jobId, page) to read output.'
            }
          });
        }
      }, fastTrackMs);

      child.on('close', (code) => {
        clearTimeout(overallTimer);
        clearTimeout(fastTrackTimer);

        activeJob.record.exitCode = code;
        activeJob.record.endTime = Date.now();
        if (activeJob.record.status !== 'TERMINATED') {
          activeJob.record.status = code === 0 ? 'COMPLETED' : 'FAILED';
        }

        try {
          logStream.end();
        } catch {}

        try {
          jobObject.terminate(0);
        } catch {}

        if (activeJob.record.status !== 'TERMINATED') {
          this.appendTerminalAudit(
            activeJob,
            activeJob.record.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
            `exitCode=${code}`
          );
        }

        // P2-R2: full-path finalization — close/error handlers also release
        // references and trigger the FIFO eviction of finished entries.
        this.finalizeJob(activeJob);
        this.emitJobEvent({
          jobId,
          pid: activeJob.record.pid,
          command: displayCommand,
          status: activeJob.record.status,
          exitCode: code
        });

        if (!isSettled) {
          isSettled = true;
          resolve({
            completedInline: true,
            data: {
              jobId,
              stdout: activeJob.inlineStdout,
              stderr: activeJob.inlineStderr,
              exitCode: code,
              completedInline: true
            }
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(overallTimer);
        clearTimeout(fastTrackTimer);

        activeJob.record.status = 'FAILED';
        activeJob.record.endTime = Date.now();

        try {
          activeJob.logStream?.write(`\n[SPAWN_ERROR: ${err.message}]\n`);
        } catch {}
        try {
          logStream.end();
        } catch {}

        try {
          jobObject.terminate(1);
        } catch {}

        activeJob.diagnostic = `SPAWN_ERROR: ${err.message}`;
        this.appendTerminalAudit(activeJob, 'FAILED', activeJob.diagnostic);

        // P2-R2: full-path finalization — close/error handlers also release
        // references and trigger the FIFO eviction of finished entries.
        this.finalizeJob(activeJob);
        this.emitJobEvent({
          jobId,
          pid: activeJob.record.pid,
          command: displayCommand,
          status: 'FAILED',
          exitCode: 1
        });

        if (!isSettled) {
          isSettled = true;
          resolve({
            completedInline: true,
            data: {
              jobId,
              stdout: activeJob.inlineStdout,
              stderr: `${activeJob.inlineStderr}\n${err.message}`,
              exitCode: 1,
              completedInline: true
            }
          });
        }
      });
    });
  }

  // ------------------------------------------------------------------------
  // Subagent async job lifecycle (external CLI / ACP dispatches)
  // ------------------------------------------------------------------------

  /**
   * Registers a subagent dispatch as a background job with its own log file.
   * The child process is bound later via bindSubagentProcess().
   */
  public createSubagentJob(params: {
    agentType: string;
    prompt: string;
    workspaceRoot: string;
    timeoutMs: number;
    childMode?: ConfinementMode;
    effectivePolicy?: ApprovalPolicy;
    isolateWorktree?: boolean;
    worktreePath?: string;
    checkpointId?: string;
    computeLiveDiff?: () => { filesModified: string[]; gitDiffStat: string };
  }): { jobId: string; logRelPath: string } {
    const jobId = `job_${Date.now()}_${crypto.randomUUID().slice(0, 8).replace(/-/g, '_')}`;
    this.assertValidJobId(jobId);

    // timeoutMs is enforced by the CLI/ACP adapter itself; the job record only
    // needs the display command and log target.
    // R1-m8: Always sanitize display command so sensitive CLI flags never leak.
    const command = sanitizeSensitiveCliFlags(
      `[${params.agentType}] ${params.prompt.replace(/\s+/g, ' ').trim().slice(0, 120)}`
    );
    const logRelPath = `.mwh/logs/${jobId}.log`;
    const logAbsPath = joinInsideRoot(params.workspaceRoot, '.mwh', 'logs', `${jobId}.log`);

    fs.mkdirSync(path.dirname(logAbsPath), { recursive: true });
    const logStream = fs.createWriteStream(logAbsPath, { flags: 'a', encoding: 'utf-8' });

    const activeJob: ActiveJobInternal = {
      record: {
        id: jobId,
        command,
        status: 'RUNNING',
        startTime: Date.now(),
        exitCode: null,
        logFile: logRelPath
      },
      child: null,
      jobObject: null,
      logAbsPath,
      logStream,
      inlineStdout: '',
      inlineStderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      agentType: params.agentType,
      workspaceRoot: params.workspaceRoot,
      initialPrompt: params.prompt,
      events: [],
      eventBytes: 0,
      nextEventSeq: 1,
      droppedEvents: 0,
      lastActivityAt: Date.now(),
      heartbeatTimer: null,
      eventWaiters: new Set(),
      childMode: params.childMode,
      effectivePolicy: params.effectivePolicy,
      isolateWorktree: params.isolateWorktree,
      worktreePath: params.worktreePath,
      checkpointId: params.checkpointId,
      computeLiveDiff: params.computeLiveDiff
    };

    this.jobs.set(jobId, activeJob);

    this.appendSubagentEvent(jobId, {
      kind: 'status',
      text: `[started] subagent '${params.agentType}' dispatched (cwd=${params.workspaceRoot})`
    });

    // Idle heartbeat: long subagent runs may emit nothing for minutes, which
    // makes a healthy run indistinguishable from a wedged one without this.
    const maxLifespanMs = Math.max(60000, (params.timeoutMs || 600000) * 3) + 30000;
    const heartbeatTimer = setInterval(() => {
      const current = this.jobs.get(jobId);
      if (!current || !current.agentType) {
        clearInterval(heartbeatTimer);
        return;
      }
      const status = current.record.status;
      if (status !== 'RUNNING' && status !== 'RUNNING_ASYNC') {
        clearInterval(heartbeatTimer);
        return;
      }
      // R2-m5: Safety backstop so a zombie job can never leak a heartbeat interval forever.
      if (Date.now() - current.record.startTime > maxLifespanMs) {
        clearInterval(heartbeatTimer);
        return;
      }
      if (Date.now() - current.lastActivityAt < 4500) {
        return;
      }
      const alive = isPidAlive(current.record.pid);
      this.appendSubagentEvent(jobId, {
        kind: 'heartbeat',
        text: `[heartbeat] subagent '${params.agentType}' running (pid=${current.record.pid ?? 'spawning'}, alive=${alive}, elapsed=${Math.floor((Date.now() - current.record.startTime) / 1000)}s)`,
        meta: { pid: current.record.pid, pidAlive: alive }
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    activeJob.heartbeatTimer = heartbeatTimer;

    this.emitJobEvent({ jobId, command, status: 'RUNNING' });
    return { jobId, logRelPath };
  }

  /**
   * Binds the real child pid, its Job-Object abort handle and (optionally) a
   * live steer function to the job.
   */
  public bindSubagentProcess(
    jobId: string,
    pid: number,
    abortFn: () => boolean,
    steerFn?: (input: string) => boolean | SteerDeliveryReceipt
  ): void {
    this.assertValidJobId(jobId);
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.record.pid = pid;
    job.customAbort = abortFn;
    job.customSteer = steerFn;

    // R1-M7: If abort() was requested before the child pid was bound, terminate immediately.
    if (job.abortRequested || job.record.status === 'TERMINATED') {
      try {
        abortFn();
      } catch {}
      this.killPidTree(pid);
    }
  }

  /**
   * Returns a structured snapshot of a subagent job's workspace, prompt, status,
   * pid liveness, and captured output for honest continuation (`action="resume"`).
   */
  public getSubagentJobContext(jobId: string): {
    jobId: string;
    status: JobStatus;
    pid?: number;
    pidAlive: boolean;
    agentType: string;
    workspaceRoot: string;
    initialPrompt: string;
    output: string;
    diagnostic?: string;
    subagentResult?: SubagentSummary;
    latestSeq: number;
    childMode?: ConfinementMode;
    effectivePolicy?: ApprovalPolicy;
    isolateWorktree: boolean;
    worktreePath?: string;
    checkpointId?: string;
    filesModified: string[];
    gitDiffStat: string;
  } | null {
    this.assertValidJobId(jobId);
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const liveDiff = this.getLiveDiff(job);
    return {
      jobId,
      status: job.record.status,
      pid: job.record.pid,
      pidAlive: isPidAlive(job.record.pid),
      agentType: job.agentType || job.subagentResult?.agentType || 'builtin',
      workspaceRoot:
        job.workspaceRoot || job.subagentResult?.effectiveCwd || process.cwd(),
      initialPrompt: job.initialPrompt || '',
      output: job.subagentResult?.output ?? (job.inlineStdout + job.inlineStderr).trim(),
      diagnostic: job.diagnostic || job.subagentResult?.diagnostic,
      subagentResult: job.subagentResult,
      latestSeq: Math.max(0, job.nextEventSeq - 1),
      childMode: job.childMode || job.subagentResult?.childMode,
      effectivePolicy: job.effectivePolicy || job.subagentResult?.effectivePolicy,
      isolateWorktree: job.isolateWorktree ?? job.subagentResult?.isolateWorktree ?? false,
      worktreePath: job.worktreePath || job.subagentResult?.worktreePath,
      checkpointId: job.checkpointId || job.subagentResult?.checkpointId,
      filesModified: liveDiff.filesModified,
      gitDiffStat: liveDiff.gitDiffStat
    };
  }

  /**
   * Appends an event to the job's bounded ring buffer and wakes every waiting
   * event cursor. Event text is sanitized before it is stored.
   */
  public appendSubagentEvent(
    jobId: string,
    event: {
      kind: SubagentEventKind;
      text: string;
      stream?: 'stdout' | 'stderr';
      meta?: Record<string, any>;
    }
  ): SubagentEvent | undefined {
    this.assertValidJobId(jobId);
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    // R3-m4: Sanitize string fields inside event.meta so sensitive CLI flags never leak via metadata.
    let cleanMeta: Record<string, any> | undefined;
    if (event.meta && typeof event.meta === 'object') {
      cleanMeta = {};
      for (const [k, v] of Object.entries(event.meta)) {
        cleanMeta[k] = typeof v === 'string' ? sanitizeSensitiveCliFlags(v) : v;
      }
    }

    const cleanText = sanitizeSensitiveCliFlags(String(event.text ?? ''));
    const entry: SubagentEvent = {
      seq: job.nextEventSeq++,
      timestamp: Date.now(),
      kind: event.kind,
      stream: event.stream,
      text: cleanText,
      ...(cleanMeta ? { meta: cleanMeta } : {})
    };

    const entryBytes = computeEventByteSize(entry);
    job.events.push(entry);
    job.eventBytes += entryBytes;
    if (event.kind !== 'heartbeat') {
      job.lastActivityAt = entry.timestamp;
    }

    // Backpressure: drop the oldest events once either cap is exceeded.
    while (
      (job.events.length > MAX_EVENT_RING_ITEMS || job.eventBytes > MAX_EVENT_RING_BYTES) &&
      job.events.length > 1
    ) {
      const shifted = job.events.shift()!;
      job.eventBytes = Math.max(0, job.eventBytes - computeEventByteSize(shifted));
      job.droppedEvents++;
    }

    for (const wake of [...job.eventWaiters]) {
      try {
        wake();
      } catch {}
    }

    return entry;
  }

  /** Streams child output into the job log + inline buffer, emitting lines. */
  public appendSubagentOutput(jobId: string, stream: 'stdout' | 'stderr', text: string): void {
    if (!text) return;
    this.assertValidJobId(jobId);
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.appendInline(stream, job, text);
    try {
      job.logStream?.write(text);
    } catch {}
    this.emitOutputLines(job, stream, text);
  }

  /** Finalizes a subagent job with its structured summary. */
  public completeSubagentJob(jobId: string, summary: SubagentSummary): void {
    this.assertValidJobId(jobId);
    const job = this.jobs.get(jobId);
    if (!job) return;

    const marker = `\n[MWH_SUBAGENT_SUMMARY]\n${JSON.stringify(summary, null, 2)}\n`;
    const stream = job.logStream;
    if (stream && !stream.destroyed && !stream.writableEnded) {
      try {
        stream.write(marker);
      } catch {}
    }
    this.appendInline('stdout', job, marker);

    job.subagentResult = summary;

    // A user-aborted job must stay TERMINATED — the late child resolution must
    // never resurrect it as COMPLETED/FAILED.
    if (job.record.status !== 'TERMINATED') {
      job.record.status = summary.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
      job.record.exitCode = summary.status === 'COMPLETED' ? 0 : 1;
      job.record.endTime = Date.now();
    }

    job.diagnostic = summary.diagnostic;
    this.appendSubagentEvent(jobId, {
      kind: summary.status === 'COMPLETED' ? 'completed' : 'error',
      text: summary.summary || summary.error || summary.status,
      meta: {
        status: summary.status,
        filesModified: summary.filesModified,
        diagnostic: summary.diagnostic
      }
    });

    // Cursor bookkeeping for the caller (includes the terminal event above).
    summary.nextSeq = job.nextEventSeq - 1;
    summary.latestSeq = job.nextEventSeq - 1;

    const isTimeout =
      summary.timedOut === true ||
      summary.error === 'TIMEOUT' ||
      (typeof summary.stopReason === 'string' && summary.stopReason.includes('timeout'));
    const termOutcome: 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'TERMINATED' =
      job.record.status === 'TERMINATED'
        ? 'TERMINATED'
        : isTimeout
          ? 'TIMEOUT'
          : summary.status === 'COMPLETED'
            ? 'COMPLETED'
            : 'FAILED';
    this.appendTerminalAudit(job, termOutcome, summary.error || summary.summary);

    this.finalizeJob(job);
    this.emitJobEvent({
      jobId,
      pid: job.record.pid,
      command: job.record.command,
      status: job.record.status,
      exitCode: job.record.exitCode
    });
  }

  /** Marks a still-running subagent job as backgrounded (dual-track yield). */
  public markSubagentRunningAsync(jobId: string): void {
    this.assertValidJobId(jobId);
    const job = this.jobs.get(jobId);
    if (!job || job.record.status !== 'RUNNING') return;
    job.record.status = 'RUNNING_ASYNC';
    this.emitJobEvent({
      jobId,
      pid: job.record.pid,
      command: job.record.command,
      status: 'RUNNING_ASYNC'
    });
  }

  /** R2-m8: Returns a read-only snapshot of the job's current event sequence cursor. */
  public getEventCursor(jobId: string): { nextSeq: number; latestSeq: number; droppedEvents: number } | null {
    this.assertValidJobId(jobId);
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      // Initial RUNNING_ASYNC receipt points nextSeq at 0 so the first pollEvents(afterSeq=0)
      // includes seq=1 ([started]) and any early message chunks emitted during the yield window.
      nextSeq: 0,
      latestSeq: Math.max(0, job.nextEventSeq - 1),
      droppedEvents: job.droppedEvents
    };
  }

  /**
   * Polls job logs in chunks of <= 8192 bytes.
   * P2: page boundaries are aligned to UTF-8 character boundaries (up to a
   * 3-byte lead-byte backoff) so multi-byte characters are never split.
   */
  public poll(jobId: string, page = 1, pageSize = 8192, workspaceRoot = process.cwd()): JobPollResult {
    this.assertValidJobId(jobId);

    const job = this.jobs.get(jobId);
    let logAbsPath = job?.logAbsPath || joinInsideRoot(workspaceRoot, '.mwh', 'logs', `${jobId}.log`);

    // Worktree / cwd drift: the log may have been created under another root.
    if (!fs.existsSync(logAbsPath)) {
      const fallback = joinInsideRoot(process.cwd(), '.mwh', 'logs', `${jobId}.log`);
      if (fs.existsSync(fallback)) {
        logAbsPath = fallback;
      }
    }

    const cursor = {
      nextSeq: job ? job.nextEventSeq - 1 : undefined,
      latestSeq: job ? job.nextEventSeq - 1 : undefined,
      droppedEvents: job?.droppedEvents,
      diagnostic: job?.diagnostic,
      pidAlive: isPidAlive(job?.record.pid)
    };
    const liveDiff = job ? this.getLiveDiff(job) : { filesModified: [], gitDiffStat: '' };

    const numericPage = Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 1;
    const numericPageSize = Number.isFinite(Number(pageSize)) ? Math.floor(Number(pageSize)) : 8192;
    const safePageSize = Math.min(Math.max(1, numericPageSize), 8192); // Max 8KB per page

    // No log on disk: serve from memory while the record lives, otherwise
    // return a legal ARCHIVED page instead of throwing JOB_LOG_NOT_FOUND
    // (which used to break cursor streams after worktree cleanup).
    if (!fs.existsSync(logAbsPath)) {
      if (!job) {
        return {
          jobId,
          status: 'UNKNOWN',
          exitCode: null,
          page: 1,
          totalPages: 1,
          totalBytes: 0,
          chunk: '[MWH_JOB_LOG_ARCHIVED]',
          ...cursor
        };
      }

      const buf = Buffer.from(job.inlineStdout + job.inlineStderr, 'utf-8');
      const memTotalBytes = buf.length;
      const memTotalPages = Math.max(1, Math.ceil(memTotalBytes / safePageSize));
      const memPage = Math.max(1, Math.min(numericPage, memTotalPages));
      const memOffset = (memPage - 1) * safePageSize;
      const memChunk =
        memTotalBytes > 0 && memOffset < memTotalBytes
          ? buf
              .subarray(memOffset, Math.min(memOffset + safePageSize, memTotalBytes))
              .toString('utf-8')
          : '';

      return {
        jobId,
        status: job.record.status,
        exitCode: job.record.exitCode ?? null,
        page: memPage,
        totalPages: memTotalPages,
        totalBytes: memTotalBytes,
        chunk: memChunk,
        ...cursor,
        filesModified: liveDiff.filesModified,
        gitDiffStat: liveDiff.gitDiffStat,
        ...(job.subagentResult ? { subagentSummary: job.subagentResult } : {})
      };
    }

    const stats = fs.statSync(logAbsPath);
    const totalBytes = stats.size;
    const totalPages = Math.max(1, Math.ceil(totalBytes / safePageSize));
    const safePage = Math.max(1, Math.min(numericPage, totalPages));

    const offset = (safePage - 1) * safePageSize;
    let chunk = '';

    if (totalBytes > 0 && offset < totalBytes) {
      chunk = this.readAlignedPage(logAbsPath, offset, Math.min(safePageSize, totalBytes - offset), totalBytes);
    }

    // P2-R2: when the in-memory record is gone (evicted or foreign log), the
    // real terminal status is unknown — never disguise it as 'COMPLETED'.
    const status: JobStatus = job?.record.status || 'UNKNOWN';
    const exitCode: number | null = job?.record.exitCode ?? null;

    return {
      jobId,
      status,
      exitCode,
      page: safePage,
      totalPages,
      totalBytes,
      chunk,
      ...cursor,
      filesModified: liveDiff.filesModified,
      gitDiffStat: liveDiff.gitDiffStat,
      ...(job?.subagentResult ? { subagentSummary: job.subagentResult } : {})
    };
  }

  /**
   * Cursor-based long poll over the job's incremental event stream.
   * Never throws for unknown jobs — an UNKNOWN snapshot is returned instead.
   */
  public async pollEvents(
    jobId: string,
    opts?: { afterSeq?: number; waitMs?: number; limit?: number }
  ): Promise<SubagentEventsResult> {
    this.assertValidJobId(jobId);

    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        jobId,
        runId: jobId,
        agentType: 'unknown',
        status: 'UNKNOWN',
        pidAlive: false,
        exitCode: null,
        events: [],
        afterSeq: 0,
        nextSeq: 0,
        latestSeq: 0,
        droppedEvents: 0,
        timedOut: false,
        output: '',
        diagnostic: '[MWH_JOB_UNKNOWN] No in-memory record for this job id',
        filesModified: [],
        gitDiffStat: ''
      };
    }

    // Cursor poisoning guard: never accept an afterSeq beyond the latest seq.
    const latestNow = job.nextEventSeq - 1;
    const safeAfterSeq =
      typeof opts?.afterSeq === 'number' && opts.afterSeq >= 0
        ? Math.min(Math.floor(opts.afterSeq), latestNow)
        : 0;
    const waitMs = Math.min(Math.max(0, Math.floor(opts?.waitMs ?? 0)), MAX_EVENT_WAIT_MS);
    const limit = Math.min(Math.max(1, Math.floor(opts?.limit ?? 100)), MAX_EVENT_RING_ITEMS);

    const hasNew = (): boolean => job.events.some((e) => e.seq > safeAfterSeq);
    const isRunning = job.record.status === 'RUNNING' || job.record.status === 'RUNNING_ASYNC';

    let timedOut = false;
    if (!hasNew() && isRunning && waitMs > 0) {
      timedOut = await new Promise<boolean>((resolve) => {
        let done = false;
        let timer: NodeJS.Timeout | null = null;

        const wake = () => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          job.eventWaiters.delete(wake);
          resolve(false);
        };

        job.eventWaiters.add(wake);
        timer = setTimeout(() => {
          if (done) return;
          done = true;
          job.eventWaiters.delete(wake);
          resolve(true);
        }, waitMs);
        timer.unref?.();
      });
    }

    const matched = job.events.filter((e) => e.seq > safeAfterSeq).slice(0, limit);
    const latestSeq = job.nextEventSeq - 1;
    const nextSeq = matched.length > 0 ? matched[matched.length - 1].seq : safeAfterSeq;
    const liveDiff = this.getLiveDiff(job);

    return {
      jobId,
      runId: job.subagentResult?.runId || jobId,
      agentType: job.agentType || 'unknown',
      status: job.record.status,
      pid: job.record.pid,
      pidAlive: isPidAlive(job.record.pid),
      exitCode: job.record.exitCode ?? null,
      events: matched,
      afterSeq: safeAfterSeq,
      nextSeq,
      latestSeq,
      droppedEvents: job.droppedEvents,
      timedOut,
      output: job.subagentResult?.output ?? (job.inlineStdout + job.inlineStderr).trim(),
      filesModified: liveDiff.filesModified,
      gitDiffStat: liveDiff.gitDiffStat,
      childMode: job.childMode || job.subagentResult?.childMode,
      effectivePolicy: job.effectivePolicy || job.subagentResult?.effectivePolicy,
      isolateWorktree: job.isolateWorktree ?? job.subagentResult?.isolateWorktree,
      worktreePath: job.worktreePath || job.subagentResult?.worktreePath,
      checkpointId: job.checkpointId || job.subagentResult?.checkpointId,
      effectiveCwd: job.workspaceRoot || job.subagentResult?.effectiveCwd,
      ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}),
      ...(job.subagentResult ? { subagentSummary: job.subagentResult } : {})
    };
  }

  /**
   * Delivers a mid-run steer instruction to a live subagent job.
   * Prefers the adapter-provided steer hook (true ACP follow-up prompt) and
   * falls back to writing raw stdin.
   */
  public steerSubagentJob(
    jobId: string,
    input: string
  ): {
    success: boolean;
    jobId: string;
    status: JobStatus;
    nextSeq: number;
    deliveryState: SteerDeliveryReceipt['deliveryState'];
    acknowledged: boolean;
    rpcId?: number;
    pendingTurns?: number;
    message: string;
  } {
    this.assertValidJobId(jobId);

    const text = typeof input === 'string' ? input : '';
    const job = this.jobs.get(jobId);

    if (!text.trim()) {
      return {
        success: false,
        jobId,
        status: job?.record.status || 'UNKNOWN',
        nextSeq: job ? job.nextEventSeq - 1 : 0,
        deliveryState: 'rejected',
        acknowledged: false,
        message: 'Steer input must not be empty'
      };
    }

    if (!job) {
      return {
        success: false,
        jobId,
        status: 'UNKNOWN',
        nextSeq: 0,
        deliveryState: 'rejected',
        acknowledged: false,
        message: `Target job '${jobId}' was not found or has been archived; use subagent_dispatch(action="run", ...) to start a new session.`
      };
    }

    const status = job.record.status;
    const alive = isPidAlive(job.record.pid);
    const running = (status === 'RUNNING' || status === 'RUNNING_ASYNC') && (job.record.pid ? alive : true);

    if (running && job.customSteer) {
      let receipt: SteerDeliveryReceipt = {
        accepted: false,
        deliveryState: 'rejected',
        acknowledged: false
      };
      try {
        const raw = job.customSteer(text);
        if (typeof raw === 'boolean') {
          receipt = {
            accepted: raw,
            deliveryState: raw ? 'stdin_written' : 'rejected',
            acknowledged: false
          };
        } else if (raw && typeof raw === 'object') {
          receipt = raw;
        }
      } catch {
        receipt = { accepted: false, deliveryState: 'rejected', acknowledged: false };
      }

      if (receipt.accepted) {
        const stateDesc =
          receipt.deliveryState === 'queued_behind_active_turn'
            ? `queued behind ${receipt.pendingTurns ?? 1} active turn(s) (rpcId=${receipt.rpcId ?? 'n/a'})`
            : receipt.deliveryState === 'dispatched_to_idle_session'
              ? `dispatched to session stdin (rpcId=${receipt.rpcId ?? 'n/a'})`
              : 'written to child stdin pipe';
        const honestMsg = `Steer frame written to child stdin pipe (${stateDesc}; acknowledged=false — NOT yet executed by upstream agent; poll events/wait to verify [ACP Steer] ack and on-disk changes)`;
        this.appendSubagentEvent(jobId, {
          kind: 'status',
          text: `[steer] ${honestMsg}`,
          meta: {
            deliveryState: receipt.deliveryState,
            acknowledged: receipt.acknowledged,
            rpcId: receipt.rpcId,
            pendingTurns: receipt.pendingTurns
          }
        });
        return {
          success: true,
          jobId,
          status: job.record.status,
          nextSeq: job.nextEventSeq - 1,
          deliveryState: receipt.deliveryState,
          acknowledged: receipt.acknowledged,
          rpcId: receipt.rpcId,
          pendingTurns: receipt.pendingTurns,
          message: honestMsg
        };
      }
    }

    if (running && job.child?.stdin && !job.child.stdin.destroyed) {
      try {
        job.child.stdin.write(text + '\n');
        const honestMsg =
          'Steer raw line written to child stdin pipe (acknowledged=false — NOT yet confirmed executed; poll events/wait to verify output)';
        this.appendSubagentEvent(jobId, {
          kind: 'status',
          text: `[steer] wrote ${text.length} chars to job stdin (unacknowledged)`,
          meta: { deliveryState: 'stdin_written', acknowledged: false }
        });
        return {
          success: true,
          jobId,
          status: job.record.status,
          nextSeq: job.nextEventSeq - 1,
          deliveryState: 'stdin_written',
          acknowledged: false,
          message: honestMsg
        };
      } catch {
        // Fall through to the failure response below.
      }
    }

    const cwdHint = job.workspaceRoot || job.subagentResult?.effectiveCwd || process.cwd();
    return {
      success: false,
      jobId,
      status: job.record.status,
      nextSeq: job.nextEventSeq - 1,
      deliveryState: 'rejected',
      acknowledged: false,
      message: `SESSION_ALREADY_TERMINATED: Target job '${jobId}' is no longer running (status=${job.record.status}, pidAlive=${alive}). The previous process is dead; on-disk files in '${cwdHint}' are preserved. Use subagent_dispatch(action="resume", jobId="${jobId}", prompt="...") to continue work in a new session.`
    };
  }

  /** Lists subagent jobs, newest first. */
  public listSubagentJobs(limit = 20): Array<{
    jobId: string;
    runId: string;
    agentType: string;
    command: string;
    status: JobStatus;
    pid?: number;
    pidAlive: boolean;
    startTime: number;
    endTime?: number;
    exitCode: number | null;
    latestSeq: number;
  }> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_JOBS_RETAINED);
    const rows: Array<{
      jobId: string;
      runId: string;
      agentType: string;
      command: string;
      status: JobStatus;
      pid?: number;
      pidAlive: boolean;
      startTime: number;
      endTime?: number;
      exitCode: number | null;
      latestSeq: number;
    }> = [];

    for (const job of this.jobs.values()) {
      if (!job.agentType) continue;
      rows.push({
        jobId: job.record.id,
        runId: job.subagentResult?.runId || job.record.id,
        agentType: job.agentType,
        command: job.record.command,
        status: job.record.status,
        pid: job.record.pid,
        pidAlive: isPidAlive(job.record.pid),
        startTime: job.record.startTime,
        endTime: job.record.endTime,
        exitCode: job.record.exitCode ?? null,
        latestSeq: job.nextEventSeq - 1
      });
    }

    rows.sort((a, b) => b.startTime - a.startTime);
    return rows.slice(0, safeLimit);
  }

  /**
   * P2: reads a page while aligning both edges to UTF-8 character boundaries.
   * Page start: if the first byte is inside a multi-byte sequence, walk back
   * (max 3 bytes) to its lead byte and include the whole character.
   * Page end: if the tail holds an incomplete sequence, pull the end back to
   * the lead byte. The returned string never contains split characters.
   */
  private readAlignedPage(
    logAbsPath: string,
    offset: number,
    bytesToRead: number,
    totalBytes: number
  ): string {
    let start = offset;
    let end = offset + bytesToRead;

    const leadLength = (b: number): number =>
      b < 0x80 ? 1 : b < 0xc0 ? 0 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : b < 0xf8 ? 4 : 0;

    const fd = fs.openSync(logAbsPath, 'r');
    try {
      // --- page start alignment ---
      if (start > 0) {
        const backSpan = Math.min(3, start);
        const backBuf = Buffer.alloc(backSpan);
        fs.readSync(fd, backBuf, 0, backSpan, start - backSpan);
        for (let i = backSpan - 1; i >= 0; i--) {
          const b = backBuf[i];
          if ((b & 0xc0) === 0x80) {
            continue; // continuation byte: keep walking back
          }
          const ll = leadLength(b);
          const leadPos = start - backSpan + i;
          if (ll >= 2 && leadPos + ll > start) {
            start = leadPos; // character straddles the boundary: include it
          }
          break; // first non-continuation byte decides
        }
      }

      // --- page end alignment ---
      if (end < totalBytes) {
        const tailSpan = Math.min(3, end - start);
        const tailBuf = Buffer.alloc(tailSpan);
        fs.readSync(fd, tailBuf, 0, tailSpan, end - tailSpan);
        // Backward scan from the last byte of the page: skip continuation
        // bytes until the lead byte of the character containing the boundary;
        // if that character extends past the page, truncate at its lead byte.
        for (let back = 0; back < tailSpan; back++) {
          const b = tailBuf[tailSpan - 1 - back];
          if ((b & 0xc0) === 0x80) {
            continue; // continuation byte: the character started earlier
          }
          const ll = leadLength(b);
          const leadPos = end - 1 - back;
          if (ll >= 2 && leadPos + ll > end) {
            end = leadPos; // incomplete trailing sequence: pull the end back
          }
          break;
        }
      }

      const readLen = end - start;
      if (readLen <= 0) {
        return '';
      }
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, start);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Delivers stdin input to a running process.
   */
  public writeStdin(jobId: string, input: string): { success: boolean; jobId: string } {
    this.assertValidJobId(jobId);

    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: No active job for ${jobId}`);
    }

    if (job.record.status !== 'RUNNING' && job.record.status !== 'RUNNING_ASYNC') {
      throw new Error(`JOB_NOT_RUNNING: Job ${jobId} status is ${job.record.status}`);
    }

    if (!job.child || !job.child.stdin || job.child.stdin.destroyed) {
      throw new Error(`JOB_STDIN_CLOSED: Stdin stream is not writable for ${jobId}`);
    }

    job.child.stdin.write(input);
    return { success: true, jobId };
  }

  /**
   * Aborts a running process and terminates its entire process tree.
   * P2: TERMINATED is only reported when the process tree verifiably died;
   * otherwise the job stays RUNNING and success=false with
   * error=JOB_TERMINATE_FAILED is returned.
   */
  public abort(jobId: string): { success: boolean; jobId: string; status: JobStatus; error?: string } {
    this.assertValidJobId(jobId);

    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: No active job for ${jobId}`);
    }

    if (job.record.status === 'RUNNING' || job.record.status === 'RUNNING_ASYNC') {
      job.abortRequested = true;
      try {
        job.logStream?.write('\n[MWH_JOB_ABORTED_BY_USER]\n');
      } catch {}

      // Subagent jobs: the CLI/ACP child lives in its own Win32 Job Object, so
      // the adapter-provided abort handle must run first (and is authoritative).
      if (job.customAbort) {
        try {
          job.customAbort();
        } catch {
          // Fall through to the pid-tree termination path below.
        }
      }

      const dead = this.terminateAndVerify(job, 1);
      if (!dead) {
        return {
          success: false,
          jobId,
          status: job.record.status,
          error: 'JOB_TERMINATE_FAILED'
        };
      }

      job.record.status = 'TERMINATED';
      job.record.endTime = Date.now();
      job.diagnostic = job.diagnostic || 'Terminated by caller (abort/interrupt)';
      this.appendTerminalAudit(job, 'TERMINATED', 'MWH_JOB_ABORTED_BY_USER');
      this.finalizeJob(job);
      this.emitJobEvent({
        jobId,
        pid: job.record.pid,
        command: job.record.command,
        status: 'TERMINATED',
        exitCode: job.record.exitCode
      });
    }

    return { success: true, jobId, status: job.record.status };
  }

  public getJob(jobId: string): JobRecord | undefined {
    this.assertValidJobId(jobId);
    return this.jobs.get(jobId)?.record;
  }
}

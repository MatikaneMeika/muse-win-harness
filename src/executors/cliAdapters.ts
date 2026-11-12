/**
 * CLI Adapters for Headless Local AI Agents
 * Probes and wraps configured ACP profiles with Win32 Job Object process containment.
 *
 * SECURITY DISCLOSURE (P3, BYOK trust model):
 * The spawned external CLI process CANNOT be constrained by this process's
 * OS-level fences (path fences, ACL sandboxes and approval flows only cover
 * in-process Muse tool execution). The external CLI runs with whatever local
 * privileges the user granted that CLI binary — Bring Your Own Key, Bring Your
 * Own Kryptonite. MWH therefore only performs PRE-DISPATCH validation (privilege
 * ceiling: child mode <= parent mode; cwd fence; audit logging) and forwards the
 * validated child mode via the MWH_CHILD_MODE environment variable for the
 * CLI's own optional consumption. It is NOT a security boundary for the child.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Win32JobObject } from '../pipeline/win32Job.js';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type AcpProfile,
  type SubagentEventKind,
  type SteerDeliveryReceipt
} from '../types.js';
import { AcpConfigManager } from '../config/acpConfig.js';

const ACTIVITY_SKIP_DIRS = new Set(['.git', 'node_modules', '.mwh', 'dist', 'target', '.venv']);

/**
 * Computes a lightweight shallow directory mtime/size fingerprint for `cwd`
 * so the liveness watchdog can detect when a silent CLI/ACP child is actively
 * writing files to disk even while stdout is temporarily quiet.
 */
function computeWorkspaceActivitySignature(cwd: string): string {
  try {
    if (!fs.existsSync(cwd)) return 'missing';
    const parts: string[] = [];
    let count = 0;
    const scanDir = (dir: string, depth: number) => {
      if (depth > 1 || count >= 200) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (count >= 200) break;
        if (ACTIVITY_SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full, depth + 1);
        } else if (entry.isFile()) {
          try {
            const st = fs.statSync(full);
            parts.push(`${path.relative(cwd, full)}:${st.size}:${Math.floor(st.mtimeMs)}`);
            count++;
          } catch {}
        }
      }
    };
    scanDir(cwd, 0);
    parts.sort();
    return parts.join('|');
  } catch {
    return 'err';
  }
}

/**
 * Computes the hard wall-clock ceiling for an activity-aware sliding timeout.
 * Real dispatches (>= 30s, or when MWH_ENABLE_SLIDING_TIMEOUT='1' in tests)
 * can slide up to 3x the base window (capped at 30 minutes) as long as real
 * output/event/disk progress continues; short synthetic hang tests (< 30s)
 * keep a tight ceiling unless explicitly opted in.
 */
export function computeHardMaxTimeoutMs(baseTimeoutMs: number): number {
  const safeBase = Math.max(50, baseTimeoutMs || DEFAULT_SUBAGENT_TIMEOUT_MS);
  if (safeBase >= 30000 || process.env.MWH_ENABLE_SLIDING_TIMEOUT === '1') {
    return Math.min(safeBase * 3, 1800000);
  }
  return safeBase;
}

export interface CliAvailability {
  available: boolean;
  path?: string;
}

/**
 * Probes configured ACP profiles and any extra names requested by callers.
 * All availability now flows through the ACP profile registry: a probed profile
 * reports availability from its enabled + detected state, while an extra name
 * that is not a configured profile is probed directly through the shell PATH.
 */
export function probeAvailableClis(extraNames?: string[]): Record<string, CliAvailability> {
  const result: Record<string, CliAvailability> = {};
  const manager = AcpConfigManager.getInstance();

  for (const p of manager.getProbedProfiles()) {
    result[p.id] = {
      available: Boolean(p.enabled && p.detected),
      path: p.binaryPath || p.command
    };
  }

  if (Array.isArray(extraNames)) {
    for (const extra of extraNames) {
      const name = String(extra || '').trim();
      if (!name || result[name]) {
        continue;
      }
      const profile = manager.resolveProfile(name);
      if (profile) {
        result[name] = {
          available: Boolean(profile.enabled && profile.detected),
          path: profile.binaryPath || profile.command
        };
      } else {
        const probe = manager.probeCommand(name);
        result[name] = { available: probe.available, path: probe.path };
      }
    }
  }

  return result;
}

/**
 * Cloud-safe sanitizer for CLI argv strings.
 *
 * Privilege-escalation flags MUST NEVER travel back to the cloud Muse model in
 * logs / job records / tool output — the cloud safety classifier trips on them
 * and falsely cancels the whole session. Every display path (job command
 * strings, log echo) therefore routes through this function.
 */
export function sanitizeSensitiveCliFlags(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  const REPLACEMENT = '[LOCAL_CONFINEMENT_ADAPTED]';
  return text
    .replace(/--always-approve/gi, REPLACEMENT)
    .replace(/--dangerously-skip-permissions/gi, REPLACEMENT)
    .replace(/--permission-mode\s+bypassPermissions/gi, REPLACEMENT)
    .replace(/bypassPermissions/gi, REPLACEMENT)
    .replace(/--full-auto/gi, REPLACEMENT);
}

/**
 * Live runtime callbacks bridging a spawned CLI/ACP child into the async Job
 * Engine (pid binding + streaming output), so long subagent runs are pollable.
 */
export interface SubagentRuntimeCallbacks {
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  onEvent?: (event: {
    kind: SubagentEventKind;
    text: string;
    stream?: 'stdout' | 'stderr';
    meta?: Record<string, any>;
  }) => void;
  onPid?: (
    pid: number,
    abortFn: () => boolean,
    steerFn?: (input: string) => boolean | SteerDeliveryReceipt
  ) => void;
}

/** Structured result of a CLI / ACP subagent adapter run. */
export interface SubagentAdapterResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  output?: string;
  diagnostic?: string;
  stopReason?: string;
  exitCode?: number | null;
  error?: string;
  message?: string;
  timedOut?: boolean;
}

/** MWH-internal credential variables that must never reach a child process. */
const MWH_SENSITIVE_ENV_KEYS: readonly string[] = [
  'MWH_HMAC_SECRET',
  'TUNNEL_RUNTIME_TOKEN',
  'MWH_CF_TUNNEL_TOKEN',
  'MWH_UI_SESSION',
  'MWH_RUNTIME_TOKEN'
];

/** Secret-shaped env var suffix pattern used when an allowlist is configured. */
const SENSITIVE_ENV_PATTERN = /(_SECRET|_TOKEN|_KEY|_PASSWORD|_PRIVATE_KEY|COOKIE)$/i;

/**
 * Builds the environment for a spawned CLI / ACP child:
 * - MWH's own credential variables are ALWAYS stripped.
 * - With a non-empty `profile.envAllowlist`, any secret-shaped variable that is
 *   not allowlisted is stripped as well.
 * - `profile.env` is merged last (explicit operator intent wins the filter).
 */
export function buildCleanChildEnv(
  cwd: string,
  childMode?: string,
  profile?: AcpProfile
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      base[key] = value;
    }
  }

  const sensitiveUpper = new Set(MWH_SENSITIVE_ENV_KEYS.map((k) => k.toUpperCase()));
  for (const key of Object.keys(base)) {
    if (sensitiveUpper.has(key.toUpperCase())) {
      delete base[key];
    }
  }

  if (Array.isArray(profile?.envAllowlist) && profile.envAllowlist.length > 0) {
    const allowSet = new Set(profile.envAllowlist.map((k) => String(k).toUpperCase()));
    for (const key of Object.keys(base)) {
      if (SENSITIVE_ENV_PATTERN.test(key) && !allowSet.has(key.toUpperCase())) {
        delete base[key];
      }
    }
  }

  // R2-m3: Never allow profile.env to re-inject MWH internal secrets.
  const safeProfileEnv: Record<string, string> = {};
  if (profile?.env && typeof profile.env === 'object') {
    for (const [key, val] of Object.entries(profile.env)) {
      if (typeof val === 'string' && !sensitiveUpper.has(key.toUpperCase())) {
        safeProfileEnv[key] = val;
      }
    }
  }

  return {
    ...base,
    ...safeProfileEnv,
    // Force UTF-8 end-to-end: CJK prompts / output must never be mangled by the
    // default Windows code page in the child's Python or Node runtime.
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    LANG: 'en_US.UTF-8',
    MWH_WORKSPACE_ROOT: cwd,
    ...(childMode ? { MWH_CHILD_MODE: childMode } : {})
  };
}

const SAFE_DIAGNOSTIC_MAX_BYTES = 4096;
const MAX_ADAPTER_OUTPUT_CHARS = 2 * 1024 * 1024; // 2MB per in-memory adapter buffer
const MAX_ACP_LINE_CHARS = 4 * 1024 * 1024; // 4MB max single NDJSON line buffer

function appendBoundedBuffer(current: string, chunk: string, limit = MAX_ADAPTER_OUTPUT_CHARS): string {
  if (current.length >= limit) return current;
  if (current.length + chunk.length > limit) {
    return current + chunk.slice(0, limit - current.length);
  }
  return current + chunk;
}

function sanitizeDiagnosticField(val: string | undefined, maxLen = 200): string {
  if (!val) return '';
  return String(val)
    .replace(/[\r\n\u0000-\u001f]+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Builds a compact, cloud-safe failure diagnostic.
 *
 * Never includes raw secrets, environment values or unsanitized paths — only
 * the provider, profile id, lifecycle stage, category and coarse process facts.
 * The result is hard-capped at 4096 UTF-8 bytes.
 */
export function buildSafeDiagnostic(facts: {
  provider: 'ACP' | 'CLI';
  profileId: string;
  stage: 'initialize' | 'new-session' | 'prompt' | 'process' | 'teardown';
  category:
    | 'protocol'
    | 'configuration'
    | 'transport'
    | 'process-start'
    | 'process-exit'
    | 'remote-limit'
    | 'timeout'
    | 'cancelled'
    | 'unknown';
  stopReason?: string;
  exitCode?: number | null;
  permission?: { policy: string; request: string; decision: 'allowed' | 'denied' };
}): string {
  const safeProfile = sanitizeDiagnosticField(facts.profileId, 120) || 'unknown';
  const safeStop = sanitizeDiagnosticField(facts.stopReason, 3800);
  const stopSuffix = safeStop ? `; stop reason: ${safeStop}` : '';
  const exitSuffix =
    facts.exitCode !== undefined && facts.exitCode !== null ? `; exit code: ${facts.exitCode}` : '';

  let text = `Subagent failure (provider: ${facts.provider}; profile: ${safeProfile}; stage: ${facts.stage}; category: ${facts.category}${stopSuffix}${exitSuffix})`;

  if (facts.permission) {
    const safePolicy = sanitizeDiagnosticField(facts.permission.policy, 64) || 'reject';
    const safeReq = sanitizeDiagnosticField(facts.permission.request, 120) || 'unknown';
    text += `\nACP unattended decision (policy: ${safePolicy}; request: ${safeReq}; decision: ${facts.permission.decision})`;
  }

  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= SAFE_DIAGNOSTIC_MAX_BYTES) {
    return text;
  }
  // Trimming may land inside a multi-byte sequence: drop the replacement char.
  return buf
    .subarray(0, SAFE_DIAGNOSTIC_MAX_BYTES)
    .toString('utf-8')
    .replace(/\uFFFD+$/, '');
}

/**
 * Windows cannot spawn .cmd/.bat shims directly (EINVAL); route them through
 * the command interpreter instead.
 */
function isWindowsScriptShim(binaryPath: string): boolean {
  const lower = binaryPath.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * R3-M3: Neutralizes cmd.exe metacharacters (%VAR% expansion and command chaining)
 * when argv must pass through cmd.exe /d /s /c for a .cmd/.bat shim.
 */
function sanitizeWindowsCmdShimArgs(args: string[]): string[] {
  return args.map((arg) =>
    String(arg)
      .replace(/[\r\n]+/g, ' ')
      .replace(/%/g, '%%')
      .replace(/[&|<>^]/g, ' ')
  );
}

/**
 * Runs a custom ACP subagent with Win32 Job Object confinement and timeout.
 *
 * Two operating modes, chosen from the profile argv:
 * - `profile.args` contains a `%PROMPT%` placeholder: one-shot template profile,
 *   the prompt is substituted into argv and stdin is closed immediately.
 * - `profile.args` has NO `%PROMPT%` (e.g. `["agent", "stdio"]`): a long-lived
 *   ACP stdio agent. The prompt must NEVER be appended to argv (that is what
 *   made ACP agents exit 2 on an unexpected positional argument). Instead a
 *   minimal JSON-RPC 2.0 client drives initialize -> session/new ->
 *   session/prompt over NDJSON, streaming session/update notifications.
 *
 * Backwards compatibility: a profile that prints plain text (no JSON-RPC) and
 * exits 0 is still reported as a successful one-shot run (plainStdout).
 */
export async function runAcpSubagent(
  profileOrId: AcpProfile | string,
  prompt: string,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_SUBAGENT_TIMEOUT_MS,
  childMode?: string,
  callbacks?: SubagentRuntimeCallbacks
): Promise<SubagentAdapterResult> {
  let profile: AcpProfile | undefined;
  if (typeof profileOrId === 'string') {
    const manager = AcpConfigManager.getInstance();
    // resolveProfile treats 'acp' (and an empty id) as the default profile.
    profile = manager.resolveProfile(profileOrId) || manager.getProfile(profileOrId);
  } else {
    profile = profileOrId;
  }

  if (!profile) {
    const requestedId = typeof profileOrId === 'string' ? profileOrId : '(inline-profile)';
    return {
      success: false,
      error: 'ACP_PROFILE_NOT_FOUND',
      message: `ACP subagent profile '${requestedId}' was not found.`,
      diagnostic: buildSafeDiagnostic({
        provider: 'ACP',
        profileId: requestedId,
        stage: 'initialize',
        category: 'configuration'
      })
    };
  }

  if (!profile.enabled) {
    return {
      success: false,
      error: 'ACP_PROFILE_DISABLED',
      message: `ACP subagent profile '${profile.id}' is currently disabled.`,
      diagnostic: buildSafeDiagnostic({
        provider: 'ACP',
        profileId: profile.id,
        stage: 'initialize',
        category: 'configuration'
      })
    };
  }

  const probed = AcpConfigManager.getInstance().probeProfile(profile);
  if (!probed.detected || !probed.binaryPath) {
    return {
      success: false,
      error: 'ACP_COMMAND_NOT_FOUND',
      message: `ACP subagent command '${profile.command}' is not accessible or not found on this machine.`,
      diagnostic: buildSafeDiagnostic({
        provider: 'ACP',
        profileId: profile.id,
        stage: 'initialize',
        category: 'configuration'
      })
    };
  }

  let jobObj: Win32JobObject | null = null;
  try {
    jobObj = new Win32JobObject();
  } catch (err: any) {
    return {
      success: false,
      error: 'JOB_OBJECT_INIT_FAILED',
      message: `Failed to initialize Win32 Job Object: ${err.message}`,
      diagnostic: buildSafeDiagnostic({
        provider: 'ACP',
        profileId: profile.id,
        stage: 'process',
        category: 'process-start'
      })
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let acpAssistantText = '';
    let plainStdout = '';
    let lineBuffer = '';
    let sawJsonRpc = false;
    let sessionId: string | undefined;
    let promptCompleted = false;
    let promptFailure: string | null = null;
    let handleWatchdog: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let reclaimTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let eofGraceTimer: NodeJS.Timeout | null = null;
    let terminateGraceTimer: NodeJS.Timeout | null = null;

    /** ACP lifecycle stage (diagnostics only — never user-facing control flow). */
    let stage: 'initialize' | 'new-session' | 'prompt' | 'process' | 'teardown' = 'initialize';
    let nextRpcId = 4;
    let latestPromptRpcId = 3;
    const activePromptIds = new Set<number>([3]);
    let abortedByCaller = false;
    let terminating = false;
    let latestPermission:
      | { policy: string; request: string; decision: 'allowed' | 'denied' }
      | undefined;
    let stopReason: string | undefined;

    /**
     * D-8: when the child spoke JSON-RPC, raw stdout is NDJSON protocol frames
     * and must NEVER be surfaced as assistant text. Only fall back to stdout
     * for plain-text (non JSON-RPC) profiles.
     */
    const resolveCleanOutput = (): string =>
      sawJsonRpc
        ? (acpAssistantText.trim() || plainStdout.trim())
        : (acpAssistantText.trim() || plainStdout.trim() || stdout.trim());

    // FIX (ACP_EXIT_2): only substitute when the placeholder is actually part
    // of the profile argv. Appending the prompt to a stdio agent's argv makes
    // it die with exit code 2 (unknown positional argument).
    const finalArgs = [...(profile.args || [])];
    const promptInArgs = finalArgs.some((a) => a.includes('%PROMPT%'));
    if (promptInArgs) {
      for (let i = 0; i < finalArgs.length; i++) {
        finalArgs[i] = finalArgs[i].replace(/%PROMPT%/g, prompt);
      }
    }

    const env = buildCleanChildEnv(cwd, childMode, profile);

    // .cmd/.bat shims cannot be spawned directly on Windows (EINVAL) — run them
    // through the fixed system command interpreter ('cmd.exe', never an env-var
    // override) with cmd.exe metacharacter sanitization (R3-M3).
    const child = isWindowsScriptShim(probed.binaryPath!)
      ? spawn(
          'cmd.exe',
          ['/d', '/s', '/c', probed.binaryPath!, ...sanitizeWindowsCmdShimArgs(finalArgs)],
          {
            cwd,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env
          }
        )
      : spawn(probed.binaryPath!, finalArgs, {
          cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env
        });

    if (promptInArgs) {
      stage = 'process';
    }

    // A child that exits before we flush a frame closes the pipe: swallow the
    // resulting EPIPE instead of letting it surface as an uncaught exception.
    child.stdin?.on('error', () => {});

    type DiagnosticCategory =
      | 'protocol'
      | 'configuration'
      | 'transport'
      | 'process-start'
      | 'process-exit'
      | 'remote-limit'
      | 'timeout'
      | 'cancelled'
      | 'unknown';

    /**
     * Single settle path. Every outcome keeps partial assistant output and, on
     * failure, always attaches a safe diagnostic (also pushed as an event).
     */
    const settle = (
      result: Partial<SubagentAdapterResult> & { success: boolean },
      category: DiagnosticCategory = 'unknown'
    ) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (handleWatchdog) clearTimeout(handleWatchdog);
      if (graceTimer) clearTimeout(graceTimer);
      if (reclaimTimer) clearTimeout(reclaimTimer);
      // NOTE: eofGraceTimer / terminateGraceTimer are intentionally NOT cleared —
      // a graded teardown must be allowed to escalate after the promise resolves.

      const effectiveCategory: DiagnosticCategory =
        abortedByCaller && !result.success ? 'cancelled' : category;
      const output = result.output ?? resolveCleanOutput();

      const diagnostic = result.success
        ? undefined
        : result.diagnostic ??
          buildSafeDiagnostic({
            provider: 'ACP',
            profileId: profile!.id,
            stage,
            category: effectiveCategory,
            stopReason: result.stopReason ?? stopReason,
            exitCode: result.exitCode,
            permission: latestPermission
          });

      if (diagnostic) {
        callbacks?.onEvent?.({ kind: 'diagnostic', stream: 'stderr', text: diagnostic });
      }

      resolve({
        ...result,
        stdout: result.stdout ?? (sawJsonRpc ? resolveCleanOutput() : stdout),
        stderr: result.stderr ?? stderr,
        output,
        ...(diagnostic ? { diagnostic } : {})
      });
    };

    const terminateJob = (code: number) => {
      try {
        jobObj!.terminate(code);
      } catch {}
    };

    const sendFrame = (frame: Record<string, any>) => {
      try {
        child.stdin?.write(JSON.stringify(frame) + '\n');
      } catch {}
    };

    /**
     * Graded termination: JSON-RPC session/cancel -> stdin EOF -> SIGTERM ->
     * Win32 Job Object kill. Each hop is bounded so a wedged child can never
     * pin the promise for the full timeout window.
     */
    const cooperativeTerminate = (reason: 'timeout' | 'abort') => {
      if (settled || terminating) return;
      terminating = true;
      abortedByCaller = reason === 'abort';
      stage = 'teardown';

      if (!promptInArgs && sessionId) {
        sendFrame({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
        callbacks?.onEvent?.({
          kind: 'status',
          stream: 'stdout',
          text: '[ACP Teardown] session/cancel sent'
        });
      }

      try {
        child.stdin?.end();
      } catch {}

      const eofGraceMs = Math.min(Math.max(50, profile!.disposeEofGraceMs ?? 400), 2000);
      const graceMs = Math.min(Math.max(50, profile!.disposeGraceMs ?? 300), 1500);

      eofGraceTimer = setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          child.kill('SIGTERM');
        } catch {}
        terminateGraceTimer = setTimeout(() => {
          if (child.exitCode !== null) return;
          terminateJob(1);
        }, graceMs);
      }, eofGraceMs);
    };

    /** Live follow-up input into the running session (mid-run steer). */
    const steeredRpcIds = new Set<number>();
    const ackedSteerRpcIds = new Set<number>();
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let lastDiskSig = computeWorkspaceActivitySignature(cwd);
    const baseTimeoutMs = Math.max(50, timeoutMs || DEFAULT_SUBAGENT_TIMEOUT_MS);
    const hardMaxTimeoutMs = computeHardMaxTimeoutMs(baseTimeoutMs);

    const steerFn = (input: string): SteerDeliveryReceipt => {
      // R2-M4: Reject steers once teardown or prompt finalization has started.
      if (
        settled ||
        terminating ||
        promptCompleted ||
        stage === 'teardown' ||
        !child.stdin ||
        child.stdin.destroyed
      ) {
        return {
          accepted: false,
          deliveryState: 'rejected',
          acknowledged: false,
          reason: 'Target ACP session is already terminating or stdin is closed'
        };
      }
      if (!promptInArgs && sessionId) {
        const pendingBefore = activePromptIds.size;
        const rpcId = nextRpcId++;
        latestPromptRpcId = rpcId;
        activePromptIds.add(rpcId);
        steeredRpcIds.add(rpcId);
        const deliveryState =
          pendingBefore > 0 ? 'queued_behind_active_turn' : 'dispatched_to_idle_session';
        sendFrame({
          jsonrpc: '2.0',
          id: rpcId,
          method: 'session/prompt',
          params: { sessionId, prompt: [{ type: 'text', text: input }] }
        });
        callbacks?.onEvent?.({
          kind: 'status',
          stream: 'stdout',
          text: `[ACP Steer] Wrote follow-up prompt frame to stdin (rpcId=${rpcId}, state=${deliveryState}, pendingTurns=${pendingBefore}, chars=${input.length}) — awaiting agent turn acknowledgement`,
          meta: { rpcId, deliveryState, pendingTurns: pendingBefore, acknowledged: false }
        });
        return {
          accepted: true,
          deliveryState,
          acknowledged: false,
          rpcId,
          pendingTurns: pendingBefore
        };
      }
      try {
        child.stdin.write(input + '\n');
        return {
          accepted: true,
          deliveryState: 'stdin_written',
          acknowledged: false
        };
      } catch {
        return {
          accepted: false,
          deliveryState: 'rejected',
          acknowledged: false,
          reason: 'Failed to write to child stdin pipe'
        };
      }
    };

    /** Final settle of a prompt-driven run (500ms grace + 5000ms reclaim). */
    const finishPromptRun = () => {
      if (settled) return;
      const text = resolveCleanOutput();
      if (promptFailure) {
        settle(
          {
            success: false,
            exitCode: 1,
            stdout: text,
            stderr,
            output: text,
            error: 'ACP_PROMPT_ERROR',
            message: promptFailure
          },
          stopReason === 'refusal' ? 'remote-limit' : 'protocol'
        );
        return;
      }
      settle({ success: true, exitCode: 0, stdout: text, stderr, output: text, stopReason });
    };

    /** Schedules the 500ms graceful exit + 5000ms handle reclaim watchdogs. */
    const schedulePromptFinalize = () => {
      if (settled) return;
      stage = 'teardown';
      graceTimer = setTimeout(() => {
        if (settled) return;
        terminateJob(0);
        finishPromptRun();
      }, 500);
      reclaimTimer = setTimeout(() => {
        if (settled) return;
        terminateJob(0);
        finishPromptRun();
      }, 5000);
    };

    const handleMessage = (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      const numericId =
        typeof msg.id === 'number'
          ? msg.id
          : typeof msg.id === 'string' && /^\d+$/.test(msg.id)
            ? Number(msg.id)
            : NaN;

      // 1) initialize response -> session/new
      if (numericId === 1 && ('result' in msg || 'error' in msg)) {
        if (msg.error) {
          promptFailure = `ACP_INIT_ERROR: ${msg.error?.message || JSON.stringify(msg.error)}`;
          terminateJob(1);
          settle(
            {
              success: false,
              exitCode: 1,
              stdout: acpAssistantText.trim() || plainStdout.trim(),
              stderr,
              error: 'ACP_INIT_ERROR',
              message: promptFailure
            },
            'protocol'
          );
          return;
        }
        stage = 'new-session';
        sendFrame({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd, mcpServers: [] }
        });
        return;
      }

      // 2) session/new response -> session/prompt
      if (numericId === 2 && ('result' in msg || 'error' in msg)) {
        if (msg.error || !msg.result?.sessionId) {
          promptFailure = `ACP_SESSION_NEW_ERROR: ${
            msg.error?.message || JSON.stringify(msg.error || msg.result || {})
          }`;
          terminateJob(1);
          settle(
            {
              success: false,
              exitCode: 1,
              stdout: acpAssistantText.trim() || plainStdout.trim(),
              stderr,
              error: 'ACP_SESSION_NEW_ERROR',
              message: promptFailure
            },
            'protocol'
          );
          return;
        }
        sessionId = String(msg.result.sessionId);
        stage = 'prompt';
        // Read-only mode does not suppress the prompt itself — mutations are
        // refused at the session/request_permission gate below.
        sendFrame({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: {
            sessionId,
            prompt: [{ type: 'text', text: prompt }]
          }
        });
        return;
      }

      // 3) streaming notifications
      if (msg.method === 'session/update') {
        lastProgressAt = Date.now();
        if (steeredRpcIds.has(latestPromptRpcId) && !ackedSteerRpcIds.has(latestPromptRpcId)) {
          ackedSteerRpcIds.add(latestPromptRpcId);
          callbacks?.onEvent?.({
            kind: 'status',
            stream: 'stdout',
            text: `[ACP Steer] Agent acknowledged steered prompt and began streaming (rpcId=${latestPromptRpcId})`,
            meta: { rpcId: latestPromptRpcId, acknowledged: true }
          });
        }
        const u = msg.params?.update;

        if (
          u?.sessionUpdate === 'agent_message_chunk' &&
          u?.content?.type === 'text' &&
          typeof u.content.text === 'string'
        ) {
          acpAssistantText = appendBoundedBuffer(acpAssistantText, u.content.text);
          callbacks?.onOutput?.('stdout', u.content.text);
          callbacks?.onEvent?.({ kind: 'message_chunk', stream: 'stdout', text: u.content.text });
          return;
        }

        if (u?.sessionUpdate === 'agent_thought_chunk') {
          callbacks?.onEvent?.({
            kind: 'status',
            stream: 'stdout',
            text: typeof u?.content?.text === 'string' ? u.content.text : '[thinking]'
          });
          return;
        }

        if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
          const toolLine = `[ACP Tool] ${u.title || u.kind || u.toolCallId || 'execute'}${u.status ? ` (${u.status})` : ''}\n`;
          callbacks?.onOutput?.('stdout', toolLine);
          callbacks?.onEvent?.({
            kind: 'tool_call',
            stream: 'stdout',
            text: toolLine.trim(),
            meta: { toolCallId: u.toolCallId, kind: u.kind, status: u.status, title: u.title }
          });
        }
        return;
      }

      // 4) permission requests from the agent -> answer locally (fail-closed)
      if (msg.method === 'session/request_permission' && msg.id !== undefined) {
        lastProgressAt = Date.now();
        const rawKind = String(msg.params?.toolCall?.kind || 'unknown');
        const rawTitle = String(msg.params?.toolCall?.title || '');
        const hasWriteVerbInTitle = /\b(write|edit|patch|delete|remove|create|modify|bash|exec|shell|command|terminal)\b/i.test(
          rawTitle
        );
        const readOnlyDenied =
          childMode === 'read-only' &&
          (!['read', 'search', 'think'].includes(rawKind) || hasWriteVerbInTitle);

        if (readOnlyDenied || profile!.permissionPolicy === 'reject') {
          sendFrame({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'cancelled' } }
          });
          latestPermission = {
            policy: childMode === 'read-only' ? 'reject' : profile!.permissionPolicy || 'reject',
            request: rawKind,
            decision: 'denied'
          };
          callbacks?.onEvent?.({
            kind: 'permission',
            stream: 'stdout',
            text: `[ACP Permission] denied ${rawKind}`,
            meta: latestPermission
          });
          return;
        }

        const options: any[] = Array.isArray(msg.params?.options) ? msg.params.options : [];
        const chosen =
          options.find((o) => o?.kind === 'allow_once') ||
          options.find((o) => o?.kind === 'allow_always');

        if (chosen && chosen.optionId) {
          sendFrame({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: chosen.optionId } }
          });
          latestPermission = {
            policy: profile!.permissionPolicy || 'allow',
            request: rawKind,
            decision: 'allowed'
          };
        } else {
          sendFrame({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'cancelled' } }
          });
          latestPermission = {
            policy: profile!.permissionPolicy || 'reject',
            request: rawKind,
            decision: 'denied'
          };
        }

        callbacks?.onEvent?.({
          kind: 'permission',
          stream: 'stdout',
          text: `[ACP Permission] ${latestPermission.decision} ${rawKind}`,
          meta: latestPermission
        });
        return;
      }

      // 5) session/prompt final response -> run finished
      // R3-M6: Track all active prompt RPC IDs. A rejected follow-up steer (numericId > 3)
      // while the primary prompt (3) is still active must NOT kill the primary turn.
      if (
        Number.isFinite(numericId) &&
        numericId >= 3 &&
        activePromptIds.has(numericId) &&
        ('result' in msg || 'error' in msg)
      ) {
        lastProgressAt = Date.now();
        activePromptIds.delete(numericId);
        if (steeredRpcIds.has(numericId) && !msg.error) {
          ackedSteerRpcIds.add(numericId);
          callbacks?.onEvent?.({
            kind: 'status',
            stream: 'stdout',
            text: `[ACP Steer] Steered prompt execution completed (rpcId=${numericId}, stopReason=${msg.result?.stopReason || 'end_turn'})`,
            meta: { rpcId: numericId, acknowledged: true, executed: true }
          });
        }
        if (msg.error && numericId > 3 && activePromptIds.size > 0) {
          callbacks?.onEvent?.({
            kind: 'status',
            stream: 'stdout',
            text: `[ACP Steer] Follow-up prompt rejected while primary turn active: ${msg.error?.message || 'busy'}`
          });
          return;
        }
        if (numericId !== latestPromptRpcId && activePromptIds.size > 0) {
          return;
        }
        promptCompleted = true;
        if (typeof msg.result?.stopReason === 'string') {
          stopReason = msg.result.stopReason;
        }
        try {
          child.stdin?.end();
        } catch {}
        if (msg.error) {
          promptFailure = `ACP_PROMPT_ERROR: ${msg.error?.message || JSON.stringify(msg.error)}`;
        } else if (msg.result?.stopReason === 'refusal') {
          promptFailure = 'ACP_PROMPT_ERROR: agent refused the prompt (stopReason=refusal)';
        }
        schedulePromptFinalize();
        return;
      }

      // R2-M3 (a): Unrecognized agent->client JSON-RPC request (has method + id, no result/error):
      // Reply immediately with -32601 Method not found so the agent never deadlocks waiting for a response.
      if (
        typeof msg.method === 'string' &&
        msg.id !== undefined &&
        msg.id !== null &&
        !('result' in msg) &&
        !('error' in msg)
      ) {
        sendFrame({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32601,
            message: `Method not supported by MWH ACP client: ${msg.method}`
          }
        });
        return;
      }

      // R2-M3 (b): Unattributed protocol-level error frame (id === null / undefined):
      // Fail-fast instead of hanging until the 600s timeout.
      if (msg.error && (msg.id === null || msg.id === undefined)) {
        promptFailure = `ACP_PROTOCOL_ERROR: ${msg.error?.message || JSON.stringify(msg.error)}`;
        terminateJob(1);
        settle(
          {
            success: false,
            exitCode: 1,
            stdout: acpAssistantText.trim() || plainStdout.trim(),
            stderr,
            error: 'ACP_PROTOCOL_ERROR',
            message: promptFailure
          },
          'protocol'
        );
      }
    };

    const handleLine = (rawLine: string) => {
      const line = rawLine.replace(/\r$/, '');
      const trimmed = line.trim();
      if (!trimmed) return;

      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            sawJsonRpc = true;
            for (const item of parsed) {
              if (item && typeof item === 'object' && item.jsonrpc === '2.0') {
                handleMessage(item);
              }
            }
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.jsonrpc === '2.0') {
            sawJsonRpc = true;
            handleMessage(parsed);
            return;
          }
        } catch {
          // Not a JSON-RPC frame; fall through to the plain-output path.
        }
      }

      // Plain, non-JSON-RPC output (e.g. `node -e console.log("...")` profiles).
      plainStdout = appendBoundedBuffer(plainStdout, line + '\n');
      callbacks?.onOutput?.('stdout', line + '\n');
    };

    if (child.pid) {
      jobObj!.assignPid(child.pid);
      // Expose pid + graded abort + live steer so a background subagent job can
      // be terminated or steered through it.
      callbacks?.onPid?.(child.pid, () => {
        try {
          cooperativeTerminate('abort');
          return true;
        } catch {
          return false;
        }
      }, steerFn);
    }

    child.stdout?.on('data', (d) => {
      const str = d.toString();
      lastProgressAt = Date.now();
      stdout = appendBoundedBuffer(stdout, str);
      if (promptInArgs) {
        callbacks?.onOutput?.('stdout', str);
        callbacks?.onEvent?.({ kind: 'message_chunk', stream: 'stdout', text: str });
        return;
      }
      if (lineBuffer.length + str.length > MAX_ACP_LINE_CHARS) {
        // R1-M8: Prevent unbounded lineBuffer OOM if child emits multi-MB stream without newline
        const flushed = (lineBuffer + str).slice(0, MAX_ACP_LINE_CHARS);
        lineBuffer = '';
        handleLine(flushed);
        return;
      }
      lineBuffer += str;
      const newlineRe = /\r?\n/;
      let match: RegExpExecArray | null;
      while ((match = newlineRe.exec(lineBuffer)) !== null) {
        const line = lineBuffer.slice(0, match.index);
        lineBuffer = lineBuffer.slice(match.index + match[0].length);
        handleLine(line);
      }
    });

    child.stderr?.on('data', (d) => {
      const str = d.toString();
      lastProgressAt = Date.now();
      stderr = appendBoundedBuffer(stderr, str);
      callbacks?.onOutput?.('stderr', str);
    });

    let observedAcpExitCode: number | null = null;
    child.on('exit', (code) => {
      observedAcpExitCode = code;
    });

    // Hung-handle leak watchdog for one-shot script profiles:
    // stdout end without process close must not hang forever.
    if (promptInArgs) {
      const armHandleWatchdog = () => {
        if (settled || handleWatchdog) return;
        handleWatchdog = setTimeout(() => {
          if (settled) return;
          terminateJob(0);
          if (observedAcpExitCode !== null && observedAcpExitCode !== 0) {
            settle(
              {
                success: false,
                exitCode: observedAcpExitCode,
                stdout,
                stderr,
                output: (plainStdout || stdout).trim(),
                error: `ACP_EXIT_${observedAcpExitCode}`,
                message: `ACP agent '${profile!.id}' exited with code ${observedAcpExitCode}`
              },
              'process-exit'
            );
            return;
          }
          settle(
            { success: true, exitCode: 0, stdout, stderr, output: (plainStdout || stdout).trim() },
            'process-exit'
          );
        }, 5000);
      };
      child.stdout?.on('end', armHandleWatchdog);
      child.stdout?.on('close', armHandleWatchdog);
    }

    const armAcpTimeoutWatchdog = (delayMs: number) => {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        const currentDiskSig = computeWorkspaceActivitySignature(cwd);
        const now = Date.now();
        const elapsed = now - startedAt;
        const diskChanged = currentDiskSig !== lastDiskSig;
        if (diskChanged) {
          lastDiskSig = currentDiskSig;
          lastProgressAt = now;
        }
        const idleSilenceMs = Math.max(0, Date.now() - lastProgressAt);
        if ((diskChanged || idleSilenceMs < Math.floor(baseTimeoutMs * 0.6)) && elapsed < hardMaxTimeoutMs) {
          const nextSliceMs = Math.max(
            50,
            Math.min(baseTimeoutMs - idleSilenceMs, hardMaxTimeoutMs - elapsed)
          );
          callbacks?.onEvent?.({
            kind: 'status',
            stream: 'stdout',
            text: `[ACP Watchdog] Activity detected; extending execution window by ${nextSliceMs}ms (elapsed=${elapsed}ms, hardCap=${hardMaxTimeoutMs}ms)`,
            meta: { elapsedMs: elapsed, nextSliceMs, hardMaxTimeoutMs }
          });
          armAcpTimeoutWatchdog(nextSliceMs);
          return;
        }
        const timeoutKind = elapsed >= hardMaxTimeoutMs ? 'hard_wall_timeout' : 'idle_timeout';
        // Grade the teardown first (cancel -> EOF -> SIGTERM -> Job Object kill),
        // then settle with whatever partial output was captured.
        cooperativeTerminate('timeout');
        settle(
          {
            success: false,
            error: 'TIMEOUT',
            stopReason: stopReason || timeoutKind,
            message: `ACP agent '${profile!.id}' timed out after ${elapsed}ms (${timeoutKind}; idleWindow=${baseTimeoutMs}ms, hardCap=${hardMaxTimeoutMs}ms)`,
            stdout: resolveCleanOutput(),
            timedOut: true
          },
          'timeout'
        );
      }, delayMs);
    };
    armAcpTimeoutWatchdog(baseTimeoutMs);

    // Kick off the handshake immediately. The stream stays open for the whole
    // session (JSON-RPC is request/response, not stdin-EOF driven).
    if (!promptInArgs) {
      sendFrame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'muse-win-harness', version: '0.1.0' }
        }
      });
    } else {
      // One-shot template profile: close stdin so the CLI never hangs on input.
      try {
        child.stdin?.end();
      } catch {}
    }

    const clearTeardownTimers = () => {
      if (eofGraceTimer) {
        clearTimeout(eofGraceTimer);
        eofGraceTimer = null;
      }
      if (terminateGraceTimer) {
        clearTimeout(terminateGraceTimer);
        terminateGraceTimer = null;
      }
    };

    child.on('close', (code) => {
      clearTeardownTimers();
      if (promptInArgs) {
        if (settled) return;
        terminateJob(0);
        if (code === 0) {
          settle({
            success: true,
            exitCode: code,
            stdout: sawJsonRpc ? resolveCleanOutput() : stdout,
            stderr,
            output: resolveCleanOutput()
          });
        } else {
          const detail = (stderr || stdout || '').trim().slice(-600);
          settle(
            {
              success: false,
              exitCode: code,
              stdout: sawJsonRpc ? resolveCleanOutput() : stdout,
              stderr,
              output: resolveCleanOutput(),
              error: `ACP_EXIT_${code ?? 'UNKNOWN'}`,
              message: detail
                ? `ACP agent '${profile!.id}' exited with code ${code}: ${detail}`
                : `ACP agent '${profile!.id}' exited with code ${code}`
            },
            'process-exit'
          );
        }
        return;
      }

      // Flush any trailing partial line before deciding the outcome.
      if (lineBuffer.trim()) {
        const tail = lineBuffer;
        lineBuffer = '';
        handleLine(tail);
      }

      if (settled) {
        terminateJob(0);
        return;
      }

      terminateJob(0);

      // 100% backwards compatibility for single-shot script profiles: plain
      // output + exit 0 with no JSON-RPC traffic is a successful run.
      if (!sawJsonRpc) {
        if (code === 0) {
          settle({
            success: true,
            exitCode: 0,
            stdout: plainStdout || stdout,
            stderr,
            output: resolveCleanOutput()
          });
        } else {
          const detail = (stderr || plainStdout || stdout || '').trim().slice(-600);
          settle(
            {
              success: false,
              exitCode: code,
              stdout: plainStdout || stdout,
              stderr,
              output: resolveCleanOutput(),
              error: `ACP_EXIT_${code ?? 'UNKNOWN'}`,
              message: detail
                ? `ACP agent '${profile!.id}' exited with code ${code}: ${detail}`
                : `ACP agent '${profile!.id}' exited with code ${code}`
            },
            'process-exit'
          );
        }
        return;
      }

      if (promptCompleted || (code === 0 && (acpAssistantText.trim() || plainStdout.trim()))) {
        finishPromptRun();
        return;
      }

      settle(
        {
          success: false,
          exitCode: code,
          stdout: resolveCleanOutput(),
          stderr,
          error: `ACP_EXIT_${code ?? 'UNKNOWN'}`,
          message: `ACP agent '${profile!.id}' closed before completing the session (exit ${code})`
        },
        'process-exit'
      );
    });

    child.on('error', (err) => {
      clearTeardownTimers();
      if (settled) return;
      terminateJob(1);
      settle(
        {
          success: false,
          error: 'SPAWN_ERROR',
          message: err.message,
          stdout: resolveCleanOutput(),
          stderr
        },
        'transport'
      );
    });
  });
}

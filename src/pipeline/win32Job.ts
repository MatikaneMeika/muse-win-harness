/**
 * Win32 Job Object and Experimental ACL Sandbox Manager
 * Enforces process tree containment and fail-closed low-integrity boundaries on Windows.
 */

import koffi from 'koffi';
import { execFileSync } from 'node:child_process';

// Load Windows API DLLs
const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');

// Win32 Job Object Constants & Structs
export const JobObjectExtendedLimitInformation = 9;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
export const PROCESS_SET_QUOTA = 0x0100;
export const PROCESS_TERMINATE = 0x0001;
export const SYNCHRONIZE = 0x00100000;
export const PROCESS_ASSIGN_RIGHTS = PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE; // 0x00100101

const IO_COUNTERS = koffi.struct('IO_COUNTERS', {
  ReadOperationCount: 'uint64',
  WriteOperationCount: 'uint64',
  OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64',
  WriteTransferCount: 'uint64',
  OtherTransferCount: 'uint64'
});

const JOBOBJECT_BASIC_LIMIT_INFORMATION = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
  PerProcessUserTimeLimit: 'int64',
  PerJobUserTimeLimit: 'int64',
  LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'size_t',
  MaximumWorkingSetSize: 'size_t',
  ActiveProcessLimit: 'uint32',
  Affinity: 'uintptr_t',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32'
});

const JOBOBJECT_EXTENDED_LIMIT_INFORMATION = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
  BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
  IoInfo: IO_COUNTERS,
  ProcessMemoryLimit: 'size_t',
  JobMemoryLimit: 'size_t',
  PeakProcessMemoryLimit: 'size_t',
  PeakJobMemoryLimit: 'size_t'
});

// Bind kernel32 functions
const CreateJobObjectW = kernel32.func('CreateJobObjectW', 'void *', ['void *', 'str16']);
const SetInformationJobObject = kernel32.func('SetInformationJobObject', 'bool', [
  'void *',
  'int',
  koffi.pointer(JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
  'uint32'
]);
const AssignProcessToJobObject = kernel32.func('AssignProcessToJobObject', 'bool', ['void *', 'void *']);
const OpenProcess = kernel32.func('OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
const TerminateJobObject = kernel32.func('TerminateJobObject', 'bool', ['void *', 'uint32']);
const CloseHandle = kernel32.func('CloseHandle', 'bool', ['void *']);
const GetCurrentProcess = kernel32.func('GetCurrentProcess', 'void *', []);

// Bind advapi32 functions
const OpenProcessToken = advapi32.func('OpenProcessToken', 'bool', [
  'void *',
  'uint32',
  koffi.out(koffi.pointer('void *'))
]);
const CreateRestrictedToken = advapi32.func('CreateRestrictedToken', 'bool', [
  'void *',
  'uint32',
  'uint32',
  'void *',
  'uint32',
  'void *',
  'uint32',
  'void *',
  koffi.out(koffi.pointer('void *'))
]);

/** P2-R2: best-effort PID liveness check (signal 0 does not actually signal). */
function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** P2-R2: synchronous sleep via Atomics.wait (bounded, main thread safe in Node). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Win32 Job Object Wrapper
 * Ensures spawned processes and their children are terminated on job close or timeout.
 */
export class Win32JobObject {
  private hJob: any = null;
  private closed = false;
  private pids: Set<number> = new Set();

  constructor(jobName?: string) {
    this.hJob = CreateJobObjectW(null, jobName ? jobName : null);
    if (!this.hJob) {
      throw new Error('Failed to create Win32 Job Object via CreateJobObjectW');
    }

    // P2 hardening: structural size self-check BEFORE any SetInformationJobObject
    // call. A silently wrong struct size would corrupt LimitFlags writes (e.g.
    // dropping KILL_ON_JOB_CLOSE) without any error surfaced by the API. On
    // 8-byte-pointer architectures the expected size is 144 bytes.
    const structSize = koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION);
    const pointerSize = process.arch === 'ia32' ? 4 : 8;
    const expectedSize = pointerSize === 8 ? 144 : 112;
    if (structSize !== expectedSize) {
      CloseHandle(this.hJob);
      this.hJob = null;
      throw new Error(
        `JOB_OBJECT_STRUCT_SIZE_MISMATCH: JOBOBJECT_EXTENDED_LIMIT_INFORMATION is ${structSize} bytes, expected ${expectedSize} on ${process.arch} — refusing to run with a possibly corrupted Job Object layout`
      );
    }

    const info = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0,
        PerJobUserTimeLimit: 0,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0
      },
      IoInfo: {
        ReadOperationCount: 0,
        WriteOperationCount: 0,
        OtherOperationCount: 0,
        ReadTransferCount: 0,
        WriteTransferCount: 0,
        OtherTransferCount: 0
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryLimit: 0,
      PeakJobMemoryLimit: 0
    };

    const success = SetInformationJobObject(
      this.hJob,
      JobObjectExtendedLimitInformation,
      info,
      koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)
    );

    if (!success) {
      CloseHandle(this.hJob);
      this.hJob = null;
      throw new Error('Failed to set JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE on Job Object');
    }

    // P2-R2: field round-trip self-check — completes immediately after the
    // single configuration SetInformationJobObject above and BEFORE the Job
    // Object handle is ever used (assignPid). This catches silent ABI
    // corruption that a pure size check can miss.
    try {
      const QueryInformationJobObject = kernel32.func(
        'QueryInformationJobObject',
        'bool',
        [
          'void *',
          'int',
          koffi.out(koffi.pointer(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)),
          'uint32',
          koffi.out(koffi.pointer('uint32'))
        ]
      );
      const returnLength = [0];
      // koffi fills the passed object in place for out struct pointers; the
      // function return value is the BOOL success flag.
      const readBackInfo = {
        BasicLimitInformation: {
          PerProcessUserTimeLimit: 0,
          PerJobUserTimeLimit: 0,
          LimitFlags: 0,
          MinimumWorkingSetSize: 0,
          MaximumWorkingSetSize: 0,
          ActiveProcessLimit: 0,
          Affinity: 0,
          PriorityClass: 0,
          SchedulingClass: 0
        },
        IoInfo: {
          ReadOperationCount: 0,
          WriteOperationCount: 0,
          OtherOperationCount: 0,
          ReadTransferCount: 0,
          WriteTransferCount: 0,
          OtherTransferCount: 0
        },
        ProcessMemoryLimit: 0,
        JobMemoryLimit: 0,
        PeakProcessMemoryLimit: 0,
        PeakJobMemoryLimit: 0
      };
      const queryOk = QueryInformationJobObject(
        this.hJob,
        JobObjectExtendedLimitInformation,
        readBackInfo,
        koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
        returnLength
      );
      const readFlags = readBackInfo.BasicLimitInformation?.LimitFlags;
      if (!queryOk || readFlags !== JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) {
        throw new Error(
          `LimitFlags read-back mismatch: expected ${JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE}, got ${
            queryOk ? readFlags : 'QueryInformationJobObject failed'
          }`
        );
      }
    } catch (err: any) {
      CloseHandle(this.hJob);
      this.hJob = null;
      throw new Error(
        `JOB_OBJECT_SELF_CHECK_FAILED: Job Object LimitFlags round-trip verification failed: ${err?.message || err}`
      );
    }
  }

  /**
   * Assigns a running process ID to the Job Object.
   */
  public assignPid(pid: number): boolean {
    if (this.closed || !this.hJob) return false;

    const hProcess = OpenProcess(PROCESS_ASSIGN_RIGHTS, false, pid);
    if (!hProcess) {
      return false;
    }

    try {
      const assigned = AssignProcessToJobObject(this.hJob, hProcess);
      if (assigned) {
        this.pids.add(pid);
      }
      return assigned;
    } finally {
      CloseHandle(hProcess);
    }
  }

  /**
   * Terminates the entire process tree associated with this Job Object.
   *
   * P2-R2: the Job handle is NOT closed until every recorded pid is verifiably
   * dead (bounded wait, then the handle stays open with KILL_ON_JOB_CLOSE as
   * backstop so a later abort can retry). A terminate on an already-closed Job
   * still runs taskkill /F /T against the recorded pids instead of silently
   * pretending the tree was handled.
   */
  public terminate(exitCode = 1): void {
    if (this.closed || !this.hJob) {
      // P2-R2: already closed — still belt-and-suspenders kill recorded pids.
      for (const pid of this.pids) {
        try {
          execFileSync('taskkill', ['/F', '/T', '/PID', pid.toString()], {
            windowsHide: true,
            stdio: 'ignore'
          });
        } catch {
          // Already dead or access denied
        }
      }
      return;
    }

    try {
      TerminateJobObject(this.hJob, exitCode);
    } catch {
      // Termination failure handled by the liveness verification below
    }

    // Belt-and-suspenders fallback: run taskkill for known assigned PIDs
    for (const pid of this.pids) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', pid.toString()], {
          windowsHide: true,
          stdio: 'ignore'
        });
      } catch {
        // Already dead or access denied
      }
    }

    // P2-R2: verify death BEFORE closing the handle (bounded ~1s).
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !this.allPidsDead()) {
      sleepSync(50);
    }

    if (this.allPidsDead()) {
      CloseHandle(this.hJob);
      this.hJob = null;
      this.closed = true;
    }
    // else: keep the handle open; KILL_ON_JOB_CLOSE guarantees cleanup on
    // process exit and a later terminate/abort can retry the kill.
  }

  /** P2-R2: true when no recorded pid is alive (vacuously true with no pids). */
  private allPidsDead(): boolean {
    for (const pid of this.pids) {
      if (isPidAlive(pid)) {
        return false;
      }
    }
    return true;
  }

  public getHandle(): any {
    return this.hJob;
  }

  public isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Mode 3 (workspace-acl-experimental) helper
 * Strictly Fail-Closed: Never silently falls back if token or ACL setup fails.
 */
export class ExperimentalAclSandbox {
  /**
   * Enforces low integrity level on target directory.
   * Throws immediately if unsupported or failing.
   */
  public static initializeWorkspace(dir: string): void {
    if (process.platform !== 'win32') {
      throw new Error('FAIL_CLOSED_ACL_SANDBOX_INIT_FAILED: Platform is not win32');
    }

    // Verify token restriction capability via advapi32
    try {
      const hProcess = GetCurrentProcess();
      const tokenPtr = [null];
      const ok = OpenProcessToken(hProcess, 0x0002 | 0x0008 | 0x0001, tokenPtr);
      if (!ok || !tokenPtr[0]) {
        throw new Error('Failed to open process token for verification');
      }

      const restrictedTokenPtr = [null];
      const res = CreateRestrictedToken(tokenPtr[0], 1, 0, null, 0, null, 0, null, restrictedTokenPtr);
      if (tokenPtr[0]) CloseHandle(tokenPtr[0]);

      if (!res || !restrictedTokenPtr[0]) {
        throw new Error('Failed to create restricted token');
      }
      if (restrictedTokenPtr[0]) CloseHandle(restrictedTokenPtr[0]);
    } catch (err: any) {
      throw new Error(`FAIL_CLOSED_ACL_SANDBOX_INIT_FAILED: Win32 token restriction check failed: ${err.message}`);
    }

    // Apply low integrity level to workspace directory
    try {
      execFileSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)L'], {
        windowsHide: true,
        stdio: 'pipe'
      });
    } catch (err: any) {
      throw new Error(`FAIL_CLOSED_ACL_SANDBOX_INIT_FAILED: icacls command failed on ${dir}: ${err.message}`);
    }
  }

  /**
   * Restores normal medium integrity level on directory.
   */
  public static restoreAcl(dir: string): void {
    try {
      execFileSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)Medium'], {
        windowsHide: true,
        stdio: 'pipe'
      });
    } catch {
      // Best-effort cleanup
    }
  }
}

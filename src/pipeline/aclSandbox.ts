/**
 * ACL Sandbox Manager for workspace-acl-experimental (Mode 3)
 * Strictly Fail-Closed: Never silently falls back to workspace-write if token or icacls setup fails.
 *
 * P2 hardening:
 * - checkSandboxCapability() performs an HONEST capability self-check for the
 *   "restricted token + integrity level" closed loop required by Mode 3.
 *   applyLowIntegrityAcl/restoreMediumIntegrityAcl remain as AUXILIARY helpers
 *   (they only set directory integrity ACLs — the gate4 function-level test
 *   depends on them) but a directory ACL alone is NOT a sandbox: the harness
 *   cannot yet spawn child processes under a restricted token (Node
 *   child_process provides no token parameter), so the closed loop cannot be
 *   demonstrated and the self-check must FAIL. PipelineKernel treats any
 *   failure as MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED and keeps the previous
 *   confinement mode.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import koffi from 'koffi';

export class AclSandboxManager {
  /**
   * P2: honest Mode 3 capability self-check (never silently degrades).
   * Verifies the individual primitives that ARE implementable today
   * (platform, restricted-token creation, icacls availability) and then
   * requires the closed-loop capability: launching child processes under the
   * restricted token with the target integrity level. That primitive is not
   * wired into the harness's process creation path, so the self-check
   * currently reports unavailable — Mode 3 switching fails closed.
   */
  public static checkSandboxCapability(): { available: boolean; reason: string } {
    if (process.platform !== 'win32') {
      return { available: false, reason: 'Platform is not win32' };
    }

    // Primitive 1: restricted-token creation (real probe, not a stub).
    try {
      const kernel32 = koffi.load('kernel32.dll');
      const advapi32 = koffi.load('advapi32.dll');

      const GetCurrentProcess = kernel32.func('GetCurrentProcess', 'void *', []);
      const CloseHandle = kernel32.func('CloseHandle', 'bool', ['void *']);
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

      const hProcess = GetCurrentProcess();
      const tokenPtr = [null];
      const ok = OpenProcessToken(hProcess, 0x0002 | 0x0008 | 0x0001, tokenPtr);
      if (!ok || !tokenPtr[0]) {
        throw new Error('OpenProcessToken failed');
      }

      const restrictedTokenPtr = [null];
      const res = CreateRestrictedToken(
        tokenPtr[0],
        1,
        0,
        null,
        0,
        null,
        0,
        null,
        restrictedTokenPtr
      );
      if (tokenPtr[0]) CloseHandle(tokenPtr[0]);

      if (!res || !restrictedTokenPtr[0]) {
        throw new Error('CreateRestrictedToken failed');
      }
      if (restrictedTokenPtr[0]) CloseHandle(restrictedTokenPtr[0]);
    } catch (err: any) {
      return {
        available: false,
        reason: `Win32 token restriction check failed: ${err?.message || err}`
      };
    }

    // Primitive 2: icacls availability (real probe on a readable directory).
    try {
      execFileSync('icacls', [os.tmpdir()], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err: any) {
      return {
        available: false,
        reason: `icacls is unavailable or failed: ${err?.message || err}`
      };
    }

    // Closed loop requirement: spawn child processes under the restricted
    // token with the target integrity level and verify enforcement. The
    // harness's only process creation path (node child_process) cannot accept
    // a restricted token, so the closed loop can never be demonstrated here.
    // Honest verdict: NOT available — Mode 3 must fail closed.
    return {
      available: false,
      reason:
        'MODE3_SANDBOX_CAPABILITY_INCOMPLETE: restricted-token child spawn is not wired into the harness process creation path (node child_process has no token parameter), so the restricted-token + integrity-level closed loop cannot be demonstrated; failing closed per spec'
    };
  }

  /**
   * Applies Low Integrity Level ACL to target directory.
   * Throws ACL_SANDBOX_INIT_FAILED_FAIL_CLOSED if token checks or icacls fails.
   *
   * P2 note: AUXILIARY helper only — setting a directory integrity ACL is not
   * a complete sandbox (no restricted-token child spawn). Kept because the
   * gate4 function-level test depends on it; Mode 3 gating goes through
   * checkSandboxCapability() instead.
   */
  public static applyLowIntegrityAcl(targetDir: string): void {
    if (process.platform !== 'win32') {
      throw new Error('ACL_SANDBOX_INIT_FAILED_FAIL_CLOSED: Platform is not win32');
    }

    try {
      const kernel32 = koffi.load('kernel32.dll');
      const advapi32 = koffi.load('advapi32.dll');

      const GetCurrentProcess = kernel32.func('GetCurrentProcess', 'void *', []);
      const CloseHandle = kernel32.func('CloseHandle', 'bool', ['void *']);
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

      const hProcess = GetCurrentProcess();
      const tokenPtr = [null];
      const ok = OpenProcessToken(hProcess, 0x0002 | 0x0008 | 0x0001, tokenPtr);
      if (!ok || !tokenPtr[0]) {
        throw new Error('OpenProcessToken failed');
      }

      const restrictedTokenPtr = [null];
      const res = CreateRestrictedToken(
        tokenPtr[0],
        1,
        0,
        null,
        0,
        null,
        0,
        null,
        restrictedTokenPtr
      );
      if (tokenPtr[0]) CloseHandle(tokenPtr[0]);

      if (!res || !restrictedTokenPtr[0]) {
        throw new Error('CreateRestrictedToken failed');
      }
      if (restrictedTokenPtr[0]) CloseHandle(restrictedTokenPtr[0]);
    } catch (err: any) {
      throw new Error(
        `ACL_SANDBOX_INIT_FAILED_FAIL_CLOSED: Win32 token restriction check failed: ${err.message}`
      );
    }

    try {
      execFileSync('icacls', [targetDir, '/setintegritylevel', '(OI)(CI)Low'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err: any) {
      throw new Error(
        `ACL_SANDBOX_INIT_FAILED_FAIL_CLOSED: icacls execution failed on ${targetDir}: ${err.message}`
      );
    }
  }

  /**
   * Restores normal Medium Integrity Level ACL to target directory.
   */
  public static restoreMediumIntegrityAcl(targetDir: string): void {
    try {
      execFileSync('icacls', [targetDir, '/setintegritylevel', '(OI)(CI)Medium'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      // Best-effort cleanup
    }
  }
}

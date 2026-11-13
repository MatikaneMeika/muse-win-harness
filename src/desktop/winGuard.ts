/**
 * WinGuard — Native Desktop Security Fence
 * - Protected Window Registry (MWH shell, approval island, self PID)
 * - Sensitive Process Blacklist (UAC, CredentialUI, TaskMgr, RegEdit, Password Managers)
 * - Dual interception by HWND/PID and Screen Coordinate (WindowFromPoint)
 * - Screenshot in-memory rectangle redaction
 * - Physical user input preemption detection (GetLastInputInfo)
 */

import {
  getLastInputIdleMs,
  getProcessNameByPid,
  getWindowPid,
  getWindowRect,
  getWindowText,
  listRedactionCandidates,
  windowFromPoint,
  type WinRect
} from './win32Native.js';

export const SENSITIVE_PROCESS_BLACKLIST = new Set<string>([
  'consent.exe',
  'credentialuibroker.exe',
  'logonui.exe',
  'lockapp.exe',
  'taskmgr.exe',
  'regedit.exe',
  'mmc.exe',
  'keepass.exe',
  'keepassxc.exe',
  '1password.exe',
  'bitwarden.exe',
  'enpass.exe',
  'lastpass.exe',
  'lsass.exe',
  'csrss.exe',
  'winlogon.exe'
]);

const PROTECTED_TITLE_PATTERNS = [
  /Muse-Win-Harness/i,
  /MWH Approval/i,
  /MWH 安全审批请求/i,
  /安全确认\s*·\s*Security Confirmation/i
];

export class WinGuard {
  private static protectedHwnds = new Set<number>();
  private static protectedPids = new Set<number>([process.pid]);

  public static registerProtectedHwnd(hwnd: number): void {
    if (Number.isFinite(hwnd) && hwnd > 0) {
      this.protectedHwnds.add(Math.trunc(hwnd));
      const pid = getWindowPid(Math.trunc(hwnd));
      if (pid > 0) this.protectedPids.add(pid);
    }
  }

  public static registerProtectedPid(pid: number): void {
    if (Number.isFinite(pid) && pid > 0) {
      this.protectedPids.add(Math.trunc(pid));
    }
  }

  public static unregisterProtectedHwnd(hwnd: number): void {
    this.protectedHwnds.delete(Math.trunc(hwnd));
  }

  public static getProtectedRegistrySnapshot(): { hwnds: number[]; pids: number[] } {
    return {
      hwnds: [...this.protectedHwnds],
      pids: [...this.protectedPids]
    };
  }

  public static isProtectedOrSensitiveWindow(hwnd: number, pid?: number, processName?: string, title?: string): string | null {
    if (hwnd > 0 && this.protectedHwnds.has(hwnd)) {
      return `Protected MWH window (hwnd=${hwnd})`;
    }
    const resolvedPid = pid ?? (hwnd > 0 ? getWindowPid(hwnd) : 0);
    if (resolvedPid > 0 && this.protectedPids.has(resolvedPid)) {
      return `Protected MWH process (pid=${resolvedPid})`;
    }
    const resolvedProc = (processName ?? (resolvedPid > 0 ? getProcessNameByPid(resolvedPid) : '')).toLowerCase();
    if (resolvedProc && SENSITIVE_PROCESS_BLACKLIST.has(resolvedProc)) {
      return `Sensitive system/security process blocked (${resolvedProc})`;
    }
    const resolvedTitle = title ?? (hwnd > 0 ? getWindowText(hwnd) : '');
    if (resolvedTitle && PROTECTED_TITLE_PATTERNS.some((re) => re.test(resolvedTitle))) {
      return `Protected MWH UI window (${resolvedTitle})`;
    }
    return null;
  }

  public static assertTargetAllowed(target: { hwnd?: number; x?: number; y?: number }): void {
    if (typeof target.hwnd === 'number' && target.hwnd > 0) {
      const reason = this.isProtectedOrSensitiveWindow(target.hwnd);
      if (reason) {
        throw new Error(`DESKTOP_GUARD_BLOCKED: ${reason}`);
      }
    }
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      const hit = windowFromPoint(target.x, target.y);
      const reason = this.isProtectedOrSensitiveWindow(
        hit.rootHwnd || hit.hwnd,
        hit.pid,
        hit.processName,
        hit.title
      );
      if (reason) {
        throw new Error(`DESKTOP_GUARD_BLOCKED: Coordinate (${target.x}, ${target.y}) lands on ${reason}`);
      }
    }
  }

  public static getRedactionRects(excludeTargetHwnd?: number): WinRect[] {
    const windows = listRedactionCandidates();
    const rects: WinRect[] = [];
    for (const w of windows) {
      if (excludeTargetHwnd && w.hwnd === excludeTargetHwnd) continue;
      if (this.isProtectedOrSensitiveWindow(w.hwnd, w.pid, w.processName, w.title)) {
        rects.push(w.rect);
      }
    }
    return rects;
  }

  public static assertNoUserPreemption(thresholdMs = 1500): void {
    const idleMs = getLastInputIdleMs();
    if (idleMs < thresholdMs) {
      throw new Error(
        `USER_INPUT_PREEMPTED: Physical user input detected ${idleMs}ms ago (< ${thresholdMs}ms); foreground action paused.`
      );
    }
  }
}

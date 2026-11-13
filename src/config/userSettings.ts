/**
 * Machine-local UI preferences that must survive a daemon relaunch.
 * Stored at `.mwh/settings.json` (gitignored). No secrets belong here.
 * Unknown keys are ignored; a missing or corrupt file fails closed to defaults.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface UserSettings {
  /** Defer non-HMAC approvals to Muse official HITL cards. Default off. */
  multiDeviceApproval: boolean;
  /** Enable native Windows desktop automation (`desktop_hands`). Default off. */
  desktopHandsEnabled: boolean;
  /** Allow foreground SendInput fallback when background delivery is unavailable. Default off. */
  desktopHandsForegroundFallback: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  multiDeviceApproval: false,
  desktopHandsEnabled: false,
  desktopHandsForegroundFallback: false
};

export function userSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.mwh', 'settings.json');
}

export function loadUserSettings(workspaceRoot: string): UserSettings {
  const file = userSettingsPath(workspaceRoot);
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_USER_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      multiDeviceApproval: raw?.multiDeviceApproval === true,
      desktopHandsEnabled: raw?.desktopHandsEnabled === true,
      desktopHandsForegroundFallback: raw?.desktopHandsForegroundFallback === true
    };
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

export function saveUserSettings(
  workspaceRoot: string,
  patch: Partial<UserSettings>
): UserSettings {
  const current = loadUserSettings(workspaceRoot);
  const next: UserSettings = {
    multiDeviceApproval:
      patch.multiDeviceApproval !== undefined
        ? patch.multiDeviceApproval === true
        : current.multiDeviceApproval,
    desktopHandsEnabled:
      patch.desktopHandsEnabled !== undefined
        ? patch.desktopHandsEnabled === true
        : current.desktopHandsEnabled,
    desktopHandsForegroundFallback:
      patch.desktopHandsForegroundFallback !== undefined
        ? patch.desktopHandsForegroundFallback === true
        : current.desktopHandsForegroundFallback
  };
  const dir = path.join(workspaceRoot, '.mwh');
  fs.mkdirSync(dir, { recursive: true });
  const file = userSettingsPath(workspaceRoot);
  const tmp = file + '.' + String(process.pid) + '.tmp';
  const body = JSON.stringify(next, null, 2) + '\n';
  fs.writeFileSync(tmp, body, { encoding: 'utf-8' });
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, body, { encoding: 'utf-8' });
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore leftover tmp
    }
  }
  return next;
}

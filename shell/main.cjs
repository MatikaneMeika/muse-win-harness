/**
 * Electron desktop shell (BrowserWindow + embedded BrowserView).
 * The frameless main window loads shell/chrome.html (32px custom titlebar),
 * and embeds a BrowserView loading https://muse.ai with muse-settings-preload.cjs
 * to render the local MWH settings drawer and floating approval island.
 */

const { app, BrowserWindow, BrowserView, ipcMain, Notification, Tray, Menu, nativeImage, session, screen, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

// --- Win32 / DWM Native Bindings (koffi) for H1 Pixel-Exact Sync & Caption Strip ---
let win32 = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('MWH_RECT', {
    left: 'int32',
    top: 'int32',
    right: 'int32',
    bottom: 'int32',
  });
  const POINT = koffi.struct('MWH_POINT', {
    x: 'int32',
    y: 'int32',
  });
  win32 = {
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ MWH_RECT* rect)'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(intptr_t hwnd, _Out_ MWH_RECT* rect)'),
    ClientToScreen: user32.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ MWH_POINT* pt)'),
    GetWindowLongW: user32.func('int32 __stdcall GetWindowLongW(intptr_t hwnd, int32 idx)'),
    GetDpiForWindow: user32.func('uint32 __stdcall GetDpiForWindow(intptr_t hwnd)'),
    DwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ MWH_RECT* rect, uint32 cb)'),
    DwmSetWindowAttributeU32: dwmapi.func('int32 __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32 attr, const uint32* val, uint32 cb)'),
  };
} catch {
  win32 = null;
}

const GWL_STYLE = -16;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_BORDER_COLOR = 34;
const DWMWA_COLOR_NONE = 0xFFFFFFFE;

function getHwndBuf(win) {
  if (!win || win.isDestroyed()) return 0;
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || buf.length === 0) return 0;
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch {
    return 0;
  }
}

/**
 * H1 Root-Cause Fix:
 * 1) Strip WS_CAPTION (0x00C00000 = WS_BORDER | WS_DLGFRAME) and WS_SYSMENU from main window
 *    so Windows 11 DWM never reserves or paints a 1px/6px top caption border (#68768a).
 * 2) Explicitly set DWMWA_BORDER_COLOR (34) = DWMWA_COLOR_NONE (0xFFFFFFFE) to suppress
 *    the Windows 11 DWM top highlight border on frameless windows.
 * 3) Synchronize the DWM caption / text colors with the live theme state so the native
 *    frame never flashes a stale light strip over the dark surface.
 */
const DWMWA_CAPTION_COLOR = 35;
const DWMWA_TEXT_COLOR = 36;

let currentThemeDark = true;

const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'ja', 'en'];
function normalizeLocale(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return 'en';
  if (s === 'zh-tw' || s === 'zh-hk' || s === 'zh-mo' || s.startsWith('zh-hant')) return 'zh-TW';
  if (s.startsWith('zh')) return 'zh-CN';
  if (s.startsWith('ja')) return 'ja';
  return 'en';
}
let currentLang = 'en';

const TRAY_LABELS = {
  'zh-CN': {
    show: '显示主窗口',
    hide: '关闭窗口（保持宿主运行）',
    quit: '退出（停止宿主与隧道）',
  },
  'zh-TW': {
    show: '顯示主視窗',
    hide: '關閉視窗（保持宿主執行）',
    quit: '結束（停止宿主與隧道）',
  },
  ja: {
    show: 'ウィンドウを表示',
    hide: 'ウィンドウを閉じる（ホストは継続）',
    quit: '終了（ホストとトンネルを停止）',
  },
  en: {
    show: 'Show Window',
    hide: 'Close Window (keep daemon running)',
    quit: 'Quit (stop daemon & tunnel)',
  },
};

function updateTrayMenu(lang = currentLang) {
  if (!tray) return;
  const labels = TRAY_LABELS[SUPPORTED_LOCALES.includes(lang) ? lang : 'en'] || TRAY_LABELS.en;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: () => showWindow() },
      { label: labels.hide, click: () => hideMainWindowToTray('tray_menu_close_window') },
      { label: labels.quit, click: () => quitFromTray('tray_menu_click') },
    ])
  );
}

function applyDwmTheme(win, dark = currentThemeDark) {
  if (!win32 || process.platform !== 'win32') return;
  if (!win || win.isDestroyed()) return;
  const hwnd = getHwndBuf(win);
  if (!hwnd) return;
  try {
    currentThemeDark = dark;
    win32.DwmSetWindowAttributeU32(hwnd, DWMWA_BORDER_COLOR, [DWMWA_COLOR_NONE], 4);
    const captionColor = dark ? 0x00151312 : 0x00F5F4F4;
    win32.DwmSetWindowAttributeU32(hwnd, DWMWA_CAPTION_COLOR, [captionColor], 4);
    const textColor = dark ? 0x00ECECEE : 0x001A1A1A;
    win32.DwmSetWindowAttributeU32(hwnd, DWMWA_TEXT_COLOR, [textColor], 4);
  } catch {
    // ignore native theme adjustment failure
  }
}

function hardenFramelessHwnd(win) {
  if (!win32 || process.platform !== 'win32') return;
  const hwnd = getHwndBuf(win);
  if (!hwnd) return;
  applyDwmTheme(win, currentThemeDark);
}

/**
 * Measure physical Win32 window & client rect geometry for the main window (H1 forensics).
 */
function measureDualWindowGeometry() {
  if (!win32 || process.platform !== 'win32') return null;
  const probeOne = (win) => {
    const hwnd = getHwndBuf(win);
    if (!hwnd) return null;
    const wr = { left: 0, top: 0, right: 0, bottom: 0 };
    const cr = { left: 0, top: 0, right: 0, bottom: 0 };
    const dwm = { left: 0, top: 0, right: 0, bottom: 0 };
    const pt = { x: 0, y: 0 };
    win32.GetWindowRect(hwnd, wr);
    win32.GetClientRect(hwnd, cr);
    win32.ClientToScreen(hwnd, pt);
    const hrDwm = win32.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, dwm, 16);
    const dpi = win32.GetDpiForWindow(hwnd);
    const style = win32.GetWindowLongW(hwnd, GWL_STYLE);
    return {
      dpi,
      scaleFactor: Number((dpi / 96).toFixed(4)),
      gwlStyleHex: '0x' + (style >>> 0).toString(16),
      dipBounds: win.getBounds(),
      windowRect: { ...wr, width: wr.right - wr.left, height: wr.bottom - wr.top },
      clientScreenRect: {
        left: pt.x,
        top: pt.y,
        right: pt.x + (cr.right - cr.left),
        bottom: pt.y + (cr.bottom - cr.top),
        width: cr.right - cr.left,
        height: cr.bottom - cr.top,
      },
      dwmExtendedFrameBounds: { ...dwm, width: dwm.right - dwm.left, height: dwm.bottom - dwm.top, hr: hrDwm },
    };
  };
  const m = probeOne(mainWindow);
  if (!m) return null;
  return {
    timestamp: new Date().toISOString(),
    mainWindow: m,
  };
}

function getCurrentGitBranch() {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'main';
  } catch {
    return 'main';
  }
}
const CURRENT_BRANCH = getCurrentGitBranch();
const DAEMON_PORT = Number(process.env.MWH_PORT || 19820);
const MAIN_URL = process.env.MWH_MUSE_URL || 'https://muse.ai';
const ROOT_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT_DIR, '.mwh', 'logs');
const EXIT_REASON_LOG_PATH = path.join(LOG_DIR, 'exit-reason.log');
const SMOKE = process.argv.includes('--smoke-test') || process.argv.includes('--smoke');
const TEST_TRAY_QUIT = process.argv.includes('--test-tray-quit');
// Preflight-only mode: ensure the daemon is up and authenticated, then exit
// without creating a window. Used by MWH启动.cmd so a dead daemon can never
// masquerade as a live desktop shell.
const ENSURE_DAEMON_ONLY = process.argv.includes('--ensure-daemon-only');

// --- H5 Exit Reason Forensic Audit Logger ---
// Enumerated Exit Call Sites in shell/main.cjs:
//   [Site #1] quitFromTray(trigger) -> app.quit() (User clicks Tray 'Quit' or --test-tray-quit)
//   [Site #2] SMOKE 30s watchdog timeout -> app.exit(1)
//   [Site #3] SMOKE ready finish -> app.quit()
//   [Site #4] TEST_TRAY_QUIT 15s watchdog timeout -> app.exit(3)
//   [Site #5] app.on('window-all-closed') when SMOKE -> app.quit()
//   [Site #6] ENSURE_DAEMON_ONLY preflight finish -> app.exit(0 | 2)
let shellExitReasonRecorded = false;
let currentExitReason = 'unknown_exit';
let currentExitTrigger = 'unspecified';
let isQuitting = false;
let uncaughtHandling = false;

let ownedDaemon = null;
let stopOwnedDaemonPromise = null;
// Last structured outcome of ensureDaemon(); surfaced to the chrome shell so it
// can show an honest "daemon not connected" banner instead of a fake ready state.
let lastDaemonStatus = null;

function recordShellExitReason(reason, trigger, extra = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      process: 'shell',
      pid: process.pid,
      reason: String(reason || 'unknown_exit'),
      trigger: String(trigger || 'unspecified'),
      ...extra,
    };
    fs.appendFileSync(EXIT_REASON_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
    shellExitReasonRecorded = true;
    currentExitReason = entry.reason;
    currentExitTrigger = entry.trigger;
  } catch {
    // ignore logging failure
  }
}

function recordShellNonFatal(reason, trigger, extra = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      process: 'shell',
      pid: process.pid,
      reason: String(reason || 'unknown_non_fatal'),
      trigger: String(trigger || 'unspecified'),
      terminal: false,
      ...extra,
    };
    fs.appendFileSync(EXIT_REASON_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // ignore logging failure
  }
}

function recordDaemonExitReasonFromShell(reason, trigger, daemonPid, extra = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      process: 'daemon',
      pid: daemonPid || null,
      reason: String(reason || 'unknown_exit'),
      trigger: String(trigger || 'shell_stop_owned_daemon'),
      ...extra,
    };
    fs.appendFileSync(EXIT_REASON_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // ignore
  }
}

function stopOwnedDaemon(reason = currentExitReason, trigger = currentExitTrigger) {
  if (stopOwnedDaemonPromise) {
    return stopOwnedDaemonPromise;
  }
  if (!ownedDaemon || ownedDaemon.killed || ownedDaemon.exitCode !== null) {
    ownedDaemon = null;
    return Promise.resolve();
  }

  isQuitting = true;
  const proc = ownedDaemon;
  const daemonPid = proc.pid;

  stopOwnedDaemonPromise = new Promise((resolve) => {
    let timer = null;
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      proc.removeListener('exit', onExit);
      ownedDaemon = null;
      stopOwnedDaemonPromise = null;
      resolve();
    };

    const onExit = () => {
      cleanup();
    };

    proc.once('exit', onExit);

    if (proc.exitCode !== null || proc.killed) {
      cleanup();
      return;
    }

    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(`__MWH_SHUTDOWN__:${reason}:${trigger}\n`);
        proc.stdin.end();
      }
    } catch {
      // ignore broken pipe
    }

    timer = setTimeout(() => {
      if (finished) return;
      recordDaemonExitReasonFromShell(reason, `${trigger}->forced_terminate`, daemonPid);
      try {
        proc.kill();
      } catch {
        // already gone
      }
      cleanup();
    }, 1500);
  });

  return stopOwnedDaemonPromise;
}

process.on('uncaughtException', async (err) => {
  if (uncaughtHandling) return;
  uncaughtHandling = true;
  isQuitting = true;
  try {
    recordShellExitReason('uncaughtException', 'process.uncaughtException', {
      error: err && err.stack ? String(err.stack) : String(err),
    });
  } catch {
    // ignore logging failure
  }
  try {
    await stopOwnedDaemon('uncaughtException', 'process.uncaughtException');
  } catch {
    // ignore
  }
  try {
    app.exit(1);
  } catch {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  recordShellNonFatal('unhandledRejection', 'process.unhandledRejection', {
    error: reason && reason.stack ? String(reason.stack) : String(reason),
  });
});

// muse voice input needs mic; the rest are standard web platform grants.
const ALLOWED_PERMISSIONS = [
  'media',
  'mediaKeySystem',
  'fullscreen',
  'notifications',
  'pointerLock',
  'clipboard-sanitized-write',
];

let mainWindow = null;
let tray = null;
let lastNotifiedApprovalId = '';
let token = process.env.TUNNEL_RUNTIME_TOKEN || '';
let signingKey = process.env.MWH_HMAC_SECRET || '';
let persistedExtra = {};
const SECRETS_FILE = path.join(__dirname, '..', '.mwh', 'secrets.json');
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let cachedShellDpapi;
function getShellDpapi() {
  if (cachedShellDpapi !== undefined) return cachedShellDpapi;
  if (process.platform !== 'win32') {
    cachedShellDpapi = null;
    return null;
  }
  try {
    const koffi = require('koffi');
    try {
      koffi.struct('MWH_SHELL_DATA_BLOB', {
        cbData: 'uint32',
        pbData: 'void *',
      });
    } catch {}
    const crypt32 = koffi.load('crypt32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const CryptProtectData = crypt32.func(
      'int __stdcall CryptProtectData(MWH_SHELL_DATA_BLOB *pDataIn, const char16_t *szDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ MWH_SHELL_DATA_BLOB *pDataOut)'
    );
    const CryptUnprotectData = crypt32.func(
      'int __stdcall CryptUnprotectData(MWH_SHELL_DATA_BLOB *pDataIn, void *ppszDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ MWH_SHELL_DATA_BLOB *pDataOut)'
    );
    const LocalFree = kernel32.func('void * __stdcall LocalFree(void *hMem)');
    cachedShellDpapi = { koffi, CryptProtectData, CryptUnprotectData, LocalFree };
    return cachedShellDpapi;
  } catch {
    cachedShellDpapi = null;
    return null;
  }
}

function dpapiProtectJsonString(plain) {
  const api = getShellDpapi();
  if (!api) throw new Error('DPAPI_UNAVAILABLE');
  const inBuf = Buffer.from(plain, 'utf-8');
  const outBlob = {};
  const ok = api.CryptProtectData(
    { cbData: inBuf.length, pbData: inBuf },
    'MWH Secrets v2',
    null,
    null,
    null,
    1,
    outBlob
  );
  if (!ok || !outBlob.pbData || !outBlob.cbData) throw new Error('DPAPI_PROTECT_FAILED');
  try {
    return Buffer.from(api.koffi.decode(outBlob.pbData, 'uint8_t', outBlob.cbData)).toString('base64');
  } finally {
    api.LocalFree(outBlob.pbData);
  }
}

function dpapiUnprotectJsonString(b64) {
  const api = getShellDpapi();
  if (!api) throw new Error('DPAPI_UNAVAILABLE');
  const inBuf = Buffer.from(b64, 'base64');
  if (!inBuf.length) throw new Error('DPAPI_EMPTY');
  const outBlob = {};
  const ok = api.CryptUnprotectData(
    { cbData: inBuf.length, pbData: inBuf },
    null,
    null,
    null,
    null,
    1,
    outBlob
  );
  if (!ok || !outBlob.pbData || typeof outBlob.cbData !== 'number') throw new Error('DPAPI_UNPROTECT_FAILED');
  try {
    return Buffer.from(api.koffi.decode(outBlob.pbData, 'uint8_t', outBlob.cbData)).toString('utf-8');
  } finally {
    api.LocalFree(outBlob.pbData);
  }
}

function isValidTokenStr(val) {
  return typeof val === 'string' && val.trim().length >= 16 && val.trim() !== 'undefined' && val.trim() !== 'null';
}

function loadPersistedSecrets() {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const outer = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
      const parsed =
        outer && typeof outer.dpapi === 'string' && outer.dpapi.trim().length > 0
          ? JSON.parse(dpapiUnprotectJsonString(outer.dpapi.trim()))
          : outer;
      if (parsed && isValidTokenStr(parsed.token)) {
        token = parsed.token.trim();
      }
      if (parsed && typeof parsed.signingKey === 'string' && parsed.signingKey.length >= 32) {
        signingKey = parsed.signingKey;
      }
      if (parsed && typeof parsed === 'object') {
        persistedExtra = {
          cookieSecret:
            typeof parsed.cookieSecret === 'string' && parsed.cookieSecret.length >= 32
              ? parsed.cookieSecret
              : persistedExtra.cookieSecret,
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : persistedExtra.createdAt,
          tokenExpiresAt:
            typeof parsed.tokenExpiresAt === 'number' && Number.isFinite(parsed.tokenExpiresAt)
              ? parsed.tokenExpiresAt
              : persistedExtra.tokenExpiresAt,
        };
      }
    }
  } catch {}
}
// Initial load immediately on script execution
loadPersistedSecrets();

function savePersistedSecrets() {
  try {
    const dir = path.dirname(SECRETS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const nowIso = new Date().toISOString();
    const inner = {
      token,
      signingKey,
      cookieSecret: persistedExtra.cookieSecret || crypto.randomBytes(32).toString('hex'),
      createdAt: persistedExtra.createdAt || nowIso,
      updatedAt: nowIso,
      tokenExpiresAt:
        typeof persistedExtra.tokenExpiresAt === 'number' && Number.isFinite(persistedExtra.tokenExpiresAt)
          ? persistedExtra.tokenExpiresAt
          : Date.now() + DEFAULT_TOKEN_TTL_MS,
    };
    persistedExtra = {
      cookieSecret: inner.cookieSecret,
      createdAt: inner.createdAt,
      tokenExpiresAt: inner.tokenExpiresAt,
    };
    const dpapi = dpapiProtectJsonString(JSON.stringify(inner));
    const outerJson = JSON.stringify(
      {
        schema: 'mwh-secrets/v2-dpapi',
        dpapi,
        updatedAt: nowIso,
      },
      null,
      2
    );
    const tmpFile = `${SECRETS_FILE}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpFile, outerJson, 'utf-8');
      fs.renameSync(tmpFile, SECRETS_FILE);
    } catch {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {}
      fs.writeFileSync(SECRETS_FILE, outerJson, 'utf-8');
    }
  } catch {}
}

function ensureSecretsForSpawn() {
  if (!token || !signingKey) {
    loadPersistedSecrets();
  }
  if (!token) {
    token = 'mwh_rt_' + crypto.randomBytes(24).toString('hex');
  }
  if (!signingKey) {
    signingKey = crypto.randomBytes(32).toString('hex');
  }
  savePersistedSecrets();
  process.env.TUNNEL_RUNTIME_TOKEN = token;
  process.env.MWH_HMAC_SECRET = signingKey;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(400, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateProbeOk(probe) {
  return Boolean(
    probe &&
      probe.ok !== false &&
      !probe.error &&
      (probe.confinementMode || probe.daemon || probe.tunnel)
  );
}

/** 端口开着不等于宿主可用。用当前令牌打一次 /api/v1/state，仅 401 时重读 secrets 再试。 */
async function probeDaemonAuth() {
  loadPersistedSecrets();
  const first = await daemonFetch('GET', '/api/v1/state', undefined, 2000);
  if (stateProbeOk(first)) return true;
  if (!(first && first.status === 401)) return false;
  loadPersistedSecrets();
  const second = await daemonFetch('GET', '/api/v1/state', undefined, 2000);
  return stateProbeOk(second);
}

/** Windows-only listener lookup. Any failure returns '' so callers keep the original detail. */
function describePortListener(port) {
  if (process.platform !== 'win32') return '';
  try {
    const netstatOut = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      timeout: 2000,
      encoding: 'utf8',
    });
    const target = `127.0.0.1:${port}`;
    let pid = '';
    for (const raw of String(netstatOut).split(/\r?\n/)) {
      const cols = raw.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[1] || '';
      const state = cols[3] || '';
      if (local === target && /^LISTENING$/i.test(state)) {
        pid = cols[cols.length - 1] || '';
        break;
      }
    }
    if (!/^\d+$/.test(pid)) return '';
    let image = '';
    try {
      const taskOut = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        timeout: 2000,
        encoding: 'utf8',
      });
      const match = String(taskOut).match(/^"([^"]+)"/);
      image = match ? match[1] : '';
    } catch {
      image = '';
    }
    return ` listener pid=${pid} image=${image}`;
  } catch {
    return '';
  }
}

function resolveNodeBin() {
  const fromEnv = process.env.MWH_NODE_EXE || process.env.MWH_NODE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'node';
}

// Result contract, shared by MWH启动.cmd (--ensure-daemon-only) and the chrome banner:
//   { ok: true, adopted: true }   -> adopted an already-running, authenticated daemon
//   { ok: true, adopted: false }  -> this process spawned and verified a daemon
//   { ok: false, reason, detail } -> PORT_OCCUPIED_UNAUTHORIZED | DAEMON_START_TIMEOUT | SPAWN_FAILED
function startDaemonProcess(nodeBin, cli, extraEnv, detachedStdio) {
  const child = spawn(nodeBin, [cli], {
    windowsHide: true,
    cwd: path.resolve(__dirname, '..'),
    detached: Boolean(detachedStdio),
    stdio: detachedStdio ? 'ignore' : ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(extraEnv || {}),
      TUNNEL_RUNTIME_TOKEN: token,
      MWH_HMAC_SECRET: signingKey,
    },
  });
  // Preflight must never pin the daemon's stdio to a process that is about to exit.
  if (detachedStdio) child.unref();
  return child;
}

async function ensureDaemon() {
  loadPersistedSecrets();
  if (await portOpen(DAEMON_PORT)) {
    if (await probeDaemonAuth()) {
      lastDaemonStatus = { ok: true, adopted: true };
      return lastDaemonStatus;
    }
    const detail =
      `127.0.0.1:${DAEMON_PORT} is listening but GET /api/v1/state was rejected. ` +
      `Not starting a second daemon. Inspect the listener with: netstat -ano | findstr :${DAEMON_PORT}` +
      describePortListener(DAEMON_PORT);
    console.error(`[MWH-SHELL] ${detail}`);
    lastDaemonStatus = { ok: false, reason: 'PORT_OCCUPIED_UNAUTHORIZED', detail };
    return lastDaemonStatus;
  }

  ensureSecretsForSpawn();
  const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  let spawnError = null;
  let retriedWithElectron = false;

  const attach = (child) => {
    const spawnedPid = child.pid;
    child.once('error', (error) => {
      spawnError = error;
    });
    if (!ENSURE_DAEMON_ONLY) {
      child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
      child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
      child.on('exit', (code, signal) => {
        if (!isQuitting) {
          recordShellExitReason('daemon_unexpected_exit', 'ownedDaemon.on(exit)', {
            daemonPid: spawnedPid,
            code,
            signal,
          });
        }
      });
    }
    return child;
  };

  ownedDaemon = attach(startDaemonProcess(resolveNodeBin(), cli, null, ENSURE_DAEMON_ONLY));

  // Wall-clock 20s cap: probes have their own timeout so this cannot stretch into minutes.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError && spawnError.code === 'ENOENT' && !retriedWithElectron) {
      retriedWithElectron = true;
      const detail = `spawn '${resolveNodeBin()}' failed with ENOENT; retrying via Electron as Node (ELECTRON_RUN_AS_NODE=1)`;
      console.warn(`[MWH-SHELL] ${detail}`);
      spawnError = null;
      ownedDaemon = attach(
        startDaemonProcess(process.execPath, cli, { ELECTRON_RUN_AS_NODE: '1' }, ENSURE_DAEMON_ONLY)
      );
    }
    if ((await portOpen(DAEMON_PORT)) && (await probeDaemonAuth())) {
      lastDaemonStatus = { ok: true, adopted: false };
      return lastDaemonStatus;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(500, remaining));
  }

  const detail = spawnError
    ? `daemon spawn failed: ${spawnError.code || spawnError.message}`
    : `daemon did not become ready on 127.0.0.1:${DAEMON_PORT} within 20s`;
  console.error(`[MWH-SHELL] ${detail}`);
  lastDaemonStatus = {
    ok: false,
    reason: spawnError ? 'SPAWN_FAILED' : 'DAEMON_START_TIMEOUT',
    detail,
  };
  return lastDaemonStatus;
}

function trayIcon() {
  // Logo source of truth: frontend/public/favicon.svg. After changing the
  // logo, re-rasterize the tray PNG via `node shell/tools/rasterize-tray.cjs`.
  const image = nativeImage.createFromPath(path.join(__dirname, 'resources', 'tray-icon.png'));
  if (image.isEmpty()) {
    console.warn('[shell] tray icon missing or invalid, continuing with empty tray icon');
    return nativeImage.createEmpty();
  }
  return image;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  layoutEmbeddedMuse();
}

function hideMainWindowToTray(trigger = 'tray_menu_close_window') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  recordShellExitReason('main_window_hidden_tray', trigger);
}

// Unified Tray / Test Quit helper ([Site #1])
async function quitFromTray(trigger = 'tray_menu_click') {
  isQuitting = true;
  recordShellExitReason('tray_quit', trigger);
  try {
    await stopOwnedDaemon('tray_quit', trigger);
  } catch {}
  if (lastDaemonStatus && lastDaemonStatus.adopted === true) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/v1/daemon/shutdown`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        signal: ac.signal,
      });
      recordShellExitReason('adopted_daemon_shutdown_post', trigger);
    } catch (err) {
      recordShellExitReason('adopted_daemon_shutdown_post', trigger, {
        detail: err && err.message ? String(err.message) : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  app.quit();
}

function createTray() {
  if (app && typeof app.getLocale === 'function' && currentLang === 'en') {
    currentLang = normalizeLocale(app.getLocale());
  }
  tray = new Tray(trayIcon());
  tray.setToolTip('Muse-Win-Harness');
  updateTrayMenu(currentLang);
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function installAuthInjection() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`http://127.0.0.1:${DAEMON_PORT}/*`, `http://localhost:${DAEMON_PORT}/*`] },
    (details, callback) => {
      if (token) {
        details.requestHeaders.Authorization = 'Bearer ' + token;
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

// Strip the Electron/app tokens from the default UA so muse.ai sees a plain
// Chromium user agent. Keeps the real Chromium version, only drops the markers.
function installPlainUserAgent() {
  const ua = session.defaultSession.getUserAgent();
  session.defaultSession.setUserAgent(
    ua.replace(/ Electron\/\S+/, '').replace(/\s+mwh-desktop-shell\/\S+/, '')
  );
}

function isAllowedPopupHost(hostname) {
  return (
    hostname === 'muse.ai' ||
    hostname.endsWith('.muse.ai') ||
    hostname === 'meta.com' ||
    hostname.endsWith('.meta.com') ||
    hostname === 'facebook.com' ||
    hostname.endsWith('.facebook.com') ||
    hostname === 'instagram.com' ||
    hostname.endsWith('.instagram.com') ||
    hostname === 'stripe.com' ||
    hostname.endsWith('.stripe.com')
  );
}

function installWindowOpenHandler() {
  const contents = museView && !museView.webContents.isDestroyed() ? museView.webContents : mainWindow && mainWindow.webContents;
  if (!contents) return;
  contents.setWindowOpenHandler(({ url }) => {
    // OAuth flows often open a blank window first and navigate it afterwards.
    if (url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          icon: path.join(__dirname, 'resources', 'app-icon-256.png'),
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
          },
        },
      };
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (isAllowedPopupHost(parsed.hostname)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            icon: path.join(__dirname, 'resources', 'app-icon-256.png'),
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        };
      }
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });
}

// G4: Prevent Chromium occlusion / background renderer throttling for dual-window shell
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

/**
 * H1 Pixel-Exact Embedded Muse Layout:
 * The embedded BrowserView is pinned to the mainWindow content area minus the
 * custom 32px title strip; Win32 harden keeps the DWM frame flush.
 */
const TITLE_BAR_HEIGHT = 32;
// Reserved strip for the "daemon not connected" banner rendered by chrome.html.
// The BrowserView is a native layer above the page, so the strip has to be
// carved out of the view bounds instead of being drawn on top of it.
const DAEMON_BANNER_HEIGHT = 28;
let daemonBannerVisible = false;
let museView = null;

function layoutEmbeddedMuse() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const content = mainWindow.getContentBounds();
  const topOffset = TITLE_BAR_HEIGHT + (daemonBannerVisible ? DAEMON_BANNER_HEIGHT : 0);
  const viewBounds = {
    x: 0,
    y: topOffset,
    width: Math.max(1, content.width),
    height: Math.max(1, content.height - topOffset),
  };
  if (museView) museView.setBounds(viewBounds);
  hardenFramelessHwnd(mainWindow);
}

function syncOverlay() {
  layoutEmbeddedMuse();
}

function attachMainWindowSync() {
  if (!mainWindow) return;
  ['move', 'resize', 'focus', 'restore', 'blur'].forEach((event) => {
    mainWindow.on(event, () => layoutEmbeddedMuse());
  });
  mainWindow.on('maximize', () => {
    layoutEmbeddedMuse();
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('mwh:window-maximized-state', true);
    }
  });
  mainWindow.on('unmaximize', () => {
    layoutEmbeddedMuse();
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('mwh:window-maximized-state', false);
    }
  });
  mainWindow.on('show', () => {
    layoutEmbeddedMuse();
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && !SMOKE) {
      event.preventDefault();
      hideMainWindowToTray('mainWindow.on(close)');
      return;
    }
    recordShellExitReason('main_window_closed', 'mainWindow.on(close)');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    recordShellExitReason('main_renderer_gone', 'mainWindow.webContents.render-process-gone', {
      reason: details && details.reason,
      exitCode: details && details.exitCode,
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: CURRENT_BRANCH && CURRENT_BRANCH !== 'main' ? `Muse-Win-Harness [${CURRENT_BRANCH}]` : 'Muse-Win-Harness',
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    thickFrame: true,
    roundedCorners: true,
    backgroundColor: '#121315',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'resources', 'app-icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'chrome-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setBackgroundThrottling(false);
  hardenFramelessHwnd(mainWindow, false);
  attachMainWindowSync();
  mainWindow.webContents.on('did-finish-load', () => {
    // Replay the latest theme snapshot so a late-loading chrome shell never
    // stays on the default dark strip after the embedded view reported light.
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('mwh:chrome-theme', { dark: currentThemeDark });
      mainWindow.webContents.send('mwh:chrome-language', { lang: currentLang });
    }
    applyDwmTheme(mainWindow, currentThemeDark);
  });
  mainWindow.loadFile(path.join(__dirname, 'chrome.html')).catch(() => {});

  museView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'muse-settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.setBrowserView(museView);
  museView.setBackgroundColor('#121315');
  layoutEmbeddedMuse();
  installWindowOpenHandler();

  let retriedMainLoad = false;
  museView.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame || retriedMainLoad) return;
    retriedMainLoad = true;
    console.warn('[MWH-SHELL] main window did-fail-load code=' + code + ' desc=' + desc + ' url=' + url + '; retrying once in 3s');
    setTimeout(() => {
      if (museView && !museView.webContents.isDestroyed()) {
        museView.webContents.loadURL(MAIN_URL).catch(() => {});
      }
    }, 3000);
  });
  museView.webContents.loadURL(MAIN_URL).catch(() => {});

  if (TEST_TRAY_QUIT) {
    const quitDeadline = setTimeout(async () => {
      isQuitting = true;
      recordShellExitReason('test_tray_quit_timeout', 'TEST_TRAY_QUIT_15s_watchdog');
      try {
        await stopOwnedDaemon('test_tray_quit_timeout', 'TEST_TRAY_QUIT_15s_watchdog');
      } catch {}
      // [Site #4]
      app.exit(3);
    }, 15000);
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        clearTimeout(quitDeadline);
        quitFromTray('tray_menu_click');
      }, 600);
    });
  }

  if (SMOKE) {
    const smokeDeadline = setTimeout(async () => {
      console.error('[MWH-SHELL] SMOKE TIMEOUT');
      isQuitting = true;
      recordShellExitReason('smoke_timeout', 'SMOKE_30s_watchdog');
      try {
        await stopOwnedDaemon('smoke_timeout', 'SMOKE_30s_watchdog');
      } catch {}
      // [Site #2]
      app.exit(1);
    }, 30000);
    mainWindow.webContents.once('did-finish-load', () => {
      clearTimeout(smokeDeadline);
      layoutEmbeddedMuse();
      const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      console.log('[MWH-SHELL] READY pid=' + process.pid + ' rssMb=' + rssMb);
      setTimeout(async () => {
        isQuitting = true;
        recordShellExitReason('smoke_finish', 'SMOKE_did_finish_load');
        try {
          await stopOwnedDaemon('smoke_finish', 'SMOKE_did_finish_load');
        } catch {}
        // [Site #3]
        app.quit();
      }, 2000);
    });
  }
  // Theme is primarily driven in real-time by DOM mutation observer in muse-settings-preload.cjs.
}


/**
 * Generic local daemon REST bridge. Every IPC route funnels through here so the
 * runtime Bearer token is attached in exactly one place and never logged.
 */
async function daemonFetch(method, route, body, timeoutMs) {
  if (!isValidTokenStr(token)) loadPersistedSecrets();
  const url = `http://127.0.0.1:${DAEMON_PORT}${route}`;
  const headers = {};
  if (isValidTokenStr(token)) {
    headers.Authorization = `Bearer ${token}`;
  }
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let abortTimer = null;
  if (Number(timeoutMs) > 0) {
    const controller = new AbortController();
    init.signal = controller.signal;
    abortTimer = setTimeout(() => controller.abort(), Number(timeoutMs));
  }
  try {
    let res = await fetch(url, init);
    if (res.status === 401) {
      loadPersistedSecrets();
      if (isValidTokenStr(token) && !(init.signal && init.signal.aborted)) {
        headers.Authorization = `Bearer ${token}`;
        res = await fetch(url, init);
      }
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      return Object.assign({ ok: false, status: res.status }, data || {});
    }
    return data === null ? { ok: true } : data;
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'DAEMON_UNREACHABLE' };
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
}

// --- Lightweight SSE subscription (daemon -> museView state patches) ---
let daemonSseRequest = null;
let daemonSseRetryTimer = null;
let daemonSseClosed = false;
let daemonSseGeneration = 0;

function stopDaemonSse() {
  daemonSseClosed = true;
  if (daemonSseRetryTimer) {
    clearTimeout(daemonSseRetryTimer);
    daemonSseRetryTimer = null;
  }
  if (daemonSseRequest) {
    try {
      daemonSseRequest.destroy();
    } catch {
      // already closed
    }
    daemonSseRequest = null;
  }
}

function connectDaemonSse() {
  if (!isValidTokenStr(token)) loadPersistedSecrets();
  const generation = ++daemonSseGeneration;
  daemonSseClosed = true;
  if (daemonSseRetryTimer) {
    clearTimeout(daemonSseRetryTimer);
    daemonSseRetryTimer = null;
  }
  if (daemonSseRequest) {
    try {
      daemonSseRequest.destroy();
    } catch {
      // already closed
    }
    daemonSseRequest = null;
  }
  daemonSseClosed = false;

  let reconnectScheduled = false;
  const scheduleReconnect = (delayMs = 1500) => {
    if (generation !== daemonSseGeneration) return;
    if (reconnectScheduled || daemonSseClosed || isQuitting) return;
    reconnectScheduled = true;
    daemonSseRequest = null;
    daemonSseRetryTimer = setTimeout(() => {
      daemonSseRetryTimer = null;
      if (!daemonSseClosed && !isQuitting && generation === daemonSseGeneration) connectDaemonSse();
    }, delayMs);
  };

  const reqHeaders = { Accept: 'text/event-stream' };
  if (isValidTokenStr(token)) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }

  const req = http.get(
    {
      host: '127.0.0.1',
      port: DAEMON_PORT,
      path: '/api/v1/events',
      headers: {
        ...reqHeaders,
        'Cache-Control': 'no-cache',
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        if (res.statusCode === 401) {
          loadPersistedSecrets();
        }
        res.resume();
        scheduleReconnect(res.statusCode === 429 ? 8000 : 1500);
        return;
      }
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          if (!frame || frame.startsWith(':')) continue;
          const dataLines = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          let patch = null;
          try {
            patch = JSON.parse(dataLines.join('\n'));
          } catch {
            patch = null;
          }
          if (patch && museView && !museView.webContents.isDestroyed()) {
            museView.webContents.send('mwh:state-patch', patch);
          }
          if (patch && patch.liveTask) {
            const pendingCount = Array.isArray(patch.pendingApprovals) ? patch.pendingApprovals.length : 0;
            if (tray && !tray.isDestroyed()) {
              tray.setToolTip(
                pendingCount > 0
                  ? `Muse-Win-Harness · ${pendingCount} 条待审批`
                  : 'Muse-Win-Harness'
              );
            }
            if (
              patch.liveTask.status === 'WAITING_APPROVAL' &&
              patch.liveTask.id &&
              patch.liveTask.id !== lastNotifiedApprovalId
            ) {
              lastNotifiedApprovalId = patch.liveTask.id;
              try {
                if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
                  mainWindow.flashFrame(true);
                }
                if (Notification.isSupported()) {
                  const n = new Notification({
                    title: 'MWH 安全审批请求',
                    body: patch.liveTask.summary || patch.liveTask.command || '有新的本机操作等待确认',
                    silent: false,
                  });
                  n.on('click', () => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                      if (mainWindow.isMinimized()) mainWindow.restore();
                      mainWindow.show();
                      mainWindow.focus();
                    }
                  });
                  n.show();
                }
              } catch {
                // Native notification is best-effort and must never crash SSE bridge.
              }
            } else if (patch.liveTask.status !== 'WAITING_APPROVAL') {
              lastNotifiedApprovalId = '';
              try {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
              } catch {
                // ignore
              }
            }
          }
        }
      });
      res.on('end', scheduleReconnect);
      res.on('close', scheduleReconnect);
    }
  );
  req.on('error', scheduleReconnect);
  daemonSseRequest = req;
}

function registerIpc() {
  ipcMain.on('mwh:open-settings', () => {
    if (museView && !museView.webContents.isDestroyed()) {
      museView.webContents.send('mwh:open-drawer');
    }
  });
  ipcMain.on('mwh:window-minimize', () => mainWindow?.minimize());
  ipcMain.on('mwh:window-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    setImmediate(() => syncOverlay());
  });
  ipcMain.on('mwh:window-close', () => mainWindow?.close());
  ipcMain.handle('mwh:window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);
  ipcMain.handle('mwh:get-branch', () => CURRENT_BRANCH);
  ipcMain.handle('mwh:get-version-info', () => {
    const isMain = !CURRENT_BRANCH || CURRENT_BRANCH === 'main' || CURRENT_BRANCH === 'HEAD' || CURRENT_BRANCH === 'master';
    const version = 'v0.1.0';
    return {
      version,
      branch: CURRENT_BRANCH,
      isMain,
      displayLabel: isMain ? version : `${version} · ${CURRENT_BRANCH}`,
    };
  });
  ipcMain.handle('mwh:get-settings', () => daemonFetch('GET', '/api/v1/state'));

  ipcMain.handle('mwh:set-mode', (_event, payload) =>
    daemonFetch('POST', '/api/v1/security/mode', {
      profile: payload?.profile,
      mode: payload?.mode,
      approvalPolicy: payload?.approvalPolicy,
      source: 'ui_island',
    })
  );

  ipcMain.handle('mwh:set-policy', (_event, payload) =>
    daemonFetch('POST', '/api/v1/security/policy', {
      approvalPolicy: payload?.approvalPolicy,
      source: 'ui_island',
    })
  );

  ipcMain.handle('mwh:toggle-auto-downgrade', (_event, payload) =>
    daemonFetch('POST', '/api/v1/security/auto-downgrade', {
      enabled: payload?.enabled,
      source: 'ui_island',
    })
  );

  ipcMain.handle('mwh:toggle-multi-device-approval', (_event, payload) =>
    daemonFetch('POST', '/api/v1/security/multi-device-approval', {
      enabled: payload?.enabled,
      source: 'ui_island',
    })
  );

  ipcMain.handle('mwh:set-tunnel-driver', (_event, payload) =>
    daemonFetch('POST', '/api/v1/tunnel/driver', {
      driver: payload?.driver,
      config: payload?.config,
      source: 'ui_island',
    })
  );

  ipcMain.handle('mwh:rotate-token', async () => {
    const res = await daemonFetch('POST', '/api/v1/tunnel/rotate-token', { source: 'ui_island' });
    if (res && typeof res.bearerToken === 'string' && res.bearerToken.length > 0) {
      loadPersistedSecrets();
      token = res.bearerToken;
      if (typeof res.tokenExpiresAt === 'number' && Number.isFinite(res.tokenExpiresAt)) {
        persistedExtra.tokenExpiresAt = res.tokenExpiresAt;
      }
      process.env.TUNNEL_RUNTIME_TOKEN = token;
      savePersistedSecrets();
      connectDaemonSse();
      return { ok: true, maskedToken: res.maskedToken, bearerToken: res.bearerToken };
    }
    return { ok: false, error: (res && res.error) || 'ROTATE_TOKEN_FAILED' };
  });

  ipcMain.handle('mwh:get-runtime-token', async () => {
    if (!isValidTokenStr(token)) loadPersistedSecrets();
    if (!isValidTokenStr(token)) {
      try {
        const res = await daemonFetch('GET', '/api/v1/tunnel/token');
        if (res && isValidTokenStr(res.bearerToken)) {
          token = res.bearerToken.trim();
          process.env.TUNNEL_RUNTIME_TOKEN = token;
          savePersistedSecrets();
        }
      } catch {}
    }
    return { ok: true, token };
  });

  ipcMain.handle('mwh:emergency-kill', () =>
    daemonFetch('POST', '/api/v1/daemon/emergency-kill', { source: 'ui_island' })
  );

  ipcMain.handle('mwh:workspace-add', (_event, payload) =>
    daemonFetch('POST', '/api/v1/workspaces/add', { path: payload?.path })
  );

  ipcMain.handle('mwh:workspace-remove', (_event, payload) =>
    daemonFetch('POST', '/api/v1/workspaces/remove', { path: payload?.path })
  );

  ipcMain.handle('mwh:acp-list', () => daemonFetch('GET', '/api/v1/acp/profiles'));

  ipcMain.handle('mwh:acp-save', (_event, payload) =>
    daemonFetch('POST', '/api/v1/acp/profile', payload || {})
  );

  ipcMain.handle('mwh:acp-delete', (_event, payload) =>
    daemonFetch('DELETE', '/api/v1/acp/profile', { id: payload?.id })
  );

  ipcMain.handle('mwh:acp-toggle', (_event, payload) =>
    daemonFetch('POST', '/api/v1/acp/toggle', { id: payload?.id, enabled: payload?.enabled })
  );

  ipcMain.handle('mwh:acp-probe', (_event, payload) =>
    daemonFetch('POST', '/api/v1/acp/probe', { command: payload?.command })
  );

  // Resource-library mutations used to fetch 127.0.0.1 from the Muse page
  // origin (HTTPS). Chromium blocks that as a private-network / mixed-content
  // request and the panel shows "Failed to fetch" without the daemon ever
  // seeing the click. Main-process fetch is not subject to that restriction.
  ipcMain.handle('mwh:daemon-http', (_event, payload) => {
    const method = String((payload && payload.method) || 'GET').toUpperCase();
    const route = String((payload && payload.path) || '');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return { ok: false, error: 'INVALID_METHOD' };
    }
    if (!/^\/api\/v1\/[A-Za-z0-9/_-]*$/.test(route)) {
      return { ok: false, error: 'INVALID_PATH' };
    }
    const slow =
      route.includes('/resources/toggle') ||
      route.includes('/resources/probe') ||
      route.includes('/resources/scan');
    return daemonFetch(method, route, payload && payload.body, slow ? 60000 : undefined);
  });

  ipcMain.handle('mwh:worktree-spawn', (_event, payload) =>
    daemonFetch('POST', '/api/v1/worktrees/spawn', {
      agentId: payload?.agentId || 'builtin',
      requestedMode: payload?.requestedMode,
    })
  );

  ipcMain.handle('mwh:worktree-merge', (_event, payload) =>
    daemonFetch('POST', '/api/v1/worktrees/' + encodeURIComponent(payload?.id) + '/merge', {})
  );

  ipcMain.handle('mwh:worktree-remove', (_event, payload) =>
    daemonFetch('DELETE', '/api/v1/worktrees/' + encodeURIComponent(payload?.id))
  );

  ipcMain.handle('mwh:snapshot-rollback', (_event, payload) =>
    daemonFetch('POST', '/api/v1/snapshots/' + encodeURIComponent(payload?.id) + '/rollback', {})
  );

  ipcMain.handle('mwh:snapshot-delete', (_event, payload) =>
    daemonFetch('POST', '/api/v1/snapshots/delete', { ids: payload?.ids })
  );

  ipcMain.handle('mwh:snapshot-prune', (_event, payload) =>
    daemonFetch('POST', '/api/v1/snapshots/prune', { keepRecent: payload?.keepRecent })
  );

  ipcMain.handle('mwh:task-approve', (_event, payload) =>
    daemonFetch('POST', '/api/v1/tasks/' + encodeURIComponent(payload?.id) + '/approve', {
      scope: payload?.scope || 'once',
      root: payload?.root,
      source: 'ui_island',
    })
  );

  ipcMain.handle('mwh:task-reject', (_event, payload) =>
    daemonFetch('POST', '/api/v1/tasks/' + encodeURIComponent(payload?.id) + '/reject', {
      source: 'ui_island',
    })
  );

  ipcMain.handle('mwh:task-kill', (_event, payload) =>
    daemonFetch('POST', '/api/v1/tasks/' + encodeURIComponent(payload?.id) + '/kill', {
      source: 'ui_island',
    })
  );

  const handleThemeSync = (payload) => {
    const dark = typeof payload?.dark === 'boolean' ? payload.dark : (typeof payload?.isDark === 'boolean' ? payload.isDark : true);
    currentThemeDark = dark;
    const bg = dark ? '#121315' : '#f4f4f5';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(bg);
      applyDwmTheme(mainWindow, dark);
      if (!mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('mwh:chrome-theme', { dark, color: bg });
      }
    }
    if (museView && !museView.webContents.isDestroyed()) {
      try {
        museView.setBackgroundColor(bg);
      } catch {
        // ignore background repaint failure
      }
    }
    return { ok: true };
  };

  ipcMain.on('mwh:theme-sync', (_event, payload) => handleThemeSync(payload));
  ipcMain.handle('mwh:theme-sync', async (_event, payload) => handleThemeSync(payload));

  const handleLanguageSync = (payload) => {
    const lang = normalizeLocale(payload?.lang || payload?.language);
    if (currentLang === lang && !payload?.force) {
      return { ok: true, lang: currentLang };
    }
    currentLang = lang;
    updateTrayMenu(currentLang);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('mwh:chrome-language', { lang: currentLang });
    }
    return { ok: true, lang: currentLang };
  };

  ipcMain.on('mwh:language-sync', (_event, payload) => handleLanguageSync(payload));
  ipcMain.handle('mwh:language-sync', async (_event, payload) => handleLanguageSync(payload));
  ipcMain.handle('mwh:get-language', () => currentLang);

  ipcMain.on('mwh:window-hide-tray', () => {
    mainWindow?.hide();
  });

  // 岛布局主进程文件镜像：注入岛 localStorage 挂在 muse.ai 远站 origin 上，可能被
  // 站点脚本清空；且 SMOKE/test 退出走 app.exit() 强杀，不保证 localStorage 落盘。
  // 因此每次保存即时镜像写 userData/island-layout.json，作为最终事实源。
  let islandLayoutFile = null;
  let islandLayoutSaveTimer = null;
  const resolveIslandLayoutFile = () => {
    // userData 路径惰性获取：app ready 之后才有效，registerIpc 恰在 ready 后调用。
    if (!islandLayoutFile) {
      islandLayoutFile = path.join(app.getPath('userData'), 'island-layout.json');
    }
    return islandLayoutFile;
  };
  ipcMain.on('mwh:island-layout-save', (_event, raw) => {
    if (typeof raw !== 'string' || raw.length >= 4096) return;
    if (islandLayoutSaveTimer) clearTimeout(islandLayoutSaveTimer);
    islandLayoutSaveTimer = setTimeout(() => {
      islandLayoutSaveTimer = null;
      try {
        fs.writeFile(resolveIslandLayoutFile(), raw, 'utf8', (err) => {
          if (err) console.error('mwh: island layout mirror write failed', err);
        });
      } catch (err) {
        // 镜像写失败只记日志，绝不抛出影响主进程。
        console.error('mwh: island layout mirror write failed', err);
      }
    }, 500);
  });
  ipcMain.handle('mwh:island-layout-load', () => {
    try {
      return fs.readFileSync(resolveIslandLayoutFile(), 'utf8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('mwh:measure-window-geometry', () => {
    return measureDualWindowGeometry();
  });

  ipcMain.handle('mwh:daemon-status', () => {
    // ensureDaemon() has not resolved yet: report "unknown" instead of a fake ready.
    const status = lastDaemonStatus || { ok: false, reason: 'DAEMON_STATUS_UNKNOWN' };
    const shouldShowBanner = status.ok !== true;
    if (shouldShowBanner !== daemonBannerVisible) {
      daemonBannerVisible = shouldShowBanner;
      layoutEmbeddedMuse();
    }
    return status;
  });
}

// Single-instance lock for interactive desktop shell runs: prevents duplicate
// shells from coexisting and tearing down a shared daemon when one shell quits.
const IS_INTERACTIVE_SHELL = !ENSURE_DAEMON_ONLY && !SMOKE && !TEST_TRAY_QUIT;
if (IS_INTERACTIVE_SHELL) {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    recordShellExitReason('second_instance_redirected', 'app.requestSingleInstanceLock');
    app.exit(0);
  } else {
    app.on('second-instance', () => {
      showWindow();
    });
  }
}

app.whenReady().then(async () => {
  installPlainUserAgent();
  if (ENSURE_DAEMON_ONLY) {
    // Preflight: verify the daemon is reachable and authenticated, then exit.
    // No window, no tray, no IPC, no SSE. Exit code 0 = ready, 2 = not ready.
    const result = await ensureDaemon();
    // Detach ownership so throwing away this process cannot kill the daemon
    // it just started (app.exit skips before-quit, but be explicit).
    ownedDaemon = null;
    stopOwnedDaemonPromise = null;
    console.log('[MWH-PREFLIGHT] ' + JSON.stringify(result));
    recordShellExitReason(result.ok ? 'preflight_ok' : 'preflight_failed', 'ENSURE_DAEMON_ONLY', {
      ok: result.ok,
      adopted: result.adopted,
      daemonReason: result.reason,
      detail: result.detail,
    });
    // [Site #6]
    app.exit(result.ok ? 0 : 2);
    return;
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });
  await ensureDaemon();
  installAuthInjection();
  registerIpc();
  connectDaemonSse();
  if (!SMOKE) createTray();
  createWindow();
});

app.on('before-quit', (event) => {
  isQuitting = true;
  stopDaemonSse();
  if (!shellExitReasonRecorded) {
    recordShellExitReason('app_before_quit', 'app.on(before-quit)');
  }
  if (ownedDaemon || stopOwnedDaemonPromise) {
    event.preventDefault();
    stopOwnedDaemon(currentExitReason, currentExitTrigger).finally(() => {
      app.quit();
    });
  }
});

app.on('will-quit', () => {
  if (!shellExitReasonRecorded) {
    recordShellExitReason('app_will_quit', 'app.on(will-quit)');
  }
});

app.on('window-all-closed', () => {
  if (SMOKE) {
    recordShellExitReason('window_all_closed_smoke', 'app.on(window-all-closed)');
    // [Site #5]
    app.quit();
    return;
  }
  if (!isQuitting) {
    recordShellExitReason('window_all_closed_tray_resident', 'app.on(window-all-closed)');
  }
});

app.on('child-process-gone', (_event, details) => {
  if (details && details.reason && details.reason !== 'clean-exit') {
    recordShellExitReason('electron_child_process_gone', 'app.on(child-process-gone)', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  }
});

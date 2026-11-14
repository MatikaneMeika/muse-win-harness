/**
 * Native Win32 Desktop Engine (koffi in-process + pure Node zlib PNG).
 * Lazy-loaded on Windows only when Desktop Hands is invoked.
 * Zero external runtime dependencies beyond koffi.
 */

import koffi from 'koffi';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const deflateAsync = promisify(zlib.deflate);
const MAX_SCREENSHOT_PIXELS = 3840 * 2160;
const MAX_RAW_CAPTURE_DIMENSION = 16384;
const MAX_RAW_CAPTURE_PIXELS = 12288 * 8640; // ~106 MP safety cap for raw multi-monitor GDI capture

export interface WinRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WindowInfo {
  hwnd: number;
  pid: number;
  title: string;
  className: string;
  processName: string;
  bounds: { x: number; y: number; width: number; height: number };
  dpi: number;
  dpiScale: number;
  isMinimized: boolean;
  isForeground: boolean;
}

export interface ScreenshotCaptureResult {
  base64: string;
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number };
  dpiScale: number;
  scaleFactor: number;
}

interface Win32Bindings {
  user32: any;
  gdi32: any;
  dwmapi: any;
  kernel32: any;
  EnumWindows: any;
  EnumChildWindows: any;
  EnumWindowsProc: any;
  IsWindow: any;
  IsWindowVisible: any;
  IsWindowEnabled: any;
  IsIconic: any;
  GetWindowTextW: any;
  GetClassNameW: any;
  GetWindowThreadProcessId: any;
  GetWindowRect: any;
  GetClientRect: any;
  ScreenToClient: any;
  GetForegroundWindow: any;
  SetForegroundWindow: any;
  ShowWindow: any;
  WindowFromPoint: any;
  GetAncestor: any;
  GetCursorPos: any;
  SetCursorPos: any;
  GetSystemMetrics: any;
  GetDpiForWindow: any;
  GetLastInputInfo: any;
  SendInput: any;
  PostMessageW: any;
  SendMessageTimeoutIntW: any;
  SendMessageTimeoutBufW: any;
  PrintWindow: any;
  GetDC: any;
  GetWindowDC: any;
  ReleaseDC: any;
  SetProcessDpiAwarenessContext: any;
  DwmGetWindowAttribute: any;
  CreateCompatibleDC: any;
  CreateCompatibleBitmap: any;
  SelectObject: any;
  BitBlt: any;
  GetDIBits: any;
  DeleteObject: any;
  DeleteDC: any;
  OpenProcess: any;
  QueryFullProcessImageNameW: any;
  CloseHandle: any;
  GetTickCount: any;
}

let cachedBindings: Win32Bindings | null = null;

function ensureWin32(): Win32Bindings {
  if (process.platform !== 'win32') {
    throw new Error('PLATFORM_NOT_SUPPORTED: Win32 native engine only runs on Windows.');
  }
  if (cachedBindings) return cachedBindings;

  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const RECT = koffi.struct('MWH_DH_RECT', {
    left: 'int32',
    top: 'int32',
    right: 'int32',
    bottom: 'int32'
  });

  const POINT = koffi.struct('MWH_DH_POINT', {
    x: 'int32',
    y: 'int32'
  });

  const LASTINPUTINFO = koffi.struct('MWH_DH_LASTINPUTINFO', {
    cbSize: 'uint32',
    dwTime: 'uint32'
  });

  const EnumWindowsProc = koffi.proto('bool __stdcall MWH_EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

  const bindings: Win32Bindings = {
    user32,
    gdi32,
    dwmapi,
    kernel32,
    EnumWindowsProc,
    EnumWindows: user32.func('bool __stdcall EnumWindows(MWH_EnumWindowsProc* lpEnumFunc, intptr_t lParam)'),
    EnumChildWindows: user32.func('bool __stdcall EnumChildWindows(intptr_t hWndParent, MWH_EnumWindowsProc* lpEnumFunc, intptr_t lParam)'),
    IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
    IsWindowEnabled: user32.func('bool __stdcall IsWindowEnabled(intptr_t hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
    GetWindowTextW: user32.func('int32 __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16* lpString, int32 nMaxCount)'),
    GetClassNameW: user32.func('int32 __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16* lpClassName, int32 nMaxCount)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32* lpdwProcessId)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ MWH_DH_RECT* lpRect)'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(intptr_t hwnd, _Out_ MWH_DH_RECT* lpRect)'),
    ScreenToClient: user32.func('bool __stdcall ScreenToClient(intptr_t hwnd, _Inout_ MWH_DH_POINT* lpPoint)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int32 nCmdShow)'),
    WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(MWH_DH_POINT point)'),
    GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 gaFlags)'),
    GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ MWH_DH_POINT* lpPoint)'),
    SetCursorPos: user32.func('bool __stdcall SetCursorPos(int32 X, int32 Y)'),
    GetSystemMetrics: user32.func('int32 __stdcall GetSystemMetrics(int32 nIndex)'),
    GetDpiForWindow: user32.func('uint32 __stdcall GetDpiForWindow(intptr_t hwnd)'),
    GetLastInputInfo: user32.func('bool __stdcall GetLastInputInfo(_Inout_ MWH_DH_LASTINPUTINFO* plii)'),
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, void* pInputs, int32 cbSize)'),
    PostMessageW: user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)'),
    SendMessageTimeoutIntW: user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hWnd, uint32 Msg, intptr_t wParam, intptr_t lParam, uint32 fuFlags, uint32 uTimeout, _Out_ uintptr_t* lpdwResult)'),
    SendMessageTimeoutBufW: user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hWnd, uint32 Msg, uintptr_t wParam, void* lParam, uint32 fuFlags, uint32 uTimeout, _Out_ uintptr_t* lpdwResult)'),
    PrintWindow: user32.func('bool __stdcall PrintWindow(intptr_t hwnd, void* hdcBlt, uint32 nFlags)'),
    GetDC: user32.func('void* __stdcall GetDC(intptr_t hwnd)'),
    GetWindowDC: user32.func('void* __stdcall GetWindowDC(intptr_t hwnd)'),
    ReleaseDC: user32.func('int32 __stdcall ReleaseDC(intptr_t hwnd, void* hDC)'),
    SetProcessDpiAwarenessContext: user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)'),
    DwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 dwAttribute, _Out_ MWH_DH_RECT* pvAttribute, uint32 cbAttribute)'),
    CreateCompatibleDC: gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)'),
    CreateCompatibleBitmap: gdi32.func('void* __stdcall CreateCompatibleBitmap(void* hdc, int32 cx, int32 cy)'),
    SelectObject: gdi32.func('void* __stdcall SelectObject(void* hdc, void* h)'),
    BitBlt: gdi32.func('bool __stdcall BitBlt(void* hdc, int32 x, int32 y, int32 cx, int32 cy, void* hdcSrc, int32 x1, int32 y1, uint32 rop)'),
    GetDIBits: gdi32.func('int32 __stdcall GetDIBits(void* hdc, void* hbm, uint32 start, uint32 cLines, void* lpvBits, void* lpbmi, uint32 usage)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(void* ho)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(void* hdc)'),
    OpenProcess: kernel32.func('void* __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void* hProcess, uint32 dwFlags, _Out_ uint16* lpExeName, _Inout_ uint32* lpdwSize)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(void* hObject)'),
    GetTickCount: kernel32.func('uint32 __stdcall GetTickCount()')
  };

  try {
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (HANDLE)-4
    bindings.SetProcessDpiAwarenessContext(-4);
  } catch {
    // Best-effort: already set or older Windows build.
  }

  cachedBindings = bindings;
  return bindings;
}

function utf16BufToString(buf: Uint16Array, len: number): string {
  if (len <= 0) return '';
  return Buffer.from(buf.buffer, buf.byteOffset, len * 2).toString('utf16le');
}

export function getWindowText(hwnd: number): string {
  const b = ensureWin32();
  const buf = new Uint16Array(512);
  const len = b.GetWindowTextW(hwnd, buf, buf.length);
  return utf16BufToString(buf, len);
}

export function getWindowClassName(hwnd: number): string {
  const b = ensureWin32();
  const buf = new Uint16Array(256);
  const len = b.GetClassNameW(hwnd, buf, buf.length);
  return utf16BufToString(buf, len);
}

export function getWindowPid(hwnd: number): number {
  const b = ensureWin32();
  const pidOut = [0];
  b.GetWindowThreadProcessId(hwnd, pidOut);
  return pidOut[0] || 0;
}

export function getProcessNameByPid(pid: number): string {
  if (!pid || pid <= 0) return '';
  const b = ensureWin32();
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const hProc = b.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!hProc) return '';
  try {
    const buf = new Uint16Array(512);
    const size = [buf.length];
    if (b.QueryFullProcessImageNameW(hProc, 0, buf, size)) {
      const fullPath = utf16BufToString(buf, size[0]);
      const parts = fullPath.split(/[\\/]/);
      return parts[parts.length - 1] || '';
    }
    return '';
  } finally {
    b.CloseHandle(hProc);
  }
}

export function getWindowRect(hwnd: number): WinRect | null {
  const b = ensureWin32();
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  // DWMWA_EXTENDED_FRAME_BOUNDS = 9 gives accurate visible frame without invisible drop-shadow borders
  const hr = b.DwmGetWindowAttribute(hwnd, 9, rect, 16);
  if (hr === 0 && rect.right > rect.left && rect.bottom > rect.top) {
    return rect;
  }
  if (b.GetWindowRect(hwnd, rect)) {
    return rect;
  }
  return null;
}

export function isWindowValid(hwnd: number): boolean {
  const b = ensureWin32();
  return Boolean(b.IsWindow(hwnd));
}

export function listWindows(options?: { includeMinimized?: boolean; titleFilter?: string; processFilter?: string }): WindowInfo[] {
  const b = ensureWin32();
  const fgHwnd = Number(b.GetForegroundWindow()) || 0;
  const hwnds: number[] = [];
  const cb = koffi.register((hwnd: number) => {
    hwnds.push(Number(hwnd));
    return true;
  }, koffi.pointer(b.EnumWindowsProc));

  try {
    b.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }

  const titleFilter = options?.titleFilter?.toLowerCase() || '';
  const processFilter = options?.processFilter?.toLowerCase() || '';
  const includeMinimized = options?.includeMinimized !== false;
  const results: WindowInfo[] = [];

  for (const hwnd of hwnds) {
    if (!b.IsWindowVisible(hwnd)) continue;
    const minimized = Boolean(b.IsIconic(hwnd));
    if (!includeMinimized && minimized) continue;
    const title = getWindowText(hwnd);
    if (!title.trim()) continue;
    const rect = getWindowRect(hwnd);
    if (!rect || rect.right - rect.left <= 1 || rect.bottom - rect.top <= 1) continue;

    const pid = getWindowPid(hwnd);
    const processName = getProcessNameByPid(pid);
    const className = getWindowClassName(hwnd);

    if (titleFilter && !title.toLowerCase().includes(titleFilter)) continue;
    if (processFilter && !processName.toLowerCase().includes(processFilter)) continue;

    const dpi = Number(b.GetDpiForWindow(hwnd)) || 96;
    results.push({
      hwnd,
      pid,
      title,
      className,
      processName,
      bounds: {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top
      },
      dpi,
      dpiScale: Number((dpi / 96).toFixed(2)),
      isMinimized: minimized,
      isForeground: hwnd === fgHwnd
    });
  }

  return results;
}

export interface RedactionCandidate {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
  rect: WinRect;
}

export function listRedactionCandidates(): RedactionCandidate[] {
  const b = ensureWin32();
  const hwnds: number[] = [];
  const cb = koffi.register((hwnd: number) => {
    hwnds.push(Number(hwnd));
    return true;
  }, koffi.pointer(b.EnumWindowsProc));

  try {
    b.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }

  const candidates: RedactionCandidate[] = [];
  for (const hwnd of hwnds) {
    if (!b.IsWindowVisible(hwnd)) continue;
    if (b.IsIconic(hwnd)) continue;
    const rect = getWindowRect(hwnd);
    if (!rect || rect.right - rect.left <= 1 || rect.bottom - rect.top <= 1) continue;
    const pid = getWindowPid(hwnd);
    const processName = pid > 0 ? getProcessNameByPid(pid) : '';
    const title = getWindowText(hwnd);
    candidates.push({ hwnd, pid, processName, title, rect });
  }
  return candidates;
}

export function windowFromPoint(x: number, y: number): { hwnd: number; rootHwnd: number; pid: number; processName: string; title: string } {
  const b = ensureWin32();
  const rawHwnd = Number(b.WindowFromPoint({ x: Math.trunc(x), y: Math.trunc(y) })) || 0;
  const GA_ROOT = 2;
  const rootHwnd = rawHwnd ? (Number(b.GetAncestor(rawHwnd, GA_ROOT)) || rawHwnd) : 0;
  const targetHwnd = rootHwnd || rawHwnd;
  const pid = targetHwnd ? getWindowPid(targetHwnd) : 0;
  return {
    hwnd: rawHwnd,
    rootHwnd: targetHwnd,
    pid,
    processName: pid ? getProcessNameByPid(pid) : '',
    title: targetHwnd ? getWindowText(targetHwnd) : ''
  };
}

export function getLastInputIdleMs(): number {
  const b = ensureWin32();
  const lii = { cbSize: 8, dwTime: 0 };
  if (!b.GetLastInputInfo(lii)) return 0; // fail-closed: treat as active user input
  const nowTick = Number(b.GetTickCount());
  const diff = (nowTick - lii.dwTime) >>> 0;
  // If diff > 2^31 (~24.8 days), treat as wraparound/skew and fail-closed
  if (diff > 0x80000000) return 0;
  return diff;
}

export function getVirtualScreenBounds(): { x: number; y: number; width: number; height: number } {
  const b = ensureWin32();
  return {
    x: b.GetSystemMetrics(76), // SM_XVIRTUALSCREEN
    y: b.GetSystemMetrics(77), // SM_YVIRTUALSCREEN
    width: b.GetSystemMetrics(78), // SM_CXVIRTUALSCREEN
    height: b.GetSystemMetrics(79) // SM_CYVIRTUALSCREEN
  };
}

// --- Pure Node PNG Encoder (zlib.deflateSync + CRC32) ---
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

async function encodeBgraToPng(bgra: Buffer, width: number, height: number): Promise<Buffer> {
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type None
    const srcStart = y * stride;
    for (let x = 0; x < width; x++) {
      const s = srcStart + x * 4;
      const d = rowStart + 1 + x * 4;
      raw[d] = bgra[s + 2];     // R
      raw[d + 1] = bgra[s + 1]; // G
      raw[d + 2] = bgra[s];     // B
      raw[d + 3] = 255;         // A
    }
  }
  const compressed = await deflateAsync(raw, { level: 3 });
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

export function redactBgraRects(
  bgra: Buffer,
  captureBounds: { x: number; y: number; width: number; height: number },
  redactRects: WinRect[]
): number {
  let redactedCount = 0;
  const capRight = captureBounds.x + captureBounds.width;
  const capBottom = captureBounds.y + captureBounds.height;

  for (const r of redactRects) {
    const ix1 = Math.max(captureBounds.x, r.left);
    const iy1 = Math.max(captureBounds.y, r.top);
    const ix2 = Math.min(capRight, r.right);
    const iy2 = Math.min(capBottom, r.bottom);
    if (ix2 <= ix1 || iy2 <= iy1) continue;
    redactedCount++;
    const localX1 = ix1 - captureBounds.x;
    const localY1 = iy1 - captureBounds.y;
    const localX2 = ix2 - captureBounds.x;
    const localY2 = iy2 - captureBounds.y;
    for (let y = localY1; y < localY2; y++) {
      const rowOffset = y * captureBounds.width * 4;
      for (let x = localX1; x < localX2; x++) {
        const idx = rowOffset + x * 4;
        // #0B0C10 in BGRA
        bgra[idx] = 0x10;
        bgra[idx + 1] = 0x0c;
        bgra[idx + 2] = 0x0b;
        bgra[idx + 3] = 0xff;
      }
    }
  }
  return redactedCount;
}

export function downsampleBgraIfNeeded(
  bgra: Buffer,
  srcWidth: number,
  srcHeight: number,
  maxPixels = MAX_SCREENSHOT_PIXELS
): { bgra: Buffer; width: number; height: number; scaleFactor: number } {
  const totalPixels = srcWidth * srcHeight;
  const maxLongEdge = 3840;
  const maxShortEdge = 2160;
  const curLong = Math.max(srcWidth, srcHeight);
  const curShort = Math.min(srcWidth, srcHeight);
  if (totalPixels <= maxPixels && curLong <= maxLongEdge && curShort <= maxShortEdge) {
    return { bgra, width: srcWidth, height: srcHeight, scaleFactor: 1 };
  }
  const pixelRatio = totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1;
  const longRatio = curLong > maxLongEdge ? maxLongEdge / curLong : 1;
  const shortRatio = curShort > maxShortEdge ? maxShortEdge / curShort : 1;
  const ratio = Math.min(pixelRatio, longRatio, shortRatio);
  const dstWidth = Math.max(1, Math.min(srcWidth, Math.floor(srcWidth * ratio)));
  const dstHeight = Math.max(1, Math.min(srcHeight, Math.floor(srcHeight * ratio)));
  const scaleFactor = Number((dstWidth / srcWidth).toFixed(4));
  const out = Buffer.allocUnsafe(dstWidth * dstHeight * 4);

  for (let dy = 0; dy < dstHeight; dy++) {
    const sy0 = Math.floor((dy * srcHeight) / dstHeight);
    const sy1 = Math.max(sy0 + 1, Math.min(srcHeight, Math.floor(((dy + 1) * srcHeight) / dstHeight)));
    const dstRowOffset = dy * dstWidth * 4;
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx0 = Math.floor((dx * srcWidth) / dstWidth);
      const sx1 = Math.max(sx0 + 1, Math.min(srcWidth, Math.floor(((dx + 1) * srcWidth) / dstWidth)));
      let bSum = 0;
      let gSum = 0;
      let rSum = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const srcRowOffset = sy * srcWidth * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const sIdx = srcRowOffset + sx * 4;
          bSum += bgra[sIdx];
          gSum += bgra[sIdx + 1];
          rSum += bgra[sIdx + 2];
          count++;
        }
      }
      const dIdx = dstRowOffset + dx * 4;
      out[dIdx] = Math.round(bSum / count);
      out[dIdx + 1] = Math.round(gSum / count);
      out[dIdx + 2] = Math.round(rSum / count);
      out[dIdx + 3] = 0xff;
    }
  }

  return { bgra: out, width: dstWidth, height: dstHeight, scaleFactor };
}

export async function captureScreenshot(options: {
  hwnd?: number;
  region?: { x: number; y: number; width: number; height: number };
  redactRects?: WinRect[];
}): Promise<ScreenshotCaptureResult & { redactedCount: number }> {
  const b = ensureWin32();
  const vs = getVirtualScreenBounds();
  let captureBounds: { x: number; y: number; width: number; height: number };
  let printWindowBounds: { x: number; y: number; width: number; height: number } | null = null;
  let dpiScale = 1;
  const targetHwnd = options.hwnd && options.hwnd > 0 ? options.hwnd : 0;

  if (targetHwnd) {
    if (!isWindowValid(targetHwnd)) {
      throw new Error(`INVALID_HWND: Window handle ${targetHwnd} is no longer valid`);
    }
    if (b.IsIconic(targetHwnd)) {
      throw new Error(`WINDOW_MINIMIZED: Cannot screenshot minimized window ${targetHwnd}`);
    }
    const r = getWindowRect(targetHwnd);
    if (!r || r.right - r.left <= 0 || r.bottom - r.top <= 0) {
      throw new Error(`INVALID_WINDOW_BOUNDS: Cannot capture window ${targetHwnd}`);
    }
    captureBounds = {
      x: r.left,
      y: r.top,
      width: r.right - r.left,
      height: r.bottom - r.top
    };
    const rawRect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (b.GetWindowRect(targetHwnd, rawRect) && rawRect.right > rawRect.left && rawRect.bottom > rawRect.top) {
      printWindowBounds = {
        x: rawRect.left,
        y: rawRect.top,
        width: rawRect.right - rawRect.left,
        height: rawRect.bottom - rawRect.top
      };
    }
    const dpi = Number(b.GetDpiForWindow(targetHwnd)) || 96;
    dpiScale = Number((dpi / 96).toFixed(2));
  } else if (options.region) {
    const rx1 = Math.trunc(options.region.x);
    const ry1 = Math.trunc(options.region.y);
    const rw = Math.max(1, Math.trunc(options.region.width));
    const rh = Math.max(1, Math.trunc(options.region.height));
    // If caller passes origin (0,0) with an oversized sentinel region (>= virtual screen)
    // when virtual screen has negative offsets (multi-monitor above/left of primary),
    // expand to full virtual screen so both paths capture the unified virtual desktop.
    const isFullScreenSentinel =
      rx1 === 0 && ry1 === 0 && rw >= vs.width && rh >= vs.height && (vs.x < 0 || vs.y < 0);
    const ix1 = isFullScreenSentinel ? vs.x : Math.max(vs.x, rx1);
    const iy1 = isFullScreenSentinel ? vs.y : Math.max(vs.y, ry1);
    const ix2 = Math.min(vs.x + vs.width, rx1 + rw);
    const iy2 = Math.min(vs.y + vs.height, ry1 + rh);
    if (ix2 <= ix1 || iy2 <= iy1) {
      throw new Error('INVALID_REGION: screenshot region does not intersect virtual screen');
    }
    captureBounds = { x: ix1, y: iy1, width: ix2 - ix1, height: iy2 - iy1 };
    const primaryHwnd = Number(b.GetForegroundWindow()) || 0;
    const dpi = primaryHwnd ? Number(b.GetDpiForWindow(primaryHwnd)) || 96 : 96;
    dpiScale = Number((dpi / 96).toFixed(2));
  } else {
    captureBounds = vs;
    const primaryHwnd = Number(b.GetForegroundWindow()) || 0;
    const dpi = primaryHwnd ? Number(b.GetDpiForWindow(primaryHwnd)) || 96 : 96;
    dpiScale = Number((dpi / 96).toFixed(2));
  }

  const activeBounds = targetHwnd && printWindowBounds ? printWindowBounds : captureBounds;
  let { width, height } = captureBounds;
  if (
    width > MAX_RAW_CAPTURE_DIMENSION ||
    height > MAX_RAW_CAPTURE_DIMENSION ||
    activeBounds.width > MAX_RAW_CAPTURE_DIMENSION ||
    activeBounds.height > MAX_RAW_CAPTURE_DIMENSION ||
    width * height > MAX_RAW_CAPTURE_PIXELS ||
    activeBounds.width * activeBounds.height > MAX_RAW_CAPTURE_PIXELS
  ) {
    const culprit = activeBounds.width * activeBounds.height >= width * height ? activeBounds : captureBounds;
    throw new Error(
      `SCREENSHOT_REGION_TOO_LARGE: Capture area (${culprit.width}x${culprit.height}) exceeds ${MAX_RAW_CAPTURE_PIXELS} raw pixel safety limit; specify a smaller region or target hwnd.`
    );
  }

  const screenDc = b.GetDC(0);
  if (!screenDc) {
    throw new Error('GDI_DC_FAILED: Failed to acquire screen DC');
  }
  const memDc = b.CreateCompatibleDC(screenDc);
  let hBitmap = b.CreateCompatibleBitmap(screenDc, activeBounds.width, activeBounds.height);
  let oldObj = b.SelectObject(memDc, hBitmap);
  let effectiveBounds = activeBounds;

  try {
    let captured = false;
    if (targetHwnd) {
      // PW_RENDERFULLCONTENT = 2 captures occluded/background DWM windows cleanly
      captured = Boolean(b.PrintWindow(targetHwnd, memDc, 2));
    }
    if (!captured) {
      if (effectiveBounds !== captureBounds) {
        b.SelectObject(memDc, oldObj);
        b.DeleteObject(hBitmap);
        hBitmap = b.CreateCompatibleBitmap(screenDc, captureBounds.width, captureBounds.height);
        oldObj = b.SelectObject(memDc, hBitmap);
        effectiveBounds = captureBounds;
      }
      const SRCCOPY = 0x00cc0020;
      const CAPTUREBLT = 0x40000000;
      b.BitBlt(memDc, 0, 0, captureBounds.width, captureBounds.height, screenDc, captureBounds.x, captureBounds.y, SRCCOPY | CAPTUREBLT);
    }

    width = effectiveBounds.width;
    height = effectiveBounds.height;

    // MSDN: bitmap must NOT be selected into a DC when GetDIBits is called
    b.SelectObject(memDc, oldObj);

    // BITMAPINFOHEADER (40 bytes) for top-down 32-bit BGRA DIB
    const bmi = Buffer.alloc(40);
    bmi.writeUInt32LE(40, 0);         // biSize
    bmi.writeInt32LE(width, 4);       // biWidth
    bmi.writeInt32LE(-height, 8);     // biHeight (negative = top-down)
    bmi.writeUInt16LE(1, 12);         // biPlanes
    bmi.writeUInt16LE(32, 14);        // biBitCount
    bmi.writeUInt32LE(0, 16);         // biCompression = BI_RGB

    const bgra = Buffer.allocUnsafe(width * height * 4);
    const lines = b.GetDIBits(memDc, hBitmap, 0, height, bgra, bmi, 0);
    if (lines === 0) {
      throw new Error('GDI_GETDIBITS_FAILED: Failed to read bitmap pixels');
    }

    // S5: Redact protected/sensitive windows in 1:1 physical source pixel space BEFORE downsampling
    const redactedCount = options.redactRects?.length
      ? redactBgraRects(bgra, effectiveBounds, options.redactRects)
      : 0;

    const scaled = downsampleBgraIfNeeded(bgra, width, height, MAX_SCREENSHOT_PIXELS);
    const png = await encodeBgraToPng(scaled.bgra, scaled.width, scaled.height);
    return {
      base64: png.toString('base64'),
      width: scaled.width,
      height: scaled.height,
      bounds: effectiveBounds,
      dpiScale,
      scaleFactor: scaled.scaleFactor,
      redactedCount
    };
  } finally {
    try {
      b.SelectObject(memDc, oldObj);
    } catch {}
    b.DeleteObject(hBitmap);
    b.DeleteDC(memDc);
    b.ReleaseDC(0, screenDc);
  }
}

// --- Background Win32 Message Delivery ---
function makeLParam(low: number, high: number): number {
  return ((high & 0xffff) << 16) | (low & 0xffff);
}

export function postMouseClick(
  hwnd: number,
  screenX: number,
  screenY: number,
  button: 'left' | 'right' | 'middle' = 'left',
  doubleClick = false
): { clientX: number; clientY: number } {
  const b = ensureWin32();
  const pt = { x: Math.trunc(screenX), y: Math.trunc(screenY) };
  b.ScreenToClient(hwnd, pt);
  const lp = makeLParam(pt.x, pt.y);
  const WM_MOUSEMOVE = 0x0200;
  const WM_LBUTTONDOWN = 0x0201;
  const WM_LBUTTONUP = 0x0202;
  const WM_LBUTTONDBLCLK = 0x0203;
  const WM_RBUTTONDOWN = 0x0204;
  const WM_RBUTTONUP = 0x0205;
  const WM_MBUTTONDOWN = 0x0207;
  const WM_MBUTTONUP = 0x0208;

  b.PostMessageW(hwnd, WM_MOUSEMOVE, 0, lp);
  if (button === 'right') {
    b.PostMessageW(hwnd, WM_RBUTTONDOWN, 2, lp);
    b.PostMessageW(hwnd, WM_RBUTTONUP, 0, lp);
  } else if (button === 'middle') {
    b.PostMessageW(hwnd, WM_MBUTTONDOWN, 16, lp);
    b.PostMessageW(hwnd, WM_MBUTTONUP, 0, lp);
  } else {
    b.PostMessageW(hwnd, WM_LBUTTONDOWN, 1, lp);
    b.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp);
    if (doubleClick) {
      b.PostMessageW(hwnd, WM_LBUTTONDBLCLK, 1, lp);
      b.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp);
    }
  }
  return { clientX: pt.x, clientY: pt.y };
}

export interface PostTextResult {
  hwnd: number;
  targetHwnd: number;
  targetClassName: string;
  deliveryMethod: 'win32_replacesel' | 'win32_wm_char';
  verified: boolean;
  tailMatched: boolean;
  readBackLength: number;
}

const PRIMARY_EDIT_CLASS_RE =
  /^(?:edit|richeditd2dpt|richedit20w|richedit20a|richedit50w|richedit60w|richedit|msftedit_class|scintilla)$/i;
const SECONDARY_TEXT_CLASS_RE = /(?:edit|textbox)/i;
const WRAPPER_TEXT_HOST_RE = /^notepadtextbox$/i;

function scoreTextControlClass(className: string): number {
  const trimmed = className.trim();
  if (!trimmed) return 0;
  if (PRIMARY_EDIT_CLASS_RE.test(trimmed)) return 300;
  if (SECONDARY_TEXT_CLASS_RE.test(trimmed) && !WRAPPER_TEXT_HOST_RE.test(trimmed)) return 180;
  return 0;
}

/**
 * Resolves the actual child text-input HWND inside a top-level or container HWND
 * (e.g., Win11 Store Notepad top-level `Notepad` -> `NotepadTextBox` -> `RichEditD2DPT`,
 * or classic Win32 frame -> `Edit`). Prefers visible + enabled edit controls so active
 * tabs win over hidden background tabs even when the top-level window is minimized.
 */
export function resolveTextInputTargetHwnd(hwnd: number): {
  targetHwnd: number;
  targetClassName: string;
} {
  const b = ensureWin32();
  if (!b.IsWindow(hwnd)) {
    throw new Error(`INVALID_HWND: Window handle ${hwnd} is no longer valid`);
  }

  const children: number[] = [];
  const cb = koffi.register((childHwnd: number) => {
    children.push(Number(childHwnd));
    return true;
  }, koffi.pointer(b.EnumWindowsProc));

  try {
    b.EnumChildWindows(hwnd, cb, 0);
  } finally {
    koffi.unregister(cb);
  }

  let bestHwnd = hwnd;
  let bestClass = getWindowClassName(hwnd);
  let bestScore = scoreTextControlClass(bestClass);
  if (bestScore > 0) {
    const vis = Boolean(b.IsWindowVisible(hwnd));
    const en = Boolean(b.IsWindowEnabled(hwnd));
    bestScore += vis && en ? 90 : en ? 45 : 10;
  }

  for (const child of children) {
    if (!b.IsWindow(child)) continue;
    const cls = getWindowClassName(child);
    const baseScore = scoreTextControlClass(cls);
    if (baseScore <= 0) continue;
    const vis = Boolean(b.IsWindowVisible(child));
    const en = Boolean(b.IsWindowEnabled(child));
    const stateScore = vis && en ? 100 : en ? 50 : vis ? 15 : 5;
    const total = baseScore + stateScore;
    if (total > bestScore) {
      bestScore = total;
      bestHwnd = child;
      bestClass = cls;
    }
  }

  return {
    targetHwnd: bestHwnd,
    targetClassName: bestClass
  };
}

/**
 * Sanitizes isolated UTF-16 surrogates (replacing unpaired high/low surrogates with U+FFFD)
 * while preserving valid supplementary-plane surrogate pairs (emoji, CJK extensions) intact.
 */
export function sanitizeSurrogateString(text: string): string {
  const units = toSurrogateSafeUtf16Units(text);
  if (units.length === 0) return '';
  const CHUNK = 8192;
  if (units.length <= CHUNK) {
    return String.fromCharCode(...units);
  }
  const parts: string[] = [];
  for (let i = 0; i < units.length; i += CHUNK) {
    parts.push(String.fromCharCode(...units.slice(i, i + CHUNK)));
  }
  return parts.join('');
}

/**
 * Splits a string into UTF-16 code units by iterating code points so valid surrogate
 * pairs stay ordered as [highSurrogate, lowSurrogate] and isolated surrogates become 0xFFFD.
 */
export function toSurrogateSafeUtf16Units(text: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const first = text.charCodeAt(i);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (i + 1 < text.length) {
        const second = text.charCodeAt(i + 1);
        if (second >= 0xdc00 && second <= 0xdfff) {
          units.push(first, second);
          i += 1;
          continue;
        }
      }
      units.push(0xfffd);
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      units.push(0xfffd);
    } else {
      units.push(first);
    }
  }
  return units;
}

/**
 * Compares the tail of a read-back buffer against injected text, normalizing
 * line-ending differences (\r\n vs \r vs \n) across classic Edit, RichEditD2DPT, and UIA.
 */
export function matchesTextTail(readBackText: string, injectedText: string): boolean {
  if (injectedText.length === 0) return true;
  if (readBackText.endsWith(injectedText)) return true;
  const normInjected = injectedText.replace(/\r\n|\r/g, '\n');
  const sliceLen = Math.min(readBackText.length, Math.max(normInjected.length * 2 + 64, 512));
  const tailSlice = readBackText.slice(readBackText.length - sliceLen).replace(/\r\n|\r/g, '\n');
  return tailSlice.endsWith(normInjected);
}

/**
 * Reads text from a Win32 control via SendMessageTimeoutW (WM_GETTEXTLENGTH + WM_GETTEXT)
 * with SMTO_ABORTIFHUNG so a hung target thread can never block the daemon.
 */
export function readWindowText(
  hwnd: number,
  timeoutMs = 1500
): { ok: boolean; text: string; rawLength: number } {
  const b = ensureWin32();
  const WM_GETTEXT = 0x000d;
  const WM_GETTEXTLENGTH = 0x000e;
  const SMTO_ABORTIFHUNG = 0x0002;

  const lenOut = [0];
  const okLen = Number(
    b.SendMessageTimeoutIntW(hwnd, WM_GETTEXTLENGTH, 0, 0, SMTO_ABORTIFHUNG, timeoutMs, lenOut)
  );
  if (!okLen) {
    return { ok: false, text: '', rawLength: 0 };
  }
  const rawLength = Math.max(0, Number(lenOut[0]) || 0);
  if (rawLength === 0) {
    return { ok: true, text: '', rawLength: 0 };
  }
  const maxChars = Math.min(rawLength + 8, 1024 * 1024);
  const buf = new Uint16Array(maxChars);
  const copiedOut = [0];
  const okGet = Number(
    b.SendMessageTimeoutBufW(hwnd, WM_GETTEXT, buf.length, buf, SMTO_ABORTIFHUNG, timeoutMs, copiedOut)
  );
  if (!okGet) {
    return { ok: false, text: '', rawLength };
  }
  const copied = Math.max(0, Math.min(buf.length, Number(copiedOut[0]) || 0));
  return {
    ok: true,
    text: utf16BufToString(buf, copied),
    rawLength
  };
}

export function postText(hwnd: number, text: string): PostTextResult {
  const b = ensureWin32();
  const { targetHwnd, targetClassName } = resolveTextInputTargetHwnd(hwnd);
  const safeText = sanitizeSurrogateString(text);

  if (safeText.length === 0) {
    const cur = readWindowText(targetHwnd);
    return {
      hwnd,
      targetHwnd,
      targetClassName,
      deliveryMethod: 'win32_replacesel',
      verified: true,
      tailMatched: true,
      readBackLength: cur.text.length
    };
  }

  const EM_SETSEL = 0x00b1;
  const EM_REPLACESEL = 0x00c2;
  const WM_CHAR = 0x0102;
  const SMTO_ABORTIFHUNG = 0x0002;

  const before = readWindowText(targetHwnd);
  const dummyOut = [0];

  // Primary path: position caret at the end of the text surface and atomically append via EM_REPLACESEL.
  // Works across process boundaries (user32 marshals EM_REPLACESEL) and on minimized windows
  // (including Win11 Store Notepad's RichEditD2DPT and classic Win32 Edit controls).
  b.SendMessageTimeoutIntW(targetHwnd, EM_SETSEL, 0x7fffffff, 0x7fffffff, SMTO_ABORTIFHUNG, 1500, dummyOut);
  const nullTermBuf = Buffer.from(safeText + '\0', 'utf16le');
  const replaceOk = Number(
    b.SendMessageTimeoutBufW(targetHwnd, EM_REPLACESEL, 1, nullTermBuf, SMTO_ABORTIFHUNG, 2000, dummyOut)
  );

  if (replaceOk) {
    const afterReplace = readWindowText(targetHwnd);
    const tailOk =
      afterReplace.ok &&
      afterReplace.text.length > before.text.length &&
      matchesTextTail(afterReplace.text, safeText);
    if (tailOk) {
      return {
        hwnd,
        targetHwnd,
        targetClassName,
        deliveryMethod: 'win32_replacesel',
        verified: true,
        tailMatched: true,
        readBackLength: afterReplace.text.length
      };
    }
  }

  // Fallback path: surrogate-safe WM_CHAR delivery (with \r\n normalized to \r to prevent double linebreaks)
  b.SendMessageTimeoutIntW(targetHwnd, EM_SETSEL, 0x7fffffff, 0x7fffffff, SMTO_ABORTIFHUNG, 1000, dummyOut);
  const wmCharSource = safeText.replace(/\r\n/g, '\r');
  const units = toSurrogateSafeUtf16Units(wmCharSource);
  for (const unit of units) {
    const sent = Number(
      b.SendMessageTimeoutIntW(targetHwnd, WM_CHAR, unit, 1, SMTO_ABORTIFHUNG, 500, dummyOut)
    );
    if (!sent) {
      b.PostMessageW(targetHwnd, WM_CHAR, unit, 1);
    }
  }

  const afterChar = readWindowText(targetHwnd);
  const charTailOk =
    afterChar.ok &&
    afterChar.text.length > before.text.length &&
    matchesTextTail(afterChar.text, safeText);

  return {
    hwnd,
    targetHwnd,
    targetClassName,
    deliveryMethod: 'win32_wm_char',
    verified: charTailOk,
    tailMatched: charTailOk,
    readBackLength: afterChar.ok ? afterChar.text.length : 0
  };
}

export function postScroll(hwnd: number, screenX: number, screenY: number, delta: number): void {
  const b = ensureWin32();
  const WM_MOUSEWHEEL = 0x020a;
  const wheelDelta = Math.trunc(delta) * 120;
  const wParam = ((wheelDelta & 0xffff) << 16) >>> 0;
  const lParam = makeLParam(Math.trunc(screenX), Math.trunc(screenY));
  b.PostMessageW(hwnd, WM_MOUSEWHEEL, wParam, lParam);
}

// --- Foreground Fallback Delivery (SendInput, Unicode + VirtualDesktop) ---
const INPUT_SIZE = process.arch === 'ia32' ? 28 : 40;

function buildMouseInput(dx: number, dy: number, mouseData: number, dwFlags: number): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(0, 0); // INPUT_MOUSE
  const off = process.arch === 'ia32' ? 4 : 8;
  buf.writeInt32LE(dx, off);
  buf.writeInt32LE(dy, off + 4);
  buf.writeUInt32LE(mouseData >>> 0, off + 8);
  buf.writeUInt32LE(dwFlags >>> 0, off + 12);
  return buf;
}

function buildKeyInput(wVk: number, wScan: number, dwFlags: number): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(1, 0); // INPUT_KEYBOARD
  const off = process.arch === 'ia32' ? 4 : 8;
  buf.writeUInt16LE(wVk & 0xffff, off);
  buf.writeUInt16LE(wScan & 0xffff, off + 2);
  buf.writeUInt32LE(dwFlags >>> 0, off + 4);
  return buf;
}

function normalizeVirtualCoords(x: number, y: number): { nx: number; ny: number } {
  const vs = getVirtualScreenBounds();
  const w = Math.max(1, vs.width - 1);
  const h = Math.max(1, vs.height - 1);
  const nx = Math.max(0, Math.min(65535, Math.round(((x - vs.x) * 65535) / w)));
  const ny = Math.max(0, Math.min(65535, Math.round(((y - vs.y) * 65535) / h)));
  return { nx, ny };
}

export function foregroundMouseMove(x: number, y: number): void {
  const b = ensureWin32();
  const { nx, ny } = normalizeVirtualCoords(x, y);
  const MOUSEEVENTF_MOVE = 0x0001;
  const MOUSEEVENTF_ABSOLUTE = 0x8000;
  const MOUSEEVENTF_VIRTUALDESK = 0x4000;
  const pkt = buildMouseInput(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
  b.SendInput(1, pkt, INPUT_SIZE);
}

export function foregroundClick(
  x: number | undefined,
  y: number | undefined,
  button: 'left' | 'right' | 'middle' = 'left',
  doubleClick = false
): void {
  const b = ensureWin32();
  const inputs: Buffer[] = [];
  if (typeof x === 'number' && typeof y === 'number') {
    const { nx, ny } = normalizeVirtualCoords(x, y);
    inputs.push(buildMouseInput(nx, ny, 0, 0x0001 | 0x8000 | 0x4000));
  }
  const downFlag = button === 'right' ? 0x0008 : button === 'middle' ? 0x0020 : 0x0002;
  const upFlag = button === 'right' ? 0x0010 : button === 'middle' ? 0x0040 : 0x0004;
  inputs.push(buildMouseInput(0, 0, 0, downFlag));
  inputs.push(buildMouseInput(0, 0, 0, upFlag));
  if (doubleClick) {
    inputs.push(buildMouseInput(0, 0, 0, downFlag));
    inputs.push(buildMouseInput(0, 0, 0, upFlag));
  }
  const combined = Buffer.concat(inputs);
  b.SendInput(inputs.length, combined, INPUT_SIZE);
}

export function foregroundScroll(x: number | undefined, y: number | undefined, delta: number): void {
  const b = ensureWin32();
  const inputs: Buffer[] = [];
  if (typeof x === 'number' && typeof y === 'number') {
    const { nx, ny } = normalizeVirtualCoords(x, y);
    inputs.push(buildMouseInput(nx, ny, 0, 0x0001 | 0x8000 | 0x4000));
  }
  const MOUSEEVENTF_WHEEL = 0x0800;
  inputs.push(buildMouseInput(0, 0, Math.trunc(delta) * 120, MOUSEEVENTF_WHEEL));
  const combined = Buffer.concat(inputs);
  b.SendInput(inputs.length, combined, INPUT_SIZE);
}

export function foregroundTypeText(text: string): void {
  const b = ensureWin32();
  const KEYEVENTF_UNICODE = 0x0004;
  const KEYEVENTF_KEYUP = 0x0002;
  const inputs: Buffer[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      inputs.push(buildKeyInput(0x0d, 0, 0));
      inputs.push(buildKeyInput(0x0d, 0, KEYEVENTF_KEYUP));
    } else {
      inputs.push(buildKeyInput(0, code, KEYEVENTF_UNICODE));
      inputs.push(buildKeyInput(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
  }
  if (inputs.length === 0) return;
  const combined = Buffer.concat(inputs);
  b.SendInput(inputs.length, combined, INPUT_SIZE);
}

const VK_MAP: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  menu: 0x12,
  shift: 0x10,
  win: 0x5b,
  meta: 0x5b,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b
};

export function resolveVirtualKey(key: string): number {
  const norm = key.trim().toLowerCase();
  if (VK_MAP[norm]) return VK_MAP[norm];
  if (norm.length === 1) {
    const code = norm.toUpperCase().charCodeAt(0);
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) {
      return code;
    }
  }
  throw new Error(`UNKNOWN_VIRTUAL_KEY: Unsupported key '${key}'`);
}

export function foregroundHotkey(keys: string[]): void {
  const b = ensureWin32();
  const vks = keys.map(resolveVirtualKey);
  const KEYEVENTF_KEYUP = 0x0002;
  const inputs: Buffer[] = [];
  for (const vk of vks) {
    inputs.push(buildKeyInput(vk, 0, 0));
  }
  for (let i = vks.length - 1; i >= 0; i--) {
    inputs.push(buildKeyInput(vks[i], 0, KEYEVENTF_KEYUP));
  }
  if (inputs.length === 0) return;
  const combined = Buffer.concat(inputs);
  b.SendInput(inputs.length, combined, INPUT_SIZE);
}

export function focusWindow(hwnd: number): boolean {
  const b = ensureWin32();
  if (b.IsIconic(hwnd)) {
    b.ShowWindow(hwnd, 9); // SW_RESTORE
  }
  return Boolean(b.SetForegroundWindow(hwnd));
}

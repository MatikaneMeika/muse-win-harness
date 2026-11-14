/**
 * Desktop Hands v2 (Native Win32 + Lazy-Loaded UIA Bridge + WinGuard)
 * - Zero per-action powershell.exe spawning
 * - Multimodal screenshot capture with protected-window redaction
 * - Background-first delivery (UIA / PostMessageW), gated foreground SendInput fallback
 * - Emergency-epoch step-level abort for batch sequences
 * - Disabled by default
 */

import {
  captureScreenshot,
  focusWindow,
  foregroundClick,
  foregroundHotkey,
  foregroundMouseMove,
  foregroundScroll,
  foregroundTypeText,
  listWindows,
  postMouseClick,
  postScroll,
  postText
} from '../desktop/win32Native.js';
import { WinGuard } from '../desktop/winGuard.js';
import { UiaBridge, type UiaElementTokenEntry } from '../desktop/uiaBridge.js';
import { SubagentDispatcher } from '../subagents/dispatcher.js';
import { classifyDesktopStepDelivery, normalizeDesktopHandsParams } from './desktopDelivery.js';

export type DesktopDelivery = 'auto' | 'background' | 'foreground';

export type DesktopActOp =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'move'
  | 'type_text'
  | 'hotkey'
  | 'scroll'
  | 'invoke'
  | 'set_value'
  | 'toggle'
  | 'select'
  | 'focus'
  | 'wait';

export interface DesktopHandsStep {
  op: DesktopActOp;
  hwnd?: number;
  delivery?: DesktopDelivery;
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  text?: string;
  keys?: string[];
  delta?: number;
  automationId?: string;
  name?: string;
  controlType?: string;
  elementToken?: string;
  value?: string;
  durationMs?: number;
}

export interface DesktopHandsParams {
  action:
    | 'windows'
    | 'inspect'
    | 'screenshot'
    | 'act'
    | 'batch'
    | 'mouse_move'
    | 'click'
    | 'type_text';
  hwnd?: number;
  titleFilter?: string;
  processFilter?: string;
  includeMinimized?: boolean;
  maxDepth?: number;
  maxNodes?: number;
  region?: { x: number; y: number; width: number; height: number };
  delivery?: DesktopDelivery;
  op?: DesktopActOp;
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  text?: string;
  keys?: string[];
  delta?: number;
  automationId?: string;
  name?: string;
  controlType?: string;
  elementToken?: string;
  value?: string;
  durationMs?: number;
  steps?: DesktopHandsStep[];
}

export interface DesktopHandsExecuteOptions {
  foregroundFallback?: boolean;
}

const MAX_BATCH_STEPS = 30;
const MAX_WAIT_MS = 10000;
const MAX_TEXT_LEN = 4096;

function assertFiniteCoord(val: unknown, label: string): number {
  const num = Number(val);
  if (!Number.isFinite(num)) {
    throw new Error(`INVALID_COORDINATES: ${label} must be a finite number`);
  }
  return Math.trunc(num);
}

function assertPositiveHwnd(val: unknown, contextLabel: string): number {
  const hwnd = Number(val);
  if (!Number.isFinite(hwnd) || hwnd <= 0) {
    throw new Error(`INVALID_HWND: ${contextLabel} requires a valid positive window handle (hwnd)`);
  }
  return Math.trunc(hwnd);
}

async function sleepSlicedWithEmergency(ms: number, startEpoch: number): Promise<void> {
  const clamped = Math.max(0, Math.min(MAX_WAIT_MS, Math.trunc(ms)));
  let remaining = clamped;
  while (remaining > 0) {
    if (SubagentDispatcher.getEmergencyEpoch() !== startEpoch) {
      throw new Error('EMERGENCY_STOP_ABORTED: Desktop wait aborted by emergency stop');
    }
    const slice = Math.min(100, remaining);
    await new Promise((resolve) => setTimeout(resolve, slice));
    remaining -= slice;
  }
  if (SubagentDispatcher.getEmergencyEpoch() !== startEpoch) {
    throw new Error('EMERGENCY_STOP_ABORTED: Desktop wait aborted by emergency stop');
  }
}

export class DesktopHands {
  private static mutexChain: Promise<void> = Promise.resolve();

  private static withDesktopMutex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutexChain.then(fn, fn);
    this.mutexChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  public static async execute(
    rawParams: DesktopHandsParams,
    enabled = false,
    options: DesktopHandsExecuteOptions = {}
  ): Promise<any> {
    if (!enabled) {
      throw new Error('DESKTOP_HANDS_DISABLED: Desktop Hands is disabled in configuration.');
    }
    if (process.platform !== 'win32') {
      throw new Error('PLATFORM_NOT_SUPPORTED: Desktop Hands only supports Windows platform.');
    }

    const params = normalizeDesktopHandsParams(rawParams as any) as DesktopHandsParams;

    switch (params.action) {
      case 'windows': {
        const raw = listWindows({
          includeMinimized: params.includeMinimized,
          titleFilter: params.titleFilter,
          processFilter: params.processFilter
        });
        const windows = raw.filter(
          (w) => !WinGuard.isProtectedOrSensitiveWindow(w.hwnd, w.pid, w.processName, w.title)
        );
        return {
          action: 'windows',
          count: windows.length,
          windows
        };
      }

      case 'inspect': {
        const hwnd = assertPositiveHwnd(params.hwnd, 'inspect');
        WinGuard.assertTargetAllowed({ hwnd });
        return this.withDesktopMutex(async () => {
          const treeRes = await UiaBridge.inspect({
            hwnd,
            maxDepth: params.maxDepth,
            maxNodes: params.maxNodes
          });
          return {
            action: 'inspect',
            hwnd,
            ...treeRes
          };
        });
      }

      case 'screenshot': {
        const hwnd = typeof params.hwnd === 'number' && params.hwnd > 0 ? Math.trunc(params.hwnd) : undefined;
        if (hwnd) {
          WinGuard.assertTargetAllowed({ hwnd });
        }
        if (params.region) {
          assertFiniteCoord(params.region.x, 'region.x');
          assertFiniteCoord(params.region.y, 'region.y');
          const rw = assertFiniteCoord(params.region.width, 'region.width');
          const rh = assertFiniteCoord(params.region.height, 'region.height');
          if (rw <= 0 || rh <= 0) {
            throw new Error('INVALID_REGION: screenshot region width and height must be positive');
          }
        }
        return this.withDesktopMutex(async () => {
          const redactRects = WinGuard.getRedactionRects(hwnd);
          const shot = await captureScreenshot({
            hwnd,
            region: params.region,
            redactRects
          });
          return {
            action: 'screenshot',
            hwnd: hwnd ?? null,
            width: shot.width,
            height: shot.height,
            bounds: shot.bounds,
            dpiScale: shot.dpiScale,
            scaleFactor: shot.scaleFactor,
            redactedCount: shot.redactedCount,
            __mcpImage: {
              data: shot.base64,
              mimeType: 'image/png'
            }
          };
        });
      }

      case 'act': {
        if (!params.op) {
          throw new Error('INVALID_ACT_PARAMS: act requires an op parameter');
        }
        const startEpoch = SubagentDispatcher.getEmergencyEpoch();
        return this.withDesktopMutex(async () => {
          const result = await this.executeStep(
            {
              op: params.op!,
              hwnd: params.hwnd,
              delivery: params.delivery,
              x: params.x,
              y: params.y,
              button: params.button,
              text: params.text,
              keys: params.keys,
              delta: params.delta,
              automationId: params.automationId,
              name: params.name,
              controlType: params.controlType,
              elementToken: params.elementToken,
              value: params.value,
              durationMs: params.durationMs
            },
            options,
            startEpoch
          );
          return {
            action: 'act',
            ...result
          };
        });
      }

      case 'batch': {
        if (!Array.isArray(params.steps) || params.steps.length === 0) {
          throw new Error('INVALID_BATCH_PARAMS: batch requires a non-empty steps array');
        }
        if (params.steps.length > MAX_BATCH_STEPS) {
          throw new Error(`BATCH_LIMIT_EXCEEDED: batch supports at most ${MAX_BATCH_STEPS} steps`);
        }
        const startEpoch = SubagentDispatcher.getEmergencyEpoch();
        return this.withDesktopMutex(async () => {
          const results: any[] = [];
          for (let i = 0; i < params.steps!.length; i++) {
            const step = params.steps![i];
            const stepHwnd = step.hwnd ?? params.hwnd;
            const stepDelivery = step.delivery ?? params.delivery;
            try {
              if (SubagentDispatcher.getEmergencyEpoch() !== startEpoch) {
                throw new Error(`EMERGENCY_STOP_ABORTED: Desktop batch aborted at step ${i + 1}`);
              }
              const res = await this.executeStep(
                { ...step, hwnd: stepHwnd, delivery: stepDelivery },
                options,
                startEpoch
              );
              results.push({ step: i + 1, ...res });
            } catch (err: any) {
              const errMsg = String(err?.message || err);
              const status = errMsg.includes('USER_INPUT_PREEMPTED')
                ? 'PAUSED_USER_PREEMPTION'
                : errMsg.includes('EMERGENCY_STOP_ABORTED')
                  ? 'ABORTED'
                  : 'PARTIAL_FAILURE';
              return {
                action: 'batch',
                status,
                completedSteps: results.length,
                nextStepIndex: i,
                error: errMsg,
                results
              };
            }
          }
          return {
            action: 'batch',
            status: 'COMPLETED',
            completedSteps: results.length,
            results
          };
        });
      }

      // --- Legacy v1 compatibility actions ---
      case 'mouse_move': {
        const x = assertFiniteCoord(params.x ?? 0, 'x');
        const y = assertFiniteCoord(params.y ?? 0, 'y');
        const startEpoch = SubagentDispatcher.getEmergencyEpoch();
        return this.withDesktopMutex(() =>
          this.executeStep(
            { op: 'move', x, y, hwnd: params.hwnd, delivery: 'foreground' },
            options,
            startEpoch
          )
        );
      }

      case 'click': {
        const startEpoch = SubagentDispatcher.getEmergencyEpoch();
        return this.withDesktopMutex(() =>
          this.executeStep(
            {
              op: 'click',
              x: params.x,
              y: params.y,
              hwnd: params.hwnd,
              elementToken: params.elementToken,
              button: params.button,
              delivery: params.delivery ?? 'auto'
            },
            options,
            startEpoch
          )
        );
      }

      case 'type_text': {
        const text = params.text || '';
        if (text.length > MAX_TEXT_LEN) {
          throw new Error(`TEXT_TOO_LONG: type_text text exceeds the ${MAX_TEXT_LEN} character limit`);
        }
        const startEpoch = SubagentDispatcher.getEmergencyEpoch();
        return this.withDesktopMutex(() =>
          this.executeStep(
            {
              op: 'type_text',
              text,
              hwnd: params.hwnd,
              elementToken: params.elementToken,
              delivery: params.delivery ?? 'auto'
            },
            options,
            startEpoch
          )
        );
      }

      default:
        throw new Error(`UNKNOWN_DESKTOP_HANDS_ACTION: ${(params as any).action}`);
    }
  }

  private static async executeStep(
    step: DesktopHandsStep,
    options: DesktopHandsExecuteOptions,
    startEpoch: number
  ): Promise<any> {
    if (SubagentDispatcher.getEmergencyEpoch() !== startEpoch) {
      throw new Error('EMERGENCY_STOP_ABORTED: Desktop step aborted by emergency stop');
    }

    const op = step.op;
    if (op === 'wait') {
      const durationMs = Number.isFinite(Number(step.durationMs)) ? Number(step.durationMs) : 200;
      await sleepSlicedWithEmergency(durationMs, startEpoch);
      return { op: 'wait', durationMs: Math.max(0, Math.min(MAX_WAIT_MS, Math.trunc(durationMs))), delivery: 'none' };
    }

    let hwnd = typeof step.hwnd === 'number' && step.hwnd > 0 ? Math.trunc(step.hwnd) : undefined;
    let resolvedToken: UiaElementTokenEntry | undefined;
    if (typeof step.elementToken === 'string' && step.elementToken.trim().length > 0) {
      resolvedToken = UiaBridge.resolveElementToken(step.elementToken, hwnd);
      if (!hwnd && resolvedToken.hwnd > 0) {
        hwnd = resolvedToken.hwnd;
      }
    }

    const requiresCoords =
      op === 'click' || op === 'double_click' || op === 'right_click' || op === 'move' || op === 'scroll';
    let rawX = step.x;
    let rawY = step.y;
    if (resolvedToken && (rawX === undefined || rawX === null) && (rawY === undefined || rawY === null) && requiresCoords) {
      if (resolvedToken.bounds.width <= 0 || resolvedToken.bounds.height <= 0) {
        throw new Error(
          `STALE_ELEMENT_TOKEN: Element token '${resolvedToken.token}' has zero/invalid bounds (${resolvedToken.bounds.width}x${resolvedToken.bounds.height})`
        );
      }
      rawX = Math.round(resolvedToken.bounds.x + resolvedToken.bounds.width / 2);
      rawY = Math.round(resolvedToken.bounds.y + resolvedToken.bounds.height / 2);
    }

    const x = requiresCoords
      ? assertFiniteCoord(rawX, 'x')
      : rawX !== undefined
        ? assertFiniteCoord(rawX, 'x')
        : undefined;
    const y = requiresCoords
      ? assertFiniteCoord(rawY, 'y')
      : rawY !== undefined
        ? assertFiniteCoord(rawY, 'y')
        : undefined;

    // Security fence before any UIA/input operation
    WinGuard.assertTargetAllowed({ hwnd, x, y });

    // UIA semantic operations (always background/UIA)
    if (op === 'invoke' || op === 'set_value' || op === 'toggle' || op === 'select' || op === 'focus') {
      const targetHwnd = assertPositiveHwnd(hwnd, `UIA ${op}`);
      const uiaRes = await UiaBridge.act({
        hwnd: targetHwnd,
        elementToken: resolvedToken?.token ?? step.elementToken,
        automationId: step.automationId,
        name: step.name,
        controlType: step.controlType,
        op,
        value: step.value ?? step.text
      });
      return {
        op,
        delivery: 'background_uia',
        hwnd: targetHwnd,
        ...uiaRes
      };
    }

    const requestedDelivery: DesktopDelivery = step.delivery ?? 'auto';
    const canBackground =
      Boolean(hwnd) &&
      (op === 'type_text' ||
        ((op === 'click' || op === 'double_click' || op === 'right_click' || op === 'scroll') &&
          x !== undefined &&
          y !== undefined));

    if (requestedDelivery === 'background') {
      if (!canBackground) {
        throw new Error(
          `BACKGROUND_DELIVERY_UNAVAILABLE: op '${op}' requires a target hwnd (and x/y for pointer ops) for background delivery`
        );
      }
    }
    const useForeground = classifyDesktopStepDelivery({
      op,
      hwnd,
      delivery: requestedDelivery,
      x,
      y,
      elementToken: resolvedToken?.token ?? step.elementToken
    });

    if (!useForeground && hwnd) {
      switch (op) {
        case 'click':
        case 'double_click':
        case 'right_click': {
          const px = assertFiniteCoord(x, 'x');
          const py = assertFiniteCoord(y, 'y');
          const button = op === 'right_click' ? 'right' : step.button || 'left';
          const dbl = op === 'double_click';
          const client = postMouseClick(hwnd, px, py, button, dbl);
          return {
            op,
            delivery: 'background_msg',
            hwnd,
            x: px,
            y: py,
            button,
            client,
            ...(resolvedToken ? { elementToken: resolvedToken.token } : {})
          };
        }
        case 'type_text': {
          const text = step.text || '';
          if (text.length > MAX_TEXT_LEN) {
            throw new Error(`TEXT_TOO_LONG: type_text text exceeds the ${MAX_TEXT_LEN} character limit`);
          }
          postText(hwnd, text);
          return {
            op,
            delivery: 'background_msg',
            hwnd,
            length: text.length,
            ...(resolvedToken ? { elementToken: resolvedToken.token } : {})
          };
        }
        case 'scroll': {
          const px = assertFiniteCoord(x, 'x');
          const py = assertFiniteCoord(y, 'y');
          const delta = assertFiniteCoord(step.delta ?? -3, 'delta');
          postScroll(hwnd, px, py, delta);
          return {
            op,
            delivery: 'background_msg',
            hwnd,
            x: px,
            y: py,
            delta,
            ...(resolvedToken ? { elementToken: resolvedToken.token } : {})
          };
        }
      }
    }

    // Foreground fallback path (SendInput)
    if (!options.foregroundFallback) {
      throw new Error(
        `FOREGROUND_FALLBACK_DISABLED: Operation '${op}' requires foreground fallback, which is currently disabled in settings.`
      );
    }
    WinGuard.assertNoUserPreemption(1500);

    if (hwnd) {
      focusWindow(hwnd);
    }

    switch (op) {
      case 'move': {
        const px = assertFiniteCoord(x, 'x');
        const py = assertFiniteCoord(y, 'y');
        foregroundMouseMove(px, py);
        return { op, delivery: 'foreground', x: px, y: py };
      }
      case 'click':
      case 'double_click':
      case 'right_click': {
        const px = assertFiniteCoord(x, 'x');
        const py = assertFiniteCoord(y, 'y');
        const button = op === 'right_click' ? 'right' : step.button || 'left';
        const dbl = op === 'double_click';
        foregroundClick(px, py, button, dbl);
        return { op, delivery: 'foreground', x: px, y: py, button };
      }
      case 'scroll': {
        const px = assertFiniteCoord(x, 'x');
        const py = assertFiniteCoord(y, 'y');
        const delta = assertFiniteCoord(step.delta ?? -3, 'delta');
        foregroundScroll(px, py, delta);
        return { op, delivery: 'foreground', x: px, y: py, delta };
      }
      case 'type_text': {
        const text = step.text || '';
        if (text.length > MAX_TEXT_LEN) {
          throw new Error(`TEXT_TOO_LONG: type_text text exceeds the ${MAX_TEXT_LEN} character limit`);
        }
        foregroundTypeText(text);
        return { op, delivery: 'foreground', length: text.length };
      }
      case 'hotkey': {
        if (!Array.isArray(step.keys) || step.keys.length === 0) {
          throw new Error('INVALID_HOTKEY_PARAMS: hotkey requires a non-empty keys array');
        }
        foregroundHotkey(step.keys);
        return { op, delivery: 'foreground', keys: step.keys };
      }
      default:
        throw new Error(`UNKNOWN_DESKTOP_OP: ${op}`);
    }
  }
}

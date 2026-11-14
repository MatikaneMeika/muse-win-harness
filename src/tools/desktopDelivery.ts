/**
 * Pure delivery-channel classification for Desktop Hands v2.
 * Shared between ApprovalEngine.evaluateRisk / isActionPreApproved and DesktopHands.executeStep
 * so risk evaluation and runtime delivery never drift apart.
 * Zero native/koffi/child_process imports.
 */

export type DesktopDeliveryMode = 'auto' | 'background' | 'foreground';

export interface DesktopDeliveryStepLike {
  op?: string;
  hwnd?: unknown;
  delivery?: string;
  x?: unknown;
  y?: unknown;
  elementToken?: unknown;
}

export interface DesktopDeliveryClassification {
  isPerception: boolean;
  isForeground: boolean;
  deliveryTag: 'read' | 'bg' | 'fg';
}

const UIA_OPS = new Set(['invoke', 'set_value', 'toggle', 'select', 'focus']);

const VALID_DESKTOP_ACTIONS = new Set([
  'windows',
  'inspect',
  'screenshot',
  'act',
  'batch',
  'mouse_move',
  'click',
  'type_text'
]);

/**
 * Normalizes desktop_hands client params so callers that supply `op` or `steps`
 * without an explicit top-level `action` are deterministically mapped to
 * `action: 'act'` or `action: 'batch'` before risk evaluation, approval hashing,
 * and execution.
 */
export function normalizeDesktopHandsParams(
  params: Record<string, any> | undefined
): Record<string, any> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return {};
  }
  const cloned = structuredClone(params);
  const rawAction = typeof cloned.action === 'string' ? cloned.action.trim() : '';
  if (!rawAction) {
    if (Array.isArray(cloned.steps)) {
      cloned.action = 'batch';
    } else if (typeof cloned.op === 'string' && cloned.op.trim().length > 0) {
      cloned.action = 'act';
    }
  }
  return cloned;
}

export function isValidDesktopHandsAction(action: unknown): boolean {
  return typeof action === 'string' && VALID_DESKTOP_ACTIONS.has(action);
}

function hasPositiveHwnd(val: unknown): boolean {
  // Strict check: runtime hwnd normalization only accepts real numbers, so a
  // string hwnd must classify as foreground (fail-closed) to match delivery.
  return typeof val === 'number' && Number.isFinite(val) && val > 0;
}

function hasFiniteCoord(val: unknown): boolean {
  return val !== undefined && val !== null && Number.isFinite(Number(val));
}

function hasValidElementToken(val: unknown): boolean {
  return typeof val === 'string' && val.trim().length > 0;
}

export function classifyDesktopStepDelivery(step: DesktopDeliveryStepLike): boolean {
  const op = typeof step.op === 'string' ? step.op : '';
  if (op === 'wait' || UIA_OPS.has(op)) {
    return false;
  }
  if (op === 'move' || op === 'hotkey') {
    return true;
  }

  const hwndOk = hasPositiveHwnd(step.hwnd);
  const hasPointerTarget =
    (hasFiniteCoord(step.x) && hasFiniteCoord(step.y)) || hasValidElementToken(step.elementToken);
  const canBackground =
    hwndOk &&
    (op === 'type_text' ||
      ((op === 'click' || op === 'double_click' || op === 'right_click' || op === 'scroll') &&
        hasPointerTarget));

  const requested = step.delivery === 'background' || step.delivery === 'foreground' ? step.delivery : 'auto';
  if (requested === 'background') {
    // Background-only throws if unavailable rather than falling back to foreground.
    return false;
  }
  if (requested === 'foreground') {
    return true;
  }
  return !canBackground;
}

export function classifyDesktopCall(params: Record<string, any> | undefined): DesktopDeliveryClassification {
  const p = normalizeDesktopHandsParams(params);
  const action = typeof p.action === 'string' ? p.action : '';

  if (action === 'windows' || action === 'inspect' || action === 'screenshot') {
    return { isPerception: true, isForeground: false, deliveryTag: 'read' };
  }

  let isForeground = false;
  if (action === 'mouse_move') {
    isForeground = true;
  } else if (action === 'click') {
    isForeground = classifyDesktopStepDelivery({
      op: 'click',
      hwnd: p.hwnd,
      delivery: p.delivery,
      x: p.x,
      y: p.y,
      elementToken: p.elementToken
    });
  } else if (action === 'type_text') {
    isForeground = classifyDesktopStepDelivery({
      op: 'type_text',
      hwnd: p.hwnd,
      delivery: p.delivery,
      elementToken: p.elementToken
    });
  } else if (action === 'act') {
    isForeground = classifyDesktopStepDelivery({
      op: p.op,
      hwnd: p.hwnd,
      delivery: p.delivery,
      x: p.x,
      y: p.y,
      elementToken: p.elementToken
    });
  } else if (action === 'batch') {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    isForeground = steps.some((s: any) =>
      classifyDesktopStepDelivery({
        op: s?.op,
        hwnd: s?.hwnd ?? p.hwnd,
        delivery: s?.delivery ?? p.delivery,
        x: s?.x,
        y: s?.y,
        elementToken: s?.elementToken ?? p.elementToken
      })
    );
  } else {
    isForeground = p.delivery === 'foreground';
  }

  return {
    isPerception: false,
    isForeground,
    deliveryTag: isForeground ? 'fg' : 'bg'
  };
}

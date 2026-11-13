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
}

export interface DesktopDeliveryClassification {
  isPerception: boolean;
  isForeground: boolean;
  deliveryTag: 'read' | 'bg' | 'fg';
}

const UIA_OPS = new Set(['invoke', 'set_value', 'toggle', 'select', 'focus']);

function hasPositiveHwnd(val: unknown): boolean {
  const n = Number(val);
  return Number.isFinite(n) && n > 0;
}

function hasFiniteCoord(val: unknown): boolean {
  return val !== undefined && val !== null && Number.isFinite(Number(val));
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
  const canBackground =
    hwndOk &&
    (op === 'type_text' ||
      ((op === 'click' || op === 'double_click' || op === 'right_click' || op === 'scroll') &&
        hasFiniteCoord(step.x) &&
        hasFiniteCoord(step.y)));

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
  const p = params || {};
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
      y: p.y
    });
  } else if (action === 'type_text') {
    isForeground = classifyDesktopStepDelivery({
      op: 'type_text',
      hwnd: p.hwnd,
      delivery: p.delivery
    });
  } else if (action === 'act') {
    isForeground = classifyDesktopStepDelivery({
      op: p.op,
      hwnd: p.hwnd,
      delivery: p.delivery,
      x: p.x,
      y: p.y
    });
  } else if (action === 'batch') {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    isForeground = steps.some((s: any) =>
      classifyDesktopStepDelivery({
        op: s?.op,
        hwnd: s?.hwnd ?? p.hwnd,
        delivery: s?.delivery ?? p.delivery,
        x: s?.x,
        y: s?.y
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

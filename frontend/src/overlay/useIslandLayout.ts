import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * 浮岛布局：位置 / 尺寸 / 胶囊三态，持久化在 localStorage。
 *
 * 交互契约（与注入端 shell/muse-settings-preload.cjs 保持一致）：
 * - 单击标题栏：胶囊与面板互相切换；
 * - 按住 90ms 后拖动：直接写 style.transform，松手才提交并持久化，触发瞬间整岛 Q弹一次；
 * - 右下角把手：拖动缩放，范围 360x200 ~ 720x520。
 */

export interface IslandLayoutState {
  w: number;
  h: number;
  x: number | null;
  y: number | null;
  capsule: boolean;
}

const STORE_KEY = 'mwh_island_layout_v2';
export const ISLAND_MIN_W = 432;
export const ISLAND_MIN_H = 240;
export const ISLAND_MAX_W = 864;
export const ISLAND_MAX_H = 624;
export const ISLAND_CAPSULE_W = 108;
export const ISLAND_CAPSULE_H = 42;
const LONG_PRESS_MS = 90;
const MOVE_THRESHOLD = 4;

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** 降低动态偏好下所有过渡直接跳变，避免晕动。 */
export const ISLAND_REDUCED_MOTION =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function readLayout(): IslandLayoutState {
  const fallback: IslandLayoutState = { w: 624, h: 384, x: null, y: null, capsule: false };
  if (typeof window === 'undefined') return fallback;
  // 存档可能被旧版本写坏，解析失败时回落默认布局而不是让覆盖层崩掉。
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<IslandLayoutState>;
    return {
      w: clamp(Number(parsed.w) || fallback.w, ISLAND_MIN_W, ISLAND_MAX_W),
      h: clamp(Number(parsed.h) || fallback.h, ISLAND_MIN_H, ISLAND_MAX_H),
      x: typeof parsed.x === 'number' ? parsed.x : null,
      y: typeof parsed.y === 'number' ? parsed.y : null,
      capsule: Boolean(parsed.capsule),
    };
  } catch (err) {
    console.error('mwh: island layout read failed', err);
    return fallback;
  }
}

function writeLayout(state: IslandLayoutState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('mwh: island layout save failed', err);
  }
}

interface PressState {
  pointerId: number;
  x: number;
  y: number;
  fired: boolean;
  timer: number | null;
}

export function useIslandLayout() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<IslandLayoutState>(readLayout());
  const [capsule, setCapsuleState] = useState<boolean>(layoutRef.current.capsule);
  const pressRef = useRef<PressState | null>(null);
  const dragRef = useRef<{ dx: number; dy: number; w: number } | null>(null);
  const resizeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const apply = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const layout = layoutRef.current;
    // 胶囊态宽度锁定 108px 绝对不变量，彻底根除视口右边界抖动反馈
    if (layout.capsule) {
      el.style.width = `${ISLAND_CAPSULE_W}px`;
      el.style.height = `${ISLAND_CAPSULE_H}px`;
    } else {
      el.style.width = `${layout.w}px`;
      el.style.height = `${layout.h}px`;
    }
    const w = layout.capsule ? ISLAND_CAPSULE_W : layout.w;
    const h = layout.capsule ? ISLAND_CAPSULE_H : layout.h;
    if (layout.x === null || layout.y === null) {
      layout.x = Math.max(12, window.innerWidth - w - 24);
      layout.y = Math.max(12, window.innerHeight - h - 96);
    }
    layout.x = clamp(layout.x, 12, Math.max(12, window.innerWidth - w - 12));
    layout.y = clamp(layout.y, 12, Math.max(12, window.innerHeight - h - 12));
    el.style.transform = `translate3d(${Math.round(layout.x)}px, ${Math.round(layout.y)}px, 0)`;
  }, []);

  useEffect(() => {
    apply();
    const onResize = () => apply();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply]);

  const setCapsule = useCallback(
    (next: boolean) => {
      if (layoutRef.current.capsule === next) return;
      layoutRef.current.capsule = next;
      setCapsuleState(next);
      apply();
      writeLayout(layoutRef.current);
    },
    [apply],
  );

  const toggleCapsule = useCallback(() => {
    setCapsule(!layoutRef.current.capsule);
  }, [setCapsule]);

  const onHeaderPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    const target = event.currentTarget;
    pressRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      fired: false,
      timer: null,
    };
    pressRef.current.timer = window.setTimeout(() => {
      const press = pressRef.current;
      const el = containerRef.current;
      if (!press || !el) return;
      press.fired = true;
      const currentW = layoutRef.current.capsule ? ISLAND_CAPSULE_W : el.offsetWidth;
      dragRef.current = {
        dx: press.x - (layoutRef.current.x ?? 0),
        dy: press.y - (layoutRef.current.y ?? 0),
        w: currentW,
      };
      el.style.transition = 'none';
      el.style.boxShadow = '0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.1)';
      el.style.cursor = 'grabbing';
      el.dataset.dragging = '1';
      try {
        document.body.dataset.mwhBadgeDragging = 'true';
      } catch {}
      if (!ISLAND_REDUCED_MOTION) {
        // 轻盈微弹提示：达到长按阈值那一刻整岛微弹性响应一次。
        el.classList.remove('mwh-island-pop');
        void el.offsetWidth;
        el.classList.add('mwh-island-pop');
        const clearPop = () => el.classList.remove('mwh-island-pop');
        el.addEventListener('animationend', clearPop, { once: true });
        window.setTimeout(clearPop, 240);
      }
    }, LONG_PRESS_MS);
    target.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const press = pressRef.current;
      if (press && !press.fired) {
        if (
          Math.abs(moveEvent.clientX - press.x) > MOVE_THRESHOLD ||
          Math.abs(moveEvent.clientY - press.y) > MOVE_THRESHOLD
        ) {
          if (press.timer) window.clearTimeout(press.timer);
          pressRef.current = null;
        }
        return;
      }
      if (!dragRef.current) return;
      const layout = layoutRef.current;
      const w = layout.capsule ? ISLAND_CAPSULE_W : dragRef.current.w;
      const h = layout.capsule ? ISLAND_CAPSULE_H : layout.h;
      layout.x = clamp(
        moveEvent.clientX - dragRef.current.dx,
        12,
        Math.max(12, window.innerWidth - w - 12),
      );
      layout.y = clamp(
        moveEvent.clientY - dragRef.current.dy,
        12,
        Math.max(12, window.innerHeight - h - 12),
      );
      el.style.transform = `translate3d(${Math.round(layout.x)}px, ${Math.round(layout.y)}px, 0)`;
    };

    const onUp = () => {
      const press = pressRef.current;
      const el = containerRef.current;
      if (press?.timer) window.clearTimeout(press.timer);
      try {
        delete document.body.dataset.mwhBadgeDragging;
      } catch {}
      if (dragRef.current) {
        dragRef.current = null;
        if (el) {
          el.style.cursor = '';
          el.style.boxShadow = '';
          el.style.scale = '';
          el.classList.remove('mwh-island-pop');
          el.style.transition = ISLAND_REDUCED_MOTION
            ? 'none'
            : 'transform 220ms cubic-bezier(0.22,1,0.36,1)';
          window.setTimeout(() => {
            if (el) el.style.transition = '';
          }, 240);
        }
        writeLayout(layoutRef.current);
        // 拖动收尾后短暂标记，避免紧接着的 click 又把岛收成胶囊。
        window.setTimeout(() => {
          if (el) delete el.dataset.dragging;
        }, 60);
      }
      pressRef.current = null;
      try {
        if (target.hasPointerCapture && target.hasPointerCapture(event.pointerId)) {
          target.releasePointerCapture(event.pointerId);
        }
      } catch {}
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      target.removeEventListener('lostpointercapture', onUp);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
    /* 捕获被系统/重绘抢走时也要收尾，否则 body 上的拖动态标记会残留，边缘缩放检测被长期抑制 */
    target.addEventListener('lostpointercapture', onUp);
  }, []);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.preventDefault();
      const target = event.currentTarget;
      const layout = layoutRef.current;
      if (layout.capsule) {
        layout.capsule = false;
        setCapsuleState(false);
        apply();
      }
      resizeRef.current = { x: event.clientX, y: event.clientY, w: layout.w, h: layout.h };
      target.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const current = resizeRef.current;
        if (!current) return;
        layoutRef.current.w = Math.round(
          clamp(current.w + (moveEvent.clientX - current.x), ISLAND_MIN_W, ISLAND_MAX_W),
        );
        layoutRef.current.h = Math.round(
          clamp(current.h + (moveEvent.clientY - current.y), ISLAND_MIN_H, ISLAND_MAX_H),
        );
        apply();
      };

      const onUp = () => {
        resizeRef.current = null;
        writeLayout(layoutRef.current);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
      };

      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    [apply],
  );

  return {
    containerRef,
    capsule,
    setCapsule,
    toggleCapsule,
    onHeaderPointerDown,
    onResizePointerDown,
  };
}

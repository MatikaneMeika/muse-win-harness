import React from 'react';
import { useReducedMotion } from 'motion/react';

/**
 * iOS 式布尔开关（浏览器调试面）。
 *
 * 规格真源：docs/DESIGN.md 4.1（静态）与 4.8（动效）。必须与
 * `shell/muse-settings-preload.cjs` 的 `.mwh-switch` 逐字一致，否则两处手感会分叉：
 * - 轨道 46×28、圆角 9999、圆点 22×22、内缩 3px、位移 18px；
 * - 开 = 任务栏同款紫蓝渐变 #8B5CF6 → #6366F1 → #3B82F6（--mwh-accent-grad），关 = 中性灰；
 * - 轨道 background-color 180ms ease、按下 transform 80ms ease；
 * - 圆点 transform 180ms cubic-bezier(.16,1,.3,1)；
 * - 焦点环 3px rgba(99,102,241,.16/.12)，禁用整体 0.45 不透明度；
 * - 不描边、不加投影（唯一例外是圆点自身的 1px 微投影）；
 * - 系统"减少动效"时全部过渡归零（对齐 CSS 的 prefers-reduced-motion 块）。
 */
export interface MwhSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 无障碍名称，同时作为原生 title 的兜底 */
  label: string;
  /** 跟随宿主明暗主题；暗色为默认 */
  dark?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function MwhSwitch({
  checked,
  onChange,
  label,
  dark = true,
  disabled = false,
  title,
  className = '',
}: MwhSwitchProps) {
  const prefersReducedMotion = useReducedMotion();
  const track = checked
    ? 'bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] hover:bg-[linear-gradient(135deg,#7C3AED_0%,#4F46E5_50%,#2563EB_100%)]'
    : dark
      ? 'bg-white/[0.09] hover:bg-white/[0.12]'
      : 'bg-black/[0.12] hover:bg-black/[0.16]';
  // 焦点环取 --mwh-accent-soft：暗 0.16 / 亮 0.12
  const focusRing = dark
    ? 'focus-visible:shadow-[0_0_0_3px_rgba(99,102,241,0.16)]'
    : 'focus-visible:shadow-[0_0_0_3px_rgba(99,102,241,0.12)]';
  const press = prefersReducedMotion ? 'active:scale-100' : 'active:scale-[0.97]';

  const trackMotion = {
    transition: prefersReducedMotion
      ? 'none'
      : 'background-color 180ms ease, transform 80ms ease',
  } as const;
  const dotMotion = {
    transition: prefersReducedMotion ? 'none' : 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  } as const;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title || label}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onChange(!checked);
      }}
      style={trackMotion}
      className={`relative inline-flex h-7 w-[46px] shrink-0 items-center rounded-full p-0 outline-none ${press} disabled:cursor-not-allowed disabled:opacity-[0.45] ${focusRing} ${track} ${className}`}
    >
      <span
        style={dotMotion}
        className={`pointer-events-none absolute left-[3px] top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] ${
          checked ? 'translate-x-[18px]' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export default MwhSwitch;

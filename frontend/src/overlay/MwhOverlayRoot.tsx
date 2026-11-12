import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useMwhState } from '../services/useMwhState';
import { LiveTaskFloatingIsland } from './LiveTaskFloatingIsland';
import { MwhSettingsModal } from './MwhSettingsModal';

/**
 * 上层核心交付物：`src/overlay/MwhOverlayRoot.tsx`
 * 通过 `pointer-events-none` 容器悬浮在 `https://muse.ai` WebView 之上（仅内部胶囊、灵动岛和弹窗本身为 `pointer-events-auto`）
 * 完全访问模式不绘制全窗口边框或内发光，警示只留在右上角徽章与状态胶囊。
 */
export const MwhOverlayRoot: React.FC = () => {
  const state = useMwhState();
  const prefersReducedMotion = useReducedMotion();

  return (
    <div
      data-testid="mwh-overlay-root"
      className="fixed inset-0 z-30 pointer-events-none overflow-hidden"
    >
      {/* 窗口按钮和设置在外框标题栏。浮层只留任务岛和设置窗。 */}

      {/* 组件 B：底部悬浮任务/审批/回滚灵动胶囊 */}
      <LiveTaskFloatingIsland />

      {/* 组件 C：中央圆角设置模态框 */}
      <MwhSettingsModal />

      {/* 顶部轻量操作反馈提示 (Toast) */}
      <AnimatePresence initial={false}>
        {state.lastCopiedToast && (
          <motion.div
            key="mwh-toast"
            role="status"
            aria-live="polite"
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            transition={
              prefersReducedMotion ? { duration: 0 } : { duration: 0.15, ease: [0.22, 1, 0.36, 1] }
            }
            className="fixed top-14 right-4 z-50 pointer-events-auto px-4 py-2 rounded-full text-xs font-medium bg-[#18181B]/95 text-white border border-white/[0.06] shadow-lg backdrop-blur-md"
          >
            {state.lastCopiedToast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

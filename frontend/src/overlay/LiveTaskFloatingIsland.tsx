import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  GitMerge,
  Loader2,
  Pin,
  RotateCcw,
  ShieldAlert,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { useTranslation } from '../i18n';
import { mwhService } from '../services/mwhService';
import { useMwhState } from '../services/useMwhState';
import { ISLAND_REDUCED_MOTION, useIslandLayout } from './useIslandLayout';

/** 日志行：块级流 + 固定行高，禁止被 flex 收缩压扁。 */
const LOG_LINE = 'block min-h-[17px] whitespace-nowrap overflow-hidden text-ellipsis';

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const ISLAND_TRANSITION = ISLAND_REDUCED_MOTION
  ? 'none'
  : `width 240ms ${EASE}, height 240ms ${EASE}, border-radius 240ms ${EASE}, opacity 180ms ${EASE}`;

/** 品牌紫蓝焦点环：2px #6366F1，仅键盘可见。 */
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6366F1]/70 focus-visible:ring-offset-0';

function initialElapsedSec(clock: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(clock || '').trim());
  if (!match) return 0;
  const now = new Date();
  const started = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  );
  const diff = Math.floor((now.getTime() - started.getTime()) / 1000);
  return diff >= 0 && diff < 86400 ? diff : 0;
}

/** 收起胶囊正文极简 2-3 个核心汉字，左右对齐居中，无多余噪点。 */
function islandCapsuleText(t: (key: string) => string, status?: string, fallback?: string): string {
  if (status === 'WAITING_APPROVAL') return t('island.capsule.waiting');
  if (status === 'RUNNING') return t('island.capsule.running');
  if (status === 'COMPLETED') return t('island.capsule.completed');
  if (status === 'IDLE') return t('island.capsule.idle');
  const str = String(fallback || status || '').trim();
  if (str.includes('授权') || str.includes('审批')) return t('island.capsule.waiting');
  if (str.includes('执行') || str.includes('运行')) return t('island.capsule.running');
  if (str.includes('完成') || str.includes('修改')) return t('island.capsule.completed');
  return str.length > 8 ? str.slice(0, 8) : str || t('island.capsule.idle');
}

export const LiveTaskFloatingIsland: React.FC = () => {
  const { t } = useTranslation();
  const state = useMwhState();
  const { liveTask } = state;
  const {
    containerRef,
    capsule,
    setCapsule,
    toggleCapsule,
    onHeaderPointerDown,
    onResizePointerDown,
  } = useIslandLayout();
  const [fading, setFading] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [confirmingKill, setConfirmingKill] = useState(false);
  const elapsedBaseRef = useRef(0);
  const elapsedKeyRef = useRef('');
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    setConfirmingKill(false);
  }, [liveTask.status, liveTask.id]);

  useEffect(() => {
    if (!confirmingKill) return;
    const t = window.setTimeout(() => setConfirmingKill(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmingKill]);

  const isLight = state.chromeDark === false;
  const hasModifiedFiles = liveTask.modifiedFilesCount > 0;
  const trackingUnavailable = liveTask.changeTracking === 'unavailable';
  const matchingWt = liveTask.worktreeId
    ? state.worktrees.find((wt) => wt.id === liveTask.worktreeId)
    : undefined;
  const canRollback = hasModifiedFiles && Boolean(liveTask.snapshotId);
  const canMergeWorktree =
    hasModifiedFiles &&
    Boolean(liveTask.worktreeId) &&
    Boolean(matchingWt) &&
    matchingWt!.status !== 'MISSING' &&
    matchingWt!.status !== 'MERGED';
  const autoDismiss = liveTask.status === 'COMPLETED' && !canRollback && !canMergeWorktree;

  /** 耗时逐秒走动：基线只在任务 ID 变化时重置，不被 SSE 帧抖动打回原点。 */
  useEffect(() => {
    if (liveTask.status !== 'RUNNING') {
      setElapsedSec(0);
      elapsedKeyRef.current = '';
      return;
    }
    const key = liveTask.id || liveTask.startedAt;
    if (elapsedKeyRef.current !== key) {
      elapsedKeyRef.current = key;
      elapsedBaseRef.current = Date.now() - initialElapsedSec(liveTask.startedAt) * 1000;
    }
    const tick = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - elapsedBaseRef.current) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [liveTask.status, liveTask.id, liveTask.startedAt]);

  const elapsedLabel =
    elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`;

  const activeAgentBadge =
    liveTask.sourceAgent && liveTask.sourceAgent !== 'Muse Cloud MCP' ? liveTask.sourceAgent : '';

  useEffect(() => {
    if (!autoDismiss) {
      setFading(false);
      return;
    }
    const fadeTimer = window.setTimeout(() => setFading(true), 3800);
    const dismissTimer = window.setTimeout(() => {
      mwhService.dismissCompletedLiveTask();
    }, 4000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(dismissTimer);
    };
  }, [autoDismiss, liveTask.id, liveTask.startedAt]);

  useEffect(() => {
    const el = logRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [liveTask.stdoutLines, liveTask.status, capsule]);

  const isIdle = liveTask.status === 'IDLE';
  const visible = !state.settingsModalOpen;
  const hidden = !visible || fading;

  useEffect(() => {
    if (isIdle) setCapsule(true);
  }, [isIdle, setCapsule]);

  const prevTaskKeyRef = useRef('');
  const autoExpandedTaskRef = useRef('');
  useEffect(() => {
    const taskKey =
      liveTask.id || `${String(liveTask.command || '')}|${String(liveTask.startedAt || '')}`;
    const isNewTask = prevTaskKeyRef.current !== taskKey;
    prevTaskKeyRef.current = taskKey;
    if (liveTask.status !== 'WAITING_APPROVAL' || !capsule || !isNewTask) return;
    if (autoExpandedTaskRef.current === taskKey) return;
    autoExpandedTaskRef.current = taskKey;
    setCapsule(false);
  }, [liveTask, capsule, setCapsule]);

  const completedTitle = hasModifiedFiles
    ? t('island.completedWithCount', { count: liveTask.modifiedFilesCount })
    : trackingUnavailable
      ? t('island.completedUnknown')
      : t('island.completedNoChanges');

  const capsuleTitle = (text: string) =>
    capsule ? islandCapsuleText(t, liveTask.status, text) : text;
  const headerTitle = isIdle
    ? capsule
      ? t('island.idleShort')
      : t('island.idleLong')
    : liveTask.status === 'WAITING_APPROVAL'
      ? capsuleTitle(t('island.waitingHeader', { agent: liveTask.sourceAgent }))
      : liveTask.status === 'COMPLETED'
        ? capsuleTitle(completedTitle)
        : capsuleTitle(liveTask.stepLabel || t('island.runningDefault'));

  /* Muse 官方浮层色阶：#1C1D20 面板 / #141518 代码区 / 7% 描边 / 20px 圆角 */
  const shellCls = isLight
    ? 'bg-[#EFECE6]/95 border-black/[0.06] text-[#1D1D1F] shadow-[0_12px_40px_rgba(17,17,18,0.14)]'
    : 'bg-[#1C1D20]/95 border-white/[0.07] text-[#ECECEE] shadow-[0_16px_44px_rgba(0,0,0,0.45)]';
  const codeCls = isLight ? 'bg-[#F2F1EC] text-[#2B2B30]' : 'bg-[#141518] text-[#C4C5CC]';
  const pillGhost = isLight
    ? 'bg-black/[0.06] hover:bg-black/[0.12] text-[#2C2C30]'
    : 'bg-white/[0.08] hover:bg-white/[0.14] text-[#E2E3E8]';
  const pillAccent = isLight
    ? 'bg-[#EEF2FF] hover:bg-[#E0E7FF] text-[#4F46E5]'
    : 'bg-[#6366F1]/20 hover:bg-[#6366F1]/30 text-[#A5B4FC]';
  const iconBtnCls = isLight
    ? 'hover:bg-black/[0.06] text-[#3C3C42]'
    : 'hover:bg-white/[0.08] text-[#D4D5DC]';
  const mutedCls = isLight ? 'text-[#63636A]' : 'text-[#9E9FA6]';

  const handleHeaderClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).closest('[data-island-header]')) return;
    if ((event.target as HTMLElement).closest('button')) return;
    if (containerRef.current?.dataset.dragging === '1') return;
    toggleCapsule();
  };

  return (
    <div
      ref={containerRef}
      data-testid="live-task-floating-island"
      data-tour-id="tour-approval-island"
      role="region"
      aria-label={t('island.panelAria')}
      onClick={handleHeaderClick}
      className={`fixed left-0 top-0 z-40 flex flex-col overflow-hidden backdrop-blur-xl border ${shellCls} ${
        capsule
          ? 'w-[108px] min-w-[108px] max-w-[108px] h-[42px] min-h-[42px] max-h-[42px] rounded-full cursor-pointer box-border'
          : 'rounded-[20px]'
      } ${hidden ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'}`}
      style={{ transition: ISLAND_TRANSITION, willChange: 'transform' }}
    >
      {/* Header：按住 90ms 拖动，单击切换胶囊 */}
      <div
        data-island-header="1"
        onPointerDown={onHeaderPointerDown}
        className={`flex items-center gap-2 shrink-0 px-4 cursor-grab select-none touch-none ${
          capsule ? 'h-[42px] w-[108px] px-3 justify-center box-border' : 'h-[52px]'
        }`}
      >
        {liveTask.status === 'WAITING_APPROVAL' ? (
          <ShieldAlert className="w-4 h-4 text-[#EAB364] shrink-0" />
        ) : liveTask.status === 'COMPLETED' ? (
          <CheckCircle2 className="w-4 h-4 text-[#38BDF8] shrink-0" />
        ) : isIdle ? (
          <span className="w-2 h-2 rounded-full bg-[#8E909A] shrink-0" />
        ) : (
          <Loader2 className="w-4 h-4 text-[#8B5CF6] animate-spin shrink-0" />
        )}

        {!capsule && activeAgentBadge && (
          <span
            data-testid="live-task-agent-badge"
            className={`px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold shrink-0 ${pillAccent}`}
          >
            [{activeAgentBadge}]
          </span>
        )}

        <span
          className={`font-semibold ${
            capsule ? 'text-[13px] text-center tracking-wide' : 'text-[14px] truncate min-w-0'
          }`}
          data-testid={liveTask.status === 'COMPLETED' ? 'live-task-completed-title' : undefined}
        >
          {headerTitle}
        </span>

        <div className={`${capsule ? 'hidden' : 'ml-auto'} flex items-center gap-2 min-w-0`}>
          {!capsule && liveTask.status === 'RUNNING' && (
            <span className="text-[11px] font-mono opacity-65 whitespace-nowrap min-w-0 truncate">
              {t('island.runningMeta', { elapsed: elapsedLabel, step: liveTask.stepIndex })}
              {liveTask.totalSteps}
            </span>
          )}
          {!capsule && liveTask.status === 'WAITING_APPROVAL' && (() => {
            const queueCount = state.pendingApprovals?.length || 0;
            const currentPending = state.pendingApprovals?.find((p) => p.id === liveTask.id);
            const currentIndex = state.pendingApprovals?.findIndex((p) => p.id === liveTask.id) ?? -1;
            const queuePos = currentIndex >= 0 ? currentIndex + 1 : 1;
            const isCriticalHmac = Boolean(currentPending?.requiresMobileHmac);
            return (
              <span className="text-[11px] font-mono opacity-75 whitespace-nowrap min-w-0 truncate flex items-center gap-1.5">
                {isCriticalHmac && (
                  <span className="px-1.5 py-0.5 rounded bg-[#E06C60]/20 text-[#E06C60] text-[10px] font-semibold">
                    {t('island.highRiskSignature')}
                  </span>
                )}
                {queueCount > 1 && (
                  <span className="px-1.5 py-0.5 rounded bg-[#6366F1]/25 text-[#A5B4FC] text-[10px] font-semibold">
                    {t('island.queueBadge', { pos: queuePos, count: queueCount })}
                  </span>
                )}
                <span>
                  {t('island.riskBadge', { risk: liveTask.riskScore })}
                  {liveTask.worktreeId ? ` · Worktree: ${liveTask.worktreeId}` : ''}
                </span>
              </span>
            );
          })()}
          {!capsule && liveTask.status === 'COMPLETED' && liveTask.testResultSummary && (
            <span className="text-[11px] font-mono opacity-70 whitespace-nowrap min-w-0 truncate">
              {liveTask.testResultSummary}
            </span>
          )}

          {!capsule && liveTask.status === 'RUNNING' && (
            confirmingKill ? (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-testid="live-task-kill-confirm-btn"
                  onClick={() => {
                    setConfirmingKill(false);
                    mwhService.killRunningLiveTask();
                  }}
                  className={`px-3 py-1 rounded-full text-xs font-semibold bg-[#E06C60] hover:bg-[#D05A4E] text-white flex items-center gap-1 transition-colors duration-120 cursor-pointer whitespace-nowrap ring-2 ring-[#F28B82]/50 ${FOCUS_RING}`}
                >
                  <ShieldAlert className="w-3 h-3" />
                  <span>{t('island.confirmKillPrompt')}</span>
                </button>
                <button
                  type="button"
                  data-testid="live-task-kill-cancel-btn"
                  onClick={() => setConfirmingKill(false)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium ${pillGhost} transition-colors duration-120 cursor-pointer whitespace-nowrap ${FOCUS_RING}`}
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="live-task-kill-trigger-btn"
                onClick={() => setConfirmingKill(true)}
                className={`px-3 py-1 rounded-full text-xs font-semibold bg-[#E06C60]/90 hover:bg-[#D05A4E] text-white flex items-center gap-1 transition-colors duration-120 cursor-pointer whitespace-nowrap ${FOCUS_RING}`}
              >
                <Square className="w-3 h-3 fill-current" />
                <span>{t('island.killBtn')}</span>
              </button>
            )
          )}

          {!capsule && liveTask.status === 'COMPLETED' && (
            <button
              type="button"
              onClick={() => mwhService.dismissCompletedLiveTask()}
              aria-label={t('island.dismissAria')}
              className={`w-7 h-7 rounded-full flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity duration-120 cursor-pointer ${FOCUS_RING}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="button"
            aria-label={capsule ? t('island.expandAria') : t('island.collapseAria')}
            aria-expanded={!capsule}
            onClick={() => toggleCapsule()}
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer ${iconBtnCls} ${FOCUS_RING} ${
              capsule ? 'rotate-180' : ''
            }`}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className={`flex-1 min-h-0 flex flex-col gap-2 px-3 ${capsule ? 'hidden' : 'flex'}`}>
        {isIdle && (
          <div className="flex-1 min-h-0 flex flex-col justify-center gap-1 px-1">
            <p className="text-[13px] opacity-90">{t('island.idleTitle')}</p>
            <p className={`text-[11.5px] leading-relaxed ${mutedCls}`}>
              {t('island.idleDesc')}
            </p>
          </div>
        )}

        {liveTask.status === 'WAITING_APPROVAL' && (
          <>
            <p className="text-[13px] opacity-90 leading-snug">{liveTask.summary}</p>
            <div
              className={`flex-1 min-h-0 overflow-y-auto rounded-xl px-3 py-2 font-mono text-[11px] leading-[1.65] ${codeCls}`}
            >
              <span className={LOG_LINE} title={liveTask.command}>
                <span className="opacity-55 select-none">$ </span>
                {liveTask.command}
              </span>
              <span className={`${LOG_LINE} opacity-75`} title={liveTask.targetPath}>
                {t('island.targetPath', { path: liveTask.targetPath })}
              </span>
            </div>
          </>
        )}

        {liveTask.status === 'RUNNING' && (
          <div
            ref={logRef}
            data-island-log
            onScroll={(event) => {
              const el = event.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className={`flex-1 min-h-0 overflow-y-auto overscroll-contain rounded-xl px-3 py-2 font-mono text-[11.5px] leading-[1.65] ${codeCls}`}
          >
            <span className={`${LOG_LINE} opacity-75`} title={liveTask.command}>
              <Terminal className="w-3 h-3 inline align-[-2px] mr-1.5" />
              {liveTask.command}
            </span>
            {liveTask.stdoutLines.map((line, i) => (
              <span key={i} className={LOG_LINE} title={line}>
                {line}
              </span>
            ))}
          </div>
        )}

        {liveTask.status === 'COMPLETED' && (canRollback || canMergeWorktree) && (
          <div className={`rounded-xl px-3 py-2 font-mono text-[11.5px] ${codeCls}`}>
            <span
              className={LOG_LINE}
              title={`${liveTask.snapshotId || ''} ${liveTask.worktreeId || ''}`.trim()}
            >
              {canRollback ? t('island.snapshotTag', { id: liveTask.snapshotId }) : ''}
              {canRollback && canMergeWorktree ? ' · ' : ''}
              {canMergeWorktree ? `Worktree: ${liveTask.worktreeId}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Foot */}
      {!capsule && (
        <div className="shrink-0 flex flex-wrap items-center justify-end gap-2 px-3 pt-2 pb-3">
          {liveTask.status === 'WAITING_APPROVAL' && (() => {
            const currentPending = state.pendingApprovals?.find((p) => p.id === liveTask.id);
            const isCriticalHmac = Boolean(currentPending?.requiresMobileHmac);
            const hasDesktopHwnd =
              !isCriticalHmac &&
              ((typeof liveTask.targetHwnd === 'number' && liveTask.targetHwnd > 0) ||
                (typeof currentPending?.targetHwnd === 'number' && currentPending.targetHwnd > 0) ||
                (String(liveTask.command || '').startsWith('desktop_hands(') &&
                  /"hwnd"\s*:\s*[1-9]\d*/.test(String(liveTask.command || ''))));
            return (
              <>
                <button
                  type="button"
                  onClick={() => mwhService.rejectLiveTask()}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-medium min-w-0 max-w-full flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${pillGhost} ${FOCUS_RING}`}
                >
                  <X className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{t('island.denyBtn')}</span>
                </button>
                {hasDesktopHwnd && (
                  <button
                    type="button"
                    data-testid="live-task-approve-session-btn"
                    onClick={() => mwhService.approveLiveTaskAppSession()}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-medium min-w-0 max-w-full flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${pillAccent} ${FOCUS_RING}`}
                  >
                    <Pin className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{t('island.allowAppSessionBtn')}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => mwhService.approveLiveTaskWorkspaceAlways()}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-medium min-w-0 max-w-full flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${pillGhost} ${FOCUS_RING}`}
                >
                  <Pin className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{t('island.alwaysInWorkspaceBtn')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => mwhService.approveLiveTaskOnce()}
                  className={`px-4 py-1.5 rounded-full text-xs font-semibold min-w-0 max-w-full bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] hover:bg-[linear-gradient(135deg,#7C3AED_0%,#4F46E5_50%,#2563EB_100%)] text-white flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${FOCUS_RING}`}
                >
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{t('island.allowOnceBtn')}</span>
                </button>
              </>
            );
          })()}

          {liveTask.status === 'COMPLETED' && canRollback && (
            <button
              type="button"
              data-testid="live-task-rollback-button"
              onClick={() => mwhService.rollbackSnapshot(liveTask.snapshotId!)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${pillGhost} ${FOCUS_RING}`}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('island.rollbackBtn')}</span>
            </button>
          )}

          {liveTask.status === 'COMPLETED' && canMergeWorktree && (
            <button
              type="button"
              data-testid="live-task-merge-button"
              onClick={() => mwhService.mergeWorktree(liveTask.worktreeId!)}
              className={`px-4 py-1.5 rounded-full text-xs font-semibold bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] hover:bg-[linear-gradient(135deg,#7C3AED_0%,#4F46E5_50%,#2563EB_100%)] text-white flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${FOCUS_RING}`}
            >
              <GitMerge className="w-3.5 h-3.5" />
              <span>{t('island.mergeWorktreeBtn')}</span>
            </button>
          )}
        </div>
      )}

      {/* 右下角缩放手柄 */}
      {!capsule && (
        <div
          onPointerDown={onResizePointerDown}
          aria-label={t('island.resizeAria')}
          className="absolute bottom-0 right-0 w-[18px] h-[18px] cursor-nwse-resize touch-none"
        />
      )}
    </div>
  );
};

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
import { mwhService } from '../services/mwhService';
import { useMwhState } from '../services/useMwhState';
import { ISLAND_REDUCED_MOTION, useIslandLayout } from './useIslandLayout';

/** 日志行：块级流 + 固定行高，禁止被 flex 收缩压扁。 */
const LOG_LINE = 'block min-h-[17px] whitespace-nowrap overflow-hidden text-ellipsis';

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const ISLAND_TRANSITION = ISLAND_REDUCED_MOTION
  ? 'none'
  : `width 240ms ${EASE}, height 240ms ${EASE}, border-radius 240ms ${EASE}, opacity 180ms ${EASE}`;

/** Muse 官方焦点环：2px Muse 蓝，仅键盘可见。 */
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B7FFF]/70 focus-visible:ring-offset-0';

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
function islandCapsuleText(status?: string, fallback?: string): string {
  if (status === 'WAITING_APPROVAL') return '待授权';
  if (status === 'RUNNING') return '运行中';
  if (status === 'COMPLETED') return '已完成';
  if (status === 'IDLE') return '待命';
  const str = String(fallback || status || '').trim();
  if (str.includes('授权') || str.includes('审批')) return '待授权';
  if (str.includes('执行') || str.includes('运行')) return '运行中';
  if (str.includes('完成') || str.includes('修改')) return '已完成';
  return str.length > 3 ? str.slice(0, 3) : str || '待命';
}

export const LiveTaskFloatingIsland: React.FC = () => {
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
  // 胶囊常驻：空闲时也保留在屏幕上，只收成胶囊；仅设置弹窗打开时让位。
  // 注：React 岛布局不走主进程文件镜像持久化——其 localStorage 挂在本机 daemon origin，
  // 无外站清空风险，且浏览器表面无法走 IPC（主进程文件镜像只服务注入岛）。
  const visible = !state.settingsModalOpen;
  const hidden = !visible || fading;

  useEffect(() => {
    if (isIdle) setCapsule(true);
  }, [isIdle, setCapsule]);

  // 待审批自动展开一次：仅当"新任务到来"且当前为胶囊时自动展开；
  // 同一任务只自动展开一次，用户手动收起后不反复弹开，下一个新任务到来才再次展开。
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
    ? `本地任务执行完成 · 修改 ${liveTask.modifiedFilesCount} 个文件`
    : trackingUnavailable
      ? '执行完成 · 改动数未统计'
      : '执行完成 · 未检测到文件改动';

  // 收起胶囊态：仅保留 2-3 字核心状态，展开态保留完整标题。
  const capsuleTitle = (text: string) =>
    capsule ? islandCapsuleText(liveTask.status, text) : text;
  const headerTitle = isIdle
    ? capsule
      ? '待命'
      : '空闲·待命'
    : liveTask.status === 'WAITING_APPROVAL'
      ? capsuleTitle(`等待本机执行授权 · ${liveTask.sourceAgent}`)
      : liveTask.status === 'COMPLETED'
        ? capsuleTitle(completedTitle)
        : capsuleTitle(liveTask.stepLabel || '本地任务执行中');

  /* Muse 官方浮层色阶：#1E1F24 面板 / #141518 代码区 / 8% 描边 / 20px 圆角 */
  const shellCls = isLight
    ? 'bg-white/95 border-black/[0.07] text-[#1D1D1F] shadow-[0_12px_40px_rgba(17,17,18,0.14)]'
    : 'bg-[#1E1F24]/95 border-white/[0.08] text-[#ECECEE] shadow-[0_16px_44px_rgba(0,0,0,0.45)]';
  const codeCls = isLight ? 'bg-[#F2F1EC] text-[#2B2B30]' : 'bg-[#141518] text-[#C6C7D0]';
  const pillGhost = isLight
    ? 'bg-black/[0.06] hover:bg-black/[0.12] text-[#2C2C30]'
    : 'bg-white/[0.08] hover:bg-white/[0.14] text-[#E2E3E8]';
  const pillAccent = isLight
    ? 'bg-[#E5EDFF] hover:bg-[#D4E2FF] text-[#1D58D8]'
    : 'bg-[#2B7FFF]/20 hover:bg-[#2B7FFF]/30 text-[#8AB8FF]';
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
      role="region"
      aria-label="MWH 底部任务与审批面板"
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
          <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0" />
        ) : liveTask.status === 'COMPLETED' ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
        ) : isIdle ? (
          <span className="w-2 h-2 rounded-full bg-[#8E909A] shrink-0" />
        ) : (
          <Loader2 className="w-4 h-4 text-[#4A8CFF] animate-spin shrink-0" />
        )}

        {!capsule && activeAgentBadge && (
          <span
            data-testid="live-task-agent-badge"
            className={`px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold shrink-0 ${
              isLight ? 'bg-black/[0.06] text-[#2C2C30]' : 'bg-white/[0.08] text-[#C4C5CC]'
            }`}
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
              CREATE_NO_WINDOW · 耗时 {elapsedLabel} · 步骤 {liveTask.stepIndex}/
              {liveTask.totalSteps}
            </span>
          )}
          {!capsule && liveTask.status === 'WAITING_APPROVAL' && (
            <span className="text-[11px] font-mono opacity-65 whitespace-nowrap min-w-0 truncate">
              风险 {liveTask.riskScore}
              {liveTask.worktreeId ? ` · Worktree: ${liveTask.worktreeId}` : ''}
            </span>
          )}
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
                  className={`px-3 py-1 rounded-full text-xs font-semibold bg-red-600 hover:bg-red-700 text-white flex items-center gap-1 transition-colors duration-120 cursor-pointer whitespace-nowrap ring-2 ring-red-400/60 ${FOCUS_RING}`}
                >
                  <ShieldAlert className="w-3 h-3" />
                  <span>确认强杀？</span>
                </button>
                <button
                  type="button"
                  data-testid="live-task-kill-cancel-btn"
                  onClick={() => setConfirmingKill(false)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium ${pillGhost} transition-colors duration-120 cursor-pointer whitespace-nowrap ${FOCUS_RING}`}
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="live-task-kill-trigger-btn"
                onClick={() => setConfirmingKill(true)}
                className={`px-3 py-1 rounded-full text-xs font-semibold bg-red-500/90 hover:bg-red-600 text-white flex items-center gap-1 transition-colors duration-120 cursor-pointer whitespace-nowrap ${FOCUS_RING}`}
              >
                <Square className="w-3 h-3 fill-current" />
                <span>强杀中止</span>
              </button>
            )
          )}

          {!capsule && liveTask.status === 'COMPLETED' && (
            <button
              type="button"
              onClick={() => mwhService.dismissCompletedLiveTask()}
              aria-label="关闭任务提示"
              className={`w-7 h-7 rounded-full flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity duration-120 cursor-pointer ${FOCUS_RING}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="button"
            aria-label={capsule ? '展开任务面板' : '收起为胶囊'}
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
            <p className="text-[13px] opacity-90">当前没有进行中的本机任务</p>
            <p className={`text-[11.5px] leading-relaxed ${mutedCls}`}>
              云端下发命令后会在这里实时显示进度、耗时与输出；点右侧箭头可收成胶囊常驻。
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
                目标路径: {liveTask.targetPath}
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
              {canRollback ? `写前影子快照: ${liveTask.snapshotId}` : ''}
              {canRollback && canMergeWorktree ? ' · ' : ''}
              {canMergeWorktree ? `Worktree: ${liveTask.worktreeId}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Foot */}
      {!capsule && (
        <div className="shrink-0 flex flex-wrap items-center justify-end gap-2 px-3 pt-2 pb-3">
          {liveTask.status === 'WAITING_APPROVAL' && (
            <>
              <button
                type="button"
                onClick={() => mwhService.rejectLiveTask()}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${pillGhost} ${FOCUS_RING}`}
              >
                <X className="w-3.5 h-3.5" />
                <span>拒绝</span>
              </button>
              <button
                type="button"
                onClick={() => mwhService.approveLiveTaskWorkspaceAlways()}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${pillGhost} ${FOCUS_RING}`}
              >
                <Pin className="w-3.5 h-3.5" />
                <span>本工作区始终允许</span>
              </button>
              <button
                type="button"
                onClick={() => mwhService.approveLiveTaskOnce()}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold bg-[#2B7FFF] hover:bg-[#1A6FEF] text-white flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${FOCUS_RING}`}
              >
                <Check className="w-3.5 h-3.5" />
                <span>允许一次</span>
              </button>
            </>
          )}

          {liveTask.status === 'COMPLETED' && canRollback && (
            <button
              type="button"
              data-testid="live-task-rollback-button"
              onClick={() => mwhService.rollbackSnapshot(liveTask.snapshotId!)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${pillGhost} ${FOCUS_RING}`}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>一键回滚快照 (Rollback)</span>
            </button>
          )}

          {liveTask.status === 'COMPLETED' && canMergeWorktree && (
            <button
              type="button"
              data-testid="live-task-merge-button"
              onClick={() => mwhService.mergeWorktree(liveTask.worktreeId!)}
              className={`px-4 py-1.5 rounded-full text-xs font-semibold bg-[#2B7FFF] hover:bg-[#1A6FEF] text-white flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${FOCUS_RING}`}
            >
              <GitMerge className="w-3.5 h-3.5" />
              <span>合并 Worktree</span>
            </button>
          )}
        </div>
      )}

      {/* 右下角缩放手柄 */}
      {!capsule && (
        <div
          onPointerDown={onResizePointerDown}
          aria-label="调整面板大小"
          className="absolute bottom-0 right-0 w-[18px] h-[18px] cursor-nwse-resize touch-none"
        />
      )}
    </div>
  );
};

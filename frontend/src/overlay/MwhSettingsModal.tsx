import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit2,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderPlus,
  GitMerge,
  Grid,
  Hand,
  Loader2,
  Lock,
  Monitor,
  Plus,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AuditDecision,
  ConfinementMode,
  getPermissionProfileMeta,
  PERMISSION_PROFILE_LIST,
  TunnelDriverType,
} from '../services/mwhRules';
import { mwhService, MwhState, ShadowSnapshot, AcpProfile } from '../services/mwhService';
import { useMwhState } from '../services/useMwhState';

const NAV_ITEMS: Array<{
  id: MwhState['activeSettingsTab'];
  label: string;
  sectionHeader: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'connectors', label: '连接器', sectionHeader: '连接器与隧道', icon: Grid },
  { id: 'permissions', label: '权限', sectionHeader: '权限与安全模式', icon: Hand },
  { id: 'daemon', label: '设备', sectionHeader: '本地电脑引擎', icon: Monitor },
  { id: 'subagents', label: '代理', sectionHeader: '本地代理与 Worktree', icon: Bot },
  { id: 'snapshots-audit', label: '数据控制', sectionHeader: '快照回滚与审计日志', icon: FileText },
];

type SnapshotSortOrder = 'newest' | 'oldest' | 'files-desc';

interface WorkspaceSnapshotGroup {
  normKey: string;
  displayPath: string;
  parentPrefix: string;
  folderName: string;
  items: ShadowSnapshot[];
}

function normalizeWinPath(rawPath: string): {
  normKey: string;
  displayPath: string;
  parentPrefix: string;
  folderName: string;
} {
  const trimmed = (rawPath || '未归类工作区').trim().replace(/\//g, '\\').replace(/\\+$/, '');
  const displayPath = trimmed || '未归类工作区';
  const normKey = displayPath.toLowerCase();
  const segments = displayPath.split('\\').filter(Boolean);
  if (segments.length <= 1) {
    return {
      normKey,
      displayPath,
      parentPrefix: '',
      folderName: displayPath,
    };
  }
  const folderName = segments[segments.length - 1];
  const parentPrefix = segments.slice(0, -1).join('\\');
  return {
    normKey,
    displayPath,
    parentPrefix,
    folderName,
  };
}

function parseModifiedFileCount(diffStat: string): number {
  const m = String(diffStat || '').match(/(\d+)\s*files?/i);
  if (m) return Number(m[1]) || 0;
  return 0;
}

function formatCompactTime(ts: string): string {
  const raw = String(ts || '').trim();
  if (!raw) return '--';
  // Convert ISO or full date-time into compact MM-DD HH:mm:ss when possible
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
      d.getMinutes(),
    )}:${pad(d.getSeconds())}`;
  }
  return raw.length > 19 ? raw.slice(0, 19) : raw;
}

export const MwhSettingsModal: React.FC = () => {
  const state = useMwhState();
  const prefersReducedMotion = useReducedMotion();
  const [newWorkspaceInput, setNewWorkspaceInput] = useState('');
  const [confirmingEmergencyKill, setConfirmingEmergencyKill] = useState(false);
  const [auditFilter, setAuditFilter] = useState<'ALL' | AuditDecision>('ALL');
  const [worktreePageMap, setWorktreePageMap] = useState<Record<string, number>>({});
  const [requestedSpawnMode, setRequestedSpawnMode] = useState<ConfinementMode>('workspace-write');

  // ACP Subagents State & Modal
  const [acpModalOpen, setAcpModalOpen] = useState(false);
  const [acpEditingId, setAcpEditingId] = useState<string | null>(null);
  const [acpFormId, setAcpFormId] = useState('');
  const [acpFormDisplayName, setAcpFormDisplayName] = useState('');
  const [acpFormCommand, setAcpFormCommand] = useState('');
  const [acpFormArgs, setAcpFormArgs] = useState('');
  const [acpFormEnabled, setAcpFormEnabled] = useState(true);
  const [acpProbeStatus, setAcpProbeStatus] = useState<{
    tested: boolean;
    available?: boolean;
    path?: string;
    error?: string;
  } | null>(null);
  const [acpSaving, setAcpSaving] = useState(false);

  const openAcpCreateModal = () => {
    setAcpEditingId(null);
    setAcpFormId('');
    setAcpFormDisplayName('');
    setAcpFormCommand('');
    setAcpFormArgs('');
    setAcpFormEnabled(true);
    setAcpProbeStatus(null);
    setAcpModalOpen(true);
  };

  const openAcpEditModal = (profile: AcpProfile) => {
    setAcpEditingId(profile.id);
    setAcpFormId(profile.id);
    setAcpFormDisplayName(profile.display_name || profile.id);
    setAcpFormCommand(profile.command);
    setAcpFormArgs((profile.args || []).join(' '));
    setAcpFormEnabled(profile.enabled !== false);
    setAcpProbeStatus(
      profile.detected !== undefined
        ? {
            tested: true,
            available: profile.detected,
            path: profile.binaryPath,
            error: profile.error,
          }
        : null
    );
    setAcpModalOpen(true);
  };

  const handleProbeAcp = async () => {
    if (!acpFormCommand.trim()) return;
    const res = await mwhService.probeAcpCommand(acpFormCommand.trim());
    setAcpProbeStatus({
      tested: true,
      available: res.available,
      path: res.path,
      error: res.error,
    });
  };

  const handleSaveAcp = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = acpFormId.trim();
    const command = acpFormCommand.trim();
    if (!id || !command) return;

    setAcpSaving(true);
    try {
      const parsedArgs = acpFormArgs
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const ok = await mwhService.saveAcpProfile({
        id,
        display_name: acpFormDisplayName.trim() || id,
        command,
        args: parsedArgs,
        enabled: acpFormEnabled,
        kind: 'custom',
      });

      if (ok) {
        setAcpModalOpen(false);
      }
    } finally {
      setAcpSaving(false);
    }
  };

  // Real token peek & action loading states
  const [isTokenPeeked, setIsTokenPeeked] = useState(false);
  const [switchingMode, setSwitchingMode] = useState<string | null>(null);
  const [tunnelActionLoading, setTunnelActionLoading] = useState<string | null>(null);

  // Custom UI Glass Confirm Dialog (Zero native window.confirm)
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    danger?: boolean;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleDeleteAcp = (id: string) => {
    setConfirmModal({
      open: true,
      title: '删除自定义 ACP 代理',
      message: `确定要删除 "${id}" 吗？此操作将立即热更新移除。`,
      danger: true,
      confirmText: '确认删除',
      onConfirm: async () => {
        await mwhService.deleteAcpProfile(id);
      },
    });
  };

  // Snapshot & Audit controls
  const [snapshotSort, setSnapshotSort] = useState<SnapshotSortOrder>('newest');
  const [perGroupLimit, setPerGroupLimit] = useState<number>(5);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  /* 用户点过「查看其余 N 条」的目录，仅放开该目录，不动全局每组显示条数 */
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const groupsInitRef = useRef(false);
  const [selectedSnapshotIds, setSelectedSnapshotIds] = useState<Record<string, boolean>>({});

  const groupedSnapshots = useMemo<WorkspaceSnapshotGroup[]>(() => {
    const map = new Map<string, WorkspaceSnapshotGroup>();
    const cleanSnapshots = state.snapshots.filter((snap) => {
      const p = String(snap.workspacePath || '').toLowerCase();
      if (p.includes('\\appdata\\local\\temp') || p.includes('/appdata/local/temp')) return false;
      if (p.includes('mwh_ext_test_')) return false;
      return true;
    });
    const effectiveSnapshots = cleanSnapshots.length > 0 ? cleanSnapshots : state.snapshots;
    const indexed = effectiveSnapshots.map((snap, idx) => ({ snap, idx }));

    indexed.sort((a, b) => {
      if (snapshotSort === 'files-desc') {
        const diff =
          parseModifiedFileCount(b.snap.diffStat) - parseModifiedFileCount(a.snap.diffStat);
        if (diff !== 0) return diff;
      }
      const ta = Date.parse(a.snap.timestamp);
      const tb = Date.parse(b.snap.timestamp);
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) {
        return snapshotSort === 'oldest' ? ta - tb : tb - ta;
      }
      return snapshotSort === 'oldest' ? b.idx - a.idx : a.idx - b.idx;
    });

    for (const { snap } of indexed) {
      const info = normalizeWinPath(snap.workspacePath);
      const existing = map.get(info.normKey);
      if (existing) {
        existing.items.push(snap);
      } else {
        map.set(info.normKey, {
          normKey: info.normKey,
          displayPath: info.displayPath,
          parentPrefix: info.parentPrefix,
          folderName: info.folderName,
          items: [snap],
        });
      }
    }
    return Array.from(map.values());
  }, [state.snapshots, snapshotSort]);

  /* 首次拿到分组后只展开最近活跃（排序后第一个）目录，其余折叠；之后尊重用户手动状态 */
  useEffect(() => {
    if (groupsInitRef.current || groupedSnapshots.length === 0) return;
    groupsInitRef.current = true;
    const next: Record<string, boolean> = {};
    for (let i = 1; i < groupedSnapshots.length; i += 1) {
      next[groupedSnapshots[i].normKey] = true;
    }
    setCollapsedGroups(next);
  }, [groupedSnapshots]);

  const visibleSnapshotIds = useMemo(() => {
    const ids: string[] = [];
    for (const grp of groupedSnapshots) {
      if (collapsedGroups[grp.normKey]) continue;
      const items =
        perGroupLimit > 0 && !expandedGroups[grp.normKey]
          ? grp.items.slice(0, perGroupLimit)
          : grp.items;
      for (const s of items) ids.push(s.id);
    }
    return ids;
  }, [groupedSnapshots, collapsedGroups, perGroupLimit, expandedGroups]);

  const activeSelectedIds = useMemo(() => {
    const existingSet = new Set(state.snapshots.map((s) => s.id));
    return Object.keys(selectedSnapshotIds).filter(
      (id) => selectedSnapshotIds[id] && existingSet.has(id),
    );
  }, [selectedSnapshotIds, state.snapshots]);

  const allVisibleSelected =
    visibleSnapshotIds.length > 0 &&
    visibleSnapshotIds.every((id) => Boolean(selectedSnapshotIds[id]));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedSnapshotIds((prev) => {
        const next = { ...prev };
        for (const id of visibleSnapshotIds) delete next[id];
        return next;
      });
    } else {
      setSelectedSnapshotIds((prev) => {
        const next = { ...prev };
        for (const id of visibleSnapshotIds) next[id] = true;
        return next;
      });
    }
  };

  const handleDeleteSelectedSnapshots = () => {
    if (activeSelectedIds.length === 0) return;
    setConfirmModal({
      open: true,
      title: '批量删除快照记录',
      message: `确定要删除已选的 ${activeSelectedIds.length} 条影子快照记录吗？此操作仅删除历史元数据与影子存档。`,
      danger: true,
      confirmText: '确认删除',
      onConfirm: () => {
        mwhService.deleteSnapshots(activeSelectedIds);
        setSelectedSnapshotIds({});
      },
    });
  };

  const handlePruneRecentSnapshots = () => {
    const keepCount = perGroupLimit > 0 ? perGroupLimit : 5;
    setConfirmModal({
      open: true,
      title: '清理旧快照记录',
      message: `确定每个工作区仅保留最近 ${keepCount} 次快照，并自动清理其余历史记录吗？`,
      danger: false,
      confirmText: '确认清理',
      onConfirm: () => {
        mwhService.pruneSnapshots(keepCount);
        setSelectedSnapshotIds({});
      },
    });
  };

  const pairing = mwhService.getPairingArtifacts();
  const currentProfile = getPermissionProfileMeta(state.confinementMode, state.approvalPolicy);

  const chromeDark = state.chromeDark !== false;
  /* 取值对齐 muse.ai 官方设置中心：暗 #1C1D20 / #27282C / #1E1F23，亮 #EFECE6 / #F7F6F2 / #E6E4DE */
  const modalBg = chromeDark
    ? 'bg-[#1C1D20] text-[#ECECEE] border-white/[0.07] shadow-[0_28px_80px_rgba(0,0,0,0.55)]'
    : 'bg-[#EFECE6] text-[#1D1D1F] border-black/[0.06] shadow-[0_28px_80px_rgba(0,0,0,0.18)]';
  const subtleBg = chromeDark ? 'bg-[#1E1F23] text-[#E2E3E9]' : 'bg-[#E6E4DE] text-[#252529]';
  const mutedText = chromeDark ? 'text-[#9E9FA6]' : 'text-[#63636A]';
  const cardBg = chromeDark
    ? 'bg-[#27282C] text-[#ECECEE] border border-white/[0.04]'
    : 'bg-[#F7F6F2] text-[#1D1D1F] border border-black/[0.04]';

  const modalTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const };
  const tabTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.12, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <AnimatePresence initial={false}>
      {state.settingsModalOpen && (
        <motion.div
          key="mwh-settings-backdrop"
          data-testid="mwh-settings-modal-backdrop"
          initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
          transition={modalTransition}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-auto bg-black/45"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              mwhService.closeSettingsModal();
            }
          }}
        >
          {/* 1:1 复刻 Muse 官方设置弹窗：宽 760px，高 580px，border-radius: 24px */}
          <motion.div
            key="mwh-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="MWH 本地引擎设置中心"
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
            transition={modalTransition}
            className={`relative w-[760px] max-w-[96vw] h-[580px] max-h-[90vh] rounded-[24px] border shadow-[0_20px_60px_rgba(0,0,0,0.28)] flex overflow-hidden ${modalBg}`}
          >
            {/* Left Navigation Column (1:1 Muse Official Settings Sidebar) */}
            <nav
              aria-label="设置面板导航"
              className="w-[200px] shrink-0 h-full flex flex-col py-5 px-3.5"
            >
              <div>
                <div className="px-3 pb-4">
                  <h2 className="text-[19px] font-bold tracking-tight">设置</h2>
                </div>

                <div className="space-y-0.5">
                  {NAV_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const active = state.activeSettingsTab === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => mwhService.setActiveSettingsTab(item.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] transition-colors duration-120 cursor-pointer whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B7FFF]/70 ${
                          active
                            ? chromeDark
                              ? 'bg-[#313238] text-white font-medium'
                              : 'bg-[#E3E1DB] text-[#141416] font-medium'
                            : chromeDark
                              ? 'text-[#B5B6BF] hover:bg-white/[0.04]'
                              : 'text-[#5F5F66] hover:bg-black/[0.04]'
                        }`}
                      >
                        <Icon className="w-[17px] h-[17px] shrink-0 opacity-80" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </nav>

            {/* Right Grouped Card Content Panel */}
            <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
              {/* Sticky Panel Header with Close X Button */}
              <div className="flex items-center justify-between px-6 pt-5 pb-3 shrink-0">
                <h3 className={`text-[13.5px] font-medium ${mutedText}`}>
                  {NAV_ITEMS.find((n) => n.id === state.activeSettingsTab)?.sectionHeader}
                </h3>
                <button
                  type="button"
                  onClick={() => mwhService.closeSettingsModal()}
                  aria-label="关闭设置弹窗"
                  className="w-7 h-7 rounded-full flex items-center justify-center transition-colors duration-120 cursor-pointer hover:bg-white/[0.08] text-[#D8D9E0]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Scrollable Cards Container */}
              <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-6 pb-6">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={state.activeSettingsTab}
                    initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    transition={tabTransition}
                    className="space-y-3.5"
                  >
                    {/* TAB 1: 通用 (本地电脑连接与配对) */}
                    {state.activeSettingsTab === 'connectors' && (
                      <div className="pt-1">
                        <div className={`text-[13px] font-medium mb-2 ${mutedText}`}>
                          本地电脑连接与无密钥配对说明
                        </div>
                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div className="flex items-center justify-between gap-2 min-w-0">
                            <div className="min-w-0">
                              <div className="text-[14px] font-medium truncate">
                                生成 SKILL.md 配对说明与 MCP 模板
                              </div>
                              <div className={`text-xs mt-0.5 truncate ${mutedText}`}>
                                当前端点：{mwhService.getActivePublicBaseUrl()} · 当前档位：{currentProfile.shortLabel}
                              </div>
                            </div>
                            <span className={`text-xs font-mono shrink-0 px-2 py-0.5 rounded bg-black/20 ${mutedText}`}>
                              {state.tunnel.activeDriver}
                            </span>
                          </div>

                          <details className="rounded-xl px-3 py-2 text-[11.5px] cursor-pointer group bg-white/[0.03]">
                            <summary className="font-medium text-[#8AB8FF] flex items-center justify-between select-none">
                              <span>查看完整配对说明 (无密钥)</span>
                              <ChevronDown className="w-3.5 h-3.5 group-open:rotate-180 transition-transform" />
                            </summary>
                            <pre
                              className={`mt-2 rounded-xl p-3 text-[11.5px] font-mono overflow-x-auto max-h-32 leading-relaxed ${subtleBg}`}
                            >
                              {pairing.skillMarkdownPrompt}
                            </pre>
                          </details>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  mwhService.copyTextWithToast(
                                    pairing.skillMarkdownPrompt,
                                    '已复制无密钥 SKILL.md 配对说明，可直接粘贴至会话框',
                                    true,
                                  );
                                }}
                                className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-[#2B7FFF] hover:bg-[#1B6FEF] text-white flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                              >
                                <Copy className="w-3.5 h-3.5" />
                                <span>一键复制配对口令</span>
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  mwhService.copyTextWithToast(
                                    pairing.mcpJsonConfig,
                                    '已复制 Streamable HTTP MCP JSON 模板',
                                  )
                                }
                                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap ${subtleBg} hover:opacity-85`}
                              >
                                <Copy className="w-3.5 h-3.5" />
                                <span>复制 MCP JSON</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {state.activeSettingsTab === 'connectors' && (
                      <>
                        <div className="grid grid-cols-2 gap-2.5">
                          {(
                            [
                              {
                                id: 'cloudflare-named',
                                title: 'Cloudflare 固定域名',
                                sub: '常驻固定域名 · 免重配',
                              },
                              {
                                id: 'cloudflare-quick',
                                title: 'Cloudflare 临时公网',
                                sub: 'trycloudflare · 零配置拉起',
                              },
                              {
                                id: 'tailscale-funnel',
                                title: 'Tailscale 私网直连',
                                sub: 'MagicDNS · 100.x 私网',
                              },
                              {
                                id: 'custom-tls',
                                title: '自定义公网反代',
                                sub: '自建 TLS / FRP 端点',
                              },
                            ] as Array<{ id: TunnelDriverType; title: string; sub: string }>
                          ).map((drv) => {
                            const active = state.tunnel.activeDriver === drv.id;
                            const isLoading = tunnelActionLoading === drv.id;
                            return (
                              <button
                                key={drv.id}
                                type="button"
                                disabled={Boolean(tunnelActionLoading)}
                                onClick={async () => {
                                  setTunnelActionLoading(drv.id);
                                  try {
                                    await mwhService.setTunnelDriver(drv.id);
                                  } finally {
                                    setTunnelActionLoading(null);
                                  }
                                }}
                                className={`p-3.5 rounded-2xl text-left transition-colors duration-120 cursor-pointer border ${
                                  active
                                    ? 'bg-white/[0.12] border-white/20 text-white shadow-sm'
                                    : `${cardBg} border-transparent hover:opacity-90`
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="text-[13px] font-medium">{drv.title}</div>
                                  {isLoading ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#8AB8FF]" />
                                  ) : active ? (
                                    <span className="text-[11px] font-mono text-white/90 px-1.5 py-0.5 rounded bg-white/[0.1] border border-white/[0.08]">生效中</span>
                                  ) : null}
                                </div>
                                <div className={`text-[11.5px] mt-1 ${mutedText}`}>{drv.sub}</div>
                              </button>
                            );
                          })}
                        </div>

                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          {state.tunnel.activeDriver === 'cloudflare-named' && (
                            <>
                              <div className="text-[13.5px] font-medium">
                                Cloudflare Named Tunnel 配置
                              </div>
                              <div className="grid grid-cols-1 gap-2.5 text-xs">
                                <label className="space-y-1">
                                  <span className={mutedText}>固定公网域名 (绑定至 127.0.0.1:19820)</span>
                                  <input
                                    type="text"
                                    value={state.tunnel.cfNamedDomain}
                                    onChange={(e) =>
                                      mwhService.updateTunnelFields({ cfNamedDomain: e.target.value })
                                    }
                                    className={`w-full px-3 py-2 rounded-xl font-mono border-0 outline-none ${subtleBg}`}
                                  />
                                </label>
                                <label className="space-y-1">
                                  <span className={mutedText}>Cloudflared Connector Token</span>
                                  <input
                                    type="text"
                                    value={state.tunnel.cfNamedToken}
                                    onChange={(e) =>
                                      mwhService.updateTunnelFields({ cfNamedToken: e.target.value })
                                    }
                                    className={`w-full px-3 py-2 rounded-xl font-mono border-0 outline-none ${subtleBg}`}
                                  />
                                </label>
                              </div>
                            </>
                          )}

                          {state.tunnel.activeDriver === 'cloudflare-quick' && (
                            <div className="space-y-2.5">
                              <div className="flex items-center justify-between">
                                <div>
                                  <div className="text-[13.5px] font-medium">
                                    Cloudflare Quick Tunnel (临时公网)
                                  </div>
                                  <div className={`text-xs ${mutedText}`}>
                                    按需运行 cloudflared 临时公网隧道
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  disabled={tunnelActionLoading === 'spawn_quick'}
                                  onClick={async () => {
                                    setTunnelActionLoading('spawn_quick');
                                    try {
                                      await mwhService.spawnQuickTunnelUrl();
                                    } finally {
                                      setTunnelActionLoading(null);
                                    }
                                  }}
                                  className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-[#2B7FFF] text-white hover:bg-[#1B6FEF] transition-colors duration-120 cursor-pointer whitespace-nowrap flex items-center gap-1.5 disabled:opacity-50"
                                >
                                  {tunnelActionLoading === 'spawn_quick' ? (
                                    <>
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      <span>拉起中...</span>
                                    </>
                                  ) : (
                                    <span>重新拉起临时隧道</span>
                                  )}
                                </button>
                              </div>
                              <div className={`px-3 py-2 rounded-xl font-mono text-xs truncate ${subtleBg}`}>
                                当前分配域名: {state.tunnel.cfQuickUrl || 'LOCAL-ONLY · 未拉起公网隧道'}
                              </div>
                            </div>
                          )}

                          {state.tunnel.activeDriver === 'tailscale-funnel' && (
                            <div className="space-y-2.5 text-xs">
                              <div className="text-[13.5px] font-medium">
                                Tailscale 私网 IP (100.x.y.z) 与 Funnel 网关
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <label className="space-y-1">
                                  <span className={mutedText}>Tailscale 节点 IP</span>
                                  <input
                                    type="text"
                                    value={state.tunnel.tailscaleIp}
                                    onChange={(e) =>
                                      mwhService.updateTunnelFields({ tailscaleIp: e.target.value })
                                    }
                                    className={`w-full px-3 py-2 rounded-xl font-mono border-0 outline-none ${subtleBg}`}
                                  />
                                </label>
                                <label className="space-y-1">
                                  <span className={mutedText}>MagicDNS Funnel 地址</span>
                                  <input
                                    type="text"
                                    value={state.tunnel.tailscaleMagicDns}
                                    onChange={(e) =>
                                      mwhService.updateTunnelFields({
                                        tailscaleMagicDns: e.target.value,
                                      })
                                    }
                                    className={`w-full px-3 py-2 rounded-xl font-mono border-0 outline-none ${subtleBg}`}
                                  />
                                </label>
                              </div>
                            </div>
                          )}

                          {state.tunnel.activeDriver === 'custom-tls' && (
                            <div className="space-y-2.5 text-xs">
                              <div className="text-[13.5px] font-medium">
                                自定义公网 TLS / FRP 反向代理端点
                              </div>
                              <label className="space-y-1 block">
                                <span className={mutedText}>公网 HTTPS 反代地址</span>
                                <input
                                  type="text"
                                  value={state.tunnel.customPublicUrl}
                                  onChange={(e) =>
                                    mwhService.updateTunnelFields({ customPublicUrl: e.target.value })
                                  }
                                  className={`w-full px-3 py-2 rounded-xl font-mono border-0 outline-none ${subtleBg}`}
                                />
                              </label>
                            </div>
                          )}
                        </div>

                        <div className={`rounded-2xl p-4 space-y-2.5 text-xs ${cardBg}`}>
                          <div className="text-[13.5px] font-medium">
                            当前生效端点与鉴权密钥 (Streamable HTTP MCP / REST)
                          </div>

                          <div
                            className={`p-2.5 rounded-xl flex items-center justify-between gap-2 font-mono ${subtleBg}`}
                          >
                            <span className="truncate">MCP: {pairing.mcpEndpoint}</span>
                            <button
                              type="button"
                              onClick={() =>
                                mwhService.copyTextWithToast(
                                  pairing.mcpEndpoint,
                                  '已复制 Streamable HTTP MCP URL',
                                )
                              }
                              className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 transition-colors duration-120 cursor-pointer shrink-0"
                            >
                              复制
                            </button>
                          </div>

                          <div
                            className={`p-2.5 rounded-xl flex items-center justify-between gap-2 font-mono ${subtleBg}`}
                          >
                            <span className="truncate">REST: {pairing.restEndpoint}</span>
                            <button
                              type="button"
                              onClick={() =>
                                mwhService.copyTextWithToast(pairing.restEndpoint, '已复制 REST API URL')
                              }
                              className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 transition-colors duration-120 cursor-pointer shrink-0"
                            >
                              复制
                            </button>
                          </div>

                          <div
                            className={`p-2.5 rounded-xl flex items-center justify-between gap-2 font-mono ${subtleBg}`}
                          >
                            <span className="truncate">
                              Token: {isTokenPeeked ? (mwhService.getRealToken() || state.tunnel.bearerToken) : state.tunnel.bearerToken}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => setIsTokenPeeked((prev) => !prev)}
                                title={isTokenPeeked ? '隐藏明文' : '查看完整明文'}
                                className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 text-white transition-colors duration-120 cursor-pointer flex items-center"
                              >
                                {isTokenPeeked ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const token = mwhService.getRealToken() || state.tunnel.bearerToken;
                                  mwhService.copyTextWithToast(
                                    token,
                                    '已复制真实 Bearer Token (无脱敏，可直接填入连接器)'
                                  );
                                }}
                                className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 transition-colors duration-120 cursor-pointer"
                              >
                                复制真实 Token
                              </button>
                              <button
                                type="button"
                                onClick={() => mwhService.rotateBearerToken()}
                                className="px-2.5 py-1 rounded bg-[#2B7FFF] text-white hover:bg-[#1A6FEF] flex items-center gap-1 transition-colors duration-120 cursor-pointer"
                              >
                                <RefreshCw className="w-3 h-3" />
                                <span>轮换</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      </>
                    )}

                    {/* TAB 3: 权限 (统一四档模式：计划模式 / 变更前确认 / 自主模式 / 完全访问) */}
                    {state.activeSettingsTab === 'permissions' && (
                      <>
                        <div className="space-y-2" role="radiogroup" aria-label="四档权限模式">
                          {PERMISSION_PROFILE_LIST.map((prof) => {
                            const selected = currentProfile.id === prof.id;
                            const isDanger = prof.id === 'full-access';

                            return (
                              <button
                                key={prof.id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                data-testid={`permission-profile-${prof.id}`}
                                onClick={() => {
                                  if (isDanger && !selected) {
                                    setConfirmModal({
                                      open: true,
                                      title: '切换至完全访问模式',
                                      message: '警告：完全访问模式将关闭安全围栏与审批，命令与写操作将全量无阻碍执行。是否确认切换？',
                                      danger: true,
                                      confirmText: '确认切换',
                                      onConfirm: async () => {
                                        setSwitchingMode(prof.id);
                                        try {
                                          await mwhService.setPermissionProfile(prof.id);
                                        } finally {
                                          setSwitchingMode(null);
                                        }
                                      },
                                    });
                                    return;
                                  }
                                  setSwitchingMode(prof.id);
                                  Promise.resolve(mwhService.setPermissionProfile(prof.id)).finally(() => {
                                    setSwitchingMode(null);
                                  });
                                }}
                                className={`w-full p-3.5 rounded-2xl text-left transition-colors duration-120 cursor-pointer border ${
                                  selected
                                    ? isDanger
                                      ? 'bg-red-500/12 border-red-500'
                                      : 'bg-white/[0.13] border-white/20 text-white shadow-sm'
                                    : `${cardBg} border-transparent hover:bg-white/[0.04]`
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={`w-2 h-2 rounded-full shrink-0 ${prof.dotColorClass}`}
                                    />
                                    <span className="text-[13.5px] font-semibold">{prof.title}</span>
                                  </div>
                                  {switchingMode === prof.id ? (
                                    <span className="flex items-center gap-1 text-xs text-[#8AB8FF] font-mono">
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      <span>切换中...</span>
                                    </span>
                                  ) : selected ? (
                                    <span
                                      className={`text-xs font-mono shrink-0 ${
                                        isDanger ? 'text-red-400' : 'text-[#2B7FFF]'
                                      }`}
                                    >
                                      当前生效
                                    </span>
                                  ) : null}
                                </div>
                                <p className={`text-xs mt-1 leading-relaxed pl-4 ${mutedText}`}>
                                  {prof.subtitle}
                                </p>
                              </button>
                            );
                          })}
                        </div>

                        {/* 2 小时自动降级保护 */}
                        <div className={`rounded-2xl p-4 ${cardBg}`}>
                          <div
                            className={`p-3 rounded-xl flex items-center justify-between gap-3 ${subtleBg}`}
                          >
                            <div>
                              <div className="text-xs font-medium">
                                开启「完全访问」2 小时后自动降级回「变更前确认」
                              </div>
                              <div className={`text-[11px] font-mono mt-0.5 ${mutedText}`}>
                                剩余计时: {Math.floor(state.autoDowngradeRemainingSec / 60)}m{' '}
                                {state.autoDowngradeRemainingSec % 60}s
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => mwhService.toggleAutoDowngradeTwoHours()}
                              aria-pressed={state.autoDowngradeTwoHours}
                              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-120 cursor-pointer whitespace-nowrap ${
                                state.autoDowngradeTwoHours
                                  ? 'bg-[#2B7FFF] text-white'
                                  : 'bg-neutral-500/25 opacity-75'
                              }`}
                            >
                              {state.autoDowngradeTwoHours ? '已开启 2h 自动降级' : '已关闭'}
                            </button>
                          </div>
                        </div>

                        {/* 动态安全边界说明 */}
                        <div className={`rounded-2xl p-4 space-y-2.5 ${cardBg}`}>
                          <div className="text-[13.5px] font-medium">
                            当前档位安全机制与边界说明 · {currentProfile.shortLabel}
                          </div>

                          <div className="space-y-1 text-xs">
                            <div className="font-medium text-emerald-400">当前生效的保护机制：</div>
                            {currentProfile.enforcedProtections.map((line, idx) => (
                              <div key={idx} className="pl-3 leading-relaxed opacity-90">
                                - {line}
                              </div>
                            ))}
                          </div>

                          <div className="space-y-1 text-xs pt-1">
                            <div className="font-medium text-amber-400">未覆盖边界说明：</div>
                            {currentProfile.uncoveredBoundaries.map((line, idx) => (
                              <div key={idx} className="pl-3 leading-relaxed opacity-90">
                                - {line}
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}

                    {/* TAB 4: 设备 (Windows Daemon 本地电脑引擎) */}
                    {state.activeSettingsTab === 'daemon' && (
                      <>
                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div className="flex items-center justify-between">
                            <span className="text-[14px] font-medium">
                              Windows 本地守护进程 (mwh-daemon.exe)
                            </span>
                            <span
                              className={`text-xs font-mono ${
                                state.daemon.connected ? 'text-emerald-400' : 'text-neutral-400'
                              }`}
                            >
                              {state.daemon.connected
                                ? '在线 (127.0.0.1:19820)'
                                : '离线 · 未连接本地守护进程'}
                            </span>
                          </div>

                          <div className="grid grid-cols-3 gap-2.5 text-xs font-mono">
                            <div className={`p-3 rounded-xl ${subtleBg}`}>
                              <div className={mutedText}>进程 PID / 内存</div>
                              <div className="text-[13px] font-medium mt-0.5">
                                #{state.daemon.pid} · {state.daemon.memoryMb} MB
                              </div>
                            </div>
                            <div className={`p-3 rounded-xl ${subtleBg}`}>
                              <div className={mutedText}>静默无黑框标志</div>
                              <div className="text-[13px] font-medium mt-0.5">
                                {state.daemon.createNoWindowActive ? 'CREATE_NO_WINDOW' : '未启用'}
                              </div>
                            </div>
                            <div className={`p-3 rounded-xl ${subtleBg}`}>
                              <div className={mutedText}>活跃 Job Object 树</div>
                              <div className="text-[13px] font-medium mt-0.5">
                                {state.daemon.activeJobObjects} 个受控句柄
                              </div>
                            </div>
                          </div>

                          {confirmingEmergencyKill ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                data-testid="emergency-kill-confirm-btn"
                                onClick={() => {
                                  setConfirmingEmergencyKill(false);
                                  mwhService.emergencyKillAllJobObjects();
                                }}
                                className="flex-1 py-2.5 px-4 rounded-xl bg-red-700 hover:bg-red-800 text-white font-semibold text-[13px] flex items-center justify-center gap-2 transition-colors duration-120 cursor-pointer ring-2 ring-red-400/60"
                              >
                                <ShieldAlert className="w-4 h-4" />
                                <span>确认终止所有 Win32 Job Object 进程树？</span>
                              </button>
                              <button
                                type="button"
                                data-testid="emergency-kill-cancel-btn"
                                onClick={() => setConfirmingEmergencyKill(false)}
                                className={`py-2.5 px-4 rounded-xl text-[13px] font-medium ${subtleBg} hover:opacity-80 transition-opacity duration-120 cursor-pointer`}
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              data-testid="emergency-kill-trigger-btn"
                              onClick={() => setConfirmingEmergencyKill(true)}
                              className="w-full py-2.5 px-4 rounded-xl bg-red-600 hover:bg-red-500 text-white font-medium text-[13px] flex items-center justify-center gap-2 transition-colors duration-120 cursor-pointer"
                            >
                              <ShieldAlert className="w-4 h-4" />
                              <span>全局急停（终止所有 Win32 Job Object 进程树）</span>
                            </button>
                          )}
                        </div>

                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div>
                            <div className="text-[13.5px] font-medium">
                              授权工作区目录白名单 (Workspace Roots)
                            </div>
                            <div className={`text-xs mt-0.5 ${mutedText}`}>
                              计划模式 / 变更前确认 / 自主模式下仅允许写访问以下物理路径；完全访问下跨目录普通读写不额外标为高危
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={newWorkspaceInput}
                              onChange={(e) => setNewWorkspaceInput(e.target.value)}
                              placeholder="输入本地绝对路径，例如 E:\Workspace\MyRustApp"
                              aria-label="新增授权工作区路径"
                              className={`flex-1 px-3 py-2 rounded-xl text-xs font-mono border-0 outline-none ${subtleBg}`}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                mwhService.addWorkspaceRoot(newWorkspaceInput);
                                setNewWorkspaceInput('');
                              }}
                              className="px-3.5 py-2 rounded-xl text-xs font-medium bg-[#2B7FFF] hover:bg-[#1B6FEF] text-white flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                            >
                              <FolderPlus className="w-3.5 h-3.5" />
                              <span>添加目录</span>
                            </button>
                          </div>

                          <div className="space-y-1.5">
                            {state.workspaceRoots.map((rootPath) => (
                              <div
                                key={rootPath}
                                className={`px-3 py-2 rounded-xl flex items-center justify-between gap-2 font-mono text-xs ${subtleBg}`}
                              >
                                <span className="truncate">{rootPath}</span>
                                <button
                                  type="button"
                                  onClick={() => mwhService.removeWorkspaceRoot(rootPath)}
                                  aria-label={`移除工作区 ${rootPath}`}
                                  className="text-red-400 hover:text-red-300 p-1 transition-colors duration-120 cursor-pointer shrink-0"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}

                    {/* TAB 5: 子代理 (自定义 ACP 子代理与 Git Worktree 池) */}
                    {state.activeSettingsTab === 'subagents' && (
                      <>
                        {/* 自定义 ACP 代理档案 */}
                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-[13.5px] font-medium">自定义 ACP 代理</span>
                                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400">
                                  Agent Client Protocol
                                </span>
                              </div>
                              <div className={`text-xs ${mutedText} mt-0.5`}>
                                全局通用配置 (%USERPROFILE%\.mwh\acp-profiles.json) · 可按档案独立启停 · 实时热更新
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => openAcpCreateModal()}
                              className="px-3 py-1.5 rounded-xl text-xs font-medium bg-sky-500/20 text-sky-400 hover:bg-sky-500/30 flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              添加 ACP 代理
                            </button>
                          </div>

                          {/* Profiles 列表 */}
                          {!state.acpProfiles || state.acpProfiles.length === 0 ? (
                            <div
                              className={`p-4 rounded-xl text-center space-y-2 border border-dashed border-white/[0.06] ${subtleBg}`}
                            >
                              <div className={`text-xs ${mutedText}`}>
                                暂无自定义 ACP 代理。添加后支持路径探测、按档案独立启停与 Worktree 隔离运行。
                              </div>
                              <button
                                type="button"
                                onClick={() => openAcpCreateModal()}
                                className="px-3 py-1 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 transition-colors cursor-pointer"
                              >
                                + 添加首个 ACP 代理
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {state.acpProfiles.map((profile) => (
                                <div
                                  key={profile.id}
                                  className={`p-2.5 rounded-xl flex items-center justify-between gap-3 ${subtleBg}`}
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-xs font-medium">
                                        {profile.display_name || profile.id}
                                      </span>
                                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 opacity-75">
                                        {profile.id}
                                      </span>
                                      <span
                                        className={`text-[11px] font-mono flex items-center gap-1 ${
                                          profile.detected ? 'text-emerald-500' : 'text-amber-500'
                                        }`}
                                      >
                                        {profile.detected ? (
                                          <>
                                            <Check className="w-3 h-3" /> 可执行文件就绪
                                          </>
                                        ) : (
                                          <>
                                            <AlertCircle className="w-3 h-3" /> 未找到可执行文件
                                          </>
                                        )}
                                      </span>
                                      {!profile.enabled && (
                                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-500/20 text-neutral-400">
                                          已停用
                                        </span>
                                      )}
                                    </div>

                                    <div className={`text-[11px] font-mono truncate mt-1 ${mutedText}`}>
                                      <span className="text-neutral-400">命令:</span>{' '}
                                      {profile.binaryPath || profile.command}
                                      {profile.args && profile.args.length > 0 && (
                                        <span className="opacity-60 ml-2">
                                          参数: {profile.args.join(' ')}
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2 shrink-0">
                                    {/* 启禁用开关 */}
                                    <button
                                      type="button"
                                      onClick={() => mwhService.toggleAcpProfile(profile.id)}
                                      className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                                        profile.enabled
                                          ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                                          : 'bg-neutral-500/20 text-neutral-400 hover:bg-neutral-500/30'
                                      }`}
                                    >
                                      {profile.enabled ? '已启用' : '已停用'}
                                    </button>

                                    {/* 编辑按钮 */}
                                    <button
                                      type="button"
                                      onClick={() => openAcpEditModal(profile)}
                                      className="p-1.5 rounded-lg hover:bg-white/10 text-neutral-300 hover:text-white transition-colors cursor-pointer"
                                      title="编辑 ACP 代理"
                                    >
                                      <Edit2 className="w-3.5 h-3.5" />
                                    </button>

                                    {/* 删除按钮 */}
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteAcp(profile.id)}
                                      className="p-1.5 rounded-lg hover:bg-rose-500/20 text-neutral-400 hover:text-rose-400 transition-colors cursor-pointer"
                                      title="删除 ACP 代理"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Git Worktree 并发隔离分支池 */}
                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-[13.5px] font-medium">
                                Git Worktree 并发隔离分支池 (代理权限 &lt;= 父权限)
                              </div>
                              <div className={`text-xs ${mutedText}`}>
                                当前父级档位：{currentProfile.shortLabel}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <select
                                aria-label="选择请求的代理模式"
                                value={requestedSpawnMode}
                                onChange={(e) =>
                                  setRequestedSpawnMode(e.target.value as ConfinementMode)
                                }
                                className={`px-2.5 py-1.5 rounded-xl text-xs font-mono border-0 outline-none ${subtleBg}`}
                              >
                                <option value="read-only">只读 (计划模式)</option>
                                <option value="workspace-write">工作区读写 (变更前确认 / 自主)</option>
                                <option value="danger-full-access">完全访问</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => {
                                  const preferredAgent =
                                    state.acpConfig?.acp_default_profile ||
                                    state.acpProfiles?.find((p) => p.enabled)?.id ||
                                    'builtin';
                                  mwhService.spawnIsolatedWorktree(preferredAgent, requestedSpawnMode);
                                }}
                                className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[#2B7FFF] text-white hover:bg-[#1B6FEF] transition-colors duration-120 cursor-pointer whitespace-nowrap"
                              >
                                新建隔离 Worktree
                              </button>
                            </div>
                          </div>

                          <div className="space-y-2.5">
                            {state.worktrees.map((wt) => {
                              const pageIdx = worktreePageMap[wt.id] ?? 0;
                              const pages = wt.stdoutPages;
                              const currentLines = pages[pageIdx] || pages[0] || [];

                              return (
                                <div key={wt.id} className={`p-3 rounded-xl space-y-2 ${subtleBg}`}>
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex items-center gap-2 text-xs font-mono min-w-0 truncate">
                                      <span className="font-semibold text-[#2B7FFF]">{wt.id}</span>
                                      <span className="truncate">· {wt.branchName}</span>
                                      <span>· 代理: {wt.agentId}</span>
                                      <span>· 生效: {wt.childMode}</span>
                                    </div>

                                    <div className="flex items-center gap-1.5 shrink-0">
                                      {wt.status !== 'MERGED' && wt.status !== 'MISSING' && (
                                        <button
                                          type="button"
                                          onClick={() => mwhService.mergeWorktree(wt.id)}
                                          className="px-2.5 py-1 rounded-lg text-xs font-medium bg-[#2B7FFF] text-white hover:bg-[#1B6FEF] flex items-center gap-1 transition-colors duration-120 cursor-pointer"
                                        >
                                          <GitMerge className="w-3 h-3" />
                                          <span>合并回主分支</span>
                                        </button>
                                      )}
                                      {wt.status === 'MISSING' && (
                                        <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-amber-500/15 text-amber-500">
                                          已清理 (MISSING)
                                        </span>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => mwhService.removeWorktree(wt.id)}
                                        className="px-2.5 py-1 rounded-lg text-xs bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors duration-120 cursor-pointer"
                                      >
                                        清理分支
                                      </button>
                                    </div>
                                  </div>

                                  <div className="rounded-lg bg-black/20 p-2 font-mono text-[11px] space-y-0.5 overflow-hidden">
                                    {currentLines.map((line, idx) => (
                                      <div key={idx} className="truncate">
                                        {line}
                                      </div>
                                    ))}
                                  </div>

                                  {pages.length > 1 && (
                                    <div className="flex items-center justify-end gap-2 text-[11px] font-mono">
                                      <span className={mutedText}>
                                        输出流分页 {pageIdx + 1}/{pages.length}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setWorktreePageMap((prev) => ({
                                            ...prev,
                                            [wt.id]: (pageIdx + 1) % pages.length,
                                          }))
                                        }
                                        className="px-2 py-0.5 rounded bg-black/10 hover:bg-black/20 transition-colors duration-120 cursor-pointer"
                                      >
                                        切换分页
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}

                    {/* TAB 6: 数据控制 (快照回滚与审计日志) */}
                    {state.activeSettingsTab === 'snapshots-audit' && (
                      <>
                        <div className={`rounded-2xl p-4 space-y-3 min-w-0 overflow-hidden ${cardBg}`}>
                          {/* Header + Toolbar */}
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[13.5px] font-medium">写前影子快照</div>
                              <div className={`text-[11px] mt-0.5 ${mutedText}`}>
                                Muse 写入前自动保存的安全检查点，支持单条无损还原
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 text-xs">
                              <select
                                aria-label="快照排序方式"
                                value={snapshotSort}
                                onChange={(e) =>
                                  setSnapshotSort(e.target.value as SnapshotSortOrder)
                                }
                                className={`px-2 py-1 rounded-lg text-[11.5px] border-0 outline-none cursor-pointer ${subtleBg}`}
                              >
                                <option value="newest">最新优先</option>
                                <option value="oldest">最早优先</option>
                                <option value="files-desc">按改动文件数</option>
                              </select>

                              <select
                                aria-label="每组显示条数"
                                value={perGroupLimit}
                                onChange={(e) => setPerGroupLimit(Number(e.target.value))}
                                className={`px-2 py-1 rounded-lg text-[11.5px] border-0 outline-none cursor-pointer ${subtleBg}`}
                              >
                                <option value={3}>每目录最近 3 次</option>
                                <option value={5}>每目录最近 5 次</option>
                                <option value={10}>每目录最近 10 次</option>
                                <option value={0}>显示全部 ({state.snapshots.length})</option>
                              </select>
                            </div>
                          </div>

                          {/* Batch Record Cleanup Bar (Delete records only, never batch rollback) */}
                          {(() => {
                            const allGroupsCollapsed =
                              groupedSnapshots.length > 0 &&
                              groupedSnapshots.every((g) => Boolean(collapsedGroups[g.normKey]));
                            const toggleAllGroups = () => {
                              const next = !allGroupsCollapsed;
                              const updated: Record<string, boolean> = {};
                              groupedSnapshots.forEach((g) => {
                                updated[g.normKey] = next;
                              });
                              setCollapsedGroups(updated);
                            };

                            return (
                              <div
                                className={`px-3 py-2 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs ${subtleBg}`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <button
                                    type="button"
                                    onClick={toggleSelectAllVisible}
                                    disabled={visibleSnapshotIds.length === 0}
                                    className="px-2 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                                  >
                                    {allVisibleSelected ? '取消全选' : '全选当前可见'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={toggleAllGroups}
                                    disabled={groupedSnapshots.length === 0}
                                    className="px-2 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                                  >
                                    {allGroupsCollapsed ? '全部展开' : '全部折叠'}
                                  </button>
                                  <span className={`text-[11.5px] truncate ${mutedText}`}>
                                    已选 {activeSelectedIds.length} 条记录
                                  </span>
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    onClick={handlePruneRecentSnapshots}
                                    disabled={state.snapshots.length === 0}
                                    title="按工作区仅保留最近 N 条快照记录，自动清理更早记录"
                                    className="px-2.5 py-1 rounded-lg text-[11.5px] bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                                  >
                                    磁盘瘦身：各目录仅留 {perGroupLimit > 0 ? perGroupLimit : 5} 次
                                  </button>
                                  <button
                                    type="button"
                                    onClick={handleDeleteSelectedSnapshots}
                                    disabled={activeSelectedIds.length === 0}
                                    className="px-2.5 py-1 rounded-lg text-[11.5px] bg-red-500/15 text-red-300 hover:bg-red-500/25 disabled:opacity-40 flex items-center gap-1 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    <span>
                                      删除所选记录
                                      {activeSelectedIds.length > 0 ? ` (${activeSelectedIds.length})` : ''}
                                    </span>
                                  </button>
                                </div>
                              </div>
                            );
                          })()}

                          {/* Grouped Snapshot List */}
                          {groupedSnapshots.length === 0 ? (
                            <div className={`p-4 rounded-xl text-center text-xs ${subtleBg} ${mutedText}`}>
                              暂无写前影子快照记录
                            </div>
                          ) : (
                            <div className="space-y-2.5 pr-1 max-h-[460px] overflow-y-auto overscroll-contain">
                              {groupedSnapshots.map((group) => {
                                const isCollapsed = Boolean(collapsedGroups[group.normKey]);
                                const limitedItems =
                                  perGroupLimit > 0 && !expandedGroups[group.normKey]
                                    ? group.items.slice(0, perGroupLimit)
                                    : group.items;
                                const isTrimmed = limitedItems.length < group.items.length;

                                return (
                                  <div
                                    key={group.normKey}
                                    className={`rounded-xl overflow-hidden shrink-0 border border-white/[0.05] ${subtleBg}`}
                                  >
                                    {/* Multi-level Workspace Group Header */}
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        const willExpand = Boolean(collapsedGroups[group.normKey]);
                                        setCollapsedGroups((prev) => ({
                                          ...prev,
                                          [group.normKey]: !prev[group.normKey],
                                        }));
                                        if (willExpand) {
                                          const card = event.currentTarget.parentElement;
                                          window.requestAnimationFrame(() => {
                                            card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                                          });
                                        }
                                      }}
                                      className="w-full px-3 py-2.5 min-h-[44px] h-[44px] shrink-0 flex items-center justify-between gap-2 bg-white/[0.03] hover:bg-white/[0.06] transition-colors duration-120 cursor-pointer text-left min-w-0"
                                    >
                                      <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                                        {isCollapsed ? (
                                          <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-70" />
                                        ) : (
                                          <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-70" />
                                        )}
                                        <Folder className="w-3.5 h-3.5 text-[#8AB8FF] shrink-0" />
                                        <span
                                          className="text-xs font-mono font-semibold text-[#ECECEE] truncate"
                                          title={group.displayPath}
                                        >
                                          {group.folderName}
                                        </span>
                                        {group.parentPrefix && (
                                          <span
                                            className={`text-[11px] font-mono truncate max-w-[200px] shrink-0 ${mutedText}`}
                                            title={group.displayPath}
                                          >
                                            {group.parentPrefix}
                                          </span>
                                        )}
                                      </div>

                                      <div className="flex items-center gap-1.5 shrink-0 text-[11px] font-mono">
                                        <span className="px-2 py-0.5 rounded-full bg-white/[0.08] text-[#c4c5cc] border border-white/[0.06]">
                                          {isTrimmed
                                            ? `${limitedItems.length}/${group.items.length} 条快照`
                                            : `${group.items.length} 条快照`}
                                        </span>
                                      </div>
                                    </button>

                                    {/* Group Snapshot Rows */}
                                    {!isCollapsed && (
                                      <div className="divide-y divide-white/[0.04] overflow-x-hidden flex flex-col">
                                        {limitedItems.map((snap) => {
                                          const checked = Boolean(selectedSnapshotIds[snap.id]);
                                          const shortHash = String(snap.treeHash || '').slice(0, 8);
                                          const compactTime = formatCompactTime(snap.timestamp);
                                          const fileCount = parseModifiedFileCount(snap.diffStat);

                                          return (
                                            <div
                                              key={snap.id}
                                              className="px-3 py-2.5 min-h-[56px] flex flex-col justify-center gap-1.5 min-w-0 hover:bg-white/[0.02] shrink-0 transition-colors duration-120"
                                            >
                                              <div className="flex items-center justify-between gap-2.5 min-w-0">
                                                <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                                                  <input
                                                    type="checkbox"
                                                    aria-label={`选择快照 ${snap.id}`}
                                                    checked={checked}
                                                    onChange={(e) => {
                                                      const val = e.target.checked;
                                                      setSelectedSnapshotIds((prev) => ({
                                                        ...prev,
                                                        [snap.id]: val,
                                                      }));
                                                    }}
                                                    className="rounded border-white/10 bg-black/30 cursor-pointer shrink-0"
                                                  />
                                                  <span
                                                    className="text-xs font-semibold text-[#ECECEE] truncate"
                                                    title={snap.triggerReason || '写入前快照'}
                                                  >
                                                    {snap.triggerReason || '写入前快照'}
                                                  </span>
                                                </div>

                                                <div className="flex items-center gap-2 shrink-0">
                                                  <span className="font-mono text-[11px] opacity-60">
                                                    {compactTime}
                                                  </span>
                                                  <button
                                                    type="button"
                                                    data-testid="snapshot-rollback-button"
                                                    onClick={() => {
                                                      setConfirmModal({
                                                        open: true,
                                                        title: '回滚至该影子快照',
                                                        message: `确定要将工作区回滚至快照 "${snap.id}" 吗？工作区自该快照之后的所有修改将被覆盖还原。`,
                                                        danger: true,
                                                        confirmText: '确认回滚',
                                                        onConfirm: () => {
                                                          mwhService.rollbackSnapshot(snap.id);
                                                        },
                                                      });
                                                    }}
                                                    className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors duration-120 cursor-pointer whitespace-nowrap ${
                                                      snap.rolledBack
                                                        ? 'bg-emerald-500/15 text-emerald-400'
                                                        : 'bg-white/10 hover:bg-white/20 text-[#ECECEE]'
                                                    }`}
                                                  >
                                                    {snap.rolledBack ? (
                                                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                                                    ) : (
                                                      <RotateCcw className="w-3.5 h-3.5" />
                                                    )}
                                                    <span>{snap.rolledBack ? '已回滚' : '回滚此快照'}</span>
                                                  </button>
                                                </div>
                                              </div>

                                              <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#8E909A] pl-6 overflow-hidden truncate">
                                                <span className="text-[#8AB8FF] shrink-0" title={snap.diffStat}>
                                                  {fileCount} 个文件变动
                                                </span>
                                                <span className="opacity-40 shrink-0">·</span>
                                                <span className="shrink-0" title={`Git Tree Hash: ${snap.treeHash}`}>
                                                  #{shortHash}
                                                </span>
                                                <span className="opacity-40 shrink-0">·</span>
                                                <span className="truncate opacity-70" title={snap.id}>
                                                  {snap.id}
                                                </span>
                                              </div>
                                            </div>
                                          );
                                        })}

                                        {isTrimmed && (
                                          <div className="p-2 text-center shrink-0 border-t border-white/[0.04]">
                                            <button
                                              type="button"
                                              onClick={() =>
                                                setExpandedGroups((prev) => ({
                                                  ...prev,
                                                  [group.normKey]: true,
                                                }))
                                              }
                                              className="text-xs text-[#8AB8FF] hover:underline cursor-pointer"
                                            >
                                              查看该目录下其余 {group.items.length - limitedItems.length} 条快照...
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className={`rounded-2xl p-4 space-y-3 min-w-0 overflow-hidden ${cardBg}`}>
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[13.5px] font-medium truncate">
                              本地审计日志 (.mwh/logs/audit.jsonl)
                            </div>

                            <div
                              role="group"
                              aria-label="按决策过滤审计日志"
                              className={`flex items-center p-1 rounded-xl gap-1 text-xs font-mono shrink-0 ${subtleBg}`}
                            >
                              {(['ALL', 'ALLOW', 'ASK', 'BLOCK'] as const).map((flt) => (
                                <button
                                  key={flt}
                                  type="button"
                                  onClick={() => setAuditFilter(flt)}
                                  className={`px-2.5 py-1 rounded-lg transition-colors duration-120 cursor-pointer ${
                                    auditFilter === flt
                                      ? 'bg-[#2B7FFF] text-white font-medium'
                                      : 'opacity-70 hover:opacity-100'
                                  }`}
                                >
                                  {flt}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-1.5 max-h-44 overflow-y-auto overflow-x-hidden pr-1">
                            {state.auditLogs
                              .filter(
                                (item) => auditFilter === 'ALL' || item.decision === auditFilter,
                              )
                              .map((entry) => {
                                const isModeOrSecurityChange =
                                  entry.toolName === 'switch_mode' ||
                                  entry.toolName === 'auto_downgrade' ||
                                  entry.toolName === 'approval_policy';
                                return (
                                  <div
                                    key={entry.id}
                                    data-testid={
                                      entry.toolName === 'switch_mode'
                                        ? 'audit-mode-switch-entry'
                                        : 'audit-log-entry'
                                    }
                                    className={`p-2.5 rounded-xl text-xs font-mono space-y-1 transition-colors min-w-0 overflow-hidden ${
                                      isModeOrSecurityChange
                                        ? 'bg-amber-500/12 border border-amber-500/50 ring-1 ring-amber-500/30'
                                        : subtleBg
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-2 min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                                        <span
                                          className={`font-semibold ${
                                            entry.decision === 'ALLOW'
                                              ? 'text-emerald-400'
                                              : entry.decision === 'ASK'
                                                ? 'text-amber-400'
                                                : 'text-red-400'
                                          }`}
                                        >
                                          [{entry.decision}]
                                        </span>
                                        <span className="font-semibold truncate">
                                          {entry.toolName}
                                        </span>
                                        {entry.toolName === 'switch_mode' && (
                                          <span className="px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-300 text-[10.5px] font-semibold">
                                            模式变更
                                          </span>
                                        )}
                                        <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10.5px] opacity-85">
                                          来源: {entry.actor}
                                        </span>
                                      </div>
                                      <span className="opacity-60 shrink-0">
                                        {formatCompactTime(entry.timestamp)}
                                      </span>
                                    </div>
                                    <div className="truncate opacity-90" title={entry.commandOrPath}>
                                      {entry.commandOrPath}
                                    </div>
                                    <div
                                      className={`text-[11px] font-sans truncate ${mutedText}`}
                                      title={entry.reason}
                                    >
                                      {entry.reason}
                                    </div>
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            {/* 自定义 ACP 子代理新增 / 编辑弹窗 */}
            <AnimatePresence>
              {acpModalOpen && (
                <motion.div
                  key="acp-edit-modal-backdrop"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
                  onClick={(e) => {
                    if (e.target === e.currentTarget && !acpSaving) {
                      setAcpModalOpen(false);
                    }
                  }}
                >
                  <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className={`w-full max-w-md rounded-2xl p-5 shadow-2xl border ${modalBg} space-y-4`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold">
                          {acpEditingId ? '编辑 ACP 代理' : '添加自定义 ACP 代理'}
                        </div>
                        <div className={`text-xs ${mutedText} mt-0.5`}>
                          {acpEditingId
                            ? `修改 ${acpEditingId} 的启动路径与参数`
                            : '基于 Agent Client Protocol / 外部引擎配置'}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={acpSaving}
                        onClick={() => setAcpModalOpen(false)}
                        className="p-1 rounded-lg hover:bg-white/10 text-neutral-400 hover:text-white transition-colors cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <form onSubmit={handleSaveAcp} className="space-y-3">
                      {/* 唯一标识 ID */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium block">
                          代理标识 (ID) <span className="text-rose-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          disabled={Boolean(acpEditingId) || acpSaving}
                          value={acpFormId}
                          onChange={(e) => setAcpFormId(e.target.value)}
                          placeholder="例如: codebuddy 或 agy"
                          pattern="^[a-zA-Z0-9_\-]+$"
                          title="只允许英文字母、数字、下划线和短横线"
                          className={`w-full px-3 py-1.5 rounded-xl text-xs font-mono border border-transparent ${subtleBg} focus:outline-none focus:border-sky-500 disabled:opacity-60`}
                        />
                      </div>

                      {/* 显示名称 */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium block">显示名称 (Display Name)</label>
                        <input
                          type="text"
                          disabled={acpSaving}
                          value={acpFormDisplayName}
                          onChange={(e) => setAcpFormDisplayName(e.target.value)}
                          placeholder="例如: CodeBuddy 助手"
                          className={`w-full px-3 py-1.5 rounded-xl text-xs border border-transparent ${subtleBg} focus:outline-none focus:border-sky-500`}
                        />
                      </div>

                      {/* 可执行文件路径 Command */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-medium block">
                            可执行文件路径 (Command) <span className="text-rose-400">*</span>
                          </label>
                          <button
                            type="button"
                            onClick={handleProbeAcp}
                            className="text-[11px] font-mono text-sky-400 hover:text-sky-300 underline cursor-pointer"
                          >
                            探测路径
                          </button>
                        </div>
                        <input
                          type="text"
                          required
                          disabled={acpSaving}
                          value={acpFormCommand}
                          onChange={(e) => {
                            setAcpFormCommand(e.target.value);
                            setAcpProbeStatus(null);
                          }}
                          placeholder="例如: C:\Program Files\nodejs\node.exe 或 node"
                          className={`w-full px-3 py-1.5 rounded-xl text-xs font-mono border border-transparent ${subtleBg} focus:outline-none focus:border-sky-500`}
                        />

                        {/* 探测结果提示 */}
                        {acpProbeStatus?.tested && (
                          <div
                            className={`text-[11px] font-mono p-2 rounded-lg flex items-center gap-1.5 ${
                              acpProbeStatus.available
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-amber-500/15 text-amber-400'
                            }`}
                          >
                            {acpProbeStatus.available ? (
                              <>
                                <Check className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">
                                  可执行文件已就绪: {acpProbeStatus.path}
                                </span>
                              </>
                            ) : (
                              <>
                                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                <span>未找到可执行文件 ({acpProbeStatus.error || '检查路径拼写'})</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* 启动参数 Args */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium block">启动参数 (Args)</label>
                        <input
                          type="text"
                          disabled={acpSaving}
                          value={acpFormArgs}
                          onChange={(e) => setAcpFormArgs(e.target.value)}
                          placeholder="以空格分隔，例如: C:\path\to\agent.js --acp"
                          className={`w-full px-3 py-1.5 rounded-xl text-xs font-mono border border-transparent ${subtleBg} focus:outline-none focus:border-sky-500`}
                        />
                        <div className={`text-[10.5px] ${mutedText}`}>
                          提示：执行时输入提示词将自动作为后续参数或经 stdin 管道传递。
                        </div>
                      </div>

                      {/* 立即启用 */}
                      <div className="flex items-center gap-2 pt-1">
                        <input
                          type="checkbox"
                          id="acp-enabled-toggle"
                          checked={acpFormEnabled}
                          disabled={acpSaving}
                          onChange={(e) => setAcpFormEnabled(e.target.checked)}
                          className="rounded border-white/10 text-sky-500 focus:ring-0 cursor-pointer"
                        />
                        <label
                          htmlFor="acp-enabled-toggle"
                          className="text-xs cursor-pointer select-none"
                        >
                          立即启用此代理
                        </label>
                      </div>

                      {/* 弹窗底部操作按钮 */}
                      <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/[0.05]">
                        <button
                          type="button"
                          disabled={acpSaving}
                          onClick={() => setAcpModalOpen(false)}
                          className="px-3.5 py-1.5 rounded-xl text-xs font-medium hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          取消
                        </button>
                        <button
                          type="submit"
                          disabled={acpSaving}
                          className="px-4 py-1.5 rounded-xl text-xs font-medium bg-[#2B7FFF] hover:bg-[#256FE0] text-white transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {acpSaving ? '保存中...' : '保存并生效'}
                        </button>
                      </div>
                    </form>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Custom UI Glass Confirm Dialog (Zero native window.confirm) */}
            {confirmModal && confirmModal.open && (
              <div
                role="alertdialog"
                aria-modal="true"
                className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
              >
                <div className="w-[380px] max-w-[90vw] rounded-2xl bg-[#1e1f24] border border-transparent p-5 shadow-2xl space-y-4">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                        confirmModal.danger ? 'bg-red-500/15 text-red-400' : 'bg-[#2B7FFF]/15 text-[#8AB8FF]'
                      }`}
                    >
                      {confirmModal.danger ? <AlertCircle className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
                    </div>
                    <div className="text-[14.5px] font-semibold text-white">{confirmModal.title}</div>
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-[#B5B6BF]">
                    {confirmModal.message}
                  </p>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setConfirmModal(null)}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-medium text-[#C8C9D0] hover:bg-white/[0.08] transition-colors cursor-pointer"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const cb = confirmModal.onConfirm;
                        setConfirmModal(null);
                        await cb();
                      }}
                      className={`px-4 py-1.5 rounded-xl text-xs font-medium text-white transition-colors cursor-pointer ${
                        confirmModal.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-[#2B7FFF] hover:bg-[#256FE0]'
                      }`}
                    >
                      {confirmModal.confirmText || '确定'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

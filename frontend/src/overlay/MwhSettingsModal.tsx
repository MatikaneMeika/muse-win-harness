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
  HelpCircle,
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
import { MwhSwitch } from './MwhSwitch';
import {
  AuditDecision,
  ConfinementMode,
  getPermissionProfileList,
  getPermissionProfileMeta,
  TunnelDriverType,
} from '../services/mwhRules';
import {
  mwhService,
  MwhState,
  ShadowSnapshot,
  AcpProfile,
  PublicResourceEntry,
  ResourceKind,
  McpTransport,
} from '../services/mwhService';
import { useMwhState } from '../services/useMwhState';
import { useTranslation } from '../i18n';

const NAV_ITEMS: Array<{
  id: MwhState['activeSettingsTab'];
  labelKey: string;
  sectionHeaderKey: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'connectors', labelKey: 'tab.connectors.label', sectionHeaderKey: 'tab.connectors.header', icon: Grid },
  { id: 'daemon', labelKey: 'tab.daemon.label', sectionHeaderKey: 'tab.daemon.header', icon: Monitor },
  { id: 'resources', labelKey: 'tab.resources.label', sectionHeaderKey: 'tab.resources.header', icon: Folder },
  { id: 'snapshots-audit', labelKey: 'tab.audit.label', sectionHeaderKey: 'tab.audit.header', icon: FileText },
];

const PEEK_AUTO_HIDE_MS = 15000;

function maskEndpointUrl(rawUrl: string, isPeeked: boolean): string {
  const str = String(rawUrl || '').trim();
  if (!str || isPeeked) return str;
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(str)) {
    return str;
  }
  return str.replace(/^(https?:\/\/)([^/?#]+)(.*)$/i, (_m, proto: string, hostPort: string, rest: string) => {
    const parts = hostPort.split('.');
    if (parts.length >= 2) {
      const sub = parts[0];
      const maskedSub =
        sub.length <= 4 ? `${sub.slice(0, 1)}••••` : `${sub.slice(0, 3)}••••${sub.slice(-2)}`;
      return `${proto}${[maskedSub, ...parts.slice(1)].join('.')}${rest}`;
    }
    return `${proto}${hostPort.slice(0, 3)}••••${rest}`;
  });
}

export const TOUR_STEPS = [
  {
    id: 'activity-entry',
    target: 'tour-activity-entry',
    titleKey: 'tour.step1.title',
    bodyKey: 'tour.step1.body',
  },
  {
    id: 'permission-modes',
    target: 'tour-permission-modes',
    titleKey: 'tour.step2.title',
    bodyKey: 'tour.step2.body',
  },
  {
    id: 'endpoints-credentials',
    target: 'tour-endpoints-credentials',
    titleKey: 'tour.step3.title',
    bodyKey: 'tour.step3.body',
  },
  {
    id: 'advanced-center',
    target: 'tour-advanced-center',
    titleKey: 'tour.step4.title',
    bodyKey: 'tour.step4.body',
  },
  {
    id: 'approval-island',
    target: 'tour-approval-island',
    titleKey: 'tour.step5.title',
    bodyKey: 'tour.step5.body',
  },
  {
    id: 'desktop-hands',
    target: 'tour-desktop-hands',
    titleKey: 'tour.step6.title',
    bodyKey: 'tour.step6.body',
  },
] as const;

type SnapshotSortOrder = 'newest' | 'oldest' | 'files-desc';

interface WorkspaceSnapshotGroup {
  normKey: string;
  displayPath: string;
  parentPrefix: string;
  folderName: string;
  items: ShadowSnapshot[];
}

function normalizeWinPath(rawPath: string, unassignedLabel: string): {
  normKey: string;
  displayPath: string;
  parentPrefix: string;
  folderName: string;
} {
  const trimmed = (rawPath || unassignedLabel).trim().replace(/\//g, '\\').replace(/\\+$/, '');
  const displayPath = trimmed || unassignedLabel;
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
  const { t, language: lang } = useTranslation();
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
  const [isEndpointPeeked, setIsEndpointPeeked] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [switchingMode, setSwitchingMode] = useState<string | null>(null);
  const [tunnelActionLoading, setTunnelActionLoading] = useState<string | null>(null);

  useEffect(() => {
    if (!state.settingsModalOpen) {
      setIsTokenPeeked(false);
      setIsEndpointPeeked(false);
      setTourOpen(false);
      return;
    }
    if (!isTokenPeeked && !isEndpointPeeked) return;
    const timer = window.setTimeout(() => {
      setIsTokenPeeked(false);
      setIsEndpointPeeked(false);
    }, PEEK_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [state.settingsModalOpen, isTokenPeeked, isEndpointPeeked]);

  useEffect(() => {
    if (!tourOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setTourOpen(false);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setTourStepIndex((prev) => {
          if (prev + 1 >= TOUR_STEPS.length) {
            setTourOpen(false);
            return 0;
          }
          return prev + 1;
        });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setTourStepIndex((prev) => Math.max(0, prev - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tourOpen]);

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
      title: t('agents.deleteAcpConfirmTitle'),
      message: t('agents.deleteAcpConfirmMsg', { id }),
      danger: true,
      confirmText: t('agents.confirmDeleteBtn'),
      onConfirm: async () => {
        await mwhService.deleteAcpProfile(id);
      },
    });
  };

  // Resource Library controls
  const [resAddOpen, setResAddOpen] = useState(false);
  const [resEditingId, setResEditingId] = useState<string | null>(null);
  const [resKind, setResKind] = useState<ResourceKind>('mcp');
  const [resTransport, setResTransport] = useState<McpTransport>('stdio');
  const [resId, setResId] = useState('');
  const [resDisplayName, setResDisplayName] = useState('');
  const [resCommand, setResCommand] = useState('');
  const [resArgs, setResArgs] = useState('');
  const [resCwd, setResCwd] = useState('');
  const [resHttpUrl, setResHttpUrl] = useState('');
  const [resSkillDir, setResSkillDir] = useState('');
  const [resReadonly, setResReadonly] = useState(false);
  const [resEnabled, setResEnabled] = useState(false);
  const [resProbing, setResProbing] = useState(false);
  const [resProbeResult, setResProbeResult] = useState<{
    ok: boolean;
    tools?: Array<{ name: string; description?: string }>;
    error?: string;
    faultReason?: string;
  } | null>(null);
  const [resExpandedIds, setResExpandedIds] = useState<Record<string, boolean>>({});
  const [resScanning, setResScanning] = useState(false);

  const handleOpenAddResource = () => {
    setResEditingId(null);
    setResKind('mcp');
    setResTransport('stdio');
    setResId('');
    setResDisplayName('');
    setResCommand('');
    setResArgs('');
    setResCwd('');
    setResHttpUrl('');
    setResSkillDir('');
    setResReadonly(false);
    setResEnabled(false);
    setResProbeResult(null);
    setResAddOpen(true);
  };

  const handleOpenEditResource = (entry: PublicResourceEntry) => {
    setResEditingId(entry.id);
    setResKind(entry.kind);
    setResTransport(entry.transport || 'stdio');
    setResId(entry.id);
    setResDisplayName(entry.displayName || '');
    setResCommand(entry.command || '');
    setResArgs((entry.args || []).join(' '));
    setResCwd(entry.cwd || '');
    setResHttpUrl(entry.httpUrl || '');
    setResSkillDir(entry.skillDirDisplay || '');
    setResReadonly(entry.readonly === true);
    setResEnabled(entry.enabled === true);
    setResProbeResult(null);
    setResAddOpen(true);
  };

  const handleProbeResource = async () => {
    setResProbing(true);
    try {
      let params: Record<string, unknown> = {};
      if (resKind === 'mcp') {
        if (resTransport === 'stdio') {
          params = {
            transport: 'stdio',
            command: resCommand.trim(),
            args: resArgs.split(/\s+/).filter(Boolean),
            cwd: resCwd.trim() || undefined,
          };
        } else {
          params = {
            transport: 'http',
            httpUrl: resHttpUrl.trim(),
          };
        }
      } else {
        params = {
          kind: 'skill',
          skillDir: resSkillDir.trim(),
        };
      }
      const res = await mwhService.probeResource(params);
      setResProbeResult(res);
    } finally {
      setResProbing(false);
    }
  };

  const handleSaveResource = async () => {
    const disp = resDisplayName.trim() || resId.trim();
    if (!disp) return;
    if (resEditingId) {
      await mwhService.updateResource(resEditingId, {
        displayName: disp,
        command: resCommand.trim(),
        args: resArgs.split(/\s+/).filter(Boolean),
        cwd: resCwd.trim() || undefined,
        httpUrl: resHttpUrl.trim() || undefined,
        skillDir: resSkillDir.trim() || undefined,
        readonly: resReadonly,
      });
    } else {
      await mwhService.addResource({
        id: resId.trim() || disp,
        displayName: disp,
        kind: resKind,
        transport: resKind === 'mcp' ? resTransport : undefined,
        command: resCommand.trim(),
        args: resArgs.split(/\s+/).filter(Boolean),
        cwd: resCwd.trim() || undefined,
        httpUrl: resHttpUrl.trim() || undefined,
        skillDir: resSkillDir.trim() || undefined,
        enable: resEnabled,
        readonly: false,
      });
    }
    setResAddOpen(false);
  };

  const handleDeleteResource = (entry: PublicResourceEntry) => {
    setConfirmModal({
      open: true,
      title: t('resources.deleteConfirmTitle'),
      message: t('resources.deleteConfirmMsg', { name: entry.displayName || entry.id }),
      danger: true,
      confirmText: t('agents.confirmDeleteBtn'),
      onConfirm: async () => {
        await mwhService.deleteResource(entry.id);
      },
    });
  };

  const handleScanResources = async () => {
    setResScanning(true);
    try {
      await mwhService.scanResources();
    } finally {
      setResScanning(false);
    }
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
      const info = normalizeWinPath(snap.workspacePath, t('common.unclassifiedWorkspace'));
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
  }, [state.snapshots, snapshotSort, lang]);

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
      title: t('audit.batchDeleteTitle'),
      message: t('audit.batchDeleteMsg', { count: activeSelectedIds.length }),
      danger: true,
      confirmText: t('agents.confirmDeleteBtn'),
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
      title: t('audit.pruneConfirmTitle'),
      message: t('audit.pruneConfirmMsg', { count: keepCount }),
      danger: false,
      confirmText: t('audit.pruneConfirmBtn'),
      onConfirm: () => {
        mwhService.pruneSnapshots(keepCount);
        setSelectedSnapshotIds({});
      },
    });
  };

  const pairing = mwhService.getPairingArtifacts();
  const currentProfile = getPermissionProfileMeta(state.confinementMode, state.approvalPolicy, lang);
  const permissionProfiles = getPermissionProfileList(lang);

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
            aria-label={t('modal.ariaLabel')}
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
            transition={modalTransition}
            className={`relative w-[760px] max-w-[96vw] h-[580px] max-h-[90vh] rounded-[24px] border shadow-[0_20px_60px_rgba(0,0,0,0.28)] flex overflow-hidden ${modalBg}`}
          >
            {/* Left Navigation Column (1:1 Muse Official Settings Sidebar) */}
            <nav
              aria-label={t('modal.navAriaLabel')}
              className="w-[200px] shrink-0 h-full flex flex-col py-5 px-3.5"
            >
              <div>
                <div className="px-3 pb-4" data-tour-id="tour-activity-entry">
                  <h2 className="text-[19px] font-bold tracking-tight">{t('modal.title')}</h2>
                </div>

                <div className="space-y-0.5" data-tour-id="tour-advanced-center">
                  {NAV_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const active = state.activeSettingsTab === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => mwhService.setActiveSettingsTab(item.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] transition-colors duration-120 cursor-pointer whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6366F1]/70 ${
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
                        <span className="truncate">{t(item.labelKey)}</span>
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
                  {(() => { const item = NAV_ITEMS.find((i) => i.id === state.activeSettingsTab); return item ? t(item.sectionHeaderKey) : ''; })()}
                </h3>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    data-action="open-tour"
                    data-testid="mwh-open-tour-btn"
                    onClick={() => {
                      setTourStepIndex(0);
                      setTourOpen(true);
                    }}
                    title={t('modal.tourTitle')}
                    aria-label={t('modal.tourTitle')}
                    className="w-7 h-7 rounded-full flex items-center justify-center transition-colors duration-120 cursor-pointer hover:bg-white/[0.08] text-[#D8D9E0]"
                  >
                    <HelpCircle className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => mwhService.closeSettingsModal()}
                    aria-label={t('modal.closeAriaLabel')}
                    className="w-7 h-7 rounded-full flex items-center justify-center transition-colors duration-120 cursor-pointer hover:bg-white/[0.08] text-[#D8D9E0]"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
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
                    {/* TAB 1: 连接与权限 */}
                    {(state.activeSettingsTab === 'connectors' || state.activeSettingsTab === 'permissions') && (
                      <div className="space-y-4 pt-1">
                        <div className={`text-[13px] font-semibold tracking-wide ${mutedText}`}>
                          {t('connectors.title')}
                        </div>
                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div className="flex items-center justify-between gap-2 min-w-0">
                            <div className="min-w-0">
                              <div className="text-[14px] font-medium truncate">
                                {t('connectors.pairingTitle')}
                              </div>
                              <div className={`text-xs mt-0.5 truncate ${mutedText}`}>
                                {t('connectors.pairingMeta', { endpoint: maskEndpointUrl(mwhService.getActivePublicBaseUrl(), isEndpointPeeked), profile: currentProfile.shortLabel })}
                              </div>
                            </div>
                            <span className={`text-xs font-mono shrink-0 px-2 py-0.5 rounded bg-black/20 ${mutedText}`}>
                              {state.tunnel.activeDriver}
                            </span>
                          </div>

                          <details className="rounded-xl px-3 py-2 text-[11.5px] cursor-pointer group bg-white/[0.03]">
                            <summary className="font-medium text-[#A5B4FC] flex items-center justify-between select-none">
                              <span>{t('connectors.viewPairing')}</span>
                              <ChevronDown className="w-3.5 h-3.5 group-open:rotate-180 transition-transform" />
                            </summary>
                            <pre
                              className={`mt-2 rounded-xl p-3 text-[11.5px] font-mono overflow-x-auto max-h-32 leading-relaxed ${subtleBg}`}
                            >
                              {pairing.skillMarkdownPrompt}
                            </pre>
                          </details>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                              <button
                                type="button"
                                onClick={() => {
                                  mwhService.copyTextWithToast(
                                    pairing.skillMarkdownPrompt,
                                    t('connectors.copiedPairingToast'),
                                    true,
                                  );
                                }}
                                className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] hover:brightness-105 text-white flex items-center gap-1.5 transition-all duration-120 cursor-pointer whitespace-nowrap max-w-full min-w-0 overflow-hidden text-ellipsis"
                              >
                                <Copy className="w-3.5 h-3.5 shrink-0" />
                                <span>{t('connectors.copyPairing')}</span>
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  mwhService.copyTextWithToast(
                                    pairing.mcpJsonConfig,
                                    t('connectors.copiedMcpJsonToast'),
                                  )
                                }
                                className={`px-3.5 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors duration-120 cursor-pointer whitespace-nowrap max-w-full min-w-0 overflow-hidden text-ellipsis ${subtleBg} hover:opacity-85`}
                              >
                                <Copy className="w-3.5 h-3.5 shrink-0" />
                                <span>{t('connectors.copyMcpJson')}</span>
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2.5">
                          {(
                            [
                              {
                                id: 'cloudflare-named',
                                title: t('connectors.driver.cfNamed.title'),
                                sub: t('connectors.driver.cfNamed.sub'),
                              },
                              {
                                id: 'cloudflare-quick',
                                title: t('connectors.driver.cfQuick.title'),
                                sub: t('connectors.driver.cfQuick.sub'),
                              },
                              {
                                id: 'tailscale-funnel',
                                title: t('connectors.driver.tsFunnel.title'),
                                sub: t('connectors.driver.tsFunnel.sub'),
                              },
                              {
                                id: 'custom-tls',
                                title: t('connectors.driver.customTls.title'),
                                sub: t('connectors.driver.customTls.sub'),
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
                                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#A5B4FC]" />
                                  ) : active ? (
                                    <span className="text-[11px] font-mono text-white/90 px-1.5 py-0.5 rounded bg-white/[0.1] border border-white/[0.08]">{t('common.active')}</span>
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
                                {t('connectors.cfNamed.title')}
                              </div>
                              <div className="grid grid-cols-1 gap-2.5 text-xs">
                                <label className="space-y-1">
                                  <span className={mutedText}>{t('connectors.cfNamed.domainLabel')}</span>
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
                                    {t('connectors.cfQuick.title')}
                                  </div>
                                  <div className={`text-xs ${mutedText}`}>
                                    {t('connectors.cfQuick.sub')}
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
                                  className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white hover:brightness-105 transition-all duration-120 cursor-pointer whitespace-nowrap flex items-center gap-1.5 disabled:opacity-50"
                                >
                                  {tunnelActionLoading === 'spawn_quick' ? (
                                    <>
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      <span>{t('connectors.cfQuick.starting')}</span>
                                    </>
                                  ) : (
                                    <span>{t('connectors.cfQuick.restart')}</span>
                                  )}
                                </button>
                              </div>
                              <div className={`px-3 py-2 rounded-xl font-mono text-xs truncate ${subtleBg}`}>
                                {t('connectors.cfQuick.currentDomain', { url: state.tunnel.cfQuickUrl || t('connectors.localOnly') })}
                              </div>
                            </div>
                          )}

                          {state.tunnel.activeDriver === 'tailscale-funnel' && (
                            <div className="space-y-2.5 text-xs">
                              <div className="text-[13.5px] font-medium">
                                {t('connectors.tailscale.title')}
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <label className="space-y-1">
                                  <span className={mutedText}>{t('connectors.tailscale.ipLabel')}</span>
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
                                  <span className={mutedText}>{t('connectors.tailscale.magicDnsLabel')}</span>
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
                                {t('connectors.customTls.title')}
                              </div>
                              <label className="space-y-1 block">
                                <span className={mutedText}>{t('connectors.customTls.urlLabel')}</span>
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

                        <div
                          data-tour-id="tour-endpoints-credentials"
                          className={`rounded-2xl p-4 space-y-2.5 text-xs ${cardBg}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-[13.5px] font-medium">
                              {t('connectors.endpoints.title')}
                            </div>
                            <button
                              type="button"
                              data-action="toggle-endpoint-peek"
                              onClick={() => setIsEndpointPeeked((prev) => !prev)}
                              title={
                                isEndpointPeeked
                                  ? t('connectors.endpoints.hideUrl')
                                  : t('connectors.endpoints.peekUrl')
                              }
                              className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 transition-colors duration-120 cursor-pointer flex items-center gap-1 text-[11px]"
                            >
                              {isEndpointPeeked ? (
                                <EyeOff className="w-3.5 h-3.5" />
                              ) : (
                                <Eye className="w-3.5 h-3.5" />
                              )}
                              <span>{isEndpointPeeked ? t('connectors.endpoints.hideBtn') : t('connectors.endpoints.showBtn')}</span>
                            </button>
                          </div>

                          <div
                            className={`p-2.5 rounded-xl flex items-center justify-between gap-2 min-w-0 font-mono ${subtleBg}`}
                          >
                            <span className="truncate">
                              MCP: {maskEndpointUrl(pairing.mcpEndpoint, isEndpointPeeked)}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                mwhService.copyTextWithToast(
                                  pairing.mcpEndpoint,
                                  t('connectors.endpoints.copiedMcpUrl'),
                                )
                              }
                              className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 transition-colors duration-120 cursor-pointer shrink-0"
                            >
                              {t('common.copy')}
                            </button>
                          </div>

                          <div
                            className={`p-2.5 rounded-xl flex items-center justify-between gap-2 min-w-0 font-mono ${subtleBg}`}
                          >
                            <span className="truncate">
                              REST: {maskEndpointUrl(pairing.restEndpoint, isEndpointPeeked)}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                mwhService.copyTextWithToast(pairing.restEndpoint, t('connectors.endpoints.copiedRestUrl'))
                              }
                              className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 transition-colors duration-120 cursor-pointer shrink-0"
                            >
                              {t('common.copy')}
                            </button>
                          </div>

                          <div
                            className={`p-2.5 rounded-xl flex flex-wrap items-center justify-between gap-2 min-w-0 font-mono ${subtleBg}`}
                          >
                            <span className="truncate">
                              Token: {isTokenPeeked ? (mwhService.getRealToken() || state.tunnel.bearerToken) : state.tunnel.bearerToken}
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                data-action="toggle-token-peek"
                                onClick={() => setIsTokenPeeked((prev) => !prev)}
                                title={isTokenPeeked ? t('connectors.endpoints.hideToken') : t('connectors.endpoints.peekToken')}
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
                                    t('connectors.endpoints.copiedToken')
                                  );
                                }}
                                className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 transition-colors duration-120 cursor-pointer"
                              >
                                {t('connectors.endpoints.copyRealToken')}
                              </button>
                              <button
                                type="button"
                                onClick={() => mwhService.rotateBearerToken()}
                                className="px-2.5 py-1 rounded bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white hover:brightness-105 flex items-center gap-1 transition-all duration-120 cursor-pointer"
                              >
                                <RefreshCw className="w-3 h-3" />
                                <span>{t('connectors.endpoints.rotateToken')}</span>
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* 小节：权限 */}
                        <div className={`text-[13px] font-semibold tracking-wide mt-6 mb-2 ${mutedText}`}>
                          {t('permissions.title')}
                        </div>

                        <div
                          className="space-y-2"
                          role="radiogroup"
                          aria-label={t('permissions.ariaLabel')}
                          data-tour-id="tour-permission-modes"
                        >
                          {permissionProfiles.map((prof) => {
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
                                      title: t('permissions.fullAccessConfirmTitle'),
                                      message: t('permissions.fullAccessConfirmMsg'),
                                      danger: true,
                                      confirmText: t('permissions.fullAccessConfirmBtn'),
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
                                      ? 'bg-[#E06C60]/15 border-[#E06C60]'
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
                                    <span className="flex items-center gap-1 text-xs text-[#A5B4FC] font-mono">
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      <span>{t('permissions.switching')}</span>
                                    </span>
                                  ) : selected ? (
                                    <span
                                      className={`text-xs font-mono shrink-0 ${
                                        isDanger ? 'text-[#F28B82]' : 'text-[#A5B4FC]'
                                      }`}
                                    >
                                      {t('common.currentActive')}
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
                                {t('permissions.autoDowngradeLabel')}
                              </div>
                              <div className={`text-[11px] font-mono mt-0.5 ${mutedText}`}>
                                {t('permissions.autoDowngradeRemain', { minutes: Math.floor(state.autoDowngradeRemainingSec / 60) })}
                                {state.autoDowngradeRemainingSec % 60}s
                              </div>
                            </div>
                            <MwhSwitch
                              checked={Boolean(state.autoDowngradeTwoHours)}
                              onChange={() => mwhService.toggleAutoDowngradeTwoHours()}
                              label={t('permissions.autoDowngradeAria')}
                              dark={chromeDark}
                            />
                          </div>
                          <div
                            className={`p-3 rounded-xl flex items-center justify-between gap-3 mt-3 ${subtleBg}`}
                          >
                            <div>
                              <div className="text-xs font-medium">{t('permissions.multiDeviceTitle')}</div>
                              <div className={`text-[11px] mt-0.5 leading-relaxed ${mutedText}`}>
                                {t('permissions.multiDeviceBodyPrefix')}
                                
                                <span className="text-[#EAB364]">{t('permissions.multiDeviceBodyHighlight')}</span>
                                {t('permissions.multiDeviceBodySuffix')}
                                
                              </div>
                            </div>
                            <MwhSwitch
                              checked={Boolean(state.multiDeviceApproval)}
                              onChange={() => mwhService.toggleMultiDeviceApproval()}
                              label={t('permissions.multiDeviceAria')}
                              dark={chromeDark}
                            />
                          </div>
                          <div
                            data-tour-id="tour-desktop-hands"
                            className={`p-3 rounded-xl flex items-center justify-between gap-3 mt-3 ${subtleBg}`}
                          >
                            <div>
                              <div className="text-xs font-medium">{t('permissions.desktopHandsTitle')}</div>
                              <div className={`text-[11px] mt-0.5 leading-relaxed ${mutedText}`}>
                                {t('permissions.desktopHandsBody')}
                              </div>
                            </div>
                            <MwhSwitch
                              checked={Boolean(state.desktopHandsEnabled)}
                              onChange={() => mwhService.toggleDesktopHands()}
                              label={t('permissions.desktopHandsAria')}
                              dark={chromeDark}
                            />
                          </div>
                          {state.desktopHandsEnabled && (
                            <div
                              className={`p-3 rounded-xl flex items-center justify-between gap-3 mt-2 ${subtleBg}`}
                            >
                              <div>
                                <div className="text-xs font-medium">{t('permissions.desktopHandsForegroundTitle')}</div>
                                <div className={`text-[11px] mt-0.5 leading-relaxed ${mutedText}`}>
                                  {t('permissions.desktopHandsForegroundBody')}
                                </div>
                              </div>
                              <MwhSwitch
                                checked={Boolean(state.desktopHandsForegroundFallback)}
                                onChange={() => mwhService.toggleDesktopHandsForegroundFallback()}
                                label={t('permissions.desktopHandsForegroundAria')}
                                dark={chromeDark}
                              />
                            </div>
                          )}
                        </div>

                        {/* 动态安全边界说明 */}
                        <div className={`rounded-2xl p-4 space-y-2.5 ${cardBg}`}>
                          <div className="text-[13.5px] font-medium">
                            {t('permissions.detailsTitle', { profile: currentProfile.shortLabel })}
                          </div>

                          <div className="space-y-1 text-xs">
                            <div className="font-medium text-[#7DD3FC]">{t('permissions.enforcedTitle')}</div>
                            {currentProfile.enforcedProtections.map((line, idx) => (
                              <div key={idx} className="pl-3 leading-relaxed opacity-90">
                                - {line}
                              </div>
                            ))}
                          </div>

                          <div className="space-y-1 text-xs pt-1">
                            <div className="font-medium text-[#EAB364]">{t('permissions.uncoveredTitle')}</div>
                            {currentProfile.uncoveredBoundaries.map((line, idx) => (
                              <div key={idx} className="pl-3 leading-relaxed opacity-90">
                                - {line}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* TAB 2: 工作区与代理 */}
                    {(state.activeSettingsTab === 'daemon' || state.activeSettingsTab === 'subagents') && (
                      <div className="space-y-4 pt-1">
                        <div className={`text-[13px] font-semibold tracking-wide ${mutedText}`}>
                          {t('daemon.title')}
                        </div>
                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div className="flex items-center justify-between">
                            <span className="text-[14px] font-medium">
                              {t('daemon.hostTitle')}
                            </span>
                            <span
                              className={`text-xs font-mono ${
                                state.daemon.connected ? 'text-[#7DD3FC]' : 'text-neutral-400'
                              }`}
                            >
                              {state.daemon.connected
                                ? t('daemon.online')
                                : t('daemon.offline')}
                            </span>
                          </div>

                          <div className="grid grid-cols-3 gap-2.5 text-xs font-mono">
                            <div className={`p-3 rounded-xl ${subtleBg}`}>
                              <div className={mutedText}>{t('daemon.pidMem')}</div>
                              <div className="text-[13px] font-medium mt-0.5">
                                #{state.daemon.pid} · {state.daemon.memoryMb} MB
                              </div>
                            </div>
                            <div className={`p-3 rounded-xl ${subtleBg}`}>
                              <div className={mutedText}>{t('daemon.silentFlag')}</div>
                              <div className="text-[13px] font-medium mt-0.5">
                                {state.daemon.createNoWindowActive ? 'CREATE_NO_WINDOW' : t('daemon.notEnabled')}
                              </div>
                            </div>
                            <div className={`p-3 rounded-xl ${subtleBg}`}>
                              <div className={mutedText}>{t('daemon.activeJobObjects')}</div>
                              <div className="text-[13px] font-medium mt-0.5">
                                {t('daemon.controlledHandles', { count: state.daemon.activeJobObjects })}
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
                                className="flex-1 py-2.5 px-4 rounded-xl bg-[#D05A4E] hover:bg-[#B84A3E] text-white font-semibold text-[13px] flex items-center justify-center gap-2 transition-colors duration-120 cursor-pointer ring-2 ring-[#F28B82]/60"
                              >
                                <ShieldAlert className="w-4 h-4" />
                                <span>{t('daemon.confirmKillAll')}</span>
                              </button>
                              <button
                                type="button"
                                data-testid="emergency-kill-cancel-btn"
                                onClick={() => setConfirmingEmergencyKill(false)}
                                className={`py-2.5 px-4 rounded-xl text-[13px] font-medium ${subtleBg} hover:opacity-80 transition-opacity duration-120 cursor-pointer`}
                              >
                                {t('common.cancel')}
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              data-testid="emergency-kill-trigger-btn"
                              onClick={() => setConfirmingEmergencyKill(true)}
                              className="w-full py-2.5 px-4 rounded-xl bg-[#E06C60] hover:bg-[#D05A4E] text-white font-medium text-[13px] flex items-center justify-center gap-2 transition-colors duration-120 cursor-pointer"
                            >
                              <ShieldAlert className="w-4 h-4" />
                              <span>{t('daemon.emergencyStopAll')}</span>
                            </button>
                          )}
                        </div>

                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div>
                            <div className="text-[13.5px] font-medium">
                              {t('daemon.workspacesTitle')}
                            </div>
                            <div className={`text-xs mt-0.5 ${mutedText}`}>
                              {t('daemon.workspacesDesc')}
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={newWorkspaceInput}
                              onChange={(e) => setNewWorkspaceInput(e.target.value)}
                              placeholder={t('daemon.workspacePlaceholder')}
                              aria-label={t('daemon.workspaceInputAria')}
                              className={`flex-1 px-3 py-2 rounded-xl text-xs font-mono border-0 outline-none ${subtleBg}`}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                mwhService.addWorkspaceRoot(newWorkspaceInput);
                                setNewWorkspaceInput('');
                              }}
                              className="px-3.5 py-2 rounded-xl text-xs font-medium bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] hover:brightness-105 text-white flex items-center gap-1.5 transition-all duration-120 cursor-pointer whitespace-nowrap"
                            >
                              <FolderPlus className="w-3.5 h-3.5" />
                              <span>{t('daemon.addWorkspace')}</span>
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
                                  aria-label={t('daemon.removeWorkspaceAria', { path: rootPath })}
                                  className="text-[#F28B82] hover:text-[#E06C60] p-1 transition-colors duration-120 cursor-pointer shrink-0"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* 小节：代理 */}
                        <div className={`text-[13px] font-semibold tracking-wide mt-6 mb-2 ${mutedText}`}>
                          {t('agents.title')}
                        </div>

                        {/* 自定义 ACP 代理档案 */}
                        <div className={`rounded-2xl p-4 space-y-3 ${cardBg}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-[13.5px] font-medium">{t('agents.customAcpTitle')}</span>
                                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-[#6366F1]/16 text-[#A5B4FC]">
                                  Agent Client Protocol
                                </span>
                              </div>
                              <div className={`text-xs ${mutedText} mt-0.5`}>
                                {t('agents.customAcpDesc')}
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => openAcpCreateModal()}
                              className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[#6366F1]/20 text-[#A5B4FC] hover:bg-[#6366F1]/30 flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              {t('agents.addAcp')}
                            </button>
                          </div>

                          {/* Profiles 列表 */}
                          {!state.acpProfiles || state.acpProfiles.length === 0 ? (
                            <div
                              className={`p-4 rounded-xl text-center space-y-2 border border-dashed border-white/[0.06] ${subtleBg}`}
                            >
                              <div className={`text-xs ${mutedText}`}>
                                {t('agents.emptyAcp')}
                              </div>
                              <button
                                type="button"
                                onClick={() => openAcpCreateModal()}
                                className="px-3 py-1 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/15 transition-colors cursor-pointer"
                              >
                                {t('agents.addFirstAcp')}
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
                                          profile.detected ? 'text-[#7DD3FC]' : 'text-[#EAB364]'
                                        }`}
                                      >
                                        {profile.detected ? (
                                          <>
                                            <Check className="w-3 h-3" /> {t('agents.execReady')}
                                          </>
                                        ) : (
                                          <>
                                            <AlertCircle className="w-3 h-3" /> {t('agents.execMissing')}
                                          </>
                                        )}
                                      </span>
                                      {!profile.enabled && (
                                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-500/20 text-neutral-400">
                                          {t('agents.disabledBadge')}
                                        </span>
                                      )}
                                    </div>

                                    <div className={`text-[11px] font-mono truncate mt-1 ${mutedText}`}>
                                      <span className="text-neutral-400">{t('agents.commandLabel')}</span>{' '}
                                      {profile.binaryPath || profile.command}
                                      {profile.args && profile.args.length > 0 && (
                                        <span className="opacity-60 ml-2">
                                          {t('agents.argsLabel', { args: profile.args.join(' ') })}
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2 shrink-0">
                                    {/* 启禁用开关 */}
                                    <MwhSwitch
                                      checked={profile.enabled !== false}
                                      onChange={() => mwhService.toggleAcpProfile(profile.id)}
                                      label={`${profile.enabled !== false ? t('common.disable') : t('common.enable')} ${
                                        profile.display_name || profile.id
                                      }`}
                                      dark={chromeDark}
                                    />

                                    {/* 编辑按钮 */}
                                    <button
                                      type="button"
                                      onClick={() => openAcpEditModal(profile)}
                                      className="p-1.5 rounded-lg hover:bg-white/10 text-neutral-300 hover:text-white transition-colors cursor-pointer"
                                      title={t('agents.editAcpTitle')}
                                    >
                                      <Edit2 className="w-3.5 h-3.5" />
                                    </button>

                                    {/* 删除按钮 */}
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteAcp(profile.id)}
                                      className="p-1.5 rounded-lg hover:bg-[#E06C60]/20 text-neutral-400 hover:text-[#F28B82] transition-colors cursor-pointer"
                                      title={t('agents.deleteAcpTitle')}
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
                                {t('agents.worktreeTitle')}
                              </div>
                              <div className={`text-xs ${mutedText}`}>
                                {t('agents.currentParentProfile', { profile: currentProfile.shortLabel })}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <select
                                aria-label={t('agents.selectChildModeAria')}
                                value={requestedSpawnMode}
                                onChange={(e) =>
                                  setRequestedSpawnMode(e.target.value as ConfinementMode)
                                }
                                className={`px-2.5 py-1.5 rounded-xl text-xs font-mono border-0 outline-none ${subtleBg}`}
                              >
                                <option value="read-only">{t('agents.modeReadOnly')}</option>
                                <option value="workspace-write">{t('agents.modeWorkspaceWrite')}</option>
                                <option value="danger-full-access">{t('agents.modeFullAccess')}</option>
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
                                className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white hover:brightness-105 transition-all duration-120 cursor-pointer whitespace-nowrap"
                              >
                                {t('agents.createWorktree')}
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
                                      <span className="font-semibold text-[#A5B4FC]">{wt.id}</span>
                                      <span className="truncate">· {wt.branchName}</span>
                                      <span>{t('agents.worktreeAgent', { id: wt.agentId })}</span>
                                      <span>{t('agents.worktreeEffective', { mode: wt.childMode })}</span>
                                    </div>

                                    <div className="flex items-center gap-1.5 shrink-0">
                                      {wt.status !== 'MERGED' && wt.status !== 'MISSING' && (
                                        <button
                                          type="button"
                                          onClick={() => mwhService.mergeWorktree(wt.id)}
                                          className="px-2.5 py-1 rounded-lg text-xs font-medium bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white hover:brightness-105 flex items-center gap-1 transition-all duration-120 cursor-pointer"
                                        >
                                          <GitMerge className="w-3 h-3" />
                                          <span>{t('agents.mergeBack')}</span>
                                        </button>
                                      )}
                                      {wt.status === 'MISSING' && (
                                        <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-[#D99B43]/15 text-[#EAB364]">
                                          {t('agents.cleanedMissing')}
                                        </span>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => mwhService.removeWorktree(wt.id)}
                                        className="px-2.5 py-1 rounded-lg text-xs bg-[#E06C60]/15 text-[#F28B82] hover:bg-[#E06C60]/25 transition-colors duration-120 cursor-pointer"
                                      >
                                        {t('agents.cleanBranch')}
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
                                        {t('agents.outputPagination', { current: pageIdx + 1, total: pages.length })}
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
                                        {t('agents.switchPage')}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* TAB 3: 资源库 (本机 MCP 与 Skill) */}
                    {state.activeSettingsTab === 'resources' && (
                      <div className="space-y-4 pt-1">
                        {/* Header Banner */}
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h4 className="text-[16px] font-bold tracking-tight">{t('resources.title')}</h4>
                            <div className="text-xs space-y-0.5 mt-1 leading-relaxed">
                              <p className={chromeDark ? 'text-[#ececee]' : 'text-[#1d1d1f]'}>
                                {t('resources.activationNote')}
                              </p>
                              <p className={mutedText}>
                                {t('resources.sandboxNote')}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={handleScanResources}
                              disabled={resScanning}
                              className={`px-3 py-1.5 rounded-[10px] text-xs font-medium flex items-center gap-1.5 transition-colors duration-120 cursor-pointer ${
                                chromeDark
                                  ? 'bg-[#27282c] hover:bg-[#313238] text-[#ececee]'
                                  : 'bg-[#f7f6f2] hover:bg-[#e6e4de] text-[#1d1d1f]'
                              } border border-white/5`}
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${resScanning ? 'animate-spin' : ''}`} />
                              <span>{resScanning ? t('resources.scanning') : t('resources.scanLocal')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleOpenAddResource}
                              className="px-3 py-1.5 rounded-[10px] text-xs font-medium bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white hover:brightness-105 flex items-center gap-1.5 transition-all duration-120 cursor-pointer shadow-sm"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>{t('resources.add')}</span>
                            </button>
                          </div>
                        </div>

                        {/* In-page Add / Edit Form */}
                        {resAddOpen && (
                          <div className={`rounded-[14px] p-4 space-y-3.5 ${cardBg} border border-[#6366F1]/25`}>
                            <div className="flex items-center justify-between">
                              <span className="text-[13.5px] font-semibold text-[#A5B4FC]">
                                {resEditingId ? t('resources.editTitle') : t('resources.addTitle')}
                              </span>
                              <button
                                type="button"
                                onClick={() => setResAddOpen(false)}
                                className="w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/[0.08] text-neutral-400 hover:text-white"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>

                            {/* Kind Selector (only if not editing) */}
                            {!resEditingId && (
                              <div className="flex items-center gap-2">
                                <span className={`text-xs ${mutedText} w-20 shrink-0`}>{t('resources.typeLabel')}</span>
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setResKind('mcp')}
                                    className={`px-2.5 py-1 rounded-[8px] text-xs font-medium cursor-pointer transition-colors ${
                                      resKind === 'mcp'
                                        ? 'bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white'
                                        : 'bg-white/5 text-neutral-400 hover:bg-white/10'
                                    }`}
                                  >
                                    {t('resources.localMcp')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setResKind('skill')}
                                    className={`px-2.5 py-1 rounded-[8px] text-xs font-medium cursor-pointer transition-colors ${
                                      resKind === 'skill'
                                        ? 'bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white'
                                        : 'bg-white/5 text-neutral-400 hover:bg-white/10'
                                    }`}
                                  >
                                    Skill
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Display Name */}
                            <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                              <span className={`text-xs ${mutedText} w-20 shrink-0`}>{t('resources.displayNameLabel')}</span>
                              <input
                                type="text"
                                value={resDisplayName}
                                onChange={(e) => setResDisplayName(e.target.value)}
                                placeholder={t('resources.displayNamePlaceholder')}
                                className={`flex-1 rounded-[8px] px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-[#6366F1] ${subtleBg}`}
                              />
                            </div>

                            {/* MCP-specific fields */}
                            {resKind === 'mcp' && (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs ${mutedText} w-20 shrink-0`}>{t('resources.transportLabel')}</span>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => setResTransport('stdio')}
                                      className={`px-2.5 py-1 rounded-[8px] text-xs font-medium cursor-pointer transition-colors ${
                                        resTransport === 'stdio'
                                          ? 'bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white'
                                          : 'bg-white/5 text-neutral-400 hover:bg-white/10'
                                      }`}
                                    >
                                      stdio
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setResTransport('http')}
                                      className={`px-2.5 py-1 rounded-[8px] text-xs font-medium cursor-pointer transition-colors ${
                                        resTransport === 'http'
                                          ? 'bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white'
                                          : 'bg-white/5 text-neutral-400 hover:bg-white/10'
                                      }`}
                                    >
                                      Streamable HTTP
                                    </button>
                                  </div>
                                </div>

                                {resTransport === 'stdio' ? (
                                  <>
                                    <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                                      <span className={`text-xs ${mutedText} w-20 shrink-0`}>{t('resources.cmdLabel')}</span>
                                      <input
                                        type="text"
                                        value={resCommand}
                                        onChange={(e) => setResCommand(e.target.value)}
                                        placeholder={t('resources.cmdPlaceholder')}
                                        className={`flex-1 rounded-[8px] px-3 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-[#6366F1] ${subtleBg}`}
                                      />
                                    </div>
                                    <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                                      <span className={`text-xs ${mutedText} w-20 shrink-0`}>{t('resources.argsLabel')}</span>
                                      <input
                                        type="text"
                                        value={resArgs}
                                        onChange={(e) => setResArgs(e.target.value)}
                                        placeholder={t('resources.argsPlaceholder')}
                                        className={`flex-1 rounded-[8px] px-3 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-[#6366F1] ${subtleBg}`}
                                      />
                                    </div>
                                    <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                                      <span className={`text-xs ${mutedText} w-20 shrink-0`}>{t('resources.cwdLabel')}</span>
                                      <input
                                        type="text"
                                        value={resCwd}
                                        onChange={(e) => setResCwd(e.target.value)}
                                        placeholder={t('resources.cwdPlaceholder')}
                                        className={`flex-1 rounded-[8px] px-3 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-[#6366F1] ${subtleBg}`}
                                      />
                                    </div>
                                  </>
                                ) : (
                                  <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                                    <span className={`text-xs ${mutedText} w-20 shrink-0`}>HTTP URL</span>
                                    <input
                                      type="text"
                                      value={resHttpUrl}
                                      onChange={(e) => setResHttpUrl(e.target.value)}
                                      placeholder={t('resources.urlPlaceholder')}
                                      className={`flex-1 rounded-[8px] px-3 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-[#6366F1] ${subtleBg}`}
                                    />
                                  </div>
                                )}
                              </>
                            )}

                            {/* Skill-specific fields */}
                            {resKind === 'skill' && (
                              <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                                <span className={`text-xs ${mutedText} w-20 shrink-0`}>{t('resources.skillDirLabel')}</span>
                                <input
                                  type="text"
                                  value={resSkillDir}
                                  onChange={(e) => setResSkillDir(e.target.value)}
                                  placeholder={t('resources.skillDirPlaceholder')}
                                  className={`flex-1 rounded-[8px] px-3 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-[#6366F1] ${subtleBg}`}
                                />
                              </div>
                            )}

                            {/* Edit-only: 只读 option */}
                            {resEditingId && (
                              <div
                                className={`flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 ${subtleBg}`}
                              >
                                <span className="text-xs leading-relaxed">
                                  {t('resources.readOnlyLabel')}
                                </span>
                                <MwhSwitch
                                  checked={resReadonly}
                                  onChange={setResReadonly}
                                  label={t('resources.readOnlyAria')}
                                  title={t('resources.readOnlyTitle')}
                                  dark={chromeDark}
                                />
                              </div>
                            )}

                            {/* Add-only: 立即启用 option (default false) */}
                            {!resEditingId && (
                              <div
                                className={`flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 ${subtleBg}`}
                              >
                                <span className="text-xs leading-relaxed">{t('resources.enableNowLabel')}</span>
                                <MwhSwitch
                                  checked={resEnabled}
                                  onChange={setResEnabled}
                                  label={t('resources.enableNowAria')}
                                  title={t('resources.enableNowTitle')}
                                  dark={chromeDark}
                                />
                              </div>
                            )}

                            {/* Probe Action & Result */}
                            <div className="pt-1 flex flex-wrap items-center justify-between gap-2 border-t border-white/5">
                              <button
                                type="button"
                                onClick={handleProbeResource}
                                disabled={resProbing}
                                className="px-2.5 py-1 rounded-[8px] text-xs bg-white/5 hover:bg-white/10 text-neutral-300 flex items-center gap-1 cursor-pointer transition-colors"
                              >
                                <RefreshCw className={`w-3 h-3 ${resProbing ? 'animate-spin' : ''}`} />
                                <span>{resProbing ? t('resources.probing') : t('resources.probeConn')}</span>
                              </button>

                              {resProbeResult && (
                                <div className="text-xs">
                                  {resProbeResult.ok ? (
                                    <span className="text-[#7DD3FC]">
                                      {t('resources.probeConnOk', { tools: resProbeResult.tools ? t('resources.probeConnTools', { count: resProbeResult.tools.length }) : '' })}
                                    </span>
                                  ) : (
                                    <span className="text-[#EAB364]">
                                      {t('resources.probeConnFail', { error: resProbeResult.error || resProbeResult.faultReason || t('resources.probeConnDefaultErr') })}
                                    </span>
                                  )}
                                </div>
                              )}

                              <div className="flex items-center gap-2 ml-auto">
                                <button
                                  type="button"
                                  onClick={() => setResAddOpen(false)}
                                  className="px-3 py-1 rounded-[8px] text-xs bg-white/5 hover:bg-white/10 text-neutral-300 cursor-pointer"
                                >
                                  {t('common.cancel')}
                                </button>
                                <button
                                  type="button"
                                  onClick={handleSaveResource}
                                  className="px-3 py-1 rounded-[8px] text-xs bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white hover:brightness-105 font-medium cursor-pointer"
                                >
                                  {t('common.save')}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Card 1: 本机 MCP */}
                        <div className={`rounded-[14px] p-4 space-y-3 ${cardBg}`}>
                          <div>
                            <div className="text-[14px] font-semibold text-[#1d1d1f] dark:text-[#ececee]">
                              {t('resources.localMcp')}
                            </div>
                            <div className={`text-xs ${mutedText} mt-0.5`}>
                              {t('resources.mcpSectionSub')}
                            </div>
                          </div>

                          <div className="space-y-2">
                            {state.resources.entries.filter((e) => e.kind === 'mcp').length === 0 ? (
                              <div className={`text-xs ${mutedText} py-3 text-center`}>
                                {t('resources.mcpEmpty')}
                              </div>
                            ) : (
                              state.resources.entries
                                .filter((e) => e.kind === 'mcp')
                                .map((entry) => {
                                  const isExpanded = Boolean(resExpandedIds[entry.id]);
                                  const isFault = Boolean(entry.faultReason || entry.runtimeStatus === 'fault');
                                  const isRunning = entry.runtimeStatus === 'running';

                                  return (
                                    <div
                                      key={entry.id}
                                      className={`rounded-xl p-3 border transition-colors ${
                                        chromeDark
                                          ? 'bg-[#1e1f23] border-white/5'
                                          : 'bg-[#e6e4de] border-black/5'
                                      }`}
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <div
                                          className="flex items-center gap-2 min-w-0 cursor-pointer flex-1"
                                          onClick={() =>
                                            setResExpandedIds((prev) => ({
                                              ...prev,
                                              [entry.id]: !prev[entry.id],
                                            }))
                                          }
                                        >
                                          <button
                                            type="button"
                                            className="text-neutral-400 hover:text-white p-0.5"
                                          >
                                            {isExpanded ? (
                                              <ChevronDown className="w-3.5 h-3.5" />
                                            ) : (
                                              <ChevronRight className="w-3.5 h-3.5" />
                                            )}
                                          </button>
                                          <span className="text-[13px] font-medium truncate">
                                            {entry.displayName || entry.id}
                                          </span>
                                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-neutral-400 shrink-0">
                                            {entry.sourceLabel || (entry.source === 'scan' ? t('resources.sourceScan') : t('resources.sourceManual'))}
                                          </span>
                                          {isFault ? (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#D99B43]/15 text-[#EAB364] shrink-0 font-medium">
                                              {entry.faultReason || t('resources.faultStart')}
                                            </span>
                                          ) : isRunning ? (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#38BDF8]/12 text-[#7DD3FC] shrink-0">
                                              {t('resources.statusRunning')}
                                            </span>
                                          ) : (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-500/10 text-neutral-400 shrink-0">
                                              {t('resources.statusClosed')}
                                            </span>
                                          )}
                                          {entry.readonly && (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-neutral-400 shrink-0">
                                              {t('resources.readOnlyBadge')}
                                            </span>
                                          )}
                                        </div>

                                        <div className="flex items-center gap-3 shrink-0 ml-3">
                                          <span
                                            className={`text-[11px] font-medium tabular-nums tracking-normal ${mutedText} shrink-0 whitespace-nowrap`}
                                            style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}
                                          >
                                            {t('resources.toolCount', { count: entry.toolCount ?? entry.exposedToolNames?.length ?? 0 })}
                                          </span>
                                          <div className="flex items-center gap-2">
                                          <MwhSwitch
                                            checked={entry.enabled}
                                            onChange={(next) => mwhService.toggleResource(entry.id, next)}
                                            label={`${entry.enabled ? t('common.disable') : t('common.enable')} ${
                                              entry.displayName || entry.id
                                            }`}
                                            title={
                                              isFault
                                                ? entry.faultReason || t('resources.faultTitle')
                                                : entry.enabled
                                                  ? t('resources.toggleOnTitle')
                                                  : t('resources.toggleOffTitle')
                                            }
                                            dark={chromeDark}
                                          />
                                          <button
                                            type="button"
                                            onClick={() => handleOpenEditResource(entry)}
                                            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-white/5 cursor-pointer"
                                            title={t('common.edit')}
                                          >
                                            <Edit2 className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleDeleteResource(entry)}
                                            className="p-1 rounded text-[#F28B82] hover:text-[#E06C60] hover:bg-white/5 cursor-pointer"
                                            title={t('common.delete')}
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                          </div>
                                        </div>
                                      </div>

                                      {/* Expandable in-place tools list */}
                                      {isExpanded && (
                                        <div className={`mt-2.5 pt-2.5 border-t border-white/5 space-y-2`}>
                                          <div className="text-[11.5px] font-medium text-neutral-400">
                                            {t('resources.toolsMounted')}
                                          </div>
                                          {isFault && (
                                            <div className="text-xs text-[#EAB364]">
                                              {t('resources.toolsUnmounted')}
                                            </div>
                                          )}
                                          {entry.exposedToolNames && entry.exposedToolNames.length > 0 ? (
                                            <div className="flex flex-wrap gap-1.5">
                                              {entry.exposedToolNames.map((tool, idx) => (
                                                <div
                                                  key={idx}
                                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 text-[11px] font-normal font-mono text-neutral-300"
                                                  title={t('resources.originalName', { name: tool.original })}
                                                >
                                                  <span>{tool.exposed}</span>
                                                  <span className="text-[11px] font-normal text-neutral-500">({tool.original})</span>
                                                </div>
                                              ))}
                                            </div>
                                          ) : (
                                            <div className={`text-xs ${mutedText}`}>
                                              {t('resources.noTools')}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })
                            )}
                          </div>
                        </div>

                        {/* Card 2: Skill */}
                        <div className={`rounded-[14px] p-4 space-y-3 ${cardBg}`}>
                          <div>
                            <div className="text-[14px] font-semibold text-[#1d1d1f] dark:text-[#ececee]">
                              Skill
                            </div>
                            <div className={`text-xs ${mutedText} mt-0.5`}>
                              {t('resources.skillSectionSub')}
                            </div>
                          </div>

                          <div className="space-y-2">
                            {state.resources.entries.filter((e) => e.kind === 'skill').length === 0 ? (
                              <div className={`text-xs ${mutedText} py-3 text-center`}>
                                {t('resources.skillEmpty')}
                              </div>
                            ) : (
                              state.resources.entries
                                .filter((e) => e.kind === 'skill')
                                .map((entry) => {
                                  const isExpanded = Boolean(resExpandedIds[entry.id]);
                                  const isReady = entry.enabled;
                                  // SKILL.md 缺失等故障不能显示成绿色「已就绪」。
                                  const skillFault = Boolean(
                                    entry.faultReason || entry.runtimeStatus === 'fault'
                                  );

                                  return (
                                    <div
                                      key={entry.id}
                                      className={`rounded-xl p-3 border transition-colors ${
                                        chromeDark
                                          ? 'bg-[#1e1f23] border-white/5'
                                          : 'bg-[#e6e4de] border-black/5'
                                      }`}
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <div
                                          className="flex items-center gap-2 min-w-0 cursor-pointer flex-1"
                                          onClick={() =>
                                            setResExpandedIds((prev) => ({
                                              ...prev,
                                              [entry.id]: !prev[entry.id],
                                            }))
                                          }
                                        >
                                          <button
                                            type="button"
                                            className="text-neutral-400 hover:text-white p-0.5"
                                          >
                                            {isExpanded ? (
                                              <ChevronDown className="w-3.5 h-3.5" />
                                            ) : (
                                              <ChevronRight className="w-3.5 h-3.5" />
                                            )}
                                          </button>
                                          <span className="text-[13px] font-medium truncate">
                                            {entry.displayName || entry.id}
                                          </span>
                                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-neutral-400 shrink-0">
                                            {entry.sourceLabel || (entry.source === 'scan' ? t('resources.sourceScan') : t('resources.sourceManual'))}
                                          </span>
                                          {skillFault ? (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#D99B43]/15 text-[#EAB364] font-semibold shrink-0">
                                              {entry.faultReason || t('resources.faultUnavailable')}
                                            </span>
                                          ) : isReady ? (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#38BDF8]/12 text-[#7DD3FC] shrink-0">
                                              {t('resources.statusReady')}
                                            </span>
                                          ) : (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-500/10 text-neutral-400 shrink-0">
                                              {t('resources.statusClosed')}
                                            </span>
                                          )}
                                        </div>

                                        <div className="flex items-center gap-2 shrink-0">
                                          <MwhSwitch
                                            checked={entry.enabled}
                                            onChange={(next) => mwhService.toggleResource(entry.id, next)}
                                            label={`${entry.enabled ? t('common.disable') : t('common.enable')} ${
                                              entry.displayName || entry.id
                                            }`}
                                            title={entry.enabled ? t('resources.toggleOnTitle') : t('resources.toggleOffTitle')}
                                            dark={chromeDark}
                                          />
                                          <button
                                            type="button"
                                            onClick={() => handleOpenEditResource(entry)}
                                            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-white/5 cursor-pointer"
                                            title={t('common.edit')}
                                          >
                                            <Edit2 className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleDeleteResource(entry)}
                                            className="p-1 rounded text-[#F28B82] hover:text-[#E06C60] hover:bg-white/5 cursor-pointer"
                                            title={t('common.delete')}
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      </div>

                                      {/* Expandable in-place description & path */}
                                      {isExpanded && (
                                        <div className="mt-2.5 pt-2.5 border-t border-white/5 space-y-1.5 text-xs">
                                          <div className="text-neutral-300 leading-relaxed">
                                            {entry.skillDescription || t('resources.noDescription')}
                                          </div>
                                          <div className="font-mono text-[11px] text-neutral-500">
                                            {t('resources.sourceDir', { dir: entry.skillDirDisplay || '~' })}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* TAB 4: 审计日志 (快照回滚与审计日志) */}
                    {state.activeSettingsTab === 'snapshots-audit' && (
                      <>
                        <div className={`rounded-2xl p-4 space-y-3 min-w-0 overflow-hidden ${cardBg}`}>
                          {/* Header + Toolbar */}
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[13.5px] font-medium">{t('audit.snapshotsTitle')}</div>
                              <div className={`text-[11px] mt-0.5 ${mutedText}`}>
                                {t('audit.snapshotsDesc')}
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 text-xs">
                              <select
                                aria-label={t('audit.sortAria')}
                                value={snapshotSort}
                                onChange={(e) =>
                                  setSnapshotSort(e.target.value as SnapshotSortOrder)
                                }
                                className={`px-2 py-1 rounded-lg text-[11.5px] border-0 outline-none cursor-pointer ${subtleBg}`}
                              >
                                <option value="newest">{t('audit.sortNewest')}</option>
                                <option value="oldest">{t('audit.sortOldest')}</option>
                                <option value="files-desc">{t('audit.sortFilesDesc')}</option>
                              </select>

                              <select
                                aria-label={t('audit.limitAria')}
                                value={perGroupLimit}
                                onChange={(e) => setPerGroupLimit(Number(e.target.value))}
                                className={`px-2 py-1 rounded-lg text-[11.5px] border-0 outline-none cursor-pointer ${subtleBg}`}
                              >
                                <option value={3}>{t('audit.limitN', { count: 3 })}</option>
                                <option value={5}>{t('audit.limitN', { count: 5 })}</option>
                                <option value={10}>{t('audit.limitN', { count: 10 })}</option>
                                <option value={0}>{t('audit.limitAll', { count: state.snapshots.length })}</option>
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
                                    {allVisibleSelected ? t('audit.deselectAll') : t('audit.selectAllVisible')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={toggleAllGroups}
                                    disabled={groupedSnapshots.length === 0}
                                    className="px-2 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                                  >
                                    {allGroupsCollapsed ? t('audit.expandAll') : t('audit.collapseAll')}
                                  </button>
                                  <span className={`text-[11.5px] truncate ${mutedText}`}>
                                    {t('audit.selectedCount', { count: activeSelectedIds.length })}
                                  </span>
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    onClick={handlePruneRecentSnapshots}
                                    disabled={state.snapshots.length === 0}
                                    title={t('audit.pruneTitle')}
                                    className="px-2.5 py-1 rounded-lg text-[11.5px] bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                                  >
                                    {t('audit.pruneBtn', { count: perGroupLimit > 0 ? perGroupLimit : 5 })}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={handleDeleteSelectedSnapshots}
                                    disabled={activeSelectedIds.length === 0}
                                    className="px-2.5 py-1 rounded-lg text-[11.5px] bg-[#E06C60]/15 text-[#F28B82] hover:bg-[#E06C60]/25 disabled:opacity-40 flex items-center gap-1 transition-colors duration-120 cursor-pointer whitespace-nowrap"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    <span>
                                      {t('audit.deleteSelected')}
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
                              {t('audit.snapshotsEmpty')}
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
                                        <Folder className="w-3.5 h-3.5 text-[#A5B4FC] shrink-0" />
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
                                            ? t('audit.groupCountPartial', { shown: limitedItems.length, total: group.items.length })
                                            : t('audit.groupCountTotal', { total: group.items.length })}
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
                                                    aria-label={t('audit.selectSnapAria', { id: snap.id })}
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
                                                    title={snap.triggerReason || t('audit.defaultSnapReason')}
                                                  >
                                                    {snap.triggerReason || t('audit.defaultSnapReason')}
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
                                                        title: t('audit.rollbackConfirmTitle'),
                                                        message: t('audit.rollbackConfirmMsg', { id: snap.id }),
                                                        danger: true,
                                                        confirmText: t('audit.rollbackConfirmBtn'),
                                                        onConfirm: () => {
                                                          mwhService.rollbackSnapshot(snap.id);
                                                        },
                                                      });
                                                    }}
                                                    className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors duration-120 cursor-pointer whitespace-nowrap ${
                                                      snap.rolledBack
                                                        ? 'bg-[#38BDF8]/15 text-[#7DD3FC]'
                                                        : 'bg-white/10 hover:bg-white/20 text-[#ECECEE]'
                                                    }`}
                                                  >
                                                    {snap.rolledBack ? (
                                                      <Check className="w-3.5 h-3.5 text-[#7DD3FC]" />
                                                    ) : (
                                                      <RotateCcw className="w-3.5 h-3.5" />
                                                    )}
                                                    <span>{snap.rolledBack ? t('audit.rolledBack') : t('audit.rollbackThis')}</span>
                                                  </button>
                                                </div>
                                              </div>

                                              <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#8E909A] pl-6 overflow-hidden truncate">
                                                <span className="text-[#A5B4FC] shrink-0" title={snap.diffStat}>
                                                  {t('audit.fileChanges', { count: fileCount })}
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
                                              className="text-xs text-[#A5B4FC] hover:underline cursor-pointer"
                                            >
                                              {t('audit.viewMoreSnaps', { count: group.items.length - limitedItems.length })}
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
                              {t('audit.logsTitle')}
                            </div>

                            <div
                              role="group"
                              aria-label={t('audit.filterDecisionAria')}
                              className={`flex items-center p-1 rounded-xl gap-1 text-xs font-mono shrink-0 ${subtleBg}`}
                            >
                              {(['ALL', 'ALLOW', 'ASK', 'BLOCK'] as const).map((flt) => (
                                <button
                                  key={flt}
                                  type="button"
                                  onClick={() => setAuditFilter(flt)}
                                  className={`px-2.5 py-1 rounded-lg transition-colors duration-120 cursor-pointer ${
                                    auditFilter === flt
                                      ? 'bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white font-medium'
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
                                        ? 'bg-[#D99B43]/14 border border-[#D99B43]/45 ring-1 ring-[#D99B43]/25'
                                        : subtleBg
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-2 min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                                        <span
                                          className={`font-semibold ${
                                            entry.decision === 'ALLOW'
                                              ? 'text-[#7DD3FC]'
                                              : entry.decision === 'ASK'
                                                ? 'text-[#EAB364]'
                                                : 'text-[#F28B82]'
                                          }`}
                                        >
                                          [{entry.decision}]
                                        </span>
                                        <span className="font-semibold truncate">
                                          {entry.toolName}
                                        </span>
                                        {entry.toolName === 'switch_mode' && (
                                          <span className="px-1.5 py-0.5 rounded bg-[#D99B43]/20 text-[#EAB364] text-[10.5px] font-semibold">
                                            {t('audit.modeChange')}
                                          </span>
                                        )}
                                        <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10.5px] opacity-85">
                                          {t('audit.actorLabel', { actor: entry.actor })}
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
                          {acpEditingId ? t('agents.modalEditTitle') : t('agents.modalAddTitle')}
                        </div>
                        <div className={`text-xs ${mutedText} mt-0.5`}>
                          {acpEditingId
                            ? t('agents.modalEditSub', { id: acpEditingId })
                            : t('agents.modalAddSub')}
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
                          {t('agents.formIdLabel')} <span className="text-[#F28B82]">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          disabled={Boolean(acpEditingId) || acpSaving}
                          value={acpFormId}
                          onChange={(e) => setAcpFormId(e.target.value)}
                          placeholder={t('agents.formIdPlaceholder')}
                          pattern="^[a-zA-Z0-9_\-]+$"
                          title={t('agents.formIdTitle')}
                          className={`w-full px-3 py-1.5 rounded-xl text-xs font-mono border border-transparent ${subtleBg} focus:outline-none focus:border-[#6366F1] disabled:opacity-60`}
                        />
                      </div>

                      {/* 显示名称 */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium block">{t('agents.formNameLabel')}</label>
                        <input
                          type="text"
                          disabled={acpSaving}
                          value={acpFormDisplayName}
                          onChange={(e) => setAcpFormDisplayName(e.target.value)}
                          placeholder={t('agents.formNamePlaceholder')}
                          className={`w-full px-3 py-1.5 rounded-xl text-xs border border-transparent ${subtleBg} focus:outline-none focus:border-[#6366F1]`}
                        />
                      </div>

                      {/* 可执行文件路径 Command */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-medium block">
                            {t('agents.formCmdLabel')} <span className="text-[#F28B82]">*</span>
                          </label>
                          <button
                            type="button"
                            onClick={handleProbeAcp}
                            className="text-[11px] font-mono text-[#A5B4FC] hover:text-white underline cursor-pointer"
                          >
                            {t('agents.probePath')}
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
                          placeholder={t('agents.formCmdPlaceholder')}
                          className={`w-full px-3 py-1.5 rounded-xl text-xs font-mono border border-transparent ${subtleBg} focus:outline-none focus:border-[#6366F1]`}
                        />

                        {/* 探测结果提示 */}
                        {acpProbeStatus?.tested && (
                          <div
                            className={`text-[11px] font-mono p-2 rounded-lg flex items-center gap-1.5 ${
                              acpProbeStatus.available
                                ? 'bg-[#38BDF8]/15 text-[#7DD3FC]'
                                : 'bg-[#D99B43]/15 text-[#EAB364]'
                            }`}
                          >
                            {acpProbeStatus.available ? (
                              <>
                                <Check className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">
                                  {t('agents.probeOk', { path: acpProbeStatus.path || '' })}
                                </span>
                              </>
                            ) : (
                              <>
                                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                <span>{t('agents.probeFail', { error: acpProbeStatus.error || t('agents.probeCheckSpelling') })}</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* 启动参数 Args */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium block">{t('agents.formArgsLabel')}</label>
                        <input
                          type="text"
                          disabled={acpSaving}
                          value={acpFormArgs}
                          onChange={(e) => setAcpFormArgs(e.target.value)}
                          placeholder={t('agents.formArgsPlaceholder')}
                          className={`w-full px-3 py-1.5 rounded-xl text-xs font-mono border border-transparent ${subtleBg} focus:outline-none focus:border-[#6366F1]`}
                        />
                        <div className={`text-[10.5px] ${mutedText}`}>
                          {t('agents.formArgsHint')}
                        </div>
                      </div>

                      {/* 立即启用 */}
                      <div
                        className={`flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 ${subtleBg}`}
                      >
                        <span className="text-xs leading-relaxed">{t('agents.enableNow')}</span>
                        <MwhSwitch
                          checked={acpFormEnabled}
                          onChange={setAcpFormEnabled}
                          label={t('agents.enableNow')}
                          title={t('agents.enableNowTitle')}
                          disabled={acpSaving}
                          dark={chromeDark}
                        />
                      </div>

                      {/* 弹窗底部操作按钮 */}
                      <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/[0.05]">
                        <button
                          type="button"
                          disabled={acpSaving}
                          onClick={() => setAcpModalOpen(false)}
                          className="px-3.5 py-1.5 rounded-xl text-xs font-medium hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="submit"
                          disabled={acpSaving}
                          className="px-4 py-1.5 rounded-xl text-xs font-medium bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] hover:brightness-105 text-white transition-all cursor-pointer disabled:opacity-50"
                        >
                          {acpSaving ? t('agents.saving') : t('agents.saveAndApply')}
                        </button>
                      </div>
                    </form>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Spotlight Onboarding Tour Overlay (docs/DESIGN.md 4.9) */}
            {tourOpen && (() => {
              const activeTourStep = TOUR_STEPS[tourStepIndex] || TOUR_STEPS[0];
              const isFirstStep = tourStepIndex === 0;
              const isLastStep = tourStepIndex === TOUR_STEPS.length - 1;
              return (
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label={t('tour.ariaLabel')}
                  data-testid="mwh-tour-overlay"
                  data-tour-active-target={activeTourStep.target}
                  className="fixed inset-0 z-[950] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px]"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setTourOpen(false);
                  }}
                >
                  <div
                    className={`w-[380px] max-w-[92vw] rounded-[18px] p-5 shadow-2xl border space-y-3.5 ${modalBg}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#6366F1]/16 text-[#A5B4FC]">
                        {t('tour.stepCounter', { current: tourStepIndex + 1, total: TOUR_STEPS.length })}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {TOUR_STEPS.map((s, idx) => (
                          <span
                            key={s.id}
                            title={t(s.titleKey)}
                            className={`h-1.5 rounded-full transition-all duration-180 ${
                              idx === tourStepIndex
                                ? 'w-4 bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)]'
                                : 'w-1.5 bg-white/15'
                            }`}
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        data-action="tour-close"
                        onClick={() => setTourOpen(false)}
                        aria-label={t('tour.closeAriaLabel')}
                        className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-white/10 text-neutral-400 hover:text-white cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="text-[14.5px] font-semibold">{t(activeTourStep.titleKey)}</div>
                    <p className={`text-xs leading-relaxed ${mutedText}`}>{t(activeTourStep.bodyKey)}</p>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <button
                        type="button"
                        data-action="tour-close"
                        onClick={() => setTourOpen(false)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-medium ${subtleBg} hover:opacity-85 cursor-pointer`}
                      >
                        {t('tour.skip')}
                      </button>
                      <div className="flex items-center gap-2">
                        {!isFirstStep && (
                          <button
                            type="button"
                            data-action="tour-prev"
                            onClick={() => setTourStepIndex((prev) => Math.max(0, prev - 1))}
                            className="px-3 py-1.5 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 cursor-pointer"
                          >
                            {t('tour.prev')}
                          </button>
                        )}
                        <button
                          type="button"
                          data-action={isLastStep ? 'tour-close' : 'tour-next'}
                          onClick={() => {
                            if (isLastStep) {
                              setTourOpen(false);
                            } else {
                              const nextIdx = tourStepIndex + 1;
                              const nextStep = TOUR_STEPS[nextIdx];
                              if (nextStep?.id === 'advanced-center') {
                                mwhService.setActiveSettingsTab('connectors');
                              }
                              setTourStepIndex(nextIdx);
                            }
                          }}
                          className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] text-white hover:brightness-105 cursor-pointer"
                        >
                          {isLastStep ? t('tour.finish') : t('tour.next')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

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
                        confirmModal.danger ? 'bg-[#E06C60]/15 text-[#F28B82]' : 'bg-[#6366F1]/16 text-[#A5B4FC]'
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
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const cb = confirmModal.onConfirm;
                        setConfirmModal(null);
                        await cb();
                      }}
                      className={`px-4 py-1.5 rounded-xl text-xs font-medium text-white transition-colors cursor-pointer ${
                        confirmModal.danger
                          ? 'bg-[#E06C60] hover:bg-[#D05A4E]'
                          : 'bg-[#6366F1] bg-[linear-gradient(135deg,#8B5CF6_0%,#6366F1_50%,#3B82F6_100%)] hover:brightness-105'
                      }`}
                    >
                      {confirmModal.confirmText || t('common.confirm')}
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

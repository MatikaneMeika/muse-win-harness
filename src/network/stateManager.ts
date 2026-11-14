/**
 * Desktop control plane: sanitized MwhState, SSE fan-out, and the
 * /api/v1 action surface. All routes are invoked only after BearerAuthGuard.
 * Secrets never leave this module in the clear except the one-shot
 * rotate-token HTTP response.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sanitizeSensitiveCliFlags } from '../executors/cliAdapters.js';
import { JobManager, JOB_ID_REGEX } from '../executors/jobManager.js';
import { AclSandboxManager } from '../pipeline/aclSandbox.js';
import { hashClientParams } from '../pipeline/approvalEngine.js';
import { GitCheckpointManager } from '../pipeline/gitCheckpoint.js';
import { checkSensitiveBlacklist, resolveNativePath } from '../pipeline/pathGuard.js';
import { PipelineKernel } from '../pipeline/pipeline.js';
import { validateOutboundHostSync } from '../security/outboundGuard.js';
import { SubagentDispatcher } from '../subagents/dispatcher.js';
import { getExposedMuseTools, type ToolDefinition } from '../tools/definitions.js';
import { classifyDesktopCall, normalizeDesktopHandsParams } from '../tools/desktopDelivery.js';
import { getResourcesManager } from '../resources/manager.js';
import { UiaBridge } from '../desktop/uiaBridge.js';
import { WinGuard } from '../desktop/winGuard.js';
import type { PublicResourceEntry, ResourceStatusSummary } from '../resources/types.js';
import { AcpConfigManager } from '../config/acpConfig.js';
import {
  MODE_RANK,
  VALID_CONFINEMENT_MODES,
  VALID_PERMISSION_PROFILES,
  profileToConfinementAndPolicy,
  resolvePermissionProfile,
  type AcpConfig,
  type AcpProfile,
  type ApprovalPolicy,
  type ConfinementMode,
  type ExecutionContext,
  type PermissionProfileId,
  type PipelineRequest,
  type PipelineResponse,
  type RiskLevel,
  type SubagentType,
  type ToolMetaCategory
} from '../types.js';
import type { BearerAuthGuard } from './authGuard.js';
import { resolveConfiguredTokenTtlMs, savePersistedSecrets } from '../security/secretStore.js';
import { NamedTunnelDriver, QuickTunnelDriver, SkillTemplateGenerator, assertTokenEntropy } from './tunnels.js';
import { rotateUiSessionSecret } from './uiStatic.js';
import { saveUserSettings } from '../config/userSettings.js';

export const MAX_SSE_CLIENTS = 16;

export type TunnelDriverType =
  | 'cloudflare-named'
  | 'cloudflare-quick'
  | 'tailscale-funnel'
  | 'custom-tls';

export type TaskStatus = 'IDLE' | 'WAITING_APPROVAL' | 'RUNNING' | 'COMPLETED';

const VALID_POLICIES: readonly ApprovalPolicy[] = [
  'always-ask',
  'smart-risk',
  'auto-workspace',
  'unattended-yolo'
];

const VALID_DRIVERS: readonly TunnelDriverType[] = [
  'cloudflare-named',
  'cloudflare-quick',
  'tailscale-funnel',
  'custom-tls'
];

// 模式严格度等级表（数值越小越严格，用于降级定时器判定）。
// 同步义务：顺序必须与 src/types.ts 的 ConfinementMode / VALID_CONFINEMENT_MODES 一致，
// types.ts 顺序调整时必须同步更新本表。
const MODE_STRICTNESS_RANK: Record<ConfinementMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'workspace-acl-experimental': 2,
  'danger-full-access': 3
};

const TUNNEL_CONFIG_KEYS = [
  'cfNamedDomain',
  'cfNamedToken',
  'cfQuickUrl',
  'tailscaleIp',
  'tailscaleMagicDns',
  'tailscaleFunnelEnabled',
  'customPublicUrl',
  'customTlsVerify'
] as const;

export function maskSecretToken(token: string): string {
  if (!token || token.length <= 10) return '****';
  return `${token.slice(0, 6)}****${token.slice(-4)}`;
}

export interface LiveTaskState {
  id: string;
  status: TaskStatus;
  sourceAgent: 'Muse Cloud MCP' | string;
  toolName?: string;
  targetHwnd?: number;
  worktreeId?: string;
  command: string;
  targetPath: string;
  summary: string;
  riskScore: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  stepLabel: string;
  stepIndex: number;
  totalSteps: number;
  stdoutLines: string[];
  modifiedFilesCount: number;
  testResultSummary: string;
  /**
   * 改动统计的可信度来源：
   * - `git-delta`：基于 git 脏文件集合的前后差，数字可信；
   * - `unavailable`：工作区不是 git 仓库（或 git 不可用），此时 0 不代表「没改」。
   */
  changeTracking?: 'git-delta' | 'unavailable';
  snapshotId?: string;
  startedAt: string;
}

export interface WorktreeInstance {
  id: string;
  branchName: string;
  agentId: string;
  path: string;
  childMode: ConfinementMode;
  status: 'RUNNING' | 'READY_TO_MERGE' | 'MERGED' | 'UP_TO_DATE' | 'MISSING' | 'STOPPED';
  modifiedFiles: number;
  commitsAhead: number;
  stdoutPages: string[][];
  createdAt: string;
}

export interface PendingApprovalItem {
  id: string;
  toolName: string;
  targetHwnd?: number;
  riskLevel: RiskLevel;
  summary: string;
  command: string;
  targetPath: string;
  requiresMobileHmac: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface MwhState {
  isDesktopRuntime: boolean;
  settingsModalOpen: boolean;
  activeSettingsTab: string;
  confinementMode: ConfinementMode;
  approvalPolicy: ApprovalPolicy;
  autoDowngradeTwoHours: boolean;
  autoDowngradeRemainingSec: number;
  multiDeviceApproval: boolean;
  desktopHandsEnabled: boolean;
  desktopHandsForegroundFallback: boolean;
  pendingApprovals?: PendingApprovalItem[];
  workspaceRoots: string[];
  alwaysAllowedWorkspaces: string[];
  tunnel: {
    activeDriver: TunnelDriverType;
    bearerToken: string;
    cfNamedDomain: string;
    cfNamedToken: string;
    cfQuickUrl: string;
    cfQuickRunning: boolean;
    tailscaleIp: string;
    tailscaleMagicDns: string;
    tailscaleFunnelEnabled: boolean;
    customPublicUrl: string;
    customTlsVerify: boolean;
  };
  museConnection: {
    connected: boolean;
    mode: 'disconnected' | 'tunnel' | 'local_mcp';
    summary: string;
    lastActiveAt: string | null;
  };
  daemon: {
    connected: boolean;
    pid: number;
    memoryMb: number;
    createNoWindowActive: boolean;
    activeJobObjects: number;
    uptimeSeconds: number;
    lastWindowAction: string | null;
  };
  /**
   * @deprecated 仅保留对外 REST/SSE 状态契约兼容（完全由 acpProfiles 派生）；
   * 双端设置 UI 已移除「本机 CLI 子代理桥接器」只读卡片，严禁在 UI 中重复渲染。
   */
  cliSubagents: Array<{
    id: string;
    name: string;
    binaryPath: string;
    version: string;
    detected: boolean;
    enabled: boolean;
    description: string;
  }>;
  acpConfig: AcpConfig;
  acpProfiles: AcpProfile[];
  builtinLoop: {
    enabled: boolean;
    maxIterations: number;
    thinkingLevel: 'HIGH';
    lastThinkingReport: string;
  };
  worktrees: WorktreeInstance[];
  snapshots: Array<{
    id: string;
    treeHash: string;
    timestamp: string;
    triggerReason: string;
    workspacePath: string;
    filesTouched: number;
    diffStat: string;
    rolledBack: boolean;
  }>;
  auditLogs: Array<{
    id: string;
    timestamp: string;
    decision: 'ALLOW' | 'ASK' | 'BLOCK';
    actor: string;
    toolName: string;
    commandOrPath: string;
    mode: ConfinementMode;
    reason: string;
    jobId?: string;
    terminalStatus?: string;
    diagnostic?: string;
  }>;
  liveTask: LiveTaskState;
  lastCopiedToast: string | null;
  lastInjectedChatText: string | null;
  /** Local MCP / Skill resource library summary (enabled count + public list). */
  resources: {
    enabledCount: number;
    entries: PublicResourceEntry[];
    summary: ResourceStatusSummary;
  };
}

interface PendingUiTask {
  approvalId: string;
  request: PipelineRequest;
}

function idleTask(): LiveTaskState {
  return {
    id: '',
    status: 'IDLE',
    sourceAgent: 'Muse Cloud MCP',
    command: '',
    targetPath: '',
    summary: '',
    riskScore: 'LOW',
    stepLabel: '',
    stepIndex: 0,
    totalSteps: 3,
    stdoutLines: [],
    modifiedFilesCount: 0,
    testResultSummary: '',
    changeTracking: 'git-delta',
    startedAt: ''
  };
}

function nowClock(): string {
  return new Date().toTimeString().split(' ')[0] || '';
}

function riskScoreOf(level: RiskLevel | undefined): LiveTaskState['riskScore'] {
  const raw = (level || 'medium').toUpperCase();
  if (raw === 'LOW' || raw === 'MEDIUM' || raw === 'HIGH' || raw === 'CRITICAL') {
    return raw;
  }
  return 'MEDIUM';
}

function subagentDisplayLabel(params: Record<string, any>): string {
  const raw = String(params.profile || params.agent || 'builtin').trim() || 'builtin';
  const wt = params.isolateWorktree ? ' (Worktree)' : '';
  return `${raw}${wt}`;
}

function commandPreview(toolName: string, params: Record<string, any>): string {
  if (typeof params.command === 'string' && params.command) {
    return sanitizeSensitiveCliFlags(params.command);
  }
  if (toolName === 'subagent_dispatch') {
    const agentTag = String(params.profile || params.agent || 'builtin').trim() || 'builtin';
    const promptOneLine = String(params.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return sanitizeSensitiveCliFlags(`[${agentTag}] ${promptOneLine}`);
  }
  try {
    return sanitizeSensitiveCliFlags(`${toolName}(${JSON.stringify(params)})`.slice(0, 2000));
  } catch {
    return toolName;
  }
}

export interface ControlPlaneOptions {
  kernel: PipelineKernel;
  authGuard: BearerAuthGuard;
  getRuntimeToken: () => string;
  setRuntimeToken: (token: string) => void;
  port: number;
  host: string;
  /** config.yaml `tunnel.cloudflaredPath`, reused when the UI starts a tunnel. */
  cloudflaredPath?: string;
}

export class MwhControlPlane {
  private kernel: PipelineKernel;
  private authGuard: BearerAuthGuard;
  private getRuntimeToken: () => string;
  private setRuntimeToken: (token: string) => void;
  private port: number;
  private host: string;
  private sseClients: Set<http.ServerResponse> = new Set();
  private sseHeartbeats: Map<http.ServerResponse, NodeJS.Timeout> = new Map();
  private workspaceRoots: string[];
  private alwaysAllowedWorkspaces: string[] = [];
  private worktrees: WorktreeInstance[] = [];
  private liveTask: LiveTaskState = idleTask();
  private pendingTask: PendingUiTask | null = null;
  private pendingTasks: Map<string, PipelineRequest> = new Map();
  private boundJobId: string | null = null;
  private activeDesktopTaskId: string | null = null;
  private armJobCapture = false;
  private autoDowngradeTwoHours = true;
  private autoDowngradeDeadlineMs: number | null = null;
  private downgradeTimer: NodeJS.Timeout | null = null;
  private quickDriver: QuickTunnelDriver | null = null;
  private namedDriver: NamedTunnelDriver | null = null;
  private cloudflaredPath?: string;
  private tunnel = {
    activeDriver: 'cloudflare-quick' as TunnelDriverType,
    cfNamedDomain: '',
    cfNamedToken: '',
    cfQuickUrl: '',
    cfQuickRunning: false,
    tailscaleIp: '',
    tailscaleMagicDns: '',
    tailscaleFunnelEnabled: false,
    customPublicUrl: '',
    customTlsVerify: true
  };
  private builtinReport = '';
  private unsubJob: (() => void) | null = null;
  private unsubResources: (() => void) | null = null;
  private unsubQuickExit: (() => void) | null = null;
  private preTaskDirtyFiles: Set<string> = new Set();
  private readonly bootedAt = Date.now();
  private lastMcpActiveAt: number | null = null;

  public recordMcpActivity(): void {
    this.lastMcpActiveAt = Date.now();
  }

  public isCloudflareTunnelActive(): boolean {
    if (this.tunnel.cfQuickRunning || this.quickDriver?.isRunning() === true) {
      return true;
    }
    if (this.namedDriver && (this.namedDriver as any).isRunning?.() === true) {
      return true;
    }
    return false;
  }

  private isLoopbackAddress(addr: string | undefined): boolean {
    if (!addr) return false;
    const normalized = addr.trim().toLowerCase();
    return (
      normalized === '127.0.0.1' ||
      normalized === '::1' ||
      normalized === '::ffff:127.0.0.1' ||
      normalized === 'localhost'
    );
  }

  private hasTunnelForwardingHeaders(req: http.IncomingMessage): boolean {
    return Boolean(
      req.headers['cf-connecting-ip'] ||
        req.headers['cf-ray'] ||
        req.headers['x-forwarded-for'] ||
        req.headers['x-real-ip']
    );
  }

  private isTrustedLocalUiOrigin(originHeader: string | undefined, allowMuseOrigin = false): boolean {
    if (!originHeader) return true;
    const raw = originHeader.trim().toLowerCase();
    if (!raw || raw === 'null') return false;
    if (allowMuseOrigin && (raw === 'https://muse.ai' || raw.endsWith('.muse.ai'))) {
      return true;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      const host = parsed.hostname.toLowerCase();
      const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
      if (!isLoopbackHost) return false;
      if (parsed.port && Number(parsed.port) !== this.port) return false;
      return true;
    } catch {
      return false;
    }
  }

  constructor(options: ControlPlaneOptions) {
    this.kernel = options.kernel;
    this.authGuard = options.authGuard;
    this.getRuntimeToken = options.getRuntimeToken;
    this.setRuntimeToken = options.setRuntimeToken;
    this.port = options.port;
    this.host = options.host;
    // config.yaml `tunnel.cloudflaredPath`: when the UI starts a tunnel this
    // process must honour the same explicit path the boot probe used, otherwise
    // a working boot configuration silently degrades to "cloudflared missing".
    this.cloudflaredPath = options.cloudflaredPath;
    const root = this.kernel.getContext().workspaceRoot;
    this.workspaceRoots = [root];
    this.kernel.updateContext({ workspaceRoots: [...this.workspaceRoots] });
    this.unsubJob = JobManager.getInstance().onJobEvent((event) => this.onJobLifecycle(event));
    // Resource-library lifecycle changes (scan / toggle / fault / recovery) are
    // audited and pushed to open UI streams.
    try {
      const manager = getResourcesManager(root);
      manager.setAuditSink((event) => this.appendAudit(event));
      this.unsubResources = manager.onChange(() => this.broadcastResourceState());
    } catch {
      this.unsubResources = null;
    }
  }

  private bindQuickDriverExit(driver: QuickTunnelDriver): void {
    this.unsubQuickExit?.();
    this.unsubQuickExit = driver.onExit((ev) => {
      this.tunnel.cfQuickRunning = false;
      this.tunnel.cfQuickUrl = '';
      const fallbackUrl = `http://${this.host}:${this.port}`;
      this.kernel.updateContext({ tunnelUrl: fallbackUrl });
      const tailSnippet = (ev.stderrTail || '').replace(/\s+/g, ' ').trim().slice(-240);
      this.appendAudit({
        decision: ev.expected ? 'ALLOW' : 'BLOCK',
        actor: 'system_tunnel',
        toolName: 'tunnel_driver',
        commandOrPath: ev.tunnelUrl || 'cloudflare-quick',
        reason: `QUICK_TUNNEL_EXITED: code=${ev.code} signal=${ev.signal} expected=${ev.expected}${tailSnippet ? ` tail=${tailSnippet}` : ''}`,
        status: ev.expected ? 'STOPPED' : 'ERROR'
      });
      const ctx = this.kernel.getContext();
      this.broadcastSse({
        tunnel: this.getSanitizedState().tunnel,
        auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
      });
    });
  }

  public attachOwnedTunnels(drivers: { quick?: QuickTunnelDriver | null; named?: NamedTunnelDriver | null }): void {
    if (drivers.quick) {
      this.quickDriver = drivers.quick;
      this.bindQuickDriverExit(drivers.quick);
    }
    if (drivers.named) this.namedDriver = drivers.named;
    const quickUrl = drivers.quick?.getTunnelUrl?.() || '';
    if (quickUrl) {
      this.tunnel.cfQuickUrl = quickUrl;
      this.tunnel.cfQuickRunning = true;
      this.kernel.updateContext({ tunnelUrl: quickUrl });
    } else {
      this.tunnel.cfQuickUrl = '';
      this.tunnel.cfQuickRunning = false;
    }
  }

  public dispose(): void {
    this.unsubJob?.();
    this.unsubJob = null;
    this.unsubResources?.();
    this.unsubResources = null;
    // End every MCP child spawned by the resource library (Job Object kill).
    try {
      getResourcesManager().disposeAll();
    } catch {
      // Shutdown must continue even if a child refuses to die; the Job handle's
      // KILL_ON_JOB_CLOSE backstop still fires when the daemon exits.
    }
    this.unsubQuickExit?.();
    this.unsubQuickExit = null;
    this.clearDowngradeTimer();
    try {
      this.quickDriver?.stop();
    } catch {
      // Only this instance's child is stopped.
    }
    try {
      this.namedDriver?.stop();
    } catch {
      // Only this instance's child is stopped.
    }
    for (const res of this.sseClients) {
      const timer = this.sseHeartbeats.get(res);
      if (timer) clearInterval(timer);
      try {
        res.end();
      } catch {
        // Already closed.
      }
    }
    this.sseHeartbeats.clear();
    this.sseClients.clear();
  }

  public getSanitizedState(): MwhState {
    const ctx = this.kernel.getContext();
    const acpProfiles = AcpConfigManager.getInstance().getProbedProfiles();
    const rootsToScan = Array.from(
      new Set([ctx.workspaceRoot, ...this.workspaceRoots].filter(Boolean))
    );
    const seenSnapIds = new Set<string>();
    const snapshots: MwhState['snapshots'] = [];
    for (const scanRoot of rootsToScan) {
      for (const meta of GitCheckpointManager.listCheckpoints(scanRoot)) {
        if (seenSnapIds.has(meta.id)) continue;
        seenSnapIds.add(meta.id);
        const filesTouched =
          (meta.modifiedFiles?.length || 0) +
          (meta.untrackedFiles?.length || 0) +
          (meta.protectedFiles?.length || 0);
        snapshots.push({
          id: meta.id,
          treeHash: meta.headRev || '',
          timestamp: new Date(meta.timestamp).toISOString(),
          triggerReason: meta.label || 'pre-mutation',
          workspacePath: meta.workspacePath || scanRoot,
          filesTouched,
          diffStat: filesTouched > 0 ? `${filesTouched} 个文件` : '工作区快照',
          rolledBack: meta.rolledBack === true
        });
      }
    }
    snapshots.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

    const state: MwhState = {
      isDesktopRuntime: false,
      settingsModalOpen: false,
      activeSettingsTab: 'permissions',
      confinementMode: ctx.confinementMode,
      approvalPolicy: ctx.approvalPolicy,
      autoDowngradeTwoHours: this.autoDowngradeTwoHours,
      autoDowngradeRemainingSec: this.remainingSec(),
      multiDeviceApproval: ctx.multiDeviceApproval === true,
      desktopHandsEnabled: ctx.desktopHandsEnabled === true,
      desktopHandsForegroundFallback: ctx.desktopHandsForegroundFallback === true,
      pendingApprovals: this.getSanitizedPendingApprovals(),
      workspaceRoots: [...this.workspaceRoots],
      alwaysAllowedWorkspaces: [...this.alwaysAllowedWorkspaces],
      tunnel: {
        activeDriver: this.tunnel.activeDriver,
        bearerToken: maskSecretToken(this.getRuntimeToken()),
        cfNamedDomain: this.tunnel.cfNamedDomain,
        cfNamedToken: this.tunnel.cfNamedToken ? maskSecretToken(this.tunnel.cfNamedToken) : '',
        cfQuickUrl: this.tunnel.cfQuickUrl || '',
        cfQuickRunning: this.tunnel.cfQuickRunning,
        tailscaleIp: this.tunnel.tailscaleIp,
        tailscaleMagicDns: this.tunnel.tailscaleMagicDns,
        tailscaleFunnelEnabled: this.tunnel.tailscaleFunnelEnabled,
        customPublicUrl: this.tunnel.customPublicUrl,
        customTlsVerify: this.tunnel.customTlsVerify
      },
      museConnection: (() => {
        const tunnelActive =
          (this.tunnel.activeDriver === 'cloudflare-quick' && this.tunnel.cfQuickRunning && Boolean(this.tunnel.cfQuickUrl)) ||
          (this.tunnel.activeDriver === 'cloudflare-named' && Boolean(this.tunnel.cfNamedDomain)) ||
          (this.tunnel.activeDriver === 'tailscale-funnel' && this.tunnel.tailscaleFunnelEnabled);
        const mcpRecent = this.lastMcpActiveAt !== null && Date.now() - this.lastMcpActiveAt < 300_000;
        const isMuseConnected = mcpRecent;
        return {
          connected: isMuseConnected,
          mode: isMuseConnected ? (tunnelActive ? ('tunnel' as const) : ('local_mcp' as const)) : ('disconnected' as const),
          summary: isMuseConnected
            ? (tunnelActive ? '已连通 Muse 连接器 (公网隧道)' : '已连通 Muse 连接器 (本地 MCP)')
            : tunnelActive
            ? '公网隧道就绪 · 等待 Muse 接入'
            : '未开启隧道且无活跃连接器',
          lastActiveAt: this.lastMcpActiveAt ? new Date(this.lastMcpActiveAt).toISOString() : null
        };
      })(),
      daemon: {
        connected: true,
        pid: process.pid,
        memoryMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
        createNoWindowActive: true,
        activeJobObjects: JobManager.getInstance().getActiveJobs().length,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.bootedAt) / 1000)),
        lastWindowAction: null
      },
      cliSubagents: acpProfiles.map((p) => ({
        id: p.id,
        name: p.display_name || p.id,
        binaryPath: p.binaryPath || p.command || '',
        version: p.version || '',
        detected: Boolean(p.detected),
        enabled: p.enabled !== false,
        description: p.kind ? `ACP Profile (${p.kind})` : 'ACP Subagent Profile'
      })),
      acpConfig: AcpConfigManager.getInstance().loadConfig(),
      acpProfiles,
      builtinLoop: {
        enabled: true,
        maxIterations: 15,
        thinkingLevel: 'HIGH',
        lastThinkingReport: this.builtinReport
      },
      worktrees: this.worktrees.map((wt) => {
        const dirMissing = Boolean(wt.path) && !fs.existsSync(wt.path);
        const effectiveStatus =
          dirMissing && wt.status !== 'MERGED' ? 'MISSING' : wt.status;
        return {
          ...wt,
          status: effectiveStatus,
          stdoutPages: wt.stdoutPages.map((page) => page.map((line) => this.sanitizeLogLine(line)))
        };
      }),
      snapshots,
      auditLogs: this.readAuditTail(ctx.workspaceRoot, 50),
      liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
      lastCopiedToast: null,
      lastInjectedChatText: null,
      resources: this.resourceState()
    };
    return state;
  }

  private getSanitizedPendingApprovals(): PendingApprovalItem[] {
    const ctx = this.kernel.getContext();
    return this.kernel
      .getApprovalEngine()
      .listPendingApprovals()
      .filter((r) => Date.now() <= r.expiresAt)
      .map((r) => {
        const targetHwnd =
          r.toolName === 'desktop_hands' && typeof r.params?.hwnd === 'number' && r.params.hwnd > 0
            ? Math.trunc(r.params.hwnd)
            : undefined;
        return {
          id: r.id,
          toolName: r.toolName,
          ...(targetHwnd ? { targetHwnd } : {}),
          riskLevel: r.riskLevel,
          summary: this.scrubSecretText(r.summary || ''),
          command: this.scrubSecretText(commandPreview(r.toolName, r.params || {})),
          targetPath: String(
            r.params?.path ||
              r.params?.cwd ||
              (targetHwnd ? `hwnd:${targetHwnd}` : ctx.workspaceRoot)
          ),
          requiresMobileHmac: Boolean(r.requiresMobileHmac),
          createdAt: r.createdAt,
          expiresAt: r.expiresAt
        };
      });
  }

  private promoteNextPendingTask(): boolean {
    const ctx = this.kernel.getContext();
    const remaining = this.kernel
      .getApprovalEngine()
      .listPendingApprovals()
      .filter((r) => Date.now() <= r.expiresAt);
    if (remaining.length === 0) return false;
    const next = remaining[0];
    const req = this.pendingTasks.get(next.id) || {
      id: `reexec_${next.id}`,
      toolName: next.toolName,
      category: next.category,
      params: structuredClone(next.params || {})
    };
    this.pendingTask = { approvalId: next.id, request: req };
    const targetHwnd =
      next.toolName === 'desktop_hands' && typeof next.params?.hwnd === 'number' && next.params.hwnd > 0
        ? Math.trunc(next.params.hwnd)
        : undefined;
    this.liveTask = this.sanitizeLiveTaskFrame({
      id: next.id,
      status: 'WAITING_APPROVAL',
      toolName: next.toolName,
      ...(targetHwnd ? { targetHwnd } : {}),
      sourceAgent:
        next.toolName === 'subagent_dispatch'
          ? subagentDisplayLabel(next.params || {})
          : 'Muse Cloud MCP',
      command: commandPreview(next.toolName, next.params || {}),
      targetPath:
        next.params?.path ||
        next.params?.cwd ||
        (targetHwnd ? `hwnd:${targetHwnd}` : ctx.workspaceRoot),
      summary: next.summary || '',
      riskScore: riskScoreOf(next.riskLevel),
      stepLabel: '等待本地执行确认...',
      stepIndex: 1,
      totalSteps: 3,
      stdoutLines: [],
      modifiedFilesCount: 0,
      testResultSummary: '',
      changeTracking: 'git-delta',
      startedAt: nowClock()
    });
    return true;
  }

  private formatExecutionReceiptSummary(
    toolName: string,
    params: Record<string, any> | undefined,
    execRes: PipelineResponse,
    jobId?: string
  ): string {
    const p = params || {};
    const targetBaseName =
      typeof p.path === 'string' && p.path ? path.basename(p.path) : '';
    const head =
      toolName === 'fs_mutate'
        ? `fs_mutate(${p.action || 'write'})${targetBaseName ? ` on '${targetBaseName}'` : ''} -> ${execRes.status}`
        : `${toolName} -> ${execRes.status}${jobId ? ` (jobId=${jobId})` : ''}`;
    if (execRes.status === 'ERROR' || execRes.status === 'DENIED') {
      const detail = execRes.error || execRes.reason || (typeof execRes.data?.error === 'string' ? execRes.data.error : '');
      return detail ? `${head}: ${detail}` : head;
    }
    if (toolName === 'desktop_hands' && execRes.data && typeof execRes.data === 'object') {
      try {
        const clone = { ...execRes.data };
        delete (clone as any).__mcpImage;
        return `${head} ${JSON.stringify(clone)}`;
      } catch {
        return head;
      }
    }
    return head;
  }

  private startDesktopRunningLiveTask(
    request: PipelineRequest,
    riskLevel: RiskLevel | undefined,
    summary?: string
  ): string {
    const ctx = this.kernel.getContext();
    const norm = normalizeDesktopHandsParams(request.params);
    const dhTaskId = `dh_${Date.now()}_${crypto.randomUUID().slice(0, 8).replace(/-/g, '')}`;
    const targetHwnd =
      typeof norm.hwnd === 'number' && norm.hwnd > 0 ? Math.trunc(norm.hwnd) : undefined;
    const totalSteps =
      norm.action === 'batch' && Array.isArray(norm.steps) && norm.steps.length > 0
        ? norm.steps.length
        : 1;
    this.activeDesktopTaskId = dhTaskId;
    this.liveTask = this.sanitizeLiveTaskFrame({
      ...this.liveTask,
      id: dhTaskId,
      status: 'RUNNING',
      toolName: 'desktop_hands',
      ...(targetHwnd ? { targetHwnd } : {}),
      sourceAgent: 'Muse Cloud MCP',
      command: commandPreview('desktop_hands', norm),
      targetPath: targetHwnd ? `hwnd:${targetHwnd}` : ctx.workspaceRoot,
      summary: summary || `Desktop ${norm.action || 'act'}${norm.op ? `:${norm.op}` : ''}`,
      riskScore: riskScoreOf(riskLevel || 'medium'),
      stepLabel:
        norm.action === 'batch'
          ? `桌面批处理执行中 (${totalSteps} 步)...`
          : `桌面操控执行中 (${norm.op || norm.action || 'act'})...`,
      stepIndex: 1,
      totalSteps,
      stdoutLines: [],
      startedAt: nowClock()
    });
    this.broadcastSse({ liveTask: this.sanitizeLiveTaskFrame(this.liveTask) });
    return dhTaskId;
  }

  private finishDesktopRunningLiveTask(
    dhTaskId: string,
    execRes: PipelineResponse
  ): void {
    if (this.activeDesktopTaskId === dhTaskId) {
      this.activeDesktopTaskId = null;
    }
    if (this.liveTask.id !== dhTaskId) {
      return;
    }
    const aborted =
      execRes.data?.status === 'ABORTED' ||
      String(execRes.error || '').includes('EMERGENCY_STOP_ABORTED');
    if (aborted) {
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        status: 'IDLE',
        stepLabel: '已强杀'
      });
    } else if (execRes.status === 'SUCCESS' && execRes.data?.status !== 'PARTIAL_FAILURE') {
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        status: 'COMPLETED',
        stepLabel: '桌面操作执行完成',
        stepIndex: this.liveTask.totalSteps || 1,
        modifiedFilesCount: 0,
        testResultSummary: '未检测到文件改动'
      });
    } else {
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        status: 'IDLE',
        stepLabel: '执行失败'
      });
    }
    this.broadcastSse({ liveTask: this.sanitizeLiveTaskFrame(this.liveTask) });
  }

  public async resolveFromMobileLink(
    id: string,
    action: 'approve' | 'reject',
    sig: string
  ): Promise<{
    action: 'approve' | 'reject';
    status: string;
    executed: boolean;
    executionStatus?: string;
    checkpointId?: string;
    jobId?: string;
    resultSummary?: string;
  }> {
    const engine = this.kernel.getApprovalEngine();
    const ctx = this.kernel.getContext();
    const record = engine.getApproval(id);
    if (!record) {
      throw new Error(`APPROVAL_NOT_FOUND: No pending approval for ${id}`);
    }

    const rawPending: PipelineRequest = this.pendingTasks.get(id) ||
      (this.pendingTask?.approvalId === id
        ? this.pendingTask.request
        : {
            id: `reexec_${id}`,
            toolName: record.toolName,
            category: record.category,
            params: structuredClone(record.params || {})
          });
    const pendingReq: PipelineRequest = {
      ...rawPending,
      params:
        rawPending.toolName === 'desktop_hands'
          ? normalizeDesktopHandsParams(rawPending.params || record.params)
          : structuredClone(rawPending.params || record.params || {})
    };

    const resolved = engine.resolveApproval(id, action, sig, 'once', ctx, 'mobile_link');
    this.pendingTasks.delete(id);
    if (this.pendingTask?.approvalId === id) {
      this.pendingTask = null;
    }

    if (action === 'reject') {
      engine.recordExecutionReceipt(id, {
        executionStatus: 'DENIED',
        resultSummary: 'Rejected by user via mobile HMAC link'
      });
      this.appendAudit({
        decision: 'BLOCK',
        actor: 'connector',
        toolName: record.toolName,
        commandOrPath: commandPreview(record.toolName, record.params),
        reason: 'USER_REJECTED_VIA_MOBILE',
        status: 'DENIED'
      });
      this.armJobCapture = false;
      if (!this.promoteNextPendingTask()) {
        this.liveTask = this.sanitizeLiveTaskFrame({
          ...this.liveTask,
          status: 'IDLE',
          stepLabel: '手机端已拒绝'
        });
      }
      this.broadcastSse({
        liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
        pendingApprovals: this.getSanitizedPendingApprovals(),
        auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
      });
      return {
        action,
        status: resolved.record.status,
        executed: false,
        executionStatus: 'DENIED',
        resultSummary: 'Rejected by user via mobile HMAC link'
      };
    }

    const isReadOnlyShortCircuit =
      pendingReq.category === 'read' || record.riskLevel === 'low';
    this.preTaskDirtyFiles = this.getWorkspaceDirtySet(ctx.workspaceRoot);
    let snapId = '';
    if (!isReadOnlyShortCircuit && ctx.confinementMode !== 'read-only') {
      try {
        snapId = GitCheckpointManager.create('pre-approved-task', ctx.workspaceRoot);
      } catch {
        snapId = '';
      }
    }
    if (pendingReq.toolName === 'exec_command' || pendingReq.toolName === 'subagent_dispatch') {
      this.armJobCapture = true;
      this.boundJobId = null;
    }
    let dhTaskId = '';
    if (pendingReq.toolName === 'desktop_hands' && !classifyDesktopCall(pendingReq.params).isPerception) {
      dhTaskId = this.startDesktopRunningLiveTask(pendingReq, record.riskLevel, record.summary);
    }
    const execRes = await this.kernel.handleRequest({ ...pendingReq, approvalId: id });
    if (dhTaskId) {
      this.finishDesktopRunningLiveTask(dhTaskId, execRes);
    }
    if (execRes.data && typeof execRes.data.jobId === 'string') {
      record.jobId = execRes.data.jobId;
    }
    const receiptSummary = this.formatExecutionReceiptSummary(
      record.toolName,
      pendingReq.params,
      execRes,
      record.jobId
    );
    const executionStatus =
      execRes.status === 'SUCCESS'
        ? 'SUCCESS'
        : execRes.status === 'DENIED'
          ? 'DENIED'
          : 'ERROR';
    engine.recordExecutionReceipt(id, {
      executionStatus,
      jobId: record.jobId,
      checkpointId: snapId || execRes.data?.checkpointId,
      resultSummary: this.scrubSecretText(receiptSummary)
    });
    this.absorbPipelineResult({ ...pendingReq, approvalId: id }, execRes);
    const changeReport =
      execRes.status === 'SUCCESS'
        ? this.detectExecutionChanges(ctx.workspaceRoot, pendingReq.toolName, execRes.status)
        : {
            count: this.liveTask.modifiedFilesCount,
            tracking: this.liveTask.changeTracking || ('git-delta' as const)
          };
    const modifiedFilesCount = changeReport.count;
    const isCleanAfterExec = modifiedFilesCount === 0;
    if (this.liveTask.status === 'WAITING_APPROVAL') {
      this.liveTask = {
        ...this.liveTask,
        status: execRes.status === 'SUCCESS' ? 'COMPLETED' : 'IDLE',
        modifiedFilesCount,
        changeTracking: changeReport.tracking,
        testResultSummary: this.completionSummary(
          changeReport.tracking,
          modifiedFilesCount,
          execRes.data?.exitCode
        ),
        snapshotId: isCleanAfterExec ? undefined : snapId || this.liveTask.snapshotId,
        worktreeId: isCleanAfterExec ? undefined : this.liveTask.worktreeId
      };
    } else if (snapId && !isCleanAfterExec) {
      this.liveTask = { ...this.liveTask, snapshotId: snapId };
    }
    if (this.liveTask.status === 'IDLE') {
      this.promoteNextPendingTask();
    }
    this.appendAudit({
      decision: 'ALLOW',
      actor: 'connector',
      toolName: record.toolName,
      commandOrPath: commandPreview(record.toolName, record.params),
      reason: 'USER_APPROVED_VIA_MOBILE (once)',
      status: execRes.status
    });
    this.broadcastSse({
      liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
      pendingApprovals: this.getSanitizedPendingApprovals(),
      snapshots: this.getSanitizedState().snapshots,
      auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
    });
    return {
      action,
      status: record.status,
      executed: true,
      executionStatus,
      checkpointId: snapId || execRes.data?.checkpointId,
      jobId: record.jobId,
      resultSummary: this.scrubSecretText(receiptSummary)
    };
  }

  /** Public (sanitized) resource-library snapshot used by state + SSE patches. */
  private resourceState(): MwhState['resources'] {
    try {
      const manager = getResourcesManager();
      const summary = manager.getStatusSummary();
      return {
        enabledCount: summary.enabledCount,
        entries: manager.getPublicEntries(),
        summary
      };
    } catch {
      return {
        enabledCount: 0,
        entries: [],
        summary: { enabledCount: 0, mcp: [], skills: [] }
      };
    }
  }

  private broadcastResourceState(): void {
    this.broadcastSse({ resources: this.resourceState() });
  }

  /** Built-in tools plus enabled resource-library tools (used by REST tool routes). */
  private exposedTools(): ToolDefinition[] {
    let extras: ToolDefinition[] = [];
    try {
      extras = getResourcesManager().getExposedToolDefinitions();
    } catch {
      extras = [];
    }
    return getExposedMuseTools(!!this.kernel.getContext().desktopHandsEnabled, extras);
  }

  public broadcastSse(patch: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify(patch)}\n\n`;
    for (const res of [...this.sseClients]) {
      try {
        res.write(frame);
      } catch {
        this.dropSse(res);
      }
    }
  }

  private resolveRequestActor(
    req: http.IncomingMessage,
    body?: any,
    fallback: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): 'ui_island' | 'mcp' | 'connector' {
    if (req.headers['mcp-session-id']) {
      return 'mcp';
    }
    const remoteAddr = req.socket?.remoteAddress || '127.0.0.1';
    if (!this.isLoopbackAddress(remoteAddr) || this.hasTunnelForwardingHeaders(req)) {
      return 'connector';
    }
    const secFetchSite =
      typeof req.headers['sec-fetch-site'] === 'string'
        ? req.headers['sec-fetch-site'].trim().toLowerCase()
        : '';
    if (secFetchSite === 'cross-site' || secFetchSite === 'same-site') {
      return 'connector';
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (origin !== undefined && !this.isTrustedLocalUiOrigin(origin, true)) {
      return 'connector';
    }
    const declared = body?.source;
    if (declared === 'mcp' || declared === 'connector') {
      return declared;
    }
    if (declared === 'ui_island') {
      return 'ui_island';
    }
    return fallback;
  }

  private getWorkspaceDirtySet(workspaceRoot: string): Set<string> {
    try {
      const out = execFileSync('git', ['-c', 'core.quotepath=off', 'status', '--porcelain', '-uall', '--', '.'], {
        cwd: workspaceRoot,
        windowsHide: true,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return new Set(
        out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.includes('.mwh/'))
      );
    } catch {
      return new Set();
    }
  }

  private computeModifiedFilesDelta(workspaceRoot: string): number {
    const after = this.getWorkspaceDirtySet(workspaceRoot);
    let delta = 0;
    for (const entry of after) {
      if (!this.preTaskDirtyFiles.has(entry)) {
        delta += 1;
      }
    }
    for (const entry of this.preTaskDirtyFiles) {
      if (!after.has(entry)) {
        delta += 1;
      }
    }
    return delta;
  }

  /** 工作区是否为 git 仓库；非 git 时改动数不可统计，必须显式标注而不是伪报 0。 */
  private isGitWorktree(workspaceRoot: string): boolean {
    try {
      const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: workspaceRoot,
        windowsHide: true,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return String(out).trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * 执行结束后的统一改动统计。
   *
   * 早先只在 `fs_mutate` 成功时重算，`exec_command` / `subagent_dispatch`
   * 实际写了大量文件却沿用旧的 0，导致浮岛误报「完成 · 无文件修改」。
   * 这里对所有可能写文件的工具一律重算。
   */
  private detectExecutionChanges(
    workspaceRoot: string,
    toolName: string,
    status: string
  ): { count: number; tracking: 'git-delta' | 'unavailable' } {
    if (!this.isGitWorktree(workspaceRoot)) {
      return { count: 0, tracking: 'unavailable' };
    }
    let count = this.computeModifiedFilesDelta(workspaceRoot);
    // fs_mutate 成功即视为至少改了一个文件（写入内容可能与原内容相同，git 脏集合看不出来）。
    if (toolName === 'fs_mutate' && status === 'SUCCESS' && count === 0) {
      count = 1;
    }
    return { count, tracking: 'git-delta' };
  }

  /**
   * 完成态结果摘要。无改动时不再输出「无文件修改」这类会被误读成「什么都没做」的措辞，
   * 非 git 工作区则明确说明统计不可用。
   */
  private completionSummary(
    tracking: 'git-delta' | 'unavailable',
    count: number,
    exitCode: number | null | undefined
  ): string {
    if (tracking === 'unavailable') {
      return '非 git 工作区 · 改动数未统计';
    }
    return count > 0 ? `Exit Code: ${exitCode ?? 0}` : '未检测到文件改动';
  }

  public async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string
  ): Promise<boolean> {
    try {
      if (pathname === '/api/v1/state' && method === 'GET') {
        this.send(res, 200, this.getSanitizedState());
        return true;
      }
      if (pathname === '/api/v1/events' && method === 'GET') {
        this.openSse(req, res);
        return true;
      }
      if (pathname === '/api/v1/security/mode' && method === 'POST') {
        const body = await this.readJson(req);
        await this.postMode(res, body, this.resolveRequestActor(req, body));
        return true;
      }
      if (pathname === '/api/v1/security/policy' && method === 'POST') {
        const body = await this.readJson(req);
        await this.postPolicy(res, body, this.resolveRequestActor(req, body));
        return true;
      }
      if (pathname === '/api/v1/security/auto-downgrade' && method === 'POST') {
        const body = await this.readJson(req);
        await this.postAutoDowngrade(res, body, this.resolveRequestActor(req, body));
        return true;
      }
      if (pathname === '/api/v1/security/multi-device-approval' && method === 'POST') {
        const body = await this.readJson(req);
        await this.postMultiDeviceApproval(res, body, this.resolveRequestActor(req, body));
        return true;
      }
      if (pathname === '/api/v1/security/desktop-hands' && method === 'POST') {
        const body = await this.readJson(req);
        await this.postDesktopHands(res, body, this.resolveRequestActor(req, body));
        return true;
      }
      if (pathname === '/api/v1/desktop-hands/protect-hwnd' && method === 'POST') {
        const body = await this.readJson(req);
        await this.postProtectHwnd(res, body, this.resolveRequestActor(req, body));
        return true;
      }
      if (pathname === '/api/v1/tunnel/driver' && method === 'POST') {
        const body = await this.readJson(req);
        await this.postTunnelDriver(res, body, this.resolveRequestActor(req, body));
        return true;
      }
      if (pathname === '/api/v1/tunnel/rotate-token' && method === 'POST') {
        await this.postRotateToken(res, this.resolveRequestActor(req));
        return true;
      }
      if (pathname === '/api/v1/tunnel/token' && method === 'GET') {
        res.setHeader('Cache-Control', 'no-store');
        const remote = req.socket?.remoteAddress || '';
        const isLoopback =
          remote === '127.0.0.1' ||
          remote === '::1' ||
          remote === '::ffff:127.0.0.1' ||
          remote === '';
        if (!isLoopback || this.hasTunnelForwardingHeaders(req)) {
          this.send(res, 403, {
            error: 'LOOPBACK_ONLY',
            message: 'Token endpoint is only accessible via direct local loopback socket without proxy headers'
          });
          return true;
        }
        const secFetchSite =
          typeof req.headers['sec-fetch-site'] === 'string'
            ? req.headers['sec-fetch-site'].trim().toLowerCase()
            : '';
        if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
          this.send(res, 403, {
            error: 'CROSS_ORIGIN_TOKEN_DISCOVERY_FORBIDDEN',
            message: 'Cross-origin browser requests cannot read the loopback runtime token'
          });
          return true;
        }
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        if (origin !== undefined && !this.isTrustedLocalUiOrigin(origin, false)) {
          this.send(res, 403, {
            error: 'CROSS_ORIGIN_TOKEN_DISCOVERY_FORBIDDEN',
            message: 'Untrusted Origin header rejected on loopback token discovery endpoint'
          });
          return true;
        }
        this.send(res, 200, { ok: true, bearerToken: this.getRuntimeToken() });
        return true;
      }
      if (pathname === '/api/v1/tasks/trigger' && method === 'POST') {
        await this.postTrigger(res, await this.readJson(req));
        return true;
      }
      if (pathname === '/api/v1/daemon/emergency-kill' && method === 'POST') {
        await this.postEmergencyKill(res, this.resolveRequestActor(req));
        return true;
      }
      if (pathname === '/api/v1/workspaces/add' && method === 'POST') {
        await this.postWorkspaceAdd(res, await this.readJson(req));
        return true;
      }
      if (pathname === '/api/v1/workspaces/remove' && method === 'POST') {
        await this.postWorkspaceRemove(res, await this.readJson(req), this.resolveRequestActor(req));
        return true;
      }
      if (pathname === '/api/v1/worktrees/spawn' && method === 'POST') {
        await this.postWorktreeSpawn(res, await this.readJson(req));
        return true;
      }
      if (pathname === '/api/v1/thinking-analyze' && method === 'POST') {
        await this.postThinking(res);
        return true;
      }

      const taskMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/(approve|reject|kill)$/);
      if (taskMatch && method === 'POST') {
        const id = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2];
        const body = await this.readJson(req);
        const actor = this.resolveRequestActor(req, body);
        if (action === 'approve') await this.postApprove(req, res, id, body, actor);
        else if (action === 'reject') await this.postReject(res, id, actor);
        else await this.postKill(res, id, actor);
        return true;
      }

      const mergeMatch = pathname.match(/^\/api\/v1\/worktrees\/([^/]+)\/merge$/);
      if (mergeMatch && method === 'POST') {
        await this.postWorktreeMerge(res, decodeURIComponent(mergeMatch[1]), this.resolveRequestActor(req));
        return true;
      }

      const deleteMatch = pathname.match(/^\/api\/v1\/worktrees\/([^/]+)$/);
      if (deleteMatch && method === 'DELETE') {
        await this.deleteWorktree(res, decodeURIComponent(deleteMatch[1]), this.resolveRequestActor(req));
        return true;
      }

      const snapMatch = pathname.match(/^\/api\/v1\/snapshots\/([^/]+)\/rollback$/);
      if (snapMatch && method === 'POST') {
        await this.postRollback(res, decodeURIComponent(snapMatch[1]), this.resolveRequestActor(req));
        return true;
      }
      if (pathname === '/api/v1/snapshots/delete' && method === 'POST') {
        await this.postDeleteSnapshots(res, await this.readJson(req), this.resolveRequestActor(req));
        return true;
      }
      if (pathname === '/api/v1/snapshots/prune' && method === 'POST') {
        await this.postPruneSnapshots(res, await this.readJson(req), this.resolveRequestActor(req));
        return true;
      }

      // ACP Subagents API
      if (pathname === '/api/v1/acp/profiles' && method === 'GET') {
        const mgr = AcpConfigManager.getInstance();
        this.send(res, 200, {
          ok: true,
          config: mgr.loadConfig(),
          profiles: mgr.getProbedProfiles()
        });
        return true;
      }
      if (pathname === '/api/v1/acp/profile' && method === 'POST') {
        const body = await this.readJson(req);
        const mgr = AcpConfigManager.getInstance();
        const upsertRes = mgr.upsertProfile(body);
        if (!upsertRes.success) {
          this.send(res, 400, { ok: false, error: upsertRes.error });
          return true;
        }
        const statePatch = {
          acpConfig: mgr.loadConfig(),
          acpProfiles: mgr.getProbedProfiles()
        };
        this.broadcastSse(statePatch);
        this.send(res, 200, { ok: true, profile: upsertRes.profile, ...statePatch });
        return true;
      }
      if (pathname === '/api/v1/acp/profile' && method === 'DELETE') {
        let body: any = {};
        try {
          body = await this.readJson(req);
        } catch {
          body = {};
        }
        const urlObj = new URL(req.url || '', 'http://127.0.0.1');
        const targetId = body?.id || urlObj.searchParams.get('id');
        const mgr = AcpConfigManager.getInstance();
        const delRes = mgr.deleteProfile(targetId);
        if (!delRes.success) {
          this.send(res, 400, { ok: false, error: delRes.error });
          return true;
        }
        const statePatch = {
          acpConfig: mgr.loadConfig(),
          acpProfiles: mgr.getProbedProfiles()
        };
        this.broadcastSse(statePatch);
        this.send(res, 200, { ok: true, ...statePatch });
        return true;
      }
      if (pathname === '/api/v1/acp/toggle' && method === 'POST') {
        const body = await this.readJson(req);
        const mgr = AcpConfigManager.getInstance();
        const toggleRes = mgr.toggleProfile(body?.id, body?.enabled);
        if (!toggleRes.success) {
          this.send(res, 400, { ok: false, error: toggleRes.error });
          return true;
        }
        const statePatch = {
          acpConfig: mgr.loadConfig(),
          acpProfiles: mgr.getProbedProfiles()
        };
        this.broadcastSse(statePatch);
        this.send(res, 200, { ok: true, profile: toggleRes.profile, ...statePatch });
        return true;
      }
      if (pathname === '/api/v1/acp/probe' && method === 'POST') {
        const body = await this.readJson(req);
        const mgr = AcpConfigManager.getInstance();
        const probeRes = mgr.probeCommand(body?.command);
        this.send(res, 200, { ok: true, ...probeRes });
        return true;
      }

      // Local resource library (MCP servers + Skills). Same Bearer trust level as
      // the ACP routes above; every mutation is audited.
      if (pathname === '/api/v1/resources' && method === 'GET') {
        const manager = getResourcesManager();
        this.send(res, 200, {
          ok: true,
          entries: manager.getPublicEntries(),
          summary: manager.getStatusSummary()
        });
        return true;
      }
      if (pathname === '/api/v1/resources' && method === 'POST') {
        const body = await this.readJson(req);
        const entry = await getResourcesManager().add(body || {});
        this.broadcastResourceState();
        this.send(res, 200, {
          ok: true,
          id: entry.id,
          entries: getResourcesManager().getPublicEntries(),
          summary: getResourcesManager().getStatusSummary()
        });
        return true;
      }
      if (pathname === '/api/v1/resources/scan' && method === 'POST') {
        const outcome = getResourcesManager().scan();
        this.broadcastResourceState();
        this.send(res, 200, {
          ok: true,
          discovered: outcome.discovered.length,
          added: outcome.added,
          skipped: outcome.skipped,
          entries: getResourcesManager().getPublicEntries(),
          summary: getResourcesManager().getStatusSummary()
        });
        return true;
      }
      if (pathname === '/api/v1/resources/toggle' && method === 'POST') {
        const body = await this.readJson(req);
        const id = typeof body?.id === 'string' ? body.id : '';
        if (!id) {
          this.send(res, 400, { ok: false, error: 'RESOURCE_ID_REQUIRED' });
          return true;
        }
        const entry = await getResourcesManager().toggle(id, body?.enabled === true);
        this.broadcastResourceState();
        this.send(res, 200, {
          ok: true,
          id: entry.id,
          enabled: entry.enabled,
          entries: getResourcesManager().getPublicEntries(),
          summary: getResourcesManager().getStatusSummary()
        });
        return true;
      }
      if (pathname === '/api/v1/resources/probe' && method === 'POST') {
        const body = await this.readJson(req);
        const result = await getResourcesManager().probe(body || {});
        this.send(res, result.ok ? 200 : 400, { ...result, ok: result.ok });
        return true;
      }
      if (pathname === '/api/v1/resources/update' && method === 'POST') {
        const body = await this.readJson(req);
        const id = typeof body?.id === 'string' ? body.id : '';
        if (!id) {
          this.send(res, 400, { ok: false, error: 'RESOURCE_ID_REQUIRED' });
          return true;
        }
        const entry = await getResourcesManager().update(id, body || {});
        this.broadcastResourceState();
        this.send(res, 200, {
          ok: true,
          id: entry.id,
          entries: getResourcesManager().getPublicEntries(),
          summary: getResourcesManager().getStatusSummary()
        });
        return true;
      }
      if (pathname === '/api/v1/resources' && method === 'DELETE') {
        let body: any = {};
        try {
          body = await this.readJson(req);
        } catch {
          body = {};
        }
        const urlObj = new URL(req.url || '', 'http://127.0.0.1');
        const id =
          (typeof body?.id === 'string' && body.id) || urlObj.searchParams.get('id') || '';
        if (!id) {
          this.send(res, 400, { ok: false, error: 'RESOURCE_ID_REQUIRED' });
          return true;
        }
        await getResourcesManager().remove(id);
        this.broadcastResourceState();
        this.send(res, 200, {
          ok: true,
          id,
          entries: getResourcesManager().getPublicEntries(),
          summary: getResourcesManager().getStatusSummary()
        });
        return true;
      }

      if (method === 'POST' && pathname.startsWith('/api/v1/tools/')) {
        this.recordMcpActivity();
        const toolName = decodeURIComponent(pathname.slice('/api/v1/tools/'.length));
        if (!toolName || toolName.includes('/')) {
          this.send(res, 404, { error: 'NOT_FOUND', path: pathname });
          return true;
        }
        const params = await this.readJson(req);
        const exposedTools = this.exposedTools();
        const toolDef = exposedTools.find((t) => t.name === toolName);
        if (!toolDef) {
          this.send(res, 404, { error: 'TOOL_NOT_FOUND', message: `Tool not found: ${toolName}` });
          return true;
        }
        const category = toolDef.category;
        const result = await this.invokeTool(toolName, category, params);
        this.send(res, result.status === 'ERROR' ? 500 : 200, result);
        return true;
      }
    } catch (err: any) {
      if (!res.headersSent) {
        this.send(res, 400, { error: 'BAD_REQUEST', message: err?.message || String(err) });
      }
      return true;
    }
    return false;
  }

  public async invokeTool(
    toolName: string,
    category: ToolMetaCategory,
    params: Record<string, any>
  ): Promise<PipelineResponse> {
    const ctx = this.kernel.getContext();
    const normalizedParams =
      toolName === 'desktop_hands'
        ? normalizeDesktopHandsParams(params)
        : (params || {});
    const request: PipelineRequest = {
      id: `ui_${toolName}_${Date.now()}`,
      toolName,
      category,
      params: normalizedParams as Record<string, any>
    };
    const riskEval = this.kernel.getApprovalEngine().evaluateRisk(
      toolName,
      category,
      normalizedParams,
      ctx
    );
    const isReadOnlyShortCircuit = category === 'read' || riskEval.riskLevel === 'low';
    this.preTaskDirtyFiles = this.getWorkspaceDirtySet(ctx.workspaceRoot);

    if (toolName === 'exec_command' || toolName === 'subagent_dispatch') {
      this.armJobCapture = true;
      this.boundJobId = null;
      if (!isReadOnlyShortCircuit && ctx.confinementMode !== 'read-only') {
        try {
          const snapId = GitCheckpointManager.create('pre-task', ctx.workspaceRoot);
          this.liveTask = { ...this.liveTask, snapshotId: snapId, worktreeId: undefined };
        } catch {
          // Snapshot is best-effort; execution still goes through the kernel fence.
        }
      } else {
        this.liveTask = {
          ...this.liveTask,
          snapshotId: undefined,
          worktreeId: undefined,
          modifiedFilesCount: 0
        };
      }
    }

    let dhTaskId = '';
    if (toolName === 'desktop_hands' && !classifyDesktopCall(normalizedParams).isPerception) {
      const actionKey = this.kernel.getApprovalEngine().getActionKey(toolName, normalizedParams);
      const willRunImmediately = this.kernel.getApprovalEngine().isActionPreApproved(
        toolName,
        actionKey,
        riskEval.riskLevel,
        ctx.approvalPolicy,
        ctx,
        normalizedParams
      );
      if (willRunImmediately) {
        dhTaskId = this.startDesktopRunningLiveTask(request, riskEval.riskLevel, riskEval.summary);
      }
    }

    const res = await this.kernel.handleRequest(request);
    if (dhTaskId) {
      this.finishDesktopRunningLiveTask(dhTaskId, res);
    }
    this.absorbPipelineResult(request, res);
    return res;
  }

  private absorbPipelineResult(request: PipelineRequest, res: PipelineResponse): void {
    const ctx = this.kernel.getContext();
    if (res.status === 'CONFIRMATION_REQUIRED' && res.approvalId) {
      this.armJobCapture = false;
      const storedReq: PipelineRequest = {
        ...request,
        params:
          request.toolName === 'desktop_hands'
            ? normalizeDesktopHandsParams(request.params)
            : structuredClone(request.params || {})
      };
      this.pendingTask = { approvalId: res.approvalId, request: storedReq };
      this.pendingTasks.set(res.approvalId, storedReq);
      const params = storedReq.params || {};
      const targetHwnd =
        storedReq.toolName === 'desktop_hands' && typeof params.hwnd === 'number' && params.hwnd > 0
          ? Math.trunc(params.hwnd)
          : undefined;
      this.liveTask = this.sanitizeLiveTaskFrame({
        id: res.approvalId,
        status: 'WAITING_APPROVAL',
        toolName: storedReq.toolName,
        ...(targetHwnd ? { targetHwnd } : {}),
        sourceAgent:
          storedReq.toolName === 'subagent_dispatch'
            ? subagentDisplayLabel(params)
            : 'Muse Cloud MCP',
        command: commandPreview(storedReq.toolName, params),
        targetPath:
          params.path ||
          params.cwd ||
          (targetHwnd ? `hwnd:${targetHwnd}` : ctx.workspaceRoot),
        summary: res.summary || '',
        riskScore: riskScoreOf(res.riskLevel),
        stepLabel: '等待本地执行确认...',
        stepIndex: 1,
        totalSteps: 3,
        stdoutLines: [],
        modifiedFilesCount: 0,
        testResultSummary: '',
        changeTracking: 'git-delta',
        startedAt: nowClock()
      });
      this.broadcastSse({
        liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
        pendingApprovals: this.getSanitizedPendingApprovals()
      });
      return;
    }
    if (res.status === 'SUCCESS' && res.data && typeof res.data.jobId === 'string') {
      const jobId = res.data.jobId as string;
      this.boundJobId = jobId;
      const running = res.data.status === 'RUNNING_ASYNC';
      const stdoutText = typeof res.data.stdout === 'string' ? res.data.stdout : '';
      const stdoutLines = String(stdoutText).split(/\r?\n/).filter((line) => line.length > 0);
      const changeReport = running
        ? null
        : this.detectExecutionChanges(ctx.workspaceRoot, request.toolName, 'SUCCESS');
      const modifiedFilesCount = changeReport ? changeReport.count : 0;
      const changeTracking = changeReport
        ? changeReport.tracking
        : this.liveTask.changeTracking || 'git-delta';
      const isReadOnlyOrClean = !running && modifiedFilesCount === 0;
      const isSubagent = request.toolName === 'subagent_dispatch';
      const agentTag = isSubagent
        ? String(request.params?.profile || request.params?.agent || res.data.agent || 'subagent')
        : '';
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        id: jobId,
        status: running ? 'RUNNING' : 'COMPLETED',
        sourceAgent: isSubagent
          ? subagentDisplayLabel(request.params || {})
          : 'Muse Cloud MCP',
        command: commandPreview(request.toolName, request.params || {}),
        targetPath: request.params?.cwd || request.params?.path || ctx.workspaceRoot,
        summary: res.summary || this.liveTask.summary || '',
        riskScore: riskScoreOf(res.riskLevel || 'medium'),
        stepLabel: running
          ? agentTag
            ? `[${agentTag}] 后台运行中`
            : '后台运行中'
          : agentTag
            ? `[${agentTag}] 执行完成`
            : '执行完成',
        stepIndex: running ? 2 : 3,
        totalSteps: 3,
        stdoutLines: stdoutLines.length > 0 ? stdoutLines.slice(-400) : this.liveTask.stdoutLines,
        modifiedFilesCount,
        changeTracking,
        testResultSummary: running
          ? ''
          : this.completionSummary(changeTracking, modifiedFilesCount, res.data.exitCode),
        snapshotId: isReadOnlyOrClean ? undefined : this.liveTask.snapshotId,
        worktreeId: isReadOnlyOrClean ? undefined : this.liveTask.worktreeId,
        startedAt: this.liveTask.startedAt || nowClock()
      });
      if (!running) this.armJobCapture = false;
      this.broadcastSse({ liveTask: this.sanitizeLiveTaskFrame(this.liveTask) });
    }
  }

  private onJobLifecycle(event: {
    jobId: string;
    pid?: number;
    command: string;
    status: string;
    line?: string;
    exitCode?: number | null;
  }): void {
    const matchAgent = /^\[([A-Za-z0-9_.-]+)\]/.exec(
      String(event.command || this.liveTask.command || '').trim()
    );
    const agentPrefix = matchAgent ? `[${matchAgent[1]}] ` : '';
    if (
      this.armJobCapture &&
      !this.boundJobId &&
      event.jobId &&
      (event.status === 'RUNNING' || event.status === 'RUNNING_ASYNC')
    ) {
      this.boundJobId = event.jobId;
      const ctx = this.kernel.getContext();
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        id: event.jobId,
        status: 'RUNNING',
        sourceAgent: matchAgent ? matchAgent[1] : this.liveTask.sourceAgent || 'Muse Cloud MCP',
        command: event.command || this.liveTask.command,
        targetPath: this.liveTask.targetPath || ctx.workspaceRoot,
        stepLabel:
          event.status === 'RUNNING_ASYNC'
            ? `${agentPrefix}后台运行中`
            : `${agentPrefix}正在执行...`,
        stepIndex: 2,
        totalSteps: 3,
        startedAt: this.liveTask.startedAt || nowClock()
      });
      this.broadcastSse({ liveTask: this.sanitizeLiveTaskFrame(this.liveTask) });
    }
    if (!this.boundJobId || event.jobId !== this.boundJobId) return;
    if (event.line && this.liveTask.status === 'RUNNING') {
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        stdoutLines: [...this.liveTask.stdoutLines, event.line].slice(-400)
      });
      this.broadcastSse({ liveTask: this.sanitizeLiveTaskFrame(this.liveTask) });
      return;
    }
    if (event.status === 'RUNNING_ASYNC') {
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        status: 'RUNNING',
        stepLabel: `${agentPrefix}后台运行中`,
        stepIndex: 2
      });
      this.broadcastSse({ liveTask: this.sanitizeLiveTaskFrame(this.liveTask) });
    } else if (event.status === 'COMPLETED') {
      this.armJobCapture = false;
      const ctx = this.kernel.getContext();
      // 后台作业（exec_command / 子代理）同样按 git 脏集合增量重算，不再沿用开跑前的 0。
      const changeReport = this.detectExecutionChanges(ctx.workspaceRoot, 'exec_command', 'SUCCESS');
      const modifiedFilesCount = changeReport.count;
      const isClean = modifiedFilesCount === 0;
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        status: 'COMPLETED',
        stepLabel: '执行完成',
        stepIndex: 3,
        modifiedFilesCount,
        changeTracking: changeReport.tracking,
        testResultSummary: this.completionSummary(
          changeReport.tracking,
          modifiedFilesCount,
          event.exitCode
        ),
        snapshotId: isClean ? undefined : this.liveTask.snapshotId,
        worktreeId: isClean ? undefined : this.liveTask.worktreeId
      });
      this.broadcastSse({
        liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
        auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
      });
    } else if (event.status === 'FAILED' || event.status === 'TERMINATED') {
      this.armJobCapture = false;
      const ctx = this.kernel.getContext();
      this.liveTask = this.sanitizeLiveTaskFrame({
        ...this.liveTask,
        status: 'IDLE',
        stepLabel: event.status === 'TERMINATED' ? '已强杀' : '执行失败'
      });
      this.broadcastSse({
        liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
        auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
      });
    }
  }

  private async postMode(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const requestedProfile = body?.profile as PermissionProfileId | undefined;
    let mode = body?.mode as ConfinementMode;
    let nextPolicy: ApprovalPolicy | undefined = body?.approvalPolicy as ApprovalPolicy | undefined;
    if (requestedProfile && VALID_PERMISSION_PROFILES.includes(requestedProfile)) {
      const mapped = profileToConfinementAndPolicy(requestedProfile);
      mode = mapped.confinementMode;
      nextPolicy = mapped.approvalPolicy;
    }
    if (!VALID_CONFINEMENT_MODES.includes(mode)) {
      this.send(res, 400, { error: 'INVALID_CONFINEMENT_MODE', mode });
      return;
    }
    if (actor === 'connector' && (mode === 'danger-full-access' || nextPolicy === 'unattended-yolo')) {
      this.send(res, 403, {
        error: 'REMOTE_FULL_ACCESS_ELEVATION_FORBIDDEN',
        message: 'Elevating to danger-full-access cannot be performed via remote connector without local human approval'
      });
      return;
    }
    if (mode === 'workspace-acl-experimental') {
      const cap = AclSandboxManager.checkSandboxCapability();
      if (!cap.available) {
        this.send(res, 403, { error: 'MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED', reason: cap.reason });
        return;
      }
    }
    const prevMode = this.kernel.getContext().confinementMode;
    const effectivePolicy: ApprovalPolicy =
      nextPolicy && VALID_POLICIES.includes(nextPolicy)
        ? nextPolicy
        : mode === 'danger-full-access'
          ? 'unattended-yolo'
          : mode === 'read-only'
            ? 'smart-risk'
            : 'smart-risk';
    const contextPatch: Partial<ExecutionContext> = {
      confinementMode: mode,
      approvalPolicy: effectivePolicy
    };
    if (mode === 'danger-full-access' || effectivePolicy === 'unattended-yolo') {
      contextPatch.yoloExpiresAt = Date.now() + 2 * 3600 * 1000;
    }
    this.kernel.updateContext(contextPatch);
    const parentRank = MODE_RANK[mode];
    this.worktrees = this.worktrees.map((wt) => ({
      ...wt,
      childMode: MODE_RANK[wt.childMode] <= parentRank ? wt.childMode : mode
    }));
    if (this.autoDowngradeTwoHours && MODE_STRICTNESS_RANK[mode] >= 2) {
      // danger-full-access 与 workspace-acl-experimental 两档都允许武装降级定时器。
      this.armDowngradeTimer();
    } else {
      // 关闭自动降级、或新模式比降级目标更严（read-only / workspace-write）：
      // 必须拆掉旧定时器，防止 danger→acl 切换后旧定时器漏清、或旧定时器把更严模式抬升回去。
      this.clearDowngradeTimer();
      this.autoDowngradeDeadlineMs = null;
    }
    const activeProfile = resolvePermissionProfile(mode, effectivePolicy);
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'switch_mode',
      commandOrPath: `${prevMode} -> ${mode}`,
      reason: `[${actor}] set permission profile=${activeProfile} (mode: ${prevMode} -> ${mode}, policy: ${effectivePolicy})`,
      status: 'SUCCESS'
    });
    this.broadcastSse({
      confinementMode: mode,
      approvalPolicy: effectivePolicy,
      worktrees: this.worktrees,
      auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50),
      autoDowngradeRemainingSec: this.remainingSec()
    });
    this.send(res, 200, {
      ok: true,
      profile: activeProfile,
      mode,
      approvalPolicy: effectivePolicy,
      previousMode: prevMode,
      source: actor,
      worktrees: this.worktrees
    });
  }

  private async postPolicy(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const approvalPolicy = body?.approvalPolicy as ApprovalPolicy;
    if (!VALID_POLICIES.includes(approvalPolicy)) {
      this.send(res, 400, { error: 'INVALID_APPROVAL_POLICY', approvalPolicy });
      return;
    }
    const prevPolicy = this.kernel.getContext().approvalPolicy;
    const patch: Partial<ExecutionContext> = { approvalPolicy };
    if (approvalPolicy === 'unattended-yolo') {
      patch.yoloExpiresAt = Date.now() + 2 * 3600 * 1000;
    }
    this.kernel.updateContext(patch);
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'approval_policy',
      commandOrPath: `${prevPolicy} -> ${approvalPolicy}`,
      reason: `[${actor}] set approval policy from ${prevPolicy} to ${approvalPolicy}`,
      status: 'SUCCESS'
    });
    this.broadcastSse({ approvalPolicy, auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50) });
    this.send(res, 200, { ok: true, approvalPolicy, source: actor });
  }

  private async postAutoDowngrade(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    if (typeof body?.enabled === 'boolean') {
      this.autoDowngradeTwoHours = body.enabled;
    } else {
      this.autoDowngradeTwoHours = !this.autoDowngradeTwoHours;
    }
    if (this.autoDowngradeTwoHours) {
      this.armDowngradeTimer();
    } else {
      this.clearDowngradeTimer();
      this.autoDowngradeDeadlineMs = null;
    }
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'auto_downgrade',
      commandOrPath: String(this.autoDowngradeTwoHours),
      reason: `[${actor}] set 2h auto-downgrade=${this.autoDowngradeTwoHours}`,
      status: 'SUCCESS'
    });
    this.broadcastSse({
      autoDowngradeTwoHours: this.autoDowngradeTwoHours,
      autoDowngradeRemainingSec: this.remainingSec(),
      auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
    });
    this.send(res, 200, {
      ok: true,
      autoDowngradeTwoHours: this.autoDowngradeTwoHours,
      autoDowngradeRemainingSec: this.remainingSec()
    });
  }

  private async postMultiDeviceApproval(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const ctx = this.kernel.getContext();
    const enabled =
      typeof body?.enabled === 'boolean' ? body.enabled === true : ctx.multiDeviceApproval !== true;
    this.kernel.updateContext({ multiDeviceApproval: enabled });
    let persisted = true;
    let persistNote = '';
    try {
      saveUserSettings(ctx.workspaceRoot, { multiDeviceApproval: enabled });
    } catch (err: any) {
      persisted = false;
      persistNote = ' (in-memory; persist failed: ' + String(err?.message || err).slice(0, 160) + ')';
    }
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'multi_device_approval',
      commandOrPath: String(enabled),
      reason: '[' + actor + '] set multiDeviceApproval=' + String(enabled) + persistNote,
      status: 'SUCCESS'
    });
    this.broadcastSse({
      multiDeviceApproval: enabled,
      auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
    });
    this.send(res, 200, { ok: true, multiDeviceApproval: enabled, persisted });
  }

  private async postDesktopHands(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    if (actor !== 'ui_island') {
      this.appendAudit({
        decision: 'BLOCK',
        actor,
        toolName: 'desktop_hands_config',
        commandOrPath: `enabled=${String(body?.enabled)},foreground=${String(body?.foregroundFallback)}`,
        reason: `[${actor}] REMOTE_DESKTOP_HANDS_CONFIG_FORBIDDEN: only local UI island may toggle desktop_hands`,
        status: 'DENIED'
      });
      this.send(res, 403, {
        error: 'REMOTE_DESKTOP_HANDS_CONFIG_FORBIDDEN',
        message: 'Desktop Hands configuration can only be changed from the local UI'
      });
      return;
    }
    const ctx = this.kernel.getContext();
    const nextEnabled =
      typeof body?.enabled === 'boolean' ? body.enabled === true : ctx.desktopHandsEnabled === true;
    const nextForeground =
      typeof body?.foregroundFallback === 'boolean'
        ? body.foregroundFallback === true
        : ctx.desktopHandsForegroundFallback === true;

    this.kernel.updateContext({
      desktopHandsEnabled: nextEnabled,
      desktopHandsForegroundFallback: nextForeground
    });
    if (!nextEnabled) {
      try {
        UiaBridge.dispose();
      } catch {
        // ignore
      }
    }

    let persisted = true;
    let persistNote = '';
    try {
      saveUserSettings(ctx.workspaceRoot, {
        desktopHandsEnabled: nextEnabled,
        desktopHandsForegroundFallback: nextForeground
      });
    } catch (err: any) {
      persisted = false;
      persistNote = ' (in-memory; persist failed: ' + String(err?.message || err).slice(0, 160) + ')';
    }
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'desktop_hands_config',
      commandOrPath: `enabled=${nextEnabled},foreground=${nextForeground}`,
      reason: `[${actor}] set desktopHandsEnabled=${nextEnabled}, foregroundFallback=${nextForeground}${persistNote}`,
      status: 'SUCCESS'
    });
    this.broadcastSse({
      desktopHandsEnabled: nextEnabled,
      desktopHandsForegroundFallback: nextForeground,
      auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
    });
    this.send(res, 200, {
      ok: true,
      desktopHandsEnabled: nextEnabled,
      desktopHandsForegroundFallback: nextForeground,
      persisted
    });
  }

  private async postProtectHwnd(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    if (actor !== 'ui_island') {
      this.appendAudit({
        decision: 'BLOCK',
        actor,
        toolName: 'desktop_hands_protect_hwnd',
        commandOrPath: `hwnd=${String(body?.hwnd)},pid=${String(body?.pid)}`,
        reason: `[${actor}] REMOTE_PROTECT_HWND_FORBIDDEN: only local UI island may register protected HWNDs`,
        status: 'DENIED'
      });
      this.send(res, 403, {
        error: 'REMOTE_PROTECT_HWND_FORBIDDEN',
        message: 'Protected HWND registration is restricted to the local UI'
      });
      return;
    }
    const hwnd = Number(body?.hwnd);
    if (Number.isFinite(hwnd) && hwnd > 0) {
      WinGuard.registerProtectedHwnd(Math.trunc(hwnd));
    }
    const pid = Number(body?.pid);
    if (Number.isFinite(pid) && pid > 0) {
      WinGuard.registerProtectedPid(Math.trunc(pid));
    }
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'desktop_hands_protect_hwnd',
      commandOrPath: `hwnd=${Number.isFinite(hwnd) ? Math.trunc(hwnd) : 'none'},pid=${Number.isFinite(pid) ? Math.trunc(pid) : 'none'}`,
      reason: `[${actor}] registered protected desktop window/process`,
      status: 'SUCCESS'
    });
    this.send(res, 200, { ok: true, ...WinGuard.getProtectedRegistrySnapshot() });
  }

  private async postTunnelDriver(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const driver = body?.driver as TunnelDriverType;
    if (!VALID_DRIVERS.includes(driver)) {
      this.send(res, 400, { error: 'INVALID_TUNNEL_DRIVER', driver });
      return;
    }
    const config = body?.config && typeof body.config === 'object' ? body.config : {};
    const urlFieldsToValidate = ['customPublicUrl', 'cfNamedDomain', 'cfQuickUrl', 'tailscaleMagicDns'] as const;
    for (const field of urlFieldsToValidate) {
      const rawVal = config[field];
      if (typeof rawVal === 'string' && rawVal.trim().length > 0) {
        const trimmed = rawVal.trim();
        const candidateUrl =
          (field === 'cfNamedDomain' || field === 'tailscaleMagicDns') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
            ? `https://${trimmed}`
            : trimmed;
        let parsed: URL;
        try {
          parsed = validateOutboundHostSync(candidateUrl);
        } catch (err: any) {
          this.send(res, 400, {
            error: 'INVALID_PUBLIC_TUNNEL_URL',
            field,
            message: err?.message || 'Tunnel URL rejected by outbound security guard'
          });
          return;
        }
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
          this.send(res, 400, {
            error: 'INVALID_PUBLIC_TUNNEL_URL',
            field,
            message: 'Tunnel URL must not contain credentials, query parameters, or fragments'
          });
          return;
        }
      }
    }
    // Explicit stop request from the UI: stop the child and report the real result.
    if (driver === 'cloudflare-quick' && config.stopQuick === true) {
      try {
        this.quickDriver?.stop();
      } catch {
        // Only this instance's child is stopped.
      }
      const stillRunning = this.quickDriver?.isRunning() === true;
      this.tunnel.cfQuickRunning = stillRunning;
      if (!stillRunning) this.tunnel.cfQuickUrl = '';
      this.kernel.updateContext({
        tunnelUrl: stillRunning ? this.tunnel.cfQuickUrl : `http://${this.host}:${this.port}`
      });
      this.appendAudit({
        decision: stillRunning ? 'BLOCK' : 'ALLOW',
        actor,
        toolName: 'tunnel_driver',
        commandOrPath: 'cloudflare-quick',
        reason: stillRunning
          ? 'TUNNEL_STOP_FAILED: cloudflared survived the stop request'
          : `[${actor}] stopped Cloudflare Quick Tunnel`,
        status: stillRunning ? 'ERROR' : 'SUCCESS'
      });
      const stoppedState = this.getSanitizedState().tunnel;
      this.broadcastSse({
        tunnel: stoppedState,
        auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
      });
      if (stillRunning) {
        this.send(res, 500, {
          ok: false,
          error: 'TUNNEL_STOP_FAILED',
          message: 'cloudflared is still running after the stop request'
        });
        return;
      }
      this.send(res, 200, { ok: true, tunnel: stoppedState });
      return;
    }
    try {
      this.quickDriver?.stop();
    } catch {
      // Only this instance's child is stopped.
    }
    try {
      this.namedDriver?.stop();
    } catch {
      // Only this instance's child is stopped.
    }
    this.tunnel.cfQuickRunning = false;
    this.tunnel.activeDriver = driver;
    for (const key of TUNNEL_CONFIG_KEYS) {
      if (config[key] !== undefined) {
        (this.tunnel as any)[key] = config[key];
      }
    }
    if (driver === 'cloudflare-quick' && config.spawnReal === true) {
      if (!this.quickDriver) this.quickDriver = new QuickTunnelDriver();
      this.bindQuickDriverExit(this.quickDriver);
      try {
        const url = await this.quickDriver.start(
          this.port,
          this.cloudflaredPath,
          this.kernel.getContext().workspaceRoot
        );
        this.tunnel.cfQuickUrl = url;
        this.tunnel.cfQuickRunning = true;
        this.kernel.updateContext({ tunnelUrl: url });
        this.appendAudit({
          decision: 'ALLOW',
          actor,
          toolName: 'tunnel_driver',
          commandOrPath: url,
          reason: `[${actor}] started Cloudflare Quick Tunnel (${url})`,
          status: 'SUCCESS'
        });
      } catch (err: any) {
        this.tunnel.cfQuickRunning = false;
        this.tunnel.cfQuickUrl = '';
        this.appendAudit({
          decision: 'BLOCK',
          actor,
          toolName: 'tunnel_driver',
          commandOrPath: driver,
          reason: `QUICK_TUNNEL_START_FAILED: ${err?.message || err}`,
          status: 'ERROR'
        });
        this.broadcastSse({
          tunnel: this.getSanitizedState().tunnel,
          auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
        });
        // Honest failure: never answer 200 for a tunnel that did not start.
        this.send(res, 502, {
          ok: false,
          error: 'QUICK_TUNNEL_START_FAILED',
          message: String(err?.message || err || 'cloudflared start failed')
        });
        return;
      }
    } else {
      this.appendAudit({
        decision: 'ALLOW',
        actor,
        toolName: 'tunnel_driver',
        commandOrPath: driver,
        reason: `[${actor}] updated tunnel driver configuration (${driver})`,
        status: 'SUCCESS'
      });
    }
    try {
      const endpoint = this.tunnel.cfQuickUrl || `http://${this.host}:${this.port}`;
      SkillTemplateGenerator.refreshSkillMd(endpoint);
    } catch {
      // Skill refresh must not fail the driver switch.
    }
    const sanitized = this.getSanitizedState().tunnel;
    this.broadcastSse({
      tunnel: sanitized,
      auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
    });
    this.send(res, 200, { ok: true, tunnel: sanitized });
  }

  private async postRotateToken(
    res: http.ServerResponse,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const newToken = 'mwh_rt_' + crypto.randomBytes(24).toString('hex');
    assertTokenEntropy(newToken);
    const tokenExpiresAt = Date.now() + resolveConfiguredTokenTtlMs();
    const newCookieSecret = rotateUiSessionSecret();
    this.authGuard.updateRuntimeToken(newToken, tokenExpiresAt);
    this.setRuntimeToken(newToken);
    try {
      savePersistedSecrets(this.kernel.getContext().workspaceRoot, {
        token: newToken,
        cookieSecret: newCookieSecret,
        tokenExpiresAt
      });
    } catch {
      // Best-effort persistence (e.g., if running in an ephemeral read-only test dir).
    }
    const masked = maskSecretToken(newToken);
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'rotate_token',
      commandOrPath: masked,
      reason: `[${actor}] rotated runtime bearer token`,
      status: 'SUCCESS'
    });
    this.broadcastSse({
      tunnel: { ...this.getSanitizedState().tunnel, bearerToken: masked },
      auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
    });
    // 轮换后主动拆掉所有已建立的 SSE：旧客户端仍持旧 Token，断开后由前端用新 Token 重连。
    for (const client of [...this.sseClients]) {
      try {
        client.end();
      } catch {
        // 连接可能已关闭，忽略。
      }
      this.dropSse(client);
    }
    this.send(res, 200, { ok: true, bearerToken: newToken, maskedToken: masked, tokenExpiresAt });
  }

  private async postTrigger(res: http.ServerResponse, body: any): Promise<void> {
    const toolName = typeof body?.toolName === 'string' && body.toolName
      ? body.toolName
      : typeof body?.preset === 'string'
        ? body.preset
        : '';
    if (!toolName) {
      this.send(res, 400, { error: 'TOOL_NAME_REQUIRED' });
      return;
    }
    // category 是服务端信任锚：一律采信暴露工具表定义（含资源库第三方工具），
    // 客户端自报的 category 不采信，否则 exec_command 等高危工具可被自报为 read
    // 绕过审批。工具不存在时仅接受 ToolMetaCategory 白名单内的客户端声明，
    // 其余一律落最严的 sensitive_write。
    const toolDef = this.exposedTools().find((t) => t.name === toolName);
    const TRUSTED_FALLBACK_CATEGORIES: readonly ToolMetaCategory[] = ['read', 'write', 'sensitive_write'];
    const category: ToolMetaCategory = toolDef
      ? toolDef.category
      : (TRUSTED_FALLBACK_CATEGORIES.includes(body?.category) ? body.category : 'sensitive_write');
    const params = body?.params && typeof body.params === 'object' ? body.params : {};
    const execRes = await this.invokeTool(toolName, category, params);
    this.send(res, 200, { ok: execRes.status !== 'ERROR' && execRes.status !== 'DENIED', liveTask: this.sanitizeLiveTaskFrame(this.liveTask), execution: execRes });
  }

  private async postApprove(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    if (actor !== 'ui_island') {
      this.send(res, 403, {
        error: 'REMOTE_UI_APPROVAL_FORBIDDEN',
        message: 'Floating island approvals may only be triggered by the local desktop UI'
      });
      return;
    }
    const engine = this.kernel.getApprovalEngine();
    const record = engine.getApproval(id);
    if (!record || record.status !== 'PENDING') {
      this.send(res, 400, { error: 'APPROVAL_NOT_PENDING', approvalId: id });
      return;
    }
    if (
      record.requiresMobileHmac &&
      this.isLoopbackAddress(req.socket?.remoteAddress) &&
      (!this.isLoopbackAddress(this.host) || process.env.MWH_BLOCK_LOOPBACK_CRITICAL_APPROVAL === '1')
    ) {
      this.send(res, 403, {
        error: 'LOOPBACK_SELF_APPROVAL_FORBIDDEN',
        message: 'LOOPBACK_SELF_APPROVAL_FORBIDDEN: Critical approvals cannot be granted from the loopback interface'
      });
      return;
    }
    if (Date.now() > record.expiresAt) {
      record.status = 'EXPIRED';
      engine.recordExecutionReceipt(id, {
        executionStatus: 'DENIED',
        resultSummary: 'Approval expired before execution'
      });
      this.send(res, 400, { error: 'APPROVAL_EXPIRED', approvalId: id });
      return;
    }
    const rawPendingReq: PipelineRequest =
      this.pendingTasks.get(id) ||
      (this.pendingTask?.approvalId === id
        ? this.pendingTask.request
        : {
            id: `reexec_${id}`,
            toolName: record.toolName,
            category: record.category,
            params: structuredClone(record.params || {})
          });
    const pendingReq: PipelineRequest = {
      ...rawPendingReq,
      params:
        rawPendingReq.toolName === 'desktop_hands'
          ? normalizeDesktopHandsParams(rawPendingReq.params || record.params)
          : structuredClone(rawPendingReq.params || record.params || {})
    };
    if (
      !pendingReq.params ||
      typeof pendingReq.params !== 'object' ||
      Array.isArray(pendingReq.params) ||
      hashClientParams(pendingReq.params) !== record.paramsHash
    ) {
      this.send(res, 400, { error: 'PARAMS_HASH_MISMATCH', approvalId: id });
      return;
    }
    const ctx = this.kernel.getContext();
    if (
      pendingReq.toolName === 'fs_mutate' &&
      (pendingReq.params?.action === 'edit' ||
        pendingReq.params?.action === 'move' ||
        pendingReq.params?.action === 'delete') &&
      typeof pendingReq.params?.path === 'string'
    ) {
      const rawTarget = pendingReq.params.path;
      let resolvedTarget = typeof pendingReq.params._resolvedPath === 'string' ? pendingReq.params._resolvedPath : '';
      if (!resolvedTarget && path.isAbsolute(rawTarget)) {
        resolvedTarget = path.normalize(rawTarget);
      }
      if (!resolvedTarget) {
        const root = path.resolve(ctx.workspaceRoot);
        resolvedTarget = path.resolve(root, rawTarget);
        if (!(resolvedTarget === root || resolvedTarget.startsWith(root + path.sep))) {
          resolvedTarget = '';
        }
      }
      if (!fs.existsSync(resolvedTarget)) {
        record.status = 'EXPIRED';
        const baseName = path.basename(String(pendingReq.params.path));
        engine.recordExecutionReceipt(id, {
          executionStatus: 'DENIED',
          resultSummary: `STALE_TARGET_MISSING: '${baseName}' no longer exists; stale approval cancelled`
        });
        if (this.pendingTask?.approvalId === id) {
          this.pendingTask = null;
        }
        this.liveTask = this.sanitizeLiveTaskFrame({
          ...this.liveTask,
          status: 'IDLE',
          stepLabel: '目标已不存在 · 过期批条已取消'
        });
        this.appendAudit({
          decision: 'BLOCK',
          actor,
          toolName: record.toolName,
          commandOrPath: baseName,
          reason: 'STALE_APPROVAL_TARGET_MISSING',
          status: 'DENIED'
        });
        this.broadcastSse({
          liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
          auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
        });
        this.send(res, 400, {
          error: 'STALE_APPROVAL_TARGET_MISSING',
          approvalId: id,
          message: `Target '${baseName}' no longer exists on disk`
        });
        return;
      }
    }
    const scope =
      body?.scope === 'workspace'
        ? 'workspace'
        : body?.scope === 'session' || body?.scope === 'app_session'
          ? 'session'
          : 'once';
    const forceOnce = record.riskLevel === 'critical' || record.requiresMobileHmac === true;
    const granularity = forceOnce ? 'once' : scope;
    try {
      engine.resolveApproval(id, 'approve', record.hmacSig, granularity, ctx, 'ui_island');
    } catch (err: any) {
      this.send(res, 400, { error: 'APPROVAL_RESOLVE_FAILED', message: err?.message || String(err) });
      return;
    }
    if (!forceOnce && granularity === 'workspace') {
      const root = body?.root || body?.workspaceRoot || ctx.workspaceRoot;
      if (typeof root === 'string' && root && !this.alwaysAllowedWorkspaces.includes(root)) {
        this.alwaysAllowedWorkspaces.push(root);
      }
    }
    const isReadOnlyShortCircuit =
      pendingReq.category === 'read' || record.riskLevel === 'low';
    this.preTaskDirtyFiles = this.getWorkspaceDirtySet(ctx.workspaceRoot);
    let snapId = '';
    if (!isReadOnlyShortCircuit && ctx.confinementMode !== 'read-only') {
      try {
        snapId = GitCheckpointManager.create('pre-approved-task', ctx.workspaceRoot);
      } catch {
        snapId = '';
      }
    }
    if (pendingReq.toolName === 'exec_command' || pendingReq.toolName === 'subagent_dispatch') {
      this.armJobCapture = true;
      this.boundJobId = null;
    }
    let dhTaskId = '';
    if (pendingReq.toolName === 'desktop_hands' && !classifyDesktopCall(pendingReq.params).isPerception) {
      dhTaskId = this.startDesktopRunningLiveTask(pendingReq, record.riskLevel, record.summary);
    }
    const execRes = await this.kernel.handleRequest({ ...pendingReq, approvalId: id });
    if (dhTaskId) {
      this.finishDesktopRunningLiveTask(dhTaskId, execRes);
    }
    if (execRes.data && typeof execRes.data.jobId === 'string') {
      record.jobId = execRes.data.jobId;
    }
    const receiptSummary = this.formatExecutionReceiptSummary(
      record.toolName,
      pendingReq.params,
      execRes,
      record.jobId
    );
    engine.recordExecutionReceipt(id, {
      executionStatus:
        execRes.status === 'SUCCESS'
          ? 'SUCCESS'
          : execRes.status === 'DENIED'
            ? 'DENIED'
            : 'ERROR',
      jobId: record.jobId,
      checkpointId: snapId || execRes.data?.checkpointId,
      resultSummary: this.scrubSecretText(receiptSummary)
    });
    this.pendingTasks.delete(id);
    if (this.pendingTask?.approvalId === id) {
      this.pendingTask = null;
    }
    this.absorbPipelineResult({ ...pendingReq, approvalId: id }, execRes);
    const changeReport =
      execRes.status === 'SUCCESS'
        ? this.detectExecutionChanges(ctx.workspaceRoot, pendingReq.toolName, execRes.status)
        : {
            count: this.liveTask.modifiedFilesCount,
            tracking: this.liveTask.changeTracking || ('git-delta' as const),
          };
    const modifiedFilesCount = changeReport.count;
    const isCleanAfterExec = modifiedFilesCount === 0;
    if (this.liveTask.status === 'WAITING_APPROVAL') {
      this.liveTask = {
        ...this.liveTask,
        status: execRes.status === 'SUCCESS' ? 'COMPLETED' : 'IDLE',
        modifiedFilesCount,
        changeTracking: changeReport.tracking,
        testResultSummary: this.completionSummary(
          changeReport.tracking,
          modifiedFilesCount,
          execRes.data?.exitCode
        ),
        snapshotId: isCleanAfterExec ? undefined : snapId || this.liveTask.snapshotId,
        worktreeId: isCleanAfterExec ? undefined : this.liveTask.worktreeId
      };
    } else if (snapId && !isCleanAfterExec) {
      this.liveTask = { ...this.liveTask, snapshotId: snapId };
    }
    if (this.liveTask.status === 'IDLE') {
      this.promoteNextPendingTask();
    }
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: record.toolName,
      commandOrPath: commandPreview(record.toolName, record.params),
      reason: `USER_APPROVED_VIA_UI (${granularity})`,
      status: execRes.status
    });
    this.broadcastSse({
      liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
      pendingApprovals: this.getSanitizedPendingApprovals(),
      alwaysAllowedWorkspaces: this.alwaysAllowedWorkspaces,
      snapshots: this.getSanitizedState().snapshots,
      auditLogs: this.readAuditTail(ctx.workspaceRoot, 50)
    });
    this.send(res, 200, { ok: true, approvalId: id, granularity, snapshotId: snapId, execution: execRes });
  }

  private async postReject(
    res: http.ServerResponse,
    id: string,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    if (actor !== 'ui_island') {
      this.send(res, 403, {
        error: 'REMOTE_UI_APPROVAL_FORBIDDEN',
        message: 'Floating island rejections may only be triggered by the local desktop UI'
      });
      return;
    }
    const engine = this.kernel.getApprovalEngine();
    const record = engine.getApproval(id);
    if (!record || record.status !== 'PENDING') {
      this.send(res, 400, { error: 'APPROVAL_NOT_PENDING', approvalId: id });
      return;
    }
    try {
      engine.resolveApproval(id, 'reject', record.hmacSig, 'once', this.kernel.getContext(), 'ui_island');
      engine.recordExecutionReceipt(id, {
        executionStatus: 'DENIED',
        resultSummary: 'Rejected by user on desktop floating island'
      });
    } catch (err: any) {
      this.send(res, 400, { error: 'APPROVAL_RESOLVE_FAILED', message: err?.message || String(err) });
      return;
    }
    this.appendAudit({
      decision: 'BLOCK',
      actor,
      toolName: record.toolName,
      commandOrPath: commandPreview(record.toolName, record.params),
      reason: 'USER_REJECTED_VIA_UI',
      status: 'DENIED'
    });
    this.pendingTasks.delete(id);
    if (this.pendingTask?.approvalId === id) {
      this.pendingTask = null;
    }
    this.armJobCapture = false;
    if (!this.promoteNextPendingTask()) {
      this.liveTask = this.sanitizeLiveTaskFrame({ ...this.liveTask, status: 'IDLE', stepLabel: '已拒绝' });
    }
    this.broadcastSse({
      liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
      pendingApprovals: this.getSanitizedPendingApprovals(),
      auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
    });
    this.send(res, 200, { ok: true, approvalId: id, status: 'REJECTED' });
  }

  private async postKill(
    res: http.ServerResponse,
    id: string,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    if (
      typeof id === 'string' &&
      id.startsWith('dh_') &&
      this.activeDesktopTaskId === id
    ) {
      this.activeDesktopTaskId = null;
      SubagentDispatcher.triggerEmergencyStop();
      try {
        UiaBridge.dispose();
      } catch {
        // Best-effort
      }
      this.appendAudit({
        decision: 'BLOCK',
        actor,
        toolName: 'desktop_hands',
        commandOrPath: id,
        reason: 'USER_KILL_VIA_UI',
        status: 'DENIED'
      });
      this.liveTask = this.sanitizeLiveTaskFrame({ ...this.liveTask, status: 'IDLE', stepLabel: '已强杀' });
      this.broadcastSse({
        liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
        auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
      });
      this.send(res, 200, { ok: true, jobId: id, status: 'TERMINATED' });
      return;
    }

    // 严格匹配：路径中的 jobId 必须匹配 JobManager 的 JOB_ID_REGEX（单一来源，不复制手写）
    // 且真实存在于活跃作业表；禁止回退杀 boundJobId 或「第一个活跃作业」，避免误杀兜底。
    const active = JobManager.getInstance().getActiveJobs();
    const targetJobId =
      typeof id === 'string' && JOB_ID_REGEX.test(id) && active.some((j) => j.id === id)
        ? id
        : '';
    if (!targetJobId) {
      this.send(res, 404, { ok: false, error: 'NO_ACTIVE_JOB', jobId: id });
      return;
    }
    let result: { success: boolean; jobId: string; status: string; error?: string };
    try {
      result = JobManager.getInstance().abort(targetJobId);
    } catch (err: any) {
      this.send(res, 400, { ok: false, jobId: targetJobId, error: err?.message || String(err) });
      return;
    }
    this.appendAudit({
      decision: 'BLOCK',
      actor,
      toolName: 'job_control',
      commandOrPath: targetJobId,
      reason: 'USER_KILL_VIA_UI',
      status: 'DENIED'
    });
    this.armJobCapture = false;
    this.liveTask = this.sanitizeLiveTaskFrame({ ...this.liveTask, status: 'IDLE', stepLabel: '已强杀' });
    this.broadcastSse({ liveTask: this.sanitizeLiveTaskFrame(this.liveTask), auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50) });
    this.send(res, 200, { ok: result.success, jobId: targetJobId, status: result.status });
  }

  private async postEmergencyKill(
    res: http.ServerResponse,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const abortRes = JobManager.getInstance().abortAll();
    const emergencyEpoch = SubagentDispatcher.triggerEmergencyStop();
    // Emergency kill also ends every MCP child the resource library spawned; the
    // switch state itself is preserved so nothing silently re-enables later.
    try {
      getResourcesManager().disposeAll();
    } catch {
      // Best-effort: Job Object kill-on-close still applies at process exit.
    }
    try {
      UiaBridge.dispose();
    } catch {
      // Best-effort: Job Object kill-on-close still applies at process exit.
    }
    this.kernel.getApprovalEngine().clearSessionApprovals(this.kernel.getContext());
    const rejectedApprovalIds = this.kernel
      .getApprovalEngine()
      .rejectAllPending('EMERGENCY_KILL');
    this.pendingTask = null;
    this.pendingTasks.clear();
    this.activeDesktopTaskId = null;
    this.worktrees = this.worktrees.map((wt) =>
      wt.status === 'RUNNING' ? { ...wt, status: 'STOPPED' } : wt
    );
    this.armJobCapture = false;
    this.boundJobId = null;
    this.liveTask = this.sanitizeLiveTaskFrame({ ...this.liveTask, status: 'IDLE', stepLabel: '全局急停' });
    const targetDesc = [
      abortRes.abortedIds.length > 0 ? `jobs:${abortRes.abortedIds.join(',')}` : '',
      rejectedApprovalIds.length > 0 ? `approvals:${rejectedApprovalIds.join(',')}` : ''
    ]
      .filter(Boolean)
      .join(' | ');
    this.appendAudit({
      decision: 'BLOCK',
      actor,
      toolName: 'emergency_kill',
      commandOrPath: targetDesc,
      reason: 'EMERGENCY_KILL_ALL_JOB_OBJECTS',
      status: 'DENIED'
    });
    this.broadcastSse({
      liveTask: this.sanitizeLiveTaskFrame(this.liveTask),
      worktrees: this.worktrees,
      auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
    });
    this.send(res, 200, {
      ok: true,
      ...abortRes,
      rejectedApprovalIds,
      emergencyEpoch
    });
  }

  private async postWorkspaceAdd(res: http.ServerResponse, body: any): Promise<void> {
    const raw = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!raw || raw.includes('\0')) {
      this.send(res, 400, { error: 'WORKSPACE_PATH_REQUIRED' });
      return;
    }
    const ctx = this.kernel.getContext();
    let resolvedPath = '';
    try {
      // Canonicalize & validate components FIRST (blocks Win32 reserved names,
      // trailing dots/spaces, ADS, and dangling reparse points before stat).
      resolvedPath = resolveNativePath(raw, ctx.workspaceRoot);
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        this.send(res, 403, { error: 'WORKSPACE_PATH_FORBIDDEN', reason: 'PATH_NOT_A_DIRECTORY' });
        return;
      }
      const blacklist = checkSensitiveBlacklist(resolvedPath, ctx.workspaceRoot);
      if (blacklist.blacklisted) {
        this.send(res, 403, { error: 'WORKSPACE_PATH_FORBIDDEN', reason: blacklist.reason || 'SENSITIVE_BLACKLIST' });
        return;
      }
    } catch (err: any) {
      this.send(res, 403, { error: 'WORKSPACE_PATH_FORBIDDEN', reason: err?.message || String(err) });
      return;
    }
    const already = this.workspaceRoots.some((p) => p.toLowerCase() === resolvedPath.toLowerCase());
    if (!already) this.workspaceRoots.push(resolvedPath);
    this.kernel.updateContext({ workspaceRoots: [...this.workspaceRoots] });
    this.broadcastSse({ workspaceRoots: this.workspaceRoots });
    this.send(res, 200, { ok: true, path: resolvedPath, workspaceRoots: this.workspaceRoots });
  }

  private async postWorkspaceRemove(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const raw = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!raw || raw.includes('\0')) {
      this.send(res, 400, { error: 'WORKSPACE_PATH_REQUIRED' });
      return;
    }
    // Fail-closed: only CURRENTLY REGISTERED workspace roots may be removed.
    // The request path is normalized lexically and compared against the
    // registry — no fs operation is ever performed on unregistered input,
    // which closes the path-traversal probe/mutation surface.
    const resolvedInput = path.resolve(raw).toLowerCase();
    const idx = this.workspaceRoots.findIndex((p) => path.resolve(p).toLowerCase() === resolvedInput);
    if (idx < 0) {
      this.appendAudit({
        decision: 'BLOCK',
        actor,
        toolName: 'workspace_remove',
        commandOrPath: raw,
        reason: 'UNKNOWN_WORKSPACE: path is not a registered workspace root',
        status: 'DENIED'
      });
      this.send(res, 400, { error: 'UNKNOWN_WORKSPACE' });
      return;
    }
    this.workspaceRoots.splice(idx, 1);
    this.kernel.updateContext({ workspaceRoots: [...this.workspaceRoots] });
    this.broadcastSse({ workspaceRoots: this.workspaceRoots });
    this.send(res, 200, { ok: true, workspaceRoots: this.workspaceRoots });
  }

  private async postWorktreeSpawn(res: http.ServerResponse, body: any): Promise<void> {
    const ctx = this.kernel.getContext();
    const parentMode = ctx.confinementMode;
    const requestedMode = (body?.requestedMode || parentMode) as ConfinementMode;
    const agentId = (body?.agentId || 'builtin') as SubagentType | string;
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const strict = body?.strict === true;
    if (requestedMode && !VALID_CONFINEMENT_MODES.includes(requestedMode)) {
      this.send(res, 400, { error: 'INVALID_CONFINEMENT_MODE', requestedMode });
      return;
    }
    if (strict) {
      try {
        const summary = await SubagentDispatcher.dispatch(
          {
            agent: (agentId as SubagentType) || 'builtin',
            prompt: prompt || 'Verify worktree confinement',
            childMode: requestedMode,
            isolateWorktree: true,
            steps: []
          },
          ctx
        );
        const worktree = this.trackWorktree(summary.worktreePath, String(agentId || 'builtin'), summary.childMode, summary);
        this.broadcastSse({ worktrees: this.worktrees });
        this.send(res, 200, {
          ok: true,
          worktree,
          clamped: false,
          parentMode,
          effectiveMode: summary.childMode
        });
      } catch (err: any) {
        const message = err?.message || String(err);
        if (message.includes('PRIVILEGE_ESCALATION_DENIED')) {
          this.send(res, 403, { error: 'PRIVILEGE_ESCALATION_DENIED', message, parentMode, requestedMode });
          return;
        }
        this.send(res, 500, { error: 'WORKTREE_SPAWN_FAILED', message });
      }
      return;
    }
    const effectiveMode: ConfinementMode =
      MODE_RANK[requestedMode] <= MODE_RANK[parentMode] ? requestedMode : parentMode;
    try {
      const summary = await SubagentDispatcher.dispatch(
        {
          agent: 'builtin',
          prompt: prompt || `Spawn isolated worktree for ${agentId || 'builtin'}`,
          childMode: effectiveMode,
          isolateWorktree: true,
          steps: []
        },
        ctx
      );
      const worktree = this.trackWorktree(summary.worktreePath, String(agentId || 'builtin'), effectiveMode, summary);
      this.broadcastSse({ worktrees: this.worktrees });
      this.send(res, 200, {
        ok: true,
        worktree,
        clamped: effectiveMode !== requestedMode,
        parentMode,
        effectiveMode
      });
    } catch (err: any) {
      this.send(res, 500, { error: 'WORKTREE_SPAWN_FAILED', message: err?.message || String(err) });
    }
  }

  private trackWorktree(
    worktreePath: string | undefined,
    agentId: string,
    childMode: ConfinementMode,
    summary: { filesModified?: string[]; summary?: string; status?: string }
  ): WorktreeInstance {
    const id = worktreePath ? path.basename(worktreePath) : `sub_${Date.now()}`;
    const wt: WorktreeInstance = {
      id,
      branchName: `mwh/${id}`,
      agentId,
      path: worktreePath || '',
      childMode,
      status: summary.status === 'COMPLETED' ? 'READY_TO_MERGE' : 'RUNNING',
      modifiedFiles: summary.filesModified?.length || 0,
      commitsAhead: 0,
      stdoutPages: summary.summary ? [[this.sanitizeLogLine(summary.summary)]] : [],
      createdAt: new Date().toISOString()
    };
    this.worktrees = this.worktrees.filter((item) => item.id !== id).concat(wt);
    return wt;
  }

  private async postWorktreeMerge(
    res: http.ServerResponse,
    id: string,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    if (!this.isSafeWorktreeId(id)) {
      this.send(res, 400, { ok: false, error: 'INVALID_WORKTREE_ID', code: 'INVALID_WORKTREE_ID', worktreeId: id });
      return;
    }
    const wt = this.worktrees.find((item) => item.id === id);
    if (!wt) {
      this.send(res, 404, {
        ok: false,
        error: 'WORKTREE_NOT_FOUND',
        code: 'WORKTREE_NOT_FOUND',
        status: 'MISSING',
        worktreeId: id,
        message: `Worktree '${id}' does not exist or has already been cleaned up`
      });
      return;
    }
    const ctx = this.kernel.getContext();
    if (ctx.confinementMode === 'read-only') {
      this.appendAudit({
        decision: 'BLOCK',
        actor,
        toolName: 'worktree_merge',
        commandOrPath: wt.path,
        reason: 'READ_ONLY_MERGE_FORBIDDEN',
        status: 'DENIED'
      });
      this.broadcastSse({ auditLogs: this.readAuditTail(ctx.workspaceRoot, 50) });
      this.send(res, 403, { ok: false, error: 'READ_ONLY_MERGE_FORBIDDEN', code: 'READ_ONLY_MERGE_FORBIDDEN', worktreeId: id });
      return;
    }
    // G5: Honest merge-state machine with structured 404 when worktree directory is gone/cleaned:
    // - worktree directory gone from disk      -> 404 WORKTREE_DIR_MISSING (status='MISSING')
    // - git reports nothing-to-commit/up-to-date -> 200 UP_TO_DATE (audit records the truth)
    // - git merge actually executed and succeeded -> 200 MERGED
    // - git merge failed                        -> 500 WORKTREE_MERGE_FAILED
    if (!wt.path || !fs.existsSync(wt.path)) {
      wt.status = 'MISSING';
      this.appendAudit({
        decision: 'BLOCK',
        actor,
        toolName: 'worktree_merge',
        commandOrPath: wt.path || id,
        reason: `WORKTREE_DIR_MISSING: worktree ${id} directory does not exist on disk; nothing was merged`,
        status: 'SKIPPED'
      });
      this.broadcastSse({ worktrees: this.worktrees, auditLogs: this.readAuditTail(ctx.workspaceRoot, 50) });
      this.send(res, 404, {
        ok: false,
        error: 'WORKTREE_DIR_MISSING',
        code: 'WORKTREE_DIR_MISSING',
        status: 'MISSING',
        worktreeId: id,
        message: `Worktree '${id}' directory has been cleaned up or does not exist on disk`
      });
      return;
    }
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'MWH',
      GIT_AUTHOR_EMAIL: 'mwh@localhost',
      GIT_COMMITTER_NAME: 'MWH',
      GIT_COMMITTER_EMAIL: 'mwh@localhost'
    };
    let dirty = '';
    try {
      dirty = execFileSync('git', ['status', '--porcelain'], {
        cwd: wt.path,
        windowsHide: true,
        encoding: 'utf-8',
        env: gitEnv
      });
    } catch {
      dirty = '';
    }
    let mergeOutcome: 'MERGED' | 'UP_TO_DATE';
    let auditReason: string;
    if (!dirty.trim()) {
      // No working-tree changes in the worktree: there is nothing to commit and
      // no git merge is performed. Report the truth instead of claiming MERGED.
      mergeOutcome = 'UP_TO_DATE';
      auditReason = `WORKTREE_NOTHING_TO_COMMIT: worktree ${id} reported no changes (git status clean); no merge was executed`;
    } else {
      try {
        execFileSync('git', ['checkout', '-B', wt.branchName], {
          cwd: wt.path,
          windowsHide: true,
          env: gitEnv
        });
        execFileSync('git', ['add', '-A'], { cwd: wt.path, windowsHide: true, env: gitEnv });
        execFileSync('git', ['commit', '-m', `mwh: merge ${wt.id}`], {
          cwd: wt.path,
          windowsHide: true,
          env: gitEnv
        });
      } catch {
        // A commit can fail when there is nothing new to record; merge still attempted.
      }
      try {
        const mergeOut = execFileSync('git', ['merge', '--no-edit', wt.branchName], {
          cwd: ctx.workspaceRoot,
          windowsHide: true,
          encoding: 'utf-8',
          env: gitEnv
        });
        if (/already\s+up[- ]to[- ]date/i.test(mergeOut)) {
          mergeOutcome = 'UP_TO_DATE';
          auditReason = `WORKTREE_ALREADY_UP_TO_DATE: git merge reported no diff for ${id}; not marked MERGED`;
        } else {
          mergeOutcome = 'MERGED';
          auditReason = `Merged worktree ${id}`;
        }
      } catch (err: any) {
        this.appendAudit({
          decision: 'BLOCK',
          actor,
          toolName: 'worktree_merge',
          commandOrPath: wt.branchName,
          reason: `MERGE_FAILED: ${err?.message || err}`,
          status: 'ERROR'
        });
        this.send(res, 500, { error: 'WORKTREE_MERGE_FAILED', message: err?.message || String(err) });
        return;
      }
    }
    wt.status = mergeOutcome;
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'worktree_merge',
      commandOrPath: wt.path,
      reason: auditReason,
      status: 'SUCCESS'
    });
    this.broadcastSse({ worktrees: this.worktrees, auditLogs: this.readAuditTail(ctx.workspaceRoot, 50) });
    this.send(res, 200, { ok: true, worktreeId: id, status: mergeOutcome });
  }

  private async deleteWorktree(
    res: http.ServerResponse,
    id: string,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    if (!this.isSafeWorktreeId(id)) {
      this.send(res, 400, { error: 'INVALID_WORKTREE_ID', worktreeId: id });
      return;
    }
    const wt = this.worktrees.find((item) => item.id === id);
    if (!wt) {
      this.send(res, 404, { error: 'WORKTREE_NOT_FOUND', worktreeId: id });
      return;
    }
    const ctx = this.kernel.getContext();
    if (wt.path) {
      SubagentDispatcher.cleanupWorktree(wt.path, ctx.workspaceRoot);
    }
    this.worktrees = this.worktrees.filter((item) => item.id !== id);
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'worktree_delete',
      commandOrPath: wt.path || id,
      reason: `[${actor}] cleaned up worktree ${id}`,
      status: 'SUCCESS'
    });
    this.broadcastSse({ worktrees: this.worktrees, auditLogs: this.readAuditTail(ctx.workspaceRoot, 50) });
    this.send(res, 200, { ok: true, worktreeId: id });
  }

  private async postRollback(
    res: http.ServerResponse,
    id: string,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const ctx = this.kernel.getContext();
    try {
      GitCheckpointManager.rollback(id, ctx.workspaceRoot);
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.startsWith('INVALID_SNAPSHOT_ID')) {
        this.appendAudit({
          decision: 'BLOCK',
          actor,
          toolName: 'git_checkpoint',
          commandOrPath: id,
          reason: `INVALID_SNAPSHOT_ID: rollback refused for '${id}'`,
          status: 'DENIED'
        });
        this.send(res, 400, { error: 'INVALID_SNAPSHOT_ID', message });
        return;
      }
      this.send(res, 400, { error: 'ROLLBACK_FAILED', message });
      return;
    }
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'git_checkpoint',
      commandOrPath: id,
      reason: `[${actor}] rolled back snapshot ${id}`,
      status: 'SUCCESS'
    });
    const snapshots = this.getSanitizedState().snapshots;
    this.broadcastSse({ snapshots, auditLogs: this.readAuditTail(ctx.workspaceRoot, 50) });
    this.send(res, 200, { ok: true, snapshotId: id, rolledBack: true });
  }

  private async postDeleteSnapshots(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    if (ids.length === 0) {
      this.send(res, 400, { error: 'SNAPSHOT_IDS_REQUIRED' });
      return;
    }
    const ctx = this.kernel.getContext();
    const rootsToScan = Array.from(
      new Set([ctx.workspaceRoot, ...this.workspaceRoots].filter(Boolean))
    );
    // Fail-closed batch validation: every id must exist in the snapshot index
    // of at least one candidate root BEFORE any deletion. Any unknown id
    // rejects the whole order (no partial fs mutation).
    const knownIds = new Set<string>();
    for (const root of rootsToScan) {
      for (const meta of GitCheckpointManager.listCheckpoints(root)) {
        knownIds.add(meta.id);
      }
    }
    const invalidIds = ids.filter((id: string) => !knownIds.has(id));
    if (invalidIds.length > 0) {
      this.appendAudit({
        decision: 'BLOCK',
        actor,
        toolName: 'git_checkpoint',
        commandOrPath: ids.join(','),
        reason: `INVALID_SNAPSHOT_ID: unknown snapshot id(s) ${invalidIds.join(',')} — whole delete batch refused`,
        status: 'DENIED'
      });
      this.send(res, 400, { error: 'INVALID_SNAPSHOT_ID', invalidIds });
      return;
    }
    const deletedSet = new Set<string>();
    try {
      for (const root of rootsToScan) {
        // Partition per root so the manager-level per-root index check passes
        // for ids that legitimately live in different registered roots.
        const rootIndex = new Set(
          GitCheckpointManager.listCheckpoints(root).map((meta) => meta.id)
        );
        const idsInRoot = ids.filter((id: string) => rootIndex.has(id));
        if (idsInRoot.length === 0) continue;
        for (const delId of GitCheckpointManager.deleteCheckpoints(idsInRoot, root)) {
          deletedSet.add(delId);
        }
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.startsWith('INVALID_SNAPSHOT_ID')) {
        this.appendAudit({
          decision: 'BLOCK',
          actor,
          toolName: 'git_checkpoint',
          commandOrPath: ids.join(','),
          reason: `INVALID_SNAPSHOT_ID: ${message}`,
          status: 'DENIED'
        });
        this.send(res, 400, { error: 'INVALID_SNAPSHOT_ID', message });
        return;
      }
      this.send(res, 400, { error: 'SNAPSHOT_DELETE_FAILED', message });
      return;
    }
    const deletedIds = Array.from(deletedSet);
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'git_checkpoint',
      commandOrPath: deletedIds.join(',') || ids.join(','),
      reason: `[${actor}] deleted ${deletedIds.length} snapshot record(s)`,
      status: 'SUCCESS'
    });
    const snapshots = this.getSanitizedState().snapshots;
    this.broadcastSse({ snapshots, auditLogs: this.readAuditTail(ctx.workspaceRoot, 50) });
    this.send(res, 200, { ok: true, deletedIds, snapshots });
  }

  private async postPruneSnapshots(
    res: http.ServerResponse,
    body: any,
    actor: 'ui_island' | 'mcp' | 'connector' = 'ui_island'
  ): Promise<void> {
    // Fail-closed parameter validation: keepRecent must be a bounded integer.
    // Unspecified keeps the historical default (5); any other non-conforming
    // value (non-integer / < 1 / > 100) rejects the request. The [1, 100]
    // bound mirrors the manager-layer clamp in GitCheckpointManager.pruneCheckpoints
    // so an out-of-range request fails loudly at the API boundary instead of
    // being silently clamped to 100 down below.
    const keepRecent = body?.keepRecent === undefined ? 5 : body.keepRecent;
    if (!Number.isInteger(keepRecent) || keepRecent < 1 || keepRecent > 100) {
      this.appendAudit({
        decision: 'BLOCK',
        actor,
        toolName: 'git_checkpoint',
        commandOrPath: `keepRecent=${String(body?.keepRecent)}`,
        reason: `INVALID_KEEP_RECENT: ${String(body?.keepRecent)} is not an integer in [1, 100]`,
        status: 'DENIED'
      });
      this.send(res, 400, { error: 'INVALID_KEEP_RECENT', keepRecent: body?.keepRecent });
      return;
    }
    const ctx = this.kernel.getContext();
    const rootsToScan = Array.from(
      new Set([ctx.workspaceRoot, ...this.workspaceRoots].filter(Boolean))
    );
    const deletedSet = new Set<string>();
    try {
      for (const root of rootsToScan) {
        for (const delId of GitCheckpointManager.pruneCheckpoints(keepRecent, root)) {
          deletedSet.add(delId);
        }
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.startsWith('INVALID_SNAPSHOT_ID')) {
        this.appendAudit({
          decision: 'BLOCK',
          actor,
          toolName: 'git_checkpoint',
          commandOrPath: `keepRecent=${keepRecent}`,
          reason: `INVALID_SNAPSHOT_ID: ${message}`,
          status: 'DENIED'
        });
        this.send(res, 400, { error: 'INVALID_SNAPSHOT_ID', message });
        return;
      }
      this.send(res, 400, { error: 'SNAPSHOT_PRUNE_FAILED', message });
      return;
    }
    const deletedIds = Array.from(deletedSet);
    this.appendAudit({
      decision: 'ALLOW',
      actor,
      toolName: 'git_checkpoint',
      commandOrPath: `keepRecent=${keepRecent}`,
      reason: `[${actor}] pruned ${deletedIds.length} older snapshot record(s) (keepRecent=${keepRecent})`,
      status: 'SUCCESS'
    });
    const snapshots = this.getSanitizedState().snapshots;
    this.broadcastSse({ snapshots, auditLogs: this.readAuditTail(ctx.workspaceRoot, 50) });
    this.send(res, 200, { ok: true, keepRecent, deletedIds, snapshots });
  }

  private async postThinking(res: http.ServerResponse): Promise<void> {
    const ctx = this.kernel.getContext();
    const report = [
      `1. 权限封顶：父进程当前为 ${ctx.confinementMode}，派生 Worktree 子代理遵循 ChildMode <= ParentMode。`,
      `2. 审批策略：当前为 ${ctx.approvalPolicy}。Critical 操作强制 once，且 job_control 不能自批 requiresMobileHmac。`,
      `3. 工作区白名单：${this.workspaceRoots.join(' | ') || ctx.workspaceRoot}。`,
      '4. 路径校验：执行前通过 realpath 核验物理路径，阻断符号链接越界与敏感目录。',
      '5. 快照策略：写入前记录 Git Shadow Checkpoint，异常可从 /api/v1/snapshots/:id/rollback 还原。'
    ].join('\n');
    this.builtinReport = report;
    this.broadcastSse({ builtinLoop: { ...this.getSanitizedState().builtinLoop, lastThinkingReport: report } });
    this.send(res, 200, { ok: true, thinkingLevel: 'HIGH', report, confinementMode: ctx.confinementMode, approvalPolicy: ctx.approvalPolicy, workspaceRoots: this.workspaceRoots });
  }

  private isSafeWorktreeId(id: string): boolean {
    return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) && !id.includes('..');
  }

  private armDowngradeTimer(): void {
    this.clearDowngradeTimer();
    this.autoDowngradeDeadlineMs = null;
    // 仅当当前模式 rank >= 2 时武装降级定时器：read-only / workspace-write 更严或持平，
    // 定时器到点只允许“降级”（变严），绝不允许把更严模式抬升回 workspace-write。
    const currentMode = this.kernel.getContext().confinementMode;
    if (MODE_STRICTNESS_RANK[currentMode] <= 1) {
      this.appendAudit({
        decision: 'ALLOW',
        actor: 'system_timer',
        toolName: 'auto_downgrade',
        commandOrPath: currentMode,
        reason: 'AUTO_DOWNGRADE_TIMER_SKIPPED_MODE_NOT_LOOSER_THAN_TARGET',
        status: 'SUCCESS'
      });
      return;
    }
    this.autoDowngradeDeadlineMs = Date.now() + 7200 * 1000;
    this.downgradeTimer = setTimeout(() => {
      this.downgradeTimer = null;
      this.autoDowngradeDeadlineMs = null;
      const modeAtExpiry = this.kernel.getContext().confinementMode;
      if (MODE_STRICTNESS_RANK[modeAtExpiry] <= 1) {
        // 到期时模式已被切得更严：只清定时器并落审计，不执行任何模式写入。
        this.appendAudit({
          decision: 'ALLOW',
          actor: 'system_timer',
          toolName: 'auto_downgrade',
          commandOrPath: modeAtExpiry,
          reason: 'AUTO_DOWNGRADE_SKIPPED_MODE_ALREADY_STRICT',
          status: 'SUCCESS'
        });
        this.broadcastSse({ autoDowngradeRemainingSec: 0 });
        return;
      }
      this.kernel.updateContext({ confinementMode: 'workspace-write' });
      const rank = MODE_RANK['workspace-write'];
      this.worktrees = this.worktrees.map((wt) => ({
        ...wt,
        childMode: MODE_RANK[wt.childMode] <= rank ? wt.childMode : 'workspace-write'
      }));
      this.appendAudit({
        decision: 'ALLOW',
        actor: 'system_timer',
        toolName: 'auto_downgrade',
        commandOrPath: `${modeAtExpiry} -> workspace-write`,
        reason: 'AUTO_DOWNGRADE_TWO_HOURS',
        status: 'SUCCESS'
      });
      this.broadcastSse({
        confinementMode: 'workspace-write',
        worktrees: this.worktrees,
        autoDowngradeRemainingSec: 0,
        lastCopiedToast: '安全保护：完全访问已满 2 小时，已自动降级为工作区读写模式',
        auditLogs: this.readAuditTail(this.kernel.getContext().workspaceRoot, 50)
      });
    }, 7200 * 1000);
    this.downgradeTimer.unref?.();
  }

  /** 命令输出文本脱敏：runtimeToken、hmacSecret 与隧道 Token 原文整体替换为 [REDACTED]，并剥离内部 CLI 提权标志。 */
  private scrubSecretText(text: string): string {
    const secrets = [
      this.getRuntimeToken(),
      this.kernel.getContext().hmacSecret,
      this.tunnel.cfNamedToken,
      process.env.MWH_CF_TUNNEL_TOKEN
    ].filter((v): v is string => typeof v === 'string' && v.length >= 8);
    let out = sanitizeSensitiveCliFlags(text);
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    }
    return out;
  }

  /** 单行日志脱敏：secrets 替换 + 500 字符截断（已有 8KB 分页上限之外的防线）。 */
  private sanitizeLogLine(line: string): string {
    return this.scrubSecretText(line).slice(0, 500);
  }

  /**
   * liveTask 增量帧脱敏：把帧文本（command / stdoutLines / summary 等 string 字段）中出现的
   * runtimeToken 与 hmacSecret 原文整体替换为 [REDACTED]，stdoutLines 每行截断到 500 字符。
   * 幂等：对已脱敏文本重复调用结果不变。
   */
  private sanitizeLiveTaskFrame(frame: LiveTaskState): LiveTaskState {
    return {
      ...frame,
      command: this.scrubSecretText(frame.command),
      targetPath: this.scrubSecretText(frame.targetPath),
      summary: this.scrubSecretText(frame.summary),
      stepLabel: this.scrubSecretText(frame.stepLabel),
      testResultSummary: this.scrubSecretText(frame.testResultSummary),
      stdoutLines: (frame.stdoutLines || []).map((line) => this.sanitizeLogLine(line))
    };
  }

  private clearDowngradeTimer(): void {
    if (this.downgradeTimer) {
      clearTimeout(this.downgradeTimer);
      this.downgradeTimer = null;
    }
  }

  private remainingSec(): number {
    if (!this.autoDowngradeTwoHours) return 0;
    // 定时器已清（未武装/已到期/已被更严模式切换拆掉）时必须报 0，不得虚报 7200。
    if (!this.autoDowngradeDeadlineMs) return 0;
    return Math.max(0, Math.ceil((this.autoDowngradeDeadlineMs - Date.now()) / 1000));
  }

  private openSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.sseClients.size >= MAX_SSE_CLIENTS) {
      this.send(res, 429, { error: 'TOO_MANY_SSE_CONNECTIONS' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    this.sseClients.add(res);
    res.write(`data: ${JSON.stringify(this.getSanitizedState())}\n\n`);
    const timer = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        this.dropSse(res);
      }
    }, 15000);
    timer.unref?.();
    this.sseHeartbeats.set(res, timer);
    req.on('close', () => this.dropSse(res));
  }

  private dropSse(res: http.ServerResponse): void {
    const timer = this.sseHeartbeats.get(res);
    if (timer) clearInterval(timer);
    this.sseHeartbeats.delete(res);
    this.sseClients.delete(res);
  }

  private appendAudit(entry: {
    decision: 'ALLOW' | 'ASK' | 'BLOCK';
    actor?: string;
    toolName: string;
    commandOrPath: string;
    reason: string;
    status: string;
    jobId?: string;
    terminalStatus?: string;
    diagnostic?: string;
  }): void {
    const ctx = this.kernel.getContext();
    const line = {
      id: `audit_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: new Date().toISOString(),
      decision: entry.decision,
      actor: entry.actor || 'ui_island',
      toolName: entry.toolName,
      commandOrPath: this.scrubSecretText(entry.commandOrPath),
      mode: ctx.confinementMode,
      confinementMode: ctx.confinementMode,
      reason: this.scrubSecretText(entry.reason),
      status: entry.status,
      ...(entry.jobId ? { jobId: entry.jobId } : {}),
      ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
      ...(entry.diagnostic ? { diagnostic: this.scrubSecretText(entry.diagnostic) } : {})
    };
    try {
      const logDir = path.join(ctx.workspaceRoot, '.mwh', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'audit.jsonl'), JSON.stringify(line) + '\n', 'utf-8');
    } catch {
      // Audit failure must not break the control plane response.
    }
  }

  private readAuditTail(workspaceRoot: string, limit: number): MwhState['auditLogs'] {
    const file = path.join(workspaceRoot, '.mwh', 'logs', 'audit.jsonl');
    if (!fs.existsSync(file)) return [];
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return [];
    }
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-limit).reverse();
    const mapped: MwhState['auditLogs'] = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        let decision: 'ALLOW' | 'ASK' | 'BLOCK' = 'ALLOW';
        if (row.decision === 'ALLOW' || row.decision === 'ASK' || row.decision === 'BLOCK') {
          decision = row.decision;
        } else if (row.status === 'DENIED' || row.status === 'ERROR') {
          decision = 'BLOCK';
        } else if (row.status === 'CONFIRMATION_REQUIRED') {
          decision = 'ASK';
        }
        mapped.push({
          id: String(row.id || row.requestId || ''),
          timestamp: String(row.timestamp || ''),
          decision,
          actor: String(row.actor || 'kernel'),
          toolName: String(row.toolName || ''),
          commandOrPath: String(row.commandOrPath || row.summary || row.reason || ''),
          mode: (row.mode || row.confinementMode || 'workspace-write') as ConfinementMode,
          reason: String(row.reason || row.error || ''),
          ...(row.jobId ? { jobId: String(row.jobId) } : {}),
          ...(row.terminalStatus ? { terminalStatus: String(row.terminalStatus) } : {}),
          ...(row.diagnostic ? { diagnostic: this.scrubSecretText(String(row.diagnostic)) } : {})
        });
      } catch {
        // Skip torn lines.
      }
    }
    return mapped;
  }

  private readJson(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk.toString();
        if (data.length > 1_000_000) {
          reject(new Error('BODY_TOO_LARGE'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!data.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', (err) => reject(err));
    });
  }

  private send(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }
}

import {
  detectInitialLocale,
  normalizeLocale,
  translate,
  type SupportedLocale,
  type TranslationParams,
} from '../i18n';
import {
  ApprovalPolicy,
  AuditDecision,
  clampChildMode,
  ConfinementMode,
  generatePairingArtifacts,
  getPermissionProfileMeta,
  MODE_METADATA_MAP,
  PERMISSION_PROFILE_MAP,
  PermissionProfileId,
  resolvePermissionProfile,
  TunnelDriverType,
} from './mwhRules';

export type {
  ApprovalPolicy,
  AuditDecision,
  ConfinementMode,
  PermissionProfileId,
  TunnelDriverType,
};

export type TaskStatus = 'IDLE' | 'WAITING_APPROVAL' | 'RUNNING' | 'COMPLETED';

export interface LiveTaskState {
  id: string;
  status: TaskStatus;
  sourceAgent: 'Muse Cloud MCP' | (string & {});
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
  changeTracking?: 'git-delta' | 'unavailable';
  snapshotId?: string;
  startedAt: string;
}

export interface TunnelDriverConfig {
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
}

/**
 * @deprecated 仅保留对外 REST/SSE 状态契约兼容（完全由 acpProfiles 派生）；
 * 双端设置 UI 已移除「本机 CLI 代理桥接器」只读卡片，严禁在 UI 中重复渲染。
 */
export interface CliSubagentItem {
  id: string;
  name: string;
  binaryPath: string;
  version: string;
  detected: boolean;
  enabled: boolean;
  description: string;
}

export interface AcpProfile {
  id: string;
  display_name?: string;
  kind?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  detected?: boolean;
  version?: string;
  binaryPath?: string;
  error?: string;
}

export interface AcpConfig {
  acp_enabled: boolean;
  acp_default_profile?: string;
  acp_profiles: AcpProfile[];
}

export type CliSubagentInfo = CliSubagentItem;

export interface BuiltinLoopSubagentConfig {
  enabled: boolean;
  maxIterations: number;
  thinkingLevel: 'HIGH';
  lastThinkingReport: string;
}

export type ResourceKind = 'mcp' | 'skill';
export type McpTransport = 'stdio' | 'http';
export type ResourceRuntimeStatus = 'stopped' | 'starting' | 'running' | 'fault';

export interface ExposedToolName {
  original: string;
  exposed: string;
}

export interface PublicResourceEntry {
  id: string;
  kind: ResourceKind;
  displayName: string;
  enabled: boolean;
  source: 'scan' | 'manual';
  sourceLabel: string;
  readonly: boolean;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  envSecretKeys?: string[];
  httpUrl?: string;
  httpHeaderSecretKey?: string;
  skillDirDisplay?: string;
  skillDescription?: string;
  runtimeStatus?: ResourceRuntimeStatus;
  faultReason?: string;
  exposedToolNames?: ExposedToolName[];
  toolCount?: number;
}

export interface ResourceStatusSummary {
  enabledCount: number;
  mcp: Array<{
    id: string;
    displayName: string;
    status: ResourceRuntimeStatus;
    faultReason?: string;
    toolCount: number;
    readonly: boolean;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    available: boolean;
  }>;
}

export interface ResourceLibraryState {
  enabledCount: number;
  entries: PublicResourceEntry[];
  summary: ResourceStatusSummary;
}

export interface ResourceProbeResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
  faultReason?: string;
}

export interface ResourceScanOutcome {
  ok: boolean;
  discovered: number;
  added: string[];
  skipped: Array<{ path: string; reason: string }>;
  entries: PublicResourceEntry[];
  summary: ResourceStatusSummary;
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

export interface ShadowSnapshot {
  id: string;
  treeHash: string;
  timestamp: string;
  triggerReason: string;
  workspacePath: string;
  filesTouched: number;
  diffStat: string;
  rolledBack: boolean;
}

export type GitSnapshotItem = ShadowSnapshot;

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  decision: AuditDecision;
  actor: string;
  toolName: string;
  commandOrPath: string;
  mode: ConfinementMode;
  reason: string;
}

export interface DaemonTelemetry {
  connected: boolean;
  pid: number;
  memoryMb: number;
  createNoWindowActive: boolean;
  activeJobObjects: number;
  uptimeSeconds: number;
  lastWindowAction: string | null;
}

export interface PendingApprovalItem {
  id: string;
  toolName: string;
  targetHwnd?: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
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
  activeSettingsTab:
    | 'connectors'
    | 'daemon'
    | 'resources'
    | 'snapshots-audit'
    | 'permissions'
    | 'subagents';
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
  tunnel: TunnelDriverConfig;
  daemon: DaemonTelemetry;
  cliSubagents: CliSubagentItem[];
  acpConfig?: AcpConfig;
  acpProfiles?: AcpProfile[];
  builtinLoop: BuiltinLoopSubagentConfig;
  worktrees: WorktreeInstance[];
  snapshots: ShadowSnapshot[];
  auditLogs: AuditLogEntry[];
  liveTask: LiveTaskState;
  lastCopiedToast: string | null;
  lastInjectedChatText: string | null;
  chromeDark: boolean;
  language: SupportedLocale;
  resources: ResourceLibraryState;
}

export interface MwhWindowBridge {
  minimize: () => void;
  maximize: () => void;
  hideToTray: () => void;
  isDesktop?: boolean;
  getRuntimeToken?: () => string;
  getLanguage?: () => Promise<string> | string;
  onOpenSettings?: (callback: () => void) => () => void;
  onChromeTheme?: (callback: (payload: { dark?: boolean }) => void) => () => void;
  onChromeLanguage?: (callback: (payload: { lang?: string }) => void) => () => void;
}

declare global {
  interface Window {
    mwhWindow?: MwhWindowBridge;
  }
}

const LOCAL_UI_KEYS = ['settingsModalOpen', 'activeSettingsTab', 'chromeDark', 'language'] as const;

function emptyTask(): LiveTaskState {
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
    startedAt: '',
  };
}

function createInitialState(): MwhState {
  return {
    isDesktopRuntime: typeof window !== 'undefined' && Boolean(window.mwhWindow?.isDesktop),
    settingsModalOpen: false,
    activeSettingsTab: 'connectors',
    chromeDark: true,
    language: detectInitialLocale(),
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    autoDowngradeTwoHours: true,
    autoDowngradeRemainingSec: 7200,
    multiDeviceApproval: false,
    desktopHandsEnabled: false,
    desktopHandsForegroundFallback: false,
    pendingApprovals: [],
    workspaceRoots: [],
    alwaysAllowedWorkspaces: [],
    tunnel: {
      activeDriver: 'cloudflare-named',
      bearerToken: '',
      cfNamedDomain: '',
      cfNamedToken: '',
      cfQuickUrl: '',
      cfQuickRunning: false,
      tailscaleIp: '',
      tailscaleMagicDns: '',
      tailscaleFunnelEnabled: false,
      customPublicUrl: '',
      customTlsVerify: true,
    },
    daemon: {
      connected: false,
      pid: 0,
      memoryMb: 0,
      createNoWindowActive: true,
      activeJobObjects: 0,
      uptimeSeconds: 0,
      lastWindowAction: null,
    },
    cliSubagents: [],
    acpConfig: {
      acp_enabled: true,
      acp_default_profile: '',
      acp_profiles: [],
    },
    acpProfiles: [],
    builtinLoop: {
      enabled: true,
      maxIterations: 15,
      thinkingLevel: 'HIGH',
      lastThinkingReport: '',
    },
    worktrees: [],
    snapshots: [],
    auditLogs: [],
    resources: {
      enabledCount: 0,
      entries: [],
      summary: { enabledCount: 0, mcp: [], skills: [] },
    },
    liveTask: emptyTask(),
    lastCopiedToast: null,
    lastInjectedChatText: null,
  };
}

function isValidBearerToken(t: unknown): t is string {
  return typeof t === 'string' && t.trim().length >= 16 && t.trim() !== 'undefined' && t.trim() !== 'null';
}

function discoverBearerToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    const bridged = window.mwhWindow?.getRuntimeToken?.();
    if (isValidBearerToken(bridged)) return bridged.trim();
  } catch {
    // preload token is optional
  }
  try {
    const stored = sessionStorage.getItem('mwh_bearer_token');
    if (isValidBearerToken(stored)) return stored.trim();
    if (stored === 'undefined' || stored === 'null') {
      sessionStorage.removeItem('mwh_bearer_token');
    }
  } catch {
    return '';
  }
  return '';
}

export class MwhDaemonService {
  private state: MwhState;
  private listeners: Set<(state: MwhState) => void> = new Set();
  private authListeners: Set<(required: boolean) => void> = new Set();
  private authRequired = false;
  private pinnedToken: string | null = null;
  private sseAbort: AbortController | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.state = createInitialState();
    this.installWindowBridge();
    this.syncDocumentLang(this.state.language);
    this.installLanguageSync();
    try {
      localStorage.removeItem('mwh_theme_mode');
      localStorage.removeItem('mwh_accent_color');
      localStorage.removeItem('mwh_bearer_token');
    } catch {
      // storage may be blocked; muse.ai theme keys are left untouched
    }
    void this.bootstrap();
  }

  private t(key: string, params?: TranslationParams): string {
    return translate(this.state.language, key, params);
  }

  private syncDocumentLang(lang: SupportedLocale) {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = lang;
    }
  }

  private installLanguageSync() {
    if (typeof window === 'undefined') return;
    const bridge = window.mwhWindow;
    if (bridge?.getLanguage) {
      Promise.resolve(bridge.getLanguage())
        .then((lang) => {
          if (lang) this.setLanguage(lang);
        })
        .catch(() => {});
    }
    if (bridge?.onChromeLanguage) {
      bridge.onChromeLanguage((payload) => {
        if (payload?.lang) this.setLanguage(payload.lang);
      });
    }
    if (!bridge?.isDesktop) {
      window.addEventListener('languagechange', () => {
        this.setLanguage(detectInitialLocale());
      });
    }
  }

  public setLanguage(lang: string | SupportedLocale) {
    const normalized = normalizeLocale(lang);
    if (this.state.language === normalized) return;
    this.state = { ...this.state, language: normalized };
    this.syncDocumentLang(normalized);
    this.emit();
  }

  public getState(): MwhState {
    return this.state;
  }

  public subscribe(listener: (state: MwhState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public onAuthRequired(listener: (required: boolean) => void): () => void {
    this.authListeners.add(listener);
    listener(this.authRequired);
    return () => {
      this.authListeners.delete(listener);
    };
  }

  public async submitRuntimeToken(token: string): Promise<boolean> {
    const clean = token.trim();
    if (!clean) return false;
    this.pinnedToken = clean;
    try {
      sessionStorage.setItem('mwh_bearer_token', clean);
      localStorage.removeItem('mwh_bearer_token');
    } catch {
      // storage may be blocked; the in-memory token still authorizes this session
    }
    try {
      await fetch('/ui', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + clean },
        credentials: 'same-origin',
      });
    } catch {
      // Cookie exchange is best-effort; API calls still send the Bearer header.
    }
    const ok = await this.pullState();
    this.reconnectSse();
    return ok;
  }

  public recordWindowControlAction(actionLabel: string) {
    this.state = {
      ...this.state,
      daemon: { ...this.state.daemon, lastWindowAction: actionLabel },
    };
    this.showToast(actionLabel);
  }

  public setChromeDark(dark: boolean) {
    if (this.state.chromeDark === dark) return;
    this.state = { ...this.state, chromeDark: dark };
    this.emit();
  }

  public openSettingsModal(tab?: MwhState['activeSettingsTab']) {
    this.state = {
      ...this.state,
      settingsModalOpen: true,
      activeSettingsTab: tab ?? this.state.activeSettingsTab,
    };
    this.emit();
  }

  public openSettings(tab?: MwhState['activeSettingsTab']) {
    this.openSettingsModal(tab);
  }

  public closeSettingsModal() {
    this.state = { ...this.state, settingsModalOpen: false };
    this.emit();
  }

  public setActiveSettingsTab(tab: MwhState['activeSettingsTab']) {
    let resolved = tab;
    if (tab === 'permissions') resolved = 'connectors';
    if (tab === 'subagents') resolved = 'daemon';
    this.state = { ...this.state, activeSettingsTab: resolved };
    this.emit();
  }

  public setConfinementMode(mode: ConfinementMode) {
    const defaultPolicy: ApprovalPolicy =
      mode === 'danger-full-access'
        ? 'unattended-yolo'
        : 'smart-risk';
    const profile = resolvePermissionProfile(mode, defaultPolicy);
    this.state = {
      ...this.state,
      confinementMode: mode,
      approvalPolicy: defaultPolicy,
      worktrees: this.state.worktrees.map((wt) => ({
        ...wt,
        childMode: clampChildMode(wt.childMode, mode),
      })),
    };
    this.showToast(
      this.t('service.switchedMode', {
        label: getPermissionProfileMeta(mode, defaultPolicy, this.state.language).shortLabel,
      })
    );
    void this.request('POST', '/api/v1/security/mode', {
      profile,
      mode,
      approvalPolicy: defaultPolicy,
      source: 'ui_island',
    });
  }

  public setPermissionProfile(profile: PermissionProfileId) {
    const meta = PERMISSION_PROFILE_MAP[profile];
    this.state = {
      ...this.state,
      confinementMode: meta.confinementMode,
      approvalPolicy: meta.approvalPolicy,
      worktrees: this.state.worktrees.map((wt) => ({
        ...wt,
        childMode: clampChildMode(wt.childMode, meta.confinementMode),
      })),
    };
    this.showToast(
      this.t('service.switchedMode', {
        label: getPermissionProfileMeta(meta.confinementMode, meta.approvalPolicy, this.state.language).shortLabel,
      })
    );
    void this.request('POST', '/api/v1/security/mode', {
      profile,
      mode: meta.confinementMode,
      approvalPolicy: meta.approvalPolicy,
      source: 'ui_island',
    });
  }

  public setApprovalPolicy(approvalPolicy: ApprovalPolicy) {
    this.state = { ...this.state, approvalPolicy };
    this.emit();
    void this.request('POST', '/api/v1/security/policy', { approvalPolicy, source: 'ui_island' });
  }

  public toggleMultiDeviceApproval() {
    const enabled = !this.state.multiDeviceApproval;
    this.state = { ...this.state, multiDeviceApproval: enabled };
    this.emit();
    void this.request('POST', '/api/v1/security/multi-device-approval', { enabled, source: 'ui_island' });
  }

  public toggleDesktopHands() {
    const enabled = !this.state.desktopHandsEnabled;
    this.state = { ...this.state, desktopHandsEnabled: enabled };
    this.emit();
    void this.request('POST', '/api/v1/security/desktop-hands', {
      enabled,
      foregroundFallback: this.state.desktopHandsForegroundFallback,
      source: 'ui_island'
    });
  }

  public toggleDesktopHandsForegroundFallback() {
    const foregroundFallback = !this.state.desktopHandsForegroundFallback;
    this.state = { ...this.state, desktopHandsForegroundFallback: foregroundFallback };
    this.emit();
    void this.request('POST', '/api/v1/security/desktop-hands', {
      enabled: this.state.desktopHandsEnabled,
      foregroundFallback,
      source: 'ui_island'
    });
  }

  public toggleAutoDowngradeTwoHours() {
    const enabled = !this.state.autoDowngradeTwoHours;
    this.state = {
      ...this.state,
      autoDowngradeTwoHours: enabled,
      autoDowngradeRemainingSec: enabled ? 7200 : 0,
    };
    this.emit();
    void this.request('POST', '/api/v1/security/auto-downgrade', { enabled, source: 'ui_island' });
  }

  public setTunnelDriver(driver: TunnelDriverType) {
    this.state = {
      ...this.state,
      tunnel: { ...this.state.tunnel, activeDriver: driver },
    };
    this.emit();
    void this.request('POST', '/api/v1/tunnel/driver', { driver, source: 'ui_island' });
  }

  public updateTunnelFields(partial: Partial<TunnelDriverConfig>) {
    this.state = {
      ...this.state,
      tunnel: { ...this.state.tunnel, ...partial },
    };
    this.emit();
    void this.request('POST', '/api/v1/tunnel/driver', {
      driver: this.state.tunnel.activeDriver,
      config: partial,
      source: 'ui_island',
    });
  }

  public rotateBearerToken() {
    void this.request('POST', '/api/v1/tunnel/rotate-token', {}).then((data) => {
      const next = typeof data?.bearerToken === 'string' ? data.bearerToken : '';
      if (!next) return;
      this.pinnedToken = next;
      try {
        sessionStorage.setItem('mwh_bearer_token', next);
        localStorage.removeItem('mwh_bearer_token');
      } catch {
        // in-memory token still drives the rebuilt SSE stream
      }
      this.state = {
        ...this.state,
        tunnel: { ...this.state.tunnel, bearerToken: next },
      };
      this.reconnectSse();
      this.showToast(this.t('service.tokenRotated'));
    });
  }

  public spawnQuickTunnelUrl() {
    void this.request('POST', '/api/v1/tunnel/driver', {
      driver: 'cloudflare-quick',
      config: { spawnReal: true },
    }).then((data) => {
      const url = data?.tunnel?.cfQuickUrl || this.state.tunnel.cfQuickUrl;
      this.state = {
        ...this.state,
        tunnel: {
          ...this.state.tunnel,
          ...(data?.tunnel || {}),
          activeDriver: 'cloudflare-quick',
          bearerToken: this.currentToken() || this.state.tunnel.bearerToken,
          cfQuickRunning: true,
        },
      };
      this.showToast(
        url
          ? this.t('service.quickTunnelStarted', { url })
          : this.t('service.quickTunnelRequested')
      );
    });
  }

  public getActivePublicBaseUrl(): string {
    const { tunnel } = this.state;
    const localOnly = this.t('connectors.localOnly');
    switch (tunnel.activeDriver) {
      case 'cloudflare-named':
        return tunnel.cfNamedDomain || localOnly;
      case 'cloudflare-quick':
        return tunnel.cfQuickUrl || localOnly;
      case 'tailscale-funnel':
        return tunnel.tailscaleFunnelEnabled
          ? tunnel.tailscaleMagicDns || localOnly
          : tunnel.tailscaleIp
            ? `http://${tunnel.tailscaleIp}:19820`
            : localOnly;
      case 'custom-tls':
        return tunnel.customPublicUrl || localOnly;
    }
  }

  public getPairingArtifacts() {
    const activeUrl = this.getActivePublicBaseUrl();
    const baseForArtifact =
      activeUrl.startsWith('http://') || activeUrl.startsWith('https://')
        ? activeUrl
        : 'http://127.0.0.1:19820';
    return generatePairingArtifacts(
      baseForArtifact,
      this.state.confinementMode,
      this.state.workspaceRoots,
      this.state.approvalPolicy,
      this.currentToken(),
      this.state.language
    );
  }

  public getRealToken(): string {
    return this.currentToken();
  }

  public copyTextWithToast(text: string, label: string, alsoInjectToPreviewChat = false) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    if (alsoInjectToPreviewChat) {
      this.state = { ...this.state, lastInjectedChatText: text };
    }
    this.showToast(label);
  }

  public addWorkspaceRoot(pathStr: string) {
    const clean = pathStr.trim();
    if (!clean) return;
    if (this.state.workspaceRoots.includes(clean)) {
      this.showToast(this.t('service.workspaceExists'));
      return;
    }
    this.state = { ...this.state, workspaceRoots: [...this.state.workspaceRoots, clean] };
    this.showToast(this.t('service.workspaceAdded', { path: clean }));
    void this.request('POST', '/api/v1/workspaces/add', { path: clean });
  }

  public removeWorkspaceRoot(pathStr: string) {
    this.state = {
      ...this.state,
      workspaceRoots: this.state.workspaceRoots.filter((item) => item !== pathStr),
    };
    this.showToast(this.t('service.workspaceRemoved', { path: pathStr }));
    void this.request('POST', '/api/v1/workspaces/remove', { path: pathStr });
  }

  public async saveAcpProfile(profile: Partial<AcpProfile> & { id: string; command: string }): Promise<boolean> {
    const res = await this.request('POST', '/api/v1/acp/profile', profile);
    if (res && res.ok) {
      if (res.acpProfiles) {
        this.applyServerPatch({ acpProfiles: res.acpProfiles, acpConfig: res.acpConfig });
      }
      this.showToast(this.t('service.acpSaved', { id: profile.id }));
      return true;
    }
    this.showToast(res?.error || this.t('service.acpSaveFail'));
    return false;
  }

  public async deleteAcpProfile(id: string): Promise<boolean> {
    const res = await this.request('DELETE', '/api/v1/acp/profile', { id });
    if (res && res.ok) {
      if (res.acpProfiles) {
        this.applyServerPatch({ acpProfiles: res.acpProfiles, acpConfig: res.acpConfig });
      }
      this.showToast(this.t('service.acpDeleted', { id }));
      return true;
    }
    this.showToast(res?.error || this.t('service.deleteFail'));
    return false;
  }

  public async toggleAcpProfile(id: string, enabled?: boolean): Promise<boolean> {
    const res = await this.request('POST', '/api/v1/acp/toggle', { id, enabled });
    if (res && res.ok) {
      if (res.acpProfiles) {
        this.applyServerPatch({ acpProfiles: res.acpProfiles, acpConfig: res.acpConfig });
      }
      return true;
    }
    this.showToast(res?.error || this.t('service.toggleFail'));
    return false;
  }

  public async probeAcpCommand(command: string): Promise<{ available: boolean; path?: string; error?: string }> {
    const res = await this.request('POST', '/api/v1/acp/probe', { command });
    if (res && res.ok) {
      return { available: res.available, path: res.path, error: res.error };
    }
    return { available: false, error: res?.error || this.t('service.probeFail') };
  }

  public async fetchResources(): Promise<{ entries: PublicResourceEntry[]; summary: ResourceStatusSummary } | null> {
    const res = await this.request('GET', '/api/v1/resources');
    if (res && res.ok) {
      if (res.entries) {
        this.applyServerPatch({
          resources: {
            enabledCount: res.summary?.enabledCount ?? res.entries.filter((e: any) => e.enabled).length,
            entries: res.entries,
            summary: res.summary || { enabledCount: 0, mcp: [], skills: [] },
          },
        });
      }
      return { entries: res.entries, summary: res.summary };
    }
    return null;
  }

  public async addResource(
    entry: Partial<PublicResourceEntry> & {
      id?: string;
      displayName: string;
      kind: ResourceKind;
      /* 后端 AddResourceInput 的真实字段名，与 PublicResourceEntry 的展示字段不同 */
      enable?: boolean;
      skillDir?: string;
    }
  ): Promise<boolean> {
    const res = await this.request('POST', '/api/v1/resources', entry);
    if (res && res.ok) {
      if (res.entries) {
        this.applyServerPatch({
          resources: {
            enabledCount: res.summary?.enabledCount ?? res.entries.filter((e: any) => e.enabled).length,
            entries: res.entries,
            summary: res.summary,
          },
        });
      }
      this.showToast(this.t('service.resourceAdded', { name: entry.displayName || res.id }));
      return true;
    }
    this.showToast(res?.error || this.t('service.resourceAddFail'));
    return false;
  }

  public async scanResources(): Promise<ResourceScanOutcome | null> {
    const res = await this.request('POST', '/api/v1/resources/scan');
    if (res && res.ok) {
      if (res.entries) {
        this.applyServerPatch({
          resources: {
            enabledCount: res.summary?.enabledCount ?? res.entries.filter((e: any) => e.enabled).length,
            entries: res.entries,
            summary: res.summary,
          },
        });
      }
      const addedCount = Array.isArray(res.added) ? res.added.length : 0;
      this.showToast(this.t('service.resourceScanned', { discovered: res.discovered || 0, added: addedCount }));
      return res;
    }
    this.showToast(res?.error || this.t('service.resourceScanFail'));
    return null;
  }

  public async toggleResource(id: string, enabled: boolean): Promise<boolean> {
    const res = await this.request('POST', '/api/v1/resources/toggle', { id, enabled });
    if (res && res.ok) {
      if (res.entries) {
        this.applyServerPatch({
          resources: {
            enabledCount: res.summary?.enabledCount ?? res.entries.filter((e: any) => e.enabled).length,
            entries: res.entries,
            summary: res.summary,
          },
        });
      }
      return true;
    }
    this.showToast(res?.error || this.t('service.resourceToggleFail'));
    return false;
  }

  public async probeResource(params: Record<string, unknown>): Promise<ResourceProbeResult> {
    const res = await this.request('POST', '/api/v1/resources/probe', params);
    if (res && res.ok) {
      return { ok: true, tools: res.tools, error: res.error, faultReason: res.faultReason };
    }
    return {
      ok: false,
      tools: res?.tools,
      error: res?.error || res?.faultReason || this.t('service.probeFail'),
      faultReason: res?.faultReason,
    };
  }

  public async updateResource(
    id: string,
    patch: Partial<PublicResourceEntry> & { skillDir?: string }
  ): Promise<boolean> {
    const res = await this.request('POST', '/api/v1/resources/update', { id, ...patch });
    if (res && res.ok) {
      if (res.entries) {
        this.applyServerPatch({
          resources: {
            enabledCount: res.summary?.enabledCount ?? res.entries.filter((e: any) => e.enabled).length,
            entries: res.entries,
            summary: res.summary,
          },
        });
      }
      this.showToast(this.t('service.resourceUpdated'));
      return true;
    }
    this.showToast(res?.error || this.t('service.resourceUpdateFail'));
    return false;
  }

  public async deleteResource(id: string): Promise<boolean> {
    const res = await this.request('DELETE', '/api/v1/resources', { id });
    if (res && res.ok) {
      if (res.entries) {
        this.applyServerPatch({
          resources: {
            enabledCount: res.summary?.enabledCount ?? res.entries.filter((e: any) => e.enabled).length,
            entries: res.entries,
            summary: res.summary,
          },
        });
      }
      this.showToast(this.t('service.resourceDeleted', { id }));
      return true;
    }
    this.showToast(res?.error || this.t('service.deleteFail'));
    return false;
  }

  public emergencyKillAllJobObjects() {
    this.state = {
      ...this.state,
      daemon: { ...this.state.daemon, activeJobObjects: 0 },
      worktrees: this.state.worktrees.map((wt) =>
        wt.status === 'RUNNING' ? { ...wt, status: 'STOPPED' as const } : wt
      ),
      liveTask: { ...this.state.liveTask, status: 'IDLE' },
    };
    this.showToast(this.t('service.emergencyStopToast'));
    void this.request('POST', '/api/v1/daemon/emergency-kill', {});
  }

  public spawnIsolatedWorktree(agentId: string, requestedMode: ConfinementMode) {
    void this.request('POST', '/api/v1/worktrees/spawn', { agentId, requestedMode }).then((data) => {
      if (data?.worktree) {
        this.applyServerPatch({ worktrees: [data.worktree, ...this.state.worktrees.filter((wt) => wt.id !== data.worktree.id)] });
      }
      const mode = data?.effectiveMode || requestedMode;
      this.showToast(this.t('service.worktreeCreated', { agentId, mode }));
    });
  }

  public mergeWorktree(worktreeId: string) {
    void this.request('POST', `/api/v1/worktrees/${encodeURIComponent(worktreeId)}/merge`, {}).then((data) => {
      if (data && (data.error === 'WORKTREE_NOT_FOUND' || data.error === 'WORKTREE_DIR_MISSING')) {
        this.state = {
          ...this.state,
          worktrees: this.state.worktrees.map((wt) =>
            wt.id === worktreeId ? { ...wt, status: 'MISSING' } : wt
          ),
        };
        this.emit();
        this.showToast(this.t('service.worktreeMissing', { id: worktreeId, error: data.error }));
        return;
      }
      if (data && data.ok !== false && !data.error) {
        // 如实映射服务端合并状态机：只有真正执行并成功 git merge 才标 MERGED；
        // 无差异（已是最新）与目录缺失都不谎报为已合并。
        const finalStatus: WorktreeInstance['status'] =
          data.status === 'UP_TO_DATE' || data.status === 'MISSING' ? data.status : 'MERGED';
        this.state = {
          ...this.state,
          worktrees: this.state.worktrees.map((wt) =>
            wt.id === worktreeId ? { ...wt, status: finalStatus } : wt
          ),
        };
        const statusNote =
          finalStatus === 'UP_TO_DATE'
            ? this.t('service.worktreeNoDiff')
            : finalStatus === 'MISSING'
              ? this.t('service.worktreeMissingNote')
              : '';
        this.showToast(this.t('service.worktreeMerged', { id: worktreeId, note: statusNote }));
      }
    });
  }

  public removeWorktree(worktreeId: string) {
    this.state = {
      ...this.state,
      worktrees: this.state.worktrees.filter((wt) => wt.id !== worktreeId),
    };
    this.showToast(this.t('service.worktreeCleaned', { id: worktreeId }));
    void this.request('DELETE', `/api/v1/worktrees/${encodeURIComponent(worktreeId)}`);
  }

  public rollbackSnapshot(snapshotId: string) {
    void this.request('POST', `/api/v1/snapshots/${encodeURIComponent(snapshotId)}/rollback`, {}).then((data) => {
      if (data && data.ok !== false && !data.error) {
        this.state = {
          ...this.state,
          snapshots: this.state.snapshots.map((snap) =>
            snap.id === snapshotId ? { ...snap, rolledBack: true } : snap
          ),
        };
        this.showToast(this.t('service.rollbackRequested', { id: snapshotId }));
      }
    });
  }

  public deleteSnapshots(snapshotIds: string[]) {
    if (!Array.isArray(snapshotIds) || snapshotIds.length === 0) return;
    const removeSet = new Set(snapshotIds);
    this.state = {
      ...this.state,
      snapshots: this.state.snapshots.filter((s) => !removeSet.has(s.id)),
    };
    this.emit();
    void this.request('POST', '/api/v1/snapshots/delete', { ids: snapshotIds }).then((data) => {
      if (Array.isArray(data?.snapshots)) {
        this.applyServerPatch({ snapshots: data.snapshots });
      }
      this.showToast(this.t('service.snapshotsDeleted', { count: snapshotIds.length }));
    });
  }

  public pruneSnapshots(keepRecent = 5) {
    void this.request('POST', '/api/v1/snapshots/prune', { keepRecent }).then((data) => {
      if (Array.isArray(data?.snapshots)) {
        this.applyServerPatch({ snapshots: data.snapshots });
      }
      const count = Array.isArray(data?.deletedIds) ? data.deletedIds.length : 0;
      this.showToast(
        count > 0
          ? this.t('service.snapshotsPruned', { count, keep: keepRecent })
          : this.t('service.snapshotsWithinLimit', { keep: keepRecent })
      );
    });
  }

  public approveLiveTaskOnce() {
    if (this.state.liveTask.status !== 'WAITING_APPROVAL' || !this.state.liveTask.id) return;
    void this.request('POST', `/api/v1/tasks/${encodeURIComponent(this.state.liveTask.id)}/approve`, {
      scope: 'once',
      source: 'ui_island',
    });
  }

  public approveLiveTaskAppSession() {
    if (this.state.liveTask.status !== 'WAITING_APPROVAL' || !this.state.liveTask.id) return;
    void this.request('POST', `/api/v1/tasks/${encodeURIComponent(this.state.liveTask.id)}/approve`, {
      scope: 'session',
      source: 'ui_island',
    });
  }

  public approveLiveTaskWorkspaceAlways() {
    if (this.state.liveTask.status !== 'WAITING_APPROVAL' || !this.state.liveTask.id) return;
    void this.request('POST', `/api/v1/tasks/${encodeURIComponent(this.state.liveTask.id)}/approve`, {
      scope: 'workspace',
      root: this.state.liveTask.targetPath,
      source: 'ui_island',
    });
  }

  public rejectLiveTask() {
    if (!this.state.liveTask.id) return;
    void this.request('POST', `/api/v1/tasks/${encodeURIComponent(this.state.liveTask.id)}/reject`, {
      source: 'ui_island',
    }).then(() => {
      this.showToast(this.t('service.taskRejected'));
    });
  }

  public killRunningLiveTask() {
    const id = this.state.liveTask.id || 'current';
    void this.request('POST', `/api/v1/tasks/${encodeURIComponent(id)}/kill`, {
      source: 'ui_island',
    }).then((res) => {
      if (!res || res.ok === false || res.failSafeReset) {
        if (this.state.liveTask.status === 'RUNNING') {
          this.state = {
            ...this.state,
            liveTask: { ...this.state.liveTask, status: 'IDLE', stepLabel: '无活跃任务 · 已复位' },
          };
          this.emit();
        }
        void this.pullState();
      }
      this.showToast(this.t('service.taskKilled'));
    });
  }

  public dismissCompletedLiveTask() {
    this.state = { ...this.state, liveTask: { ...this.state.liveTask, status: 'IDLE' } };
    this.emit();
  }

  private currentToken(): string {
    const candidate = this.pinnedToken || discoverBearerToken();
    return isValidBearerToken(candidate) ? candidate.trim() : '';
  }

  private async bootstrap() {
    try {
      const tokenRes = await fetch('/api/v1/tunnel/token', { method: 'GET' });
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json().catch(() => ({}));
        if (typeof tokenData?.bearerToken === 'string' && tokenData.bearerToken) {
          this.pinnedToken = tokenData.bearerToken;
          try {
            sessionStorage.setItem('mwh_bearer_token', tokenData.bearerToken);
            localStorage.removeItem('mwh_bearer_token');
          } catch {
            // storage optional
          }
          this.state = {
            ...this.state,
            tunnel: { ...this.state.tunnel, bearerToken: tokenData.bearerToken },
          };
        }
      }
    } catch {
      // Loopback fetch may fail in non-local environments; fallback to existing discovery
    }
    await this.pullState();
    this.connectSse();
  }

  private async pullState(): Promise<boolean> {
    const data = await this.request('GET', '/api/v1/state');
    if (!data || typeof data.confinementMode !== 'string') return false;
    this.applyServerPatch(data as Partial<MwhState>);
    return true;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any | null> {
    const token = this.currentToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) {
        this.setAuthRequired(true);
        return null;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data?.error) this.showToast(String(data.error));
        return data;
      }
      this.setAuthRequired(false);
      return data;
    } catch {
      this.state = {
        ...this.state,
        daemon: { ...this.state.daemon, connected: false },
      };
      this.emit();
      return null;
    }
  }

  private connectSse() {
    this.stopSse();
    const controller = new AbortController();
    this.sseAbort = controller;
    void this.pumpSse(controller);
  }

  private reconnectSse() {
    this.connectSse();
  }

  private stopSse() {
    this.sseAbort?.abort();
    this.sseAbort = null;
  }

  private async pumpSse(controller: AbortController) {
    // SSE 重连纪律：
    // - 401/403：停止重连，仅触发 onAuthRequired 通知（避免 401 无限重连自锁 IP 15 分钟）。
    // - 5xx / 网络异常：指数退避 1.5s 起步逐次翻倍、30s 封顶（实际档位 1.5→3→6→12→24→30→30…），
    //   连续失败第 8 次不再等待、直接停止并 console.warn。
    // - Token 为空：不发起连接，等待 submitRuntimeToken 成功后的 reconnectSse 再启动。
    const MAX_CONSECUTIVE_FAILURES = 8;
    let consecutiveFailures = 0;
    let backoffMs = 1500;
    while (!controller.signal.aborted) {
      const token = this.currentToken();
      if (!token) return;
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const response = await fetch('/api/v1/events', { headers, signal: controller.signal });
        if (response.status === 401 || response.status === 403) {
          this.setAuthRequired(true);
          this.state = {
            ...this.state,
            daemon: { ...this.state.daemon, connected: false },
          };
          this.emit();
          return;
        }
        if (!response.ok || !response.body) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.warn(
              `[mwhService] SSE reconnect stopped after ${consecutiveFailures} consecutive failures`,
            );
            return;
          }
          await this.delay(backoffMs, controller.signal);
          backoffMs = Math.min(backoffMs * 2, 30000);
          continue;
        }
        consecutiveFailures = 0;
        backoffMs = 1500;
        this.setAuthRequired(false);
        this.state = {
          ...this.state,
          daemon: { ...this.state.daemon, connected: true },
        };
        this.emit();
        await this.readSse(response.body, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
      }
      if (controller.signal.aborted) return;
      this.state = {
        ...this.state,
        daemon: { ...this.state.daemon, connected: false },
      };
      this.emit();
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `[mwhService] SSE reconnect stopped after ${consecutiveFailures} consecutive failures`,
        );
        return;
      }
      await this.delay(backoffMs, controller.signal);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }

  private async readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let splitAt = buffer.indexOf('\n\n');
      while (splitAt >= 0) {
        this.consumeFrame(buffer.slice(0, splitAt));
        buffer = buffer.slice(splitAt + 2);
        splitAt = buffer.indexOf('\n\n');
      }
    }
  }

  private consumeFrame(frame: string) {
    const payloadText = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!payloadText) return;
    try {
      const payload = JSON.parse(payloadText);
      if (payload && typeof payload === 'object') {
        this.applyServerPatch(payload as Partial<MwhState>);
      }
    } catch {
      // ignore malformed or heartbeat frames
    }
  }

  private applyServerPatch(patch: Partial<MwhState>) {
    const next: MwhState = { ...this.state };
    (Object.keys(patch) as (keyof MwhState)[]).forEach((key) => {
      const value = patch[key];
      if (value === undefined) return;
      const previous = next[key];
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        previous &&
        typeof previous === 'object' &&
        !Array.isArray(previous)
      ) {
        (next as unknown as Record<string, unknown>)[key] = { ...(previous as object), ...(value as object) };
      } else {
        (next as unknown as Record<string, unknown>)[key] = value;
      }
    });
    for (const key of LOCAL_UI_KEYS) {
      (next as unknown as Record<string, unknown>)[key] = this.state[key];
    }
    next.isDesktopRuntime = Boolean(window.mwhWindow?.isDesktop);
    const knownToken = this.currentToken();
    if (knownToken && next.tunnel.bearerToken.includes('****')) {
      next.tunnel = { ...next.tunnel, bearerToken: knownToken };
    }
    this.state = next;
    this.emit();
  }

  private setAuthRequired(required: boolean) {
    this.authRequired = required;
    this.authListeners.forEach((listener) => listener(required));
  }

  private emit() {
    const snapshot = this.state;
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private showToast(message: string) {
    this.state = { ...this.state, lastCopiedToast: message };
    this.emit();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.state.lastCopiedToast === message) {
        this.state = { ...this.state, lastCopiedToast: null };
        this.emit();
      }
    }, 3000);
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

  private installWindowBridge() {
    if (typeof window === 'undefined') return;
    const existing = window.mwhWindow;
    // contextBridge bridges are read-only and non-configurable: assigning over
    // one throws a TypeError at module init and kills the whole bundle (the
    // desktop shell rendered a pure black window because of this). Install the
    // browser-only fallback exclusively when no real desktop bridge exists.
    if (existing) return;
    window.mwhWindow = {
      isDesktop: false,
      minimize: () => {
        this.recordWindowControlAction(this.t('service.winMinimized'));
      },
      maximize: () => {
        this.recordWindowControlAction(this.t('service.winMaximized'));
      },
      hideToTray: () => {
        this.recordWindowControlAction(this.t('service.winHidden'));
      },
    };
  }
}

export const mwhService = new MwhDaemonService();

/**
 * Core type definitions for Muse-Win-Harness (MWH) Kernel
 */

export type ConfinementMode =
  | 'read-only'
  | 'workspace-write'
  | 'workspace-acl-experimental'
  | 'danger-full-access';

export const VALID_CONFINEMENT_MODES: readonly ConfinementMode[] = [
  'read-only',
  'workspace-write',
  'workspace-acl-experimental',
  'danger-full-access'
];

export const MODE_RANK: Record<ConfinementMode, number> = {
  'read-only': 1,
  'workspace-write': 2,
  'workspace-acl-experimental': 3,
  'danger-full-access': 4
};

export type ApprovalPolicy =
  | 'always-ask'
  | 'smart-risk'
  | 'auto-workspace'
  | 'unattended-yolo';

export type PermissionProfileId =
  | 'plan'
  | 'confirm'
  | 'autonomous'
  | 'full-access';

export const VALID_PERMISSION_PROFILES: readonly PermissionProfileId[] = [
  'plan',
  'confirm',
  'autonomous',
  'full-access'
];

export function resolvePermissionProfile(
  mode: ConfinementMode,
  policy: ApprovalPolicy
): PermissionProfileId {
  if (mode === 'read-only') return 'plan';
  if (mode === 'danger-full-access') return 'full-access';
  if (policy === 'auto-workspace' || policy === 'unattended-yolo') {
    return 'autonomous';
  }
  return 'confirm';
}

export function profileToConfinementAndPolicy(
  profile: PermissionProfileId
): { confinementMode: ConfinementMode; approvalPolicy: ApprovalPolicy } {
  switch (profile) {
    case 'plan':
      return { confinementMode: 'read-only', approvalPolicy: 'smart-risk' };
    case 'confirm':
      return { confinementMode: 'workspace-write', approvalPolicy: 'smart-risk' };
    case 'autonomous':
      return { confinementMode: 'workspace-write', approvalPolicy: 'auto-workspace' };
    case 'full-access':
      return { confinementMode: 'danger-full-access', approvalPolicy: 'unattended-yolo' };
  }
}

export type ApprovalGranularity = 'once' | 'session' | 'workspace';

export type ToolMetaCategory = 'read' | 'write' | 'sensitive_write';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Default wall-clock budget for a single subagent run (10 minutes, aligned with exec_command). */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 600000;
/** Default autonomous ReAct step ceiling for a builtin subagent. */
export const DEFAULT_SUBAGENT_MAX_STEPS = 15;

export interface ExecutionContext {
  id: string;
  confinementMode: ConfinementMode;
  approvalPolicy: ApprovalPolicy;
  workspaceRoot: string;
  workspaceRoots?: string[];
  yoloExpiresAt?: number;
  sessionApprovedActions?: Set<string>;
  workspaceApprovedActions?: Set<string>;
  hmacSecret?: string;
  tunnelUrl?: string;
  desktopHandsEnabled?: boolean;
  desktopHandsForegroundFallback?: boolean;
  /**
   * When true, non-HMAC approvals (medium everyday writes and high-risk
   * tools such as subagent dispatch) execute once Muse's official HITL
   * card has already run on the client. Critical / HMAC-gated actions
   * still pause on the local island. Defaults to false (original island).
   */
  multiDeviceApproval?: boolean;
  /** Per-dispatch subagent wall-clock budget inherited by child dispatches. */
  subagentTimeoutMs?: number;
  /** Per-dispatch ReAct step ceiling inherited by child dispatches. */
  subagentMaxSteps?: number;
}

export interface PipelineRequest {
  id: string;
  toolName: string;
  category: ToolMetaCategory;
  params: Record<string, any>;
  context?: Partial<ExecutionContext>;
  approvalId?: string;
  approvalSig?: string;
}

export interface PipelineResponse {
  status: 'SUCCESS' | 'CONFIRMATION_REQUIRED' | 'DENIED' | 'ERROR';
  data?: any;
  error?: string;
  reason?: string;
  approvalId?: string;
  approvalUrl?: string;
  riskLevel?: RiskLevel;
  requiresMobileHmac?: boolean;
  summary?: string;
  securityBoundary?: string;
  tags?: string[];
}

export interface ApprovalRecord {
  id: string;
  requestId: string;
  toolName: string;
  category: ToolMetaCategory;
  params: Record<string, any>;
  riskLevel: RiskLevel;
  summary: string;
  requiresMobileHmac: boolean;
  hmacSig: string;
  paramsHash: string;
  createdAt: number;
  expiresAt: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED';
  approvedBy?: 'hmac' | 'job_control' | 'yolo';
  granularity?: ApprovalGranularity;
  jobId?: string;
  executionStatus?: 'SUCCESS' | 'DENIED' | 'ERROR';
  checkpointId?: string;
  completedAt?: number;
  resultSummary?: string;
}

export interface ApprovalStatusReceipt {
  id: string;
  approvalId: string;
  requestId: string;
  toolName: string;
  category: ToolMetaCategory;
  riskLevel: RiskLevel;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED';
  granularity?: ApprovalGranularity;
  jobId: string | null;
  executionStatus?: 'SUCCESS' | 'DENIED' | 'ERROR';
  checkpointId?: string;
  resultSummary?: string;
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
}

/**
 * P2-R2: 'UNKNOWN' is reported by job poll when the in-memory record has been
 * evicted and only the on-disk log remains — the real terminal status of the
 * job is no longer known, so it must not be disguised as 'COMPLETED'.
 */
export type JobStatus = 'RUNNING' | 'RUNNING_ASYNC' | 'COMPLETED' | 'TERMINATED' | 'FAILED' | 'UNKNOWN';

export interface JobRecord {
  id: string;
  command: string;
  pid?: number;
  status: JobStatus;
  startTime: number;
  endTime?: number;
  exitCode: number | null;
  logFile: string;
}

export interface JobPollResult {
  jobId: string;
  status: JobStatus;
  exitCode: number | null;
  page: number;
  totalPages: number;
  totalBytes: number;
  chunk: string;
  /** Incremental event cursor fields (populated for subagent-aware jobs). */
  nextSeq?: number;
  latestSeq?: number;
  droppedEvents?: number;
  events?: SubagentEvent[];
  diagnostic?: string;
  /** Whether the backing process id is still alive. */
  pidAlive?: boolean;
  /** Present when the job was created by a subagent dispatch. */
  subagentSummary?: SubagentSummary;
  /** Live (or final) working-tree changes produced by the job. */
  filesModified?: string[];
  gitDiffStat?: string;
}

/** Incremental event stream kinds emitted by a subagent run. */
export type SubagentEventKind =
  | 'status'
  | 'message_chunk'
  | 'tool_call'
  | 'permission'
  | 'heartbeat'
  | 'diagnostic'
  | 'completed'
  | 'error';

export interface SubagentEvent {
  seq: number;
  timestamp: number;
  kind: SubagentEventKind;
  stream?: 'stdout' | 'stderr';
  text: string;
  meta?: Record<string, any>;
}

export interface SubagentEventsResult {
  jobId: string;
  runId: string;
  agentType: string;
  status: JobStatus;
  pid?: number;
  pidAlive: boolean;
  exitCode: number | null;
  events: SubagentEvent[];
  afterSeq: number;
  nextSeq: number;
  latestSeq: number;
  droppedEvents: number;
  timedOut: boolean;
  output: string;
  diagnostic?: string;
  subagentSummary?: SubagentSummary;
  /** Live (or final) working-tree changes produced by the run. */
  filesModified?: string[];
  gitDiffStat?: string;
  childMode?: ConfinementMode;
  effectivePolicy?: ApprovalPolicy;
  isolateWorktree?: boolean;
  worktreePath?: string;
  checkpointId?: string;
  effectiveCwd?: string;
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
  /** Env var names forwarded to the ACP child process. */
  envAllowlist?: string[];
  /** How permission requests from the ACP child are handled. */
  permissionPolicy?: 'allow' | 'reject' | 'auto';
  /** Grace period after EOF before a hard dispose. */
  disposeEofGraceMs?: number;
  /** Grace period granted for a graceful dispose. */
  disposeGraceMs?: number;
}

export interface AcpConfig {
  acp_enabled: boolean;
  acp_default_profile?: string;
  acp_profiles: AcpProfile[];
}

export type SubagentType = 'builtin' | 'acp' | (string & {});

/** Operations supported by the subagent_dispatch tool. */
export type SubagentAction =
  | 'run'
  | 'resume'
  | 'events'
  | 'wait'
  | 'steer'
  | 'send'
  | 'interrupt'
  | 'cancel'
  | 'list'
  | 'profiles';

/** Honest delivery state for mid-run steer writes (pipe write != upstream execution). */
export interface SteerDeliveryReceipt {
  accepted: boolean;
  deliveryState:
    | 'dispatched_to_idle_session'
    | 'queued_behind_active_turn'
    | 'stdin_written'
    | 'rejected';
  acknowledged: boolean;
  rpcId?: number;
  pendingTurns?: number;
  reason?: string;
}

export interface SubagentStep {
  tool: string;
  params: Record<string, any>;
}

export interface SubagentDispatchRequest {
  /** Subagent action; defaults to 'run' when omitted. */
  action?: SubagentAction;
  agent?: SubagentType | (string & {});
  prompt?: string;
  childMode?: ConfinementMode;
  /**
   * P3: optional approval policy the child requests. The effective policy is
   * the STRICTER of the parent policy and this request (a looser request is
   * ignored) — see SubagentDispatcher.stricterApprovalPolicy.
   */
  approvalPolicy?: ApprovalPolicy;
  isolateWorktree?: boolean;
  maxSteps?: number;
  timeoutMs?: number;
  steps?: SubagentStep[];
  cwd?: string;
  /** Explicit ACP profile id (used when agent === 'acp'). */
  profile?: string;
  /** Request an asynchronous (background job) dispatch. */
  async?: boolean;
  /** Dual-track yield window: return RUNNING_ASYNC after this many ms. */
  yieldTimeMs?: number;
  /** Correlate an events/wait/steer/interrupt call with an existing run. */
  runId?: string;
  /** Correlate an events/wait/steer/interrupt call with an existing job. */
  jobId?: string;
  /** Event cursor: only return events with seq > afterSeq. */
  afterSeq?: number;
  /** Max wall-clock wait for action 'wait'. */
  waitMs?: number;
  /** Max number of events to return for action 'events'. */
  limit?: number;
  /** Payload for action 'steer' / 'send'. */
  input?: string;
}

export interface SubagentSummary {
  status: 'COMPLETED' | 'FAILED' | 'REJECTED' | 'RUNNING_ASYNC';
  agentType: string;
  childMode: ConfinementMode;
  /**
   * P3: the effective (never looser than parent) approval policy applied to
   * this subagent run.
   */
  effectivePolicy?: ApprovalPolicy;
  isolateWorktree: boolean;
  worktreePath?: string;
  checkpointId?: string;
  stepsExecuted: number;
  summary: string;
  filesModified: string[];
  gitDiffStat: string;
  error?: string;
  /** Background job id backing this subagent run. */
  jobId?: string;
  /** Run id (currently mirrors jobId) for correlation across transports. */
  runId?: string;
  /** Final captured stdout/stderr output. */
  output?: string;
  /** Human-readable diagnostic when the run degraded or timed out. */
  diagnostic?: string;
  /** Terminal stop reason reported by the underlying agent. */
  stopReason?: string;
  /** Next event cursor the caller should pass as afterSeq. */
  nextSeq?: number;
  /** Highest event sequence number produced so far. */
  latestSeq?: number;
  /** Number of oldest events dropped due to ring backpressure. */
  droppedEvents?: number;
  /** Snapshot of the incremental event stream. */
  events?: SubagentEvent[];
  /** Whether the run exhausted its wall-clock budget. */
  timedOut?: boolean;
  /** Actual working directory passed to the child process and diffed for filesModified. */
  effectiveCwd?: string;
  /** Previous dead/terminated jobId when spawned via action="resume". */
  resumedFrom?: string;
  /** Continuation guidance when a session terminates or times out with on-disk state intact. */
  resumeHint?: string;
  /** Structured steer delivery metadata when action="steer" / "send" is invoked. */
  steerDelivery?: SteerDeliveryReceipt;
}

export interface MwhConfig {
  server: {
    host: string;
    port: number;
  };
  confinement: {
    mode: ConfinementMode;
    approvalPolicy: ApprovalPolicy;
    workspaceRoot: string;
  };
  tunnel: {
    mode: 'quick' | 'named' | 'tailscale' | 'custom' | 'off';
    cloudflaredPath: string;
    namedTunnelTokenEnv: string;
    runtimeTokenEnv: string;
    hmacSecretEnv: string;
  };
  subagents: {
    maxSteps: number;
    timeoutMs: number;
  };
  desktopHands: {
    enabled: boolean;
    foregroundFallback?: boolean;
  };
}

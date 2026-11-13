/**
 * Approval Engine & Human-in-the-Loop Security Kernel
 * Enforces policy gates, HMAC signed mobile URLs, and blocks unauthorized AI self-approvals.
 */

import crypto from 'node:crypto';
import type {
  ApprovalGranularity,
  ApprovalPolicy,
  ApprovalRecord,
  ApprovalStatusReceipt,
  ExecutionContext,
  RiskLevel,
  ToolMetaCategory
} from '../types.js';
import type { PathAccessResult } from './pathGuard.js';

/**
 * Computes a deterministic SHA-256 hash over the tool params with keys sorted,
 * used to bind an approval signature to the exact parameters it approves.
 */
export function computeParamsHash(params: Record<string, any>): string {
  const sorted = Object.keys(params)
    .sort()
    .reduce((acc, k) => {
      acc[k] = params[k];
      return acc;
    }, {} as Record<string, any>);
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

const APPROVAL_HASH_IGNORED = new Set(['_resolvedPath', '_resolvedDestination']);

/** Hash the client-supplied fields only. Server path-fence annotations must not change the approval binding. */
export function hashClientParams(params: Record<string, any> | undefined): string {
  const src = params || {};
  const copy: Record<string, any> = {};
  for (const key of Object.keys(src)) {
    if (!APPROVAL_HASH_IGNORED.has(key)) copy[key] = src[key];
  }
  return computeParamsHash(copy);
}

export class ApprovalEngine {
  private pendingApprovals: Map<string, ApprovalRecord> = new Map();
  private sessionApprovedActions: Set<string> = new Set();
  private workspaceApprovedActions: Set<string> = new Set();
  private hmacSecret: string;
  private insecureMode: boolean;

  constructor(defaultHmacSecret?: string) {
    const explicitSecret = defaultHmacSecret || process.env.MWH_HMAC_SECRET;
    if (explicitSecret) {
      this.hmacSecret = explicitSecret;
      this.insecureMode = false;
    } else {
      // No explicit secret configured: never fall back to any built-in string.
      // Critical (requiresMobileHmac) approvals are refused at issuance instead.
      this.hmacSecret = crypto.randomBytes(32).toString('hex');
      this.insecureMode = true;
    }
  }

  /**
   * Generates a stable key for identifying duplicate tool actions.
   */
  public getActionKey(toolName: string, params: Record<string, any>): string {
    const sorted = Object.keys(params)
      .sort()
      .reduce((acc, k) => {
        acc[k] = params[k];
        return acc;
      }, {} as Record<string, any>);
    return `${toolName}:${JSON.stringify(sorted)}`;
  }

  /**
   * Evaluates risk level and mobile HMAC requirement based on tool, action, and boundaries.
   */
  public evaluateRisk(
    toolName: string,
    category: ToolMetaCategory,
    params: Record<string, any>,
    context: ExecutionContext,
    pathGuardResult?: PathAccessResult
  ): { riskLevel: RiskLevel; summary: string; requiresMobileHmac: boolean } {
    const cmd = typeof params.command === 'string' ? params.command : '';
    const targetPath = typeof params.path === 'string' ? params.path : '';

    // 1. Critical: Switching to Mode 4 (danger-full-access)
    if (
      toolName === 'switch_mode' &&
      params.mode === 'danger-full-access'
    ) {
      return {
        riskLevel: 'critical',
        summary: 'Elevating confinement mode to danger-full-access (Mode 4)',
        requiresMobileHmac: true
      };
    }

    // 2. Critical: Cross-directory write in danger-full-access mode
    // Only triggers when highRiskCrossBoundary is true (sensitive blacklist or
    // explicit HMAC probe). Ordinary out-of-workspace reads/writes in Full Access
    // are not elevated to critical solely for crossing workspaceRoot.
    if (
      context.confinementMode === 'danger-full-access' &&
      category !== 'read' &&
      pathGuardResult?.highRiskCrossBoundary
    ) {
      return {
        riskLevel: 'critical',
        summary: `Cross-boundary write in danger-full-access mode to '${targetPath}'`,
        requiresMobileHmac: true
      };
    }

    // 3. Critical: Shell command checks (recursive deletion, force push, system commands)
    if (toolName === 'exec_command' && cmd) {
      // Recursive deletions (rm -rf, Remove-Item -Recurse/-r, cmd del|rd|rmdir /s or \s)
      if (
        /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b/i.test(cmd) ||
        /Remove-Item\b.*(-Recurse|\s-r\b)/i.test(cmd) ||
        /\b(rd|del|rmdir)\s+.*[\\/]s\b/i.test(cmd)
      ) {
        return {
          riskLevel: 'critical',
          summary: `High-risk recursive deletion command: '${cmd}'`,
          requiresMobileHmac: true
        };
      }

      // Force push (including --force-with-lease, -f and +branch forms such as
      // 'git push +main' and 'git push origin +refs/heads/main').
      // Hardening: paired wrapping quotes are stripped first (e.g. 'git push "+main"',
      // 'git push "-f"'), and the global `git -C <path>` form between `git` and
      // `push` is allowed (e.g. 'git -C repo push -f', 'git -C "my repo" push "+main"').
      const unquotedCmd = cmd.replace(/(["'])(.*?)\1/g, '$2');
      if (
        /git\s+(?:\S+\s+)*push(?:\s+\S+)*\s+(--force-with-lease|--force|-f\b|\+[A-Za-z])/i.test(unquotedCmd)
      ) {
        return {
          riskLevel: 'critical',
          summary: `Destructive git force push command: '${cmd}'`,
          requiresMobileHmac: true
        };
      }

      // Sensitive system administrative commands
      // G6: Windows disk `format` must be anchored at command start (or after a shell
      // separator | & ;) and followed by a drive letter (e.g. `format d:`), so flags
      // like `git log --format=%D` or `--format=...` are never false-positived.
      if (
        /\b(schtasks|reg|sc|winget|net\s+user|bcdedit|diskpart)\b/i.test(cmd) ||
        /(?:^|[|&;\r\n]\s*)format(?:\.com|\.exe)?\s+(?:\/[a-z0-9:?]+\s+)*[a-zA-Z]:(?:\s|$|[\\/])/i.test(cmd)
      ) {
        return {
          riskLevel: 'critical',
          summary: `System administrative command: '${cmd}'`,
          requiresMobileHmac: true
        };
      }

      // Read-only shell commands (whitelisted inspection commands)
      if (
        category === 'read' ||
        /^(git\s+(status|log|diff)|rg\b|get-childitem\b|get-content\b|dir\b|type\b|where\b|whoami\b|node\s+(-v|--version))\b/i.test(cmd)
      ) {
        return {
          riskLevel: 'low',
          summary: `Read-only shell command: '${cmd}'`,
          requiresMobileHmac: false
        };
      }

      // If danger-full-access mode is active
      if (context.confinementMode === 'danger-full-access') {
        return {
          riskLevel: 'high',
          summary: `Shell execution in danger-full-access mode: '${cmd}'`,
          requiresMobileHmac: false
        };
      }

      return {
        riskLevel: 'medium',
        summary: `Shell command execution: '${cmd}'`,
        requiresMobileHmac: false
      };
    }

    // 4. fs_mutate recursive deletion (the real field name is `action`, see definitions.ts).
    // Truthy check: string 'true' / 1 also escalate (fail-closed, matches fsTools behavior).
    if (
      toolName === 'fs_mutate' &&
      params.action === 'delete' &&
      !!params.recursive
    ) {
      return {
        riskLevel: 'critical',
        summary: `Recursive filesystem deletion of '${targetPath}'`,
        requiresMobileHmac: true
      };
    }

    // 4.5. Desktop Hands v2: perception (windows/inspect/screenshot) is low risk;
    // background UIA/PostMessage is medium risk; foreground SendInput is high risk.
    if (toolName === 'desktop_hands') {
      const action = typeof params.action === 'string' ? params.action : '';
      if (action === 'windows' || action === 'inspect' || action === 'screenshot') {
        return {
          riskLevel: 'low',
          summary: `Desktop perception (${action})${params.hwnd ? ` on hwnd=${params.hwnd}` : ''}`,
          requiresMobileHmac: false
        };
      }
      const isForeground =
        params.delivery === 'foreground' ||
        action === 'mouse_move' ||
        (Array.isArray(params.steps) &&
          params.steps.some(
            (s: any) => s?.delivery === 'foreground' || s?.op === 'move' || s?.op === 'hotkey'
          ));
      return {
        riskLevel: isForeground ? 'high' : 'medium',
        summary: `Desktop ${isForeground ? 'foreground' : 'background'} ${action}${params.op ? `:${params.op}` : ''}${params.hwnd ? ` (hwnd=${params.hwnd})` : ''}`,
        requiresMobileHmac: false
      };
    }

    // 5. Sensitive write / write operations
    if (category === 'sensitive_write') {
      return {
        riskLevel: 'high',
        summary: `Sensitive write operation: ${toolName} on '${targetPath}'`,
        requiresMobileHmac: false
      };
    }

    if (category === 'write') {
      return {
        riskLevel: 'medium',
        summary: `Filesystem mutation: ${toolName} on '${targetPath}'`,
        requiresMobileHmac: false
      };
    }

    // 6. Read operations
    if (category === 'read') {
      if (
        context.confinementMode === 'danger-full-access' &&
        pathGuardResult?.highRiskCrossBoundary
      ) {
        return {
          riskLevel: 'high',
          summary: `Cross-boundary read in danger-full-access mode: '${targetPath}'`,
          requiresMobileHmac: false
        };
      }
      return {
        riskLevel: 'low',
        summary: `Read operation: ${toolName} on '${targetPath}'`,
        requiresMobileHmac: false
      };
    }

    return {
      riskLevel: 'medium',
      summary: `Standard action: ${toolName}`,
      requiresMobileHmac: false
    };
  }

  /**
   * Checks whether the action is already pre-approved via policy or memory scopes.
   */
  public isActionPreApproved(
    toolName: string,
    actionKey: string,
    riskLevel: RiskLevel,
    policy: ApprovalPolicy,
    context: ExecutionContext,
    params?: Record<string, any>
  ): boolean {
    // Critical actions can NEVER be exempted by session/workspace memory scopes:
    // they always require explicit human approval through the mobile HMAC channel.
    if (riskLevel === 'critical') {
      return false;
    }

    // Session memory check
    if (
      this.sessionApprovedActions.has(actionKey) ||
      context.sessionApprovedActions?.has(actionKey)
    ) {
      return true;
    }

    // Session-level app/window authorization for desktop_hands
    if (
      toolName === 'desktop_hands' &&
      typeof params?.hwnd === 'number' &&
      params.hwnd > 0
    ) {
      const hwndKey = `desktop_hands:hwnd:${Math.trunc(params.hwnd)}`;
      if (
        this.sessionApprovedActions.has(hwndKey) ||
        context.sessionApprovedActions?.has(hwndKey)
      ) {
        return true;
      }
    }

    // Workspace memory check
    if (
      this.workspaceApprovedActions.has(actionKey) ||
      context.workspaceApprovedActions?.has(actionKey)
    ) {
      return true;
    }

    // Policy check
    if (policy === 'unattended-yolo') {
      const isYoloActive =
        (typeof context.yoloExpiresAt === 'number' &&
          Date.now() < context.yoloExpiresAt) ||
        context.confinementMode === 'danger-full-access';
      // Note: riskLevel === 'critical' already returned false above, so critical
      // actions always require confirmation even in YOLO mode.
      if (isYoloActive) {
        return true;
      }
      return false;
    }

    if (policy === 'auto-workspace') {
      if (riskLevel === 'low' || riskLevel === 'medium') {
        return true;
      }
      return false;
    }

    if (policy === 'smart-risk') {
      if (riskLevel === 'low') {
        return true;
      }
      return false;
    }

    // 'always-ask' requires approval for all non-preapproved non-low actions
    if (policy === 'always-ask') {
      if (riskLevel === 'low') {
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * Generates a pending approval record and signed mobile HMAC URL.
   */
  public createApproval(
    requestId: string,
    toolName: string,
    category: ToolMetaCategory,
    params: Record<string, any>,
    riskLevel: RiskLevel,
    summary: string,
    requiresMobileHmac: boolean,
    context: ExecutionContext
  ): { approvalRecord: ApprovalRecord; approvalUrl: string } {
    // Fail-closed: without an explicitly configured HMAC secret, critical
    // (mobile-HMAC-gated) approvals must never be issued — otherwise the
    // signature would be forgeable by anyone who knows the default string.
    if (requiresMobileHmac && this.insecureMode) {
      throw new Error(
        'APPROVAL_HMAC_SECRET_MISSING: A critical approval requires the MWH_HMAC_SECRET environment variable ' +
          '(or an explicit secret at construction). Refusing to issue a forgeable approval.'
      );
    }

    const approvalId = `appr_${crypto.randomUUID().replace(/-/g, '')}`;
    const secret = context.hmacSecret || this.hmacSecret;
    const paramsHash = hashClientParams(params);

    const hmacSig = crypto
      .createHmac('sha256', secret)
      .update(`${approvalId}:${toolName}:${riskLevel}:${paramsHash}`)
      .digest('hex');

    const now = Date.now();
    const approvalRecord: ApprovalRecord = {
      id: approvalId,
      requestId,
      toolName,
      category,
      params,
      riskLevel,
      summary,
      requiresMobileHmac,
      hmacSig,
      paramsHash,
      createdAt: now,
      expiresAt: now + 15 * 60 * 1000,
      status: 'PENDING'
    };

    this.pendingApprovals.set(approvalId, approvalRecord);
    this.evictTerminalRecordsIfNeeded();

    const tunnelHost = context.tunnelUrl || '127.0.0.1:19820';
    const protocol = tunnelHost.startsWith('http') ? '' : 'https://';
    const approvalUrl = `${protocol}${tunnelHost}/approve/${approvalId}?sig=${hmacSig}`;

    return { approvalRecord, approvalUrl };
  }

  /**
   * Resolves a pending approval with strict AI self-approval guard on critical actions.
   * `source` declares the resolution channel: records that require a mobile HMAC
   * signature may only be resolved through the human mobile link or the
   * Bearer-authenticated desktop UI island. The AI-driven job_control channel
   * can neither approve nor reject them.
   */
  public resolveApproval(
    approvalId: string,
    action: 'approve' | 'reject',
    sig?: string,
    granularity: ApprovalGranularity = 'once',
    context?: ExecutionContext,
    source?: 'job_control' | 'mobile_link' | 'ui_island'
  ): { success: boolean; record: ApprovalRecord } {
    const record = this.pendingApprovals.get(approvalId);
    if (!record) {
      throw new Error(`APPROVAL_NOT_FOUND: No pending approval for ${approvalId}`);
    }

    // One-time consumption: only PENDING records may be resolved.
    if (record.status !== 'PENDING') {
      throw new Error(
        `APPROVAL_ALREADY_RESOLVED: Approval ${approvalId} is already ${record.status}`
      );
    }

    // Expiry: expired approvals are marked EXPIRED and can no longer be resolved.
    if (Date.now() > record.expiresAt) {
      record.status = 'EXPIRED';
      throw new Error(
        `APPROVAL_EXPIRED: Approval ${approvalId} expired at ${new Date(record.expiresAt).toISOString()}`
      );
    }

    // AI self-approval guard (applies to approve AND reject): records requiring a
    // mobile HMAC signature may only be resolved through the human mobile link
    // channel — the AI-driven job_control channel can neither approve nor reject
    // them (preventing the model from voiding a pending human decision either).
    if (record.requiresMobileHmac && source !== 'mobile_link' && source !== 'ui_island') {
      throw new Error(
        'HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN: Critical action requires resolution via the mobile link channel'
      );
    }

    // Signature format hard check before any approve/reject handling:
    // a valid HMAC-SHA256 hex digest is always exactly 64 lowercase/uppercase hex chars.
    if (sig && !/^[0-9a-f]{64}$/i.test(sig)) {
      throw new Error(
        `INVALID_SIG_FORMAT: Signature must be a 64-character hex string, got length ${sig.length}`
      );
    }

    if (action === 'reject') {
      record.status = 'REJECTED';
      return { success: true, record };
    }

    // Action is 'approve'
    if (record.requiresMobileHmac) {
      if (!sig) {
        throw new Error(
          'HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN: Critical action requires valid HMAC signature'
        );
      }

      const secret = context?.hmacSecret || this.hmacSecret;
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`${approvalId}:${record.toolName}:${record.riskLevel}:${record.paramsHash}`)
        .digest('hex');

      const isSigValid =
        sig.length === expectedSig.length &&
        crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'));

      if (!isSigValid) {
        throw new Error(
          'HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN: Invalid HMAC signature for critical action'
        );
      }

      record.approvedBy = 'hmac';
    } else {
      record.approvedBy = sig ? 'hmac' : 'job_control';
    }

    // Critical approvals and any mobile-HMAC-gated approval are always one-shot:
    // ignore caller-provided granularity and never write them into
    // session/workspace memory scopes.
    if (record.riskLevel === 'critical' || record.requiresMobileHmac) {
      granularity = 'once';
    }

    record.status = 'APPROVED';
    record.granularity = granularity;

    const actionKey = this.getActionKey(record.toolName, record.params);
    if (granularity === 'session') {
      this.sessionApprovedActions.add(actionKey);
      if (context?.sessionApprovedActions) {
        context.sessionApprovedActions.add(actionKey);
      }
      if (
        record.toolName === 'desktop_hands' &&
        typeof record.params?.hwnd === 'number' &&
        record.params.hwnd > 0
      ) {
        const hwndKey = `desktop_hands:hwnd:${Math.trunc(record.params.hwnd)}`;
        this.sessionApprovedActions.add(hwndKey);
        if (context?.sessionApprovedActions) {
          context.sessionApprovedActions.add(hwndKey);
        }
      }
    } else if (granularity === 'workspace') {
      this.workspaceApprovedActions.add(actionKey);
      if (context?.workspaceApprovedActions) {
        context.workspaceApprovedActions.add(actionKey);
      }
    }

    return { success: true, record };
  }

  /**
   * Consumes an APPROVED record after the pipeline used it to authorize exactly one
   * execution. A CONSUMED approval can never authorize another execution.
   */
  public consumeApproval(approvalId: string): boolean {
    const record = this.pendingApprovals.get(approvalId);
    if (!record || record.status !== 'APPROVED') {
      return false;
    }
    record.status = 'CONSUMED';
    return true;
  }

  public getApproval(approvalId: string): ApprovalRecord | undefined {
    return this.pendingApprovals.get(approvalId);
  }

  public recordExecutionReceipt(
    approvalId: string,
    receipt: {
      executionStatus: 'SUCCESS' | 'DENIED' | 'ERROR';
      jobId?: string;
      checkpointId?: string;
      resultSummary?: string;
    }
  ): void {
    const record = this.pendingApprovals.get(approvalId);
    if (!record) return;
    record.executionStatus = receipt.executionStatus;
    if (receipt.jobId) record.jobId = receipt.jobId;
    if (receipt.checkpointId) record.checkpointId = receipt.checkpointId;
    if (receipt.resultSummary) record.resultSummary = receipt.resultSummary;
    record.completedAt = Date.now();
  }

  public getSanitizedReceipt(approvalId: string): ApprovalStatusReceipt | undefined {
    const record = this.pendingApprovals.get(approvalId);
    if (!record) return undefined;
    if (record.status === 'PENDING' && Date.now() > record.expiresAt) {
      record.status = 'EXPIRED';
    }
    return {
      id: record.id,
      approvalId: record.id,
      requestId: record.requestId,
      toolName: record.toolName,
      category: record.category,
      riskLevel: record.riskLevel,
      status: record.status,
      granularity: record.granularity,
      jobId: record.jobId || null,
      executionStatus:
        record.executionStatus ||
        (record.status === 'CONSUMED'
          ? 'SUCCESS'
          : record.status === 'REJECTED' || record.status === 'EXPIRED'
            ? 'DENIED'
            : undefined),
      checkpointId: record.checkpointId,
      resultSummary:
        record.resultSummary ||
        (record.status === 'PENDING'
          ? 'Waiting for local confirmation on desktop floating island'
          : record.status === 'CONSUMED'
            ? `Approval ${record.id} consumed and executed`
            : `Approval ${record.id} is ${record.status}`),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      completedAt: record.completedAt
    };
  }

  public getLatestSanitizedReceipt(): ApprovalStatusReceipt | null {
    const all = Array.from(this.pendingApprovals.values()).sort(
      (a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt)
    );
    if (all.length === 0) return null;
    return this.getSanitizedReceipt(all[0].id) || null;
  }

  /** Pending approvals, newest first. Read-only view of the in-memory map. */
  public listPendingApprovals(): ApprovalRecord[] {
    return Array.from(this.pendingApprovals.values())
      .filter((record) => record.status === 'PENDING')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Atomically rejects all PENDING approvals (invoked by Global Emergency Kill).
   * Preserves records with status='REJECTED' and executionStatus='DENIED' so
   * job_control(poll, approvalId) receives an honest terminal receipt instead of hanging.
   */
  public rejectAllPending(reason = 'EMERGENCY_KILL'): string[] {
    const rejectedIds: string[] = [];
    const now = Date.now();
    for (const [id, record] of this.pendingApprovals.entries()) {
      if (record.status === 'PENDING') {
        record.status = 'REJECTED';
        record.executionStatus = 'DENIED';
        record.resultSummary = `Rejected by global emergency kill (${reason})`;
        record.completedAt = now;
        rejectedIds.push(id);
      }
    }
    this.evictTerminalRecordsIfNeeded();
    return rejectedIds;
  }

  /** Clears in-memory session-level approvals (invoked by Global Emergency Kill). */
  public clearSessionApprovals(): void {
    this.sessionApprovedActions.clear();
  }

  /** Caps in-memory approval history to prevent unbounded growth over long daemon runs. */
  private evictTerminalRecordsIfNeeded(maxRetained = 200): void {
    if (this.pendingApprovals.size <= maxRetained) return;
    for (const [id, record] of this.pendingApprovals.entries()) {
      if (this.pendingApprovals.size <= maxRetained) break;
      if (record.status !== 'PENDING' && record.status !== 'APPROVED') {
        this.pendingApprovals.delete(id);
      }
    }
  }
}

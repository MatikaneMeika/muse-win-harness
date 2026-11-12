/**
 * Single-Pipeline Execution Kernel
 * Implements preExecute -> execute -> postExecute lifecycle with path fencing,
 * Win32 Job Object process containment, approval evaluation, and audit logging.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConfinementMode,
  ExecutionContext,
  PipelineRequest,
  PipelineResponse,
  RiskLevel
} from '../types.js';
import { VALID_CONFINEMENT_MODES } from '../types.js';
import { ApprovalEngine, hashClientParams } from './approvalEngine.js';
import { checkPathAccess, checkSensitiveBlacklist, type PathAccessResult } from './pathGuard.js';
import { AclSandboxManager } from './aclSandbox.js';
import { executeMuseTool, MUSE_TOOLS } from '../tools/index.js';

export const SECURITY_BOUNDARY_STATEMENT =
  '无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流';

/**
 * Context keys that must never be overridable by external request callers:
 * they define the security envelope (secret, fencing, policy, kill-switches, budgets)
 * and are stripped from request.context before it is merged into the effective context.
 */
const SENSITIVE_CONTEXT_KEYS: (keyof ExecutionContext)[] = [
  'id',
  'hmacSecret',
  'confinementMode',
  'approvalPolicy',
  'workspaceRoot',
  'workspaceRoots',
  'sessionApprovedActions',
  'workspaceApprovedActions',
  'yoloExpiresAt',
  'tunnelUrl',
  'desktopHandsEnabled',
  'subagentTimeoutMs',
  'subagentMaxSteps'
];

// Any of these characters enables chaining / command substitution / redirection
// and triggers an immediate deny in read-only mode (one-vote veto).
const READ_ONLY_DANGEROUS_CHARS_REGEX = /[|`$;&\r\n<>]/;

// Full-match (end-anchored) whitelist of read-only shell commands.
const READ_ONLY_WHITELIST_REGEX =
  /^(git (status|log|diff)( --[a-z0-9-]+)*( [A-Za-z0-9_\-.]+)*|rg( --[a-z0-9-]+)*( [A-Za-z0-9_\-.]+)*|get-childitem( [A-Za-z0-9_\-.]+)*|get-content( [A-Za-z0-9_\-.]+)*|dir( [A-Za-z0-9_\-.]+)*|type( [A-Za-z0-9_\-.]+)*|where( [A-Za-z0-9_\-.]+)*|whoami( [A-Za-z0-9_\-.]+)*|node (-v|--version))$/i;

// Dangerous git/rg flags that can redirect output or execute arbitrary programs
// even under otherwise read-looking commands (one-vote veto in read-only mode).
// --textconv is included: a textconv filter runs any program configured in
// .gitattributes, so it must never pass in read-only mode.
const READ_ONLY_DANGEROUS_FLAGS_REGEX =
  /--output\b|--ext-diff\b|--exec\b|--pager\b|--pre\b|--pre-glob\b|--textconv\b|\s-o\b/i;

export class PipelineKernel {
  private approvalEngine: ApprovalEngine;
  private defaultContext: ExecutionContext;

  constructor(
    defaultContext?: Partial<ExecutionContext>,
    approvalEngine?: ApprovalEngine
  ) {
    this.approvalEngine = approvalEngine || new ApprovalEngine();
    this.defaultContext = {
      id: `ctx_${crypto.randomUUID().slice(0, 8)}`,
      confinementMode: 'workspace-write',
      approvalPolicy: 'smart-risk',
      workspaceRoot: process.cwd(),
      sessionApprovedActions: new Set(),
      workspaceApprovedActions: new Set(),
      ...defaultContext
    };
  }

  public getApprovalEngine(): ApprovalEngine {
    return this.approvalEngine;
  }

  public getContext(): ExecutionContext {
    return this.defaultContext;
  }

  public updateContext(updates: Partial<ExecutionContext>): void {
    Object.assign(this.defaultContext, updates);
  }

  /**
   * Main entry point executing the single pipeline:
   * preExecute -> execute -> postExecute
   */
  public async handleRequest(request: PipelineRequest): Promise<PipelineResponse> {
    // Guard 0: params must be a plain object (reject null/arrays/primitives early
    // so downstream stages can rely on key/value access without throwing).
    if (
      request.params === null ||
      typeof request.params !== 'object' ||
      Array.isArray(request.params)
    ) {
      const invalidResponse: PipelineResponse = {
        status: 'DENIED',
        reason: 'INVALID_PARAMS: params must be a plain object',
        riskLevel: 'low'
      };
      await this.postExecute(request, this.defaultContext, invalidResponse, 'low');
      return invalidResponse;
    }

    // Defense layer 1 (switch_mode): reject illegal confinement modes before any
    // pipeline stage runs, independent of the check inside execute().
    if (request.toolName === 'switch_mode') {
      const requestedMode = request.params?.mode as ConfinementMode;
      if (!VALID_CONFINEMENT_MODES.includes(requestedMode)) {
        const errorResponse: PipelineResponse = {
          status: 'ERROR',
          error: `INVALID_CONFINEMENT_MODE: ${requestedMode}`
        };
        await this.postExecute(request, this.defaultContext, errorResponse, 'low');
        return errorResponse;
      }
    }

    // Strip security-sensitive keys from the externally supplied context on a
    // shallow copy: the original request object must not be mutated and no
    // external reference may flow straight into the effective context.
    const sanitizedContext: Partial<ExecutionContext> = { ...(request.context || {}) };
    for (const key of SENSITIVE_CONTEXT_KEYS) {
      delete sanitizedContext[key];
    }

    // Strip pathGuard-resolved fields from client params on a shallow copy:
    // clients must never be able to smuggle pre-resolved paths past the fence.
    const sanitizedParams: Record<string, any> = { ...request.params };
    delete sanitizedParams._resolvedPath;
    delete sanitizedParams._resolvedDestination;

    // R1-M1 & R2-M1: Prevent caller category spoofing in ANY direction (e.g. downgrading
    // sensitive_write -> write to bypass auto-workspace confirmation, or write -> read).
    // Only subagent_dispatch with an explicit read-only childMode or read-only
    // control action may run under 'read'.
    const CATEGORY_RANK = { read: 0, write: 1, sensitive_write: 2 } as const;
    const toolDef = MUSE_TOOLS.find((t) => t.name === request.toolName);
    let authoritativeCategory = request.category;
    if (request.toolName === 'switch_mode') {
      authoritativeCategory = 'sensitive_write';
    } else if (toolDef) {
      const isAllowedReadSubagent =
        request.category === 'read' &&
        request.toolName === 'subagent_dispatch' &&
        (sanitizedParams.childMode === 'read-only' ||
          sanitizedParams.action === 'events' ||
          sanitizedParams.action === 'wait' ||
          sanitizedParams.action === 'list' ||
          sanitizedParams.action === 'profiles');
      if (isAllowedReadSubagent) {
        authoritativeCategory = 'read';
      } else {
        // R3-M2: Never pass through an unknown/unregistered category string (e.g. 'admin').
        const hasValidReqCategory = Object.prototype.hasOwnProperty.call(
          CATEGORY_RANK,
          request.category
        );
        const normalizedReqCategory = hasValidReqCategory
          ? request.category
          : 'sensitive_write';
        const reqRank = CATEGORY_RANK[normalizedReqCategory];
        const defRank = CATEGORY_RANK[toolDef.category] ?? 2;
        authoritativeCategory = reqRank > defRank ? normalizedReqCategory : toolDef.category;
      }
    } else {
      authoritativeCategory = 'sensitive_write';
    }

    const pipelineRequest: PipelineRequest = {
      ...request,
      category: authoritativeCategory,
      params: sanitizedParams
    };

    const context: ExecutionContext = {
      ...this.defaultContext,
      ...sanitizedContext
    };

    // 1. preExecute (with catch-all guard: unexpected errors must degrade to an
    // ERROR response instead of propagating up as a 500)
    let preResult: PipelineResponse;
    try {
      preResult = await this.preExecute(pipelineRequest, context);
    } catch (err: any) {
      preResult = {
        status: 'ERROR',
        error: err?.message || 'Pre-execution failed'
      };
    }
    if (preResult.status !== 'SUCCESS') {
      await this.postExecute(pipelineRequest, context, preResult, preResult.riskLevel || 'low');
      return preResult;
    }

    // 2. executeStage
    let execResponse: PipelineResponse;
    const evaluatedRisk = preResult.riskLevel || 'medium';

    try {
      execResponse = await this.executeStage(pipelineRequest, context, evaluatedRisk);
      if (!execResponse.riskLevel) {
        execResponse.riskLevel = evaluatedRisk;
      }
    } catch (err: any) {
      execResponse = {
        status: 'ERROR',
        error: err.message || 'Execution failed',
        riskLevel: evaluatedRisk
      };
    }

    // 3. postExecute
    await this.postExecute(pipelineRequest, context, execResponse, evaluatedRisk);
    return execResponse;
  }

  /**
   * Stage 1: preExecute
   * Path checks, read-only enforcement, risk assessment, and approval verification.
   */
  private async preExecute(
    request: PipelineRequest,
    context: ExecutionContext
  ): Promise<PipelineResponse> {
    const { toolName, category, params } = request;

    // Tool 'job_control' is the control plane authorization mechanism; does not require recursive approval.
    // In read-only mode only log/event polling and status inspection are permitted — stdin/steer/abort/approve are denied.
    if (toolName === 'job_control') {
      if (
        context.confinementMode === 'read-only' &&
        params.action !== 'poll' &&
        params.action !== 'events' &&
        params.action !== 'status'
      ) {
        return {
          status: 'DENIED',
          reason: 'READ_ONLY_MODE_JOB_CONTROL_DENIED: Only poll/events/status are permitted in read-only mode',
          riskLevel: 'high'
        };
      }
      return { status: 'SUCCESS', riskLevel: 'low' };
    }

    // Read-only subagent_dispatch inspection actions (events / wait / list / profiles)
    // are non-mutating control-plane queries and bypass write interception.
    if (
      toolName === 'subagent_dispatch' &&
      (params.action === 'events' ||
        params.action === 'wait' ||
        params.action === 'list' ||
        params.action === 'profiles')
    ) {
      return { status: 'SUCCESS', riskLevel: 'low' };
    }

    // Guard: exec_command requires a string command (prevents downstream
    // regex/string operations from throwing on unexpected input types)
    if (toolName === 'exec_command' && typeof params.command !== 'string') {
      return {
        status: 'DENIED',
        reason: 'INVALID_PARAMS_TYPE: exec_command requires a string command',
        riskLevel: 'medium'
      };
    }

    // A. Read-only mode write interception for file mutation tools
    // R2-M7 & R3-M2: Exempt switch_mode so mode transitions reach ApprovalEngine,
    // and check category !== 'read' so no non-read category can slip through.
    if (
      context.confinementMode === 'read-only' &&
      toolName !== 'exec_command' &&
      toolName !== 'switch_mode' &&
      category !== 'read'
    ) {
      return {
        status: 'DENIED',
        reason: 'READ_ONLY_MODE_WRITE_DENIED: Modifications are forbidden in read-only mode',
        riskLevel: 'high'
      };
    }

    // B. Read-only mode shell command confinement
    if (context.confinementMode === 'read-only' && toolName === 'exec_command') {
      const command = (params.command || '').trim();

      // One-vote veto: pipeline operators, command substitution, backgrounding,
      // separators and redirections are all blocked outright.
      if (READ_ONLY_DANGEROUS_CHARS_REGEX.test(command)) {
        return {
          status: 'DENIED',
          reason: 'READ_ONLY_MODE_COMMAND_DENIED: Redirection or chaining blocked in read-only mode',
          riskLevel: 'high'
        };
      }

      // One-vote veto: dangerous git/rg flags (--output/--ext-diff/--exec/--pager/
      // --pre/--pre-glob and short -o) can write files or spawn programs.
      if (READ_ONLY_DANGEROUS_FLAGS_REGEX.test(command)) {
        return {
          status: 'DENIED',
          reason: 'READ_ONLY_MODE_COMMAND_DENIED: Dangerous output/exec flags blocked in read-only mode',
          riskLevel: 'high'
        };
      }

      // Check command against the end-anchored read-only whitelist (full match)
      if (!READ_ONLY_WHITELIST_REGEX.test(command)) {
        return {
          status: 'DENIED',
          reason: `READ_ONLY_MODE_COMMAND_DENIED: Command '${command}' not permitted in read-only mode`,
          riskLevel: 'high'
        };
      }

      // R3-M7: Enforce sensitive file blacklist on all argument tokens of read-only
      // shell commands (blocks e.g. `type .env` or `get-content id_rsa`).
      const argTokens = command
        .split(/\s+/)
        .slice(1)
        .filter((tok: string) => tok.length > 0 && !tok.startsWith('-'));
      for (const tok of argTokens) {
        const candidatePath = path.resolve(context.workspaceRoot, tok);
        const bl = checkSensitiveBlacklist(candidatePath, context.workspaceRoot);
        if (bl.blacklisted) {
          return {
            status: 'DENIED',
            reason: `READ_ONLY_MODE_COMMAND_DENIED: ${bl.reason || 'Sensitive file access denied'}`,
            riskLevel: 'high'
          };
        }
      }
    }

    // C. Filesystem path check for path-targeting tools
    let pathGuardResult: PathAccessResult | undefined;
    if (params.path && typeof params.path === 'string') {
      const op = category === 'read' ? 'read' : 'write';
      pathGuardResult = checkPathAccess(
        params.path,
        op,
        context.confinementMode,
        context.workspaceRoot,
        context.workspaceRoots
      );

      if (!pathGuardResult.allowed) {
        return {
          status: 'DENIED',
          reason: pathGuardResult.reason || 'PATH_ACCESS_DENIED',
          riskLevel: 'high'
        };
      }

      // Store resolved path in params
      params._resolvedPath = pathGuardResult.resolvedPath;
    }

    // Also validate destination path if provided (e.g. fs_mutate with action: 'move')
    if (params.destination && typeof params.destination === 'string') {
      const destResult = checkPathAccess(
        params.destination,
        'write',
        context.confinementMode,
        context.workspaceRoot,
        context.workspaceRoots
      );

      if (!destResult.allowed) {
        return {
          status: 'DENIED',
          reason: destResult.reason || 'DESTINATION_PATH_ACCESS_DENIED',
          riskLevel: 'high'
        };
      }

      params._resolvedDestination = destResult.resolvedPath;
    }

    // D. Evaluate risk level
    const riskEval = this.approvalEngine.evaluateRisk(
      toolName,
      category,
      params,
      context,
      pathGuardResult
    );

    // E. Approval verification
    const actionKey = this.approvalEngine.getActionKey(toolName, params);

    // If an approvalId was explicitly provided with request, verify the approval
    // binding: same tool, same params, not expired, and mobile-HMAC-gated records
    // must have been approved through the HMAC (mobile link) channel.
    if (request.approvalId) {
      const existingApproval = this.approvalEngine.getApproval(request.approvalId);
      if (existingApproval && existingApproval.status === 'APPROVED') {
        // Expired approvals must not stay stuck in APPROVED: mark EXPIRED and deny
        // so the caller can re-initiate a fresh approval.
        if (Date.now() > existingApproval.expiresAt) {
          existingApproval.status = 'EXPIRED';
          return {
            status: 'DENIED',
            reason: `APPROVAL_EXPIRED: Approval ${request.approvalId} expired, please request a new approval`,
            riskLevel: riskEval.riskLevel
          };
        }

        const sameTool = existingApproval.toolName === request.toolName;
        const sameParams =
          existingApproval.paramsHash === hashClientParams(request.params);
        const hmacChannelOk =
          !existingApproval.requiresMobileHmac ||
          existingApproval.approvedBy === 'hmac';

        if (!sameTool || !sameParams || !hmacChannelOk) {
          return {
            status: 'DENIED',
            reason:
              'APPROVAL_BINDING_MISMATCH: Approval does not match this request (tool/params/channel)',
            riskLevel: riskEval.riskLevel
          };
        }

        // One-time consumption: this approval can never authorize a second execution.
        this.approvalEngine.consumeApproval(request.approvalId);
        return { status: 'SUCCESS', riskLevel: riskEval.riskLevel };
      }
    }

    // Check pre-approval via policy or memory scopes
    const isPreApproved = this.approvalEngine.isActionPreApproved(
      toolName,
      actionKey,
      riskEval.riskLevel,
      context.approvalPolicy,
      context
    );

    if (!isPreApproved) {
      // Create pending approval
      const { approvalRecord, approvalUrl } = this.approvalEngine.createApproval(
        request.id,
        toolName,
        category,
        params,
        riskEval.riskLevel,
        riskEval.summary,
        riskEval.requiresMobileHmac,
        context
      );

      return {
        status: 'CONFIRMATION_REQUIRED',
        approvalId: approvalRecord.id,
        approvalUrl,
        summary: riskEval.summary,
        riskLevel: riskEval.riskLevel,
        requiresMobileHmac: riskEval.requiresMobileHmac
      };
    }

    return { status: 'SUCCESS', riskLevel: riskEval.riskLevel };
  }

  /**
   * Stage 2: executeStage
   * Dispatches tool invocation to corresponding native handler.
   * G5: Read-only short-circuit — commands evaluated as riskLevel === 'low' (or category === 'read')
   * bypass pre-execution shadow snapshots and worktree wrapping while keeping medium+ intact.
   */
  private async executeStage(
    request: PipelineRequest,
    context: ExecutionContext,
    evaluatedRisk: RiskLevel = 'medium'
  ): Promise<PipelineResponse> {
    const { toolName, params } = request;
    const isReadOnlyShortCircuit = evaluatedRisk === 'low' || request.category === 'read';
    if (
      isReadOnlyShortCircuit &&
      toolName === 'subagent_dispatch' &&
      (!params.action || params.action === 'run')
    ) {
      params.isolateWorktree = false;
      params.childMode = 'read-only';
    }

    if (toolName === 'switch_mode') {
      const targetMode = params.mode as ConfinementMode;
      if (
        targetMode !== 'read-only' &&
        targetMode !== 'workspace-write' &&
        targetMode !== 'workspace-acl-experimental' &&
        targetMode !== 'danger-full-access'
      ) {
        return { status: 'ERROR', error: `INVALID_CONFINEMENT_MODE: ${targetMode}` };
      }

      // P2 Mode 3 Fail-Closed wiring: workspace-acl-experimental requires the
      // AclSandboxManager capability self-check to pass. Initialization or
      // capability failure returns ERROR (MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED)
      // and the confinement mode stays UNCHANGED — never a silent downgrade
      // into an unenforced sandbox (spec: "初始化失败即中止报错，绝不静默降级").
      if (targetMode === 'workspace-acl-experimental') {
        let capability: { available: boolean; reason: string };
        try {
          capability = AclSandboxManager.checkSandboxCapability();
        } catch (err: any) {
          capability = { available: false, reason: err?.message || 'capability check threw' };
        }
        if (!capability.available) {
          return {
            status: 'ERROR',
            error: `MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED: ${capability.reason}`
          };
        }
      }

      this.updateContext({ confinementMode: targetMode });
      return { status: 'SUCCESS', data: { newMode: targetMode } };
    }

    try {
      const result = await executeMuseTool(
        toolName,
        params,
        context,
        this.approvalEngine
      );
      if (
        toolName === 'subagent_dispatch' &&
        (!params.action || params.action === 'run') &&
        result &&
        typeof result === 'object' &&
        (result as any).status === 'FAILED'
      ) {
        return {
          status: 'ERROR',
          error: (result as any).error || (result as any).summary || 'Subagent execution failed',
          summary: (result as any).summary,
          data: result
        };
      }
      return { status: 'SUCCESS', data: result };
    } catch (err: any) {
      return { status: 'ERROR', error: err.message || 'Tool execution failed' };
    }
  }

  /**
   * Stage 3: postExecute
   * Appends audit entry to .mwh/logs/audit.jsonl and decorates response tags.
   */
  private async postExecute(
    request: PipelineRequest,
    context: ExecutionContext,
    response: PipelineResponse,
    riskLevel: RiskLevel
  ): Promise<void> {
    // Attach security boundary statement
    response.securityBoundary = SECURITY_BOUNDARY_STATEMENT;

    // Attach tags
    response.tags = response.tags || [];
    if (context.confinementMode === 'danger-full-access') {
      if (!response.tags.includes('[FULL-ACCESS-ACTIVE]')) {
        response.tags.push('[FULL-ACCESS-ACTIVE]');
      }
    }

    const scrub = (val: string | undefined): string | undefined => {
      if (typeof val !== 'string' || !val) return val;
      let out = val;
      const secrets = [
        context.hmacSecret,
        process.env.MWH_HMAC_SECRET,
        process.env.TUNNEL_RUNTIME_TOKEN,
        process.env.MWH_CF_TUNNEL_TOKEN
      ].filter((s): s is string => typeof s === 'string' && s.length >= 8);
      for (const sec of secrets) {
        if (out.includes(sec)) out = out.split(sec).join('[REDACTED]');
      }
      return out;
    };

    const dataObj =
      response.data && typeof response.data === 'object' ? (response.data as Record<string, any>) : undefined;
    const jobId = typeof dataObj?.jobId === 'string' && dataObj.jobId ? dataObj.jobId : undefined;
    const rawSubStatus = typeof dataObj?.status === 'string' ? dataObj.status : undefined;
    const terminalStatus =
      dataObj?.timedOut === true
        ? 'TIMEOUT'
        : rawSubStatus === 'COMPLETED' ||
            rawSubStatus === 'FAILED' ||
            rawSubStatus === 'TERMINATED' ||
            rawSubStatus === 'TIMEOUT'
          ? rawSubStatus
          : response.status === 'DENIED' || response.status === 'ERROR'
            ? 'FAILED'
            : undefined;
    const diagnostic = scrub(
      typeof dataObj?.diagnostic === 'string' && dataObj.diagnostic ? dataObj.diagnostic : undefined
    );

    const auditEntry = {
      timestamp: new Date().toISOString(),
      requestId: request.id,
      ...(jobId ? { jobId } : {}),
      toolName: request.toolName,
      category: request.category,
      confinementMode: context.confinementMode,
      approvalPolicy: context.approvalPolicy,
      riskLevel,
      securityBoundary: SECURITY_BOUNDARY_STATEMENT,
      tags: [...response.tags],
      status: response.status,
      ...(terminalStatus ? { terminalStatus } : {}),
      summary: scrub(response.summary || (typeof dataObj?.summary === 'string' ? dataObj.summary : undefined)),
      reason: scrub(response.reason),
      error: scrub(response.error || (typeof dataObj?.error === 'string' ? dataObj.error : undefined)),
      ...(diagnostic ? { diagnostic } : {})
    };

    try {
      const logDir = path.join(context.workspaceRoot, '.mwh', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'audit.jsonl'),
        JSON.stringify(auditEntry) + '\n',
        'utf-8'
      );
    } catch (err: any) {
      // Never block execution, but never stay silent either: surface audit failures.
      process.stderr.write('[MWH_AUDIT_LOG_WRITE_FAILED] ' + (err?.message || String(err)) + '\n');
    }
  }
}

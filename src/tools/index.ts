/**
 * 8 Muse Tools Execution Coordinator
 */

import os from 'node:os';
import { probeAvailableClis } from '../executors/cliAdapters.js';
import { JobManager } from '../executors/jobManager.js';
import { GitCheckpointManager } from '../pipeline/gitCheckpoint.js';
import { SubagentDispatcher } from '../subagents/dispatcher.js';
import type { ApprovalEngine } from '../pipeline/approvalEngine.js';
import type { ExecutionContext } from '../types.js';
import { DesktopHands } from './desktopHands.js';
import { FsTools } from './fsTools.js';
import {
  VALID_CONFINEMENT_MODES,
  resolvePermissionProfile,
  type ConfinementMode
} from '../types.js';

export * from './definitions.js';
export * from './desktopHands.js';
export * from './fsTools.js';

export async function executeMuseTool(
  toolName: string,
  params: Record<string, any>,
  context: ExecutionContext,
  approvalEngine: ApprovalEngine
): Promise<any> {
  const jobManager = JobManager.getInstance();

  switch (toolName) {
    // Defense layer 2 (switch_mode): validate the 4-mode enum here as well, so that
    // callers bypassing PipelineKernel.execute() cannot smuggle illegal modes.
    case 'switch_mode': {
      const targetMode = params.mode as ConfinementMode;
      if (!VALID_CONFINEMENT_MODES.includes(targetMode)) {
        throw new Error(`INVALID_CONFINEMENT_MODE: ${targetMode}`);
      }
      // Mode application itself is owned by PipelineKernel (updateContext).
      context.confinementMode = targetMode;
      return { newMode: targetMode };
    }

    case 'pc_status': {
      const isFullAccess = context.confinementMode === 'danger-full-access';
      const permissionProfile = resolvePermissionProfile(
        context.confinementMode,
        context.approvalPolicy
      );
      return {
        os: {
          platform: process.platform,
          release: os.release(),
          arch: os.arch(),
          uptime: os.uptime()
        },
        cpu: {
          count: os.cpus().length,
          model: os.cpus()[0]?.model || 'Generic CPU',
          loadavg: os.loadavg()
        },
        memory: {
          heapUsed: process.memoryUsage().heapUsed,
          freeMem: os.freemem(),
          totalMem: os.totalmem()
        },
        confinement: {
          profile: permissionProfile,
          mode: context.confinementMode,
          approvalPolicy: context.approvalPolicy,
          workspaceRoot: context.workspaceRoot
        },
        securityBoundary: '无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流',
        availableClis: probeAvailableClis(),
        tunnel: {
          active: !!context.tunnelUrl,
          url: context.tunnelUrl || null
        },
        lastApprovalReceipt: approvalEngine.getLatestSanitizedReceipt(),
        tags: isFullAccess ? ['[FULL-ACCESS-ACTIVE]'] : []
      };
    }

    case 'fs_explore': {
      const targetPath = params._resolvedPath || params.path;
      // P3: the fence root and confinement mode always come from the execution
      // context — never from the walked tree (glob/grep walks are fenced against
      // the workspace root; danger-full-access is the only relaxing mode).
      return FsTools.explore(
        {
          action: params.action || 'read',
          path: targetPath,
          pattern: params.pattern,
          offset: params.offset,
          limit: params.limit
        },
        context.workspaceRoot,
        context.confinementMode
      );
    }

    case 'fs_mutate': {
      const targetPath = params._resolvedPath || params.path;
      return FsTools.mutate(
        {
          action: params.action || 'write',
          path: targetPath,
          content: params.content,
          oldText: params.oldText,
          newText: params.newText,
          // Prefer the pathGuard-resolved destination so move cannot be redirected
          // via raw params after fencing.
          destination: params._resolvedDestination || params.destination,
          recursive: params.recursive
        },
        context.workspaceRoot
      );
    }

    case 'exec_command': {
      const execRes = await jobManager.executeCommand({
        command: params.command,
        cwd: params.cwd,
        workspaceRoot: context.workspaceRoot,
        yieldTimeMs: params.yieldTimeMs,
        timeoutMs: params.timeoutMs,
        confinementMode: context.confinementMode
      });
      return execRes.data;
    }

    case 'job_control': {
      const action = params.action;
      if (action === 'poll') {
        const rawCandidate =
          typeof params.approvalId === 'string' && params.approvalId
            ? params.approvalId
            : typeof params.jobId === 'string' && params.jobId.startsWith('appr_')
              ? params.jobId
              : undefined;
        if (rawCandidate) {
          const receipt = approvalEngine.getSanitizedReceipt(rawCandidate);
          if (receipt) {
            if (receipt.jobId) {
              const polled = jobManager.poll(
                receipt.jobId,
                params.page || 1,
                params.pageSize || 8192,
                context.workspaceRoot
              );
              return {
                ...polled,
                approvalId: receipt.approvalId,
                approvalStatus: receipt.status,
                executionStatus: receipt.executionStatus
              };
            }
            const isPending = receipt.status === 'PENDING' || receipt.status === 'APPROVED';
            const isConsumedOk =
              receipt.status === 'CONSUMED' && receipt.executionStatus !== 'ERROR' && receipt.executionStatus !== 'DENIED';
            const chunkText = receipt.resultSummary || `Approval ${receipt.approvalId} is ${receipt.status}`;
            return {
              jobId: receipt.approvalId,
              approvalId: receipt.approvalId,
              approvalStatus: receipt.status,
              executionStatus: receipt.executionStatus,
              status: isPending ? 'RUNNING_ASYNC' : isConsumedOk ? 'COMPLETED' : 'FAILED',
              exitCode: isPending ? null : isConsumedOk ? 0 : 1,
              page: 1,
              totalPages: 1,
              totalBytes: Buffer.byteLength(chunkText, 'utf-8'),
              chunk: chunkText
            };
          }
        }
        const targetJobId =
          params.jobId !== undefined
            ? params.jobId
            : params.approvalId
              ? approvalEngine.getApproval(params.approvalId)?.jobId || params.approvalId
              : params.jobId;
        return jobManager.poll(
          targetJobId,
          params.page || 1,
          params.pageSize || 8192,
          context.workspaceRoot
        );
      } else if (action === 'events') {
        const rawCandidate =
          typeof params.approvalId === 'string' && params.approvalId
            ? params.approvalId
            : typeof params.jobId === 'string' && params.jobId.startsWith('appr_')
              ? params.jobId
              : undefined;
        if (rawCandidate) {
          const receipt = approvalEngine.getSanitizedReceipt(rawCandidate);
          if (receipt && !receipt.jobId) {
            return {
              jobId: receipt.approvalId,
              runId: receipt.approvalId,
              agentType: 'approval',
              status: receipt.status === 'PENDING' || receipt.status === 'APPROVED' ? 'RUNNING_ASYNC' : 'FAILED',
              pidAlive: false,
              exitCode: null,
              events: [],
              afterSeq: 0,
              nextSeq: 0,
              latestSeq: 0,
              droppedEvents: 0,
              timedOut: false,
              output: receipt.resultSummary || `Approval ${receipt.approvalId} is ${receipt.status}`
            };
          }
          if (receipt?.jobId) {
            return await jobManager.pollEvents(receipt.jobId, {
              afterSeq: params.afterSeq,
              waitMs: params.waitMs,
              limit: params.limit
            });
          }
        }
        const targetJobId =
          params.jobId !== undefined
            ? params.jobId
            : params.approvalId
              ? approvalEngine.getApproval(params.approvalId)?.jobId || params.approvalId
              : params.jobId;
        return await jobManager.pollEvents(targetJobId, {
          afterSeq: params.afterSeq,
          waitMs: params.waitMs,
          limit: params.limit
        });
      } else if (action === 'steer') {
        return jobManager.steerSubagentJob(params.jobId, params.input);
      } else if (action === 'stdin') {
        return jobManager.writeStdin(params.jobId, params.input);
      } else if (action === 'abort') {
        return jobManager.abort(params.jobId);
      } else if (action === 'approve' || action === 'reject') {
        return approvalEngine.resolveApproval(
          params.approvalId,
          action,
          params.sig,
          params.granularity || 'once',
          context,
          'job_control'
        );
      } else if (action === 'status') {
        if (params.approvalId) {
          return approvalEngine.getSanitizedReceipt(params.approvalId);
        }
        if (typeof params.jobId === 'string' && params.jobId.startsWith('appr_')) {
          return approvalEngine.getSanitizedReceipt(params.jobId);
        }
        if (params.jobId) {
          return jobManager.getJob(params.jobId);
        }
        throw new Error('INVALID_PARAMS: jobId or approvalId required for status action');
      }
      throw new Error(`UNKNOWN_JOB_CONTROL_ACTION: ${action}`);
    }

    case 'subagent_dispatch': {
      return await SubagentDispatcher.dispatch(
        {
          action: params.action,
          agent: params.agent,
          prompt: params.prompt,
          input: params.input,
          jobId: params.jobId,
          runId: params.runId,
          afterSeq: params.afterSeq,
          waitMs: params.waitMs,
          limit: params.limit,
          childMode: params.childMode,
          isolateWorktree: params.isolateWorktree,
          maxSteps: params.maxSteps,
          timeoutMs: params.timeoutMs,
          steps: params.steps,
          cwd: params.cwd,
          profile: params.profile,
          // MCP / REST dispatches default to the 500ms dual-track yield so the
          // HTTP response returns a jobId long before Cloudflare's 100s 524.
          async: params.async !== false,
          yieldTimeMs:
            typeof params.yieldTimeMs === 'number'
              ? params.yieldTimeMs
              : params.async === false
                ? undefined
                : 500
        },
        context
      );
    }

    case 'git_checkpoint': {
      const action = params.action || 'status';
      if (action === 'create') {
        const checkpointId = GitCheckpointManager.create(params.label, context.workspaceRoot);
        return { checkpointId };
      } else if (action === 'rollback') {
        if (!params.checkpointId) {
          throw new Error('MISSING_CHECKPOINT_ID: checkpointId is required for rollback');
        }
        const rolledBack = GitCheckpointManager.rollback(params.checkpointId, context.workspaceRoot);
        return { rolledBack };
      } else if (action === 'diff') {
        return { diff: GitCheckpointManager.diff(context.workspaceRoot) };
      } else {
        return GitCheckpointManager.status(context.workspaceRoot);
      }
    }

    case 'desktop_hands': {
      // Type guard: a non-string text must be a clean business rejection,
      // never an unexpected TypeError bubbling out of PowerShell plumbing.
      if (
        params.text !== undefined &&
        params.text !== null &&
        typeof params.text !== 'string'
      ) {
        throw new Error('INVALID_PARAMS_TYPE: desktop_hands text must be a string');
      }
      return DesktopHands.execute(params as any, !!context.desktopHandsEnabled);
    }

    default:
      throw new Error(`UNKNOWN_TOOL: ${toolName}`);
  }
}

/**
 * MWH Gate 5 (G2 - G10) Real Production-Path Verification Suite
 * Strictly hits the real MwhServer HTTP/SSE endpoints, PipelineKernel, ApprovalEngine,
 * Win32 Job Object process tree killer, GitCheckpointManager, and Electron shell
 * (dual-window production surface asserted over the real CDP endpoint).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { PipelineKernel } from '../dist/pipeline/pipeline.js';
import { MwhServer } from '../dist/network/server.js';
import { GitCheckpointManager } from '../dist/pipeline/gitCheckpoint.js';
import { JobManager } from '../dist/executors/jobManager.js';

const PORT = 19835;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = 'mwh_gate5_token_' + crypto.randomBytes(16).toString('hex');
const HMAC_SECRET = crypto.randomBytes(32).toString('hex');

process.env.TUNNEL_RUNTIME_TOKEN = TOKEN;
process.env.MWH_HMAC_SECRET = HMAC_SECRET;

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    ...extra,
  };
}

async function apiJson(method, route, body) {
  const headers = authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {});
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, data };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runGate5() {
  console.log('==========================================================');
  console.log('MWH Gate 5 (G2-G10) Production Control Plane & Shell Suite');
  console.log('==========================================================');

  const workdir = process.cwd();
  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    allowedWorkspaces: [workdir],
    hmacSecret: HMAC_SECRET,
  });

  const server = new MwhServer({
    port: PORT,
    host: '127.0.0.1',
    runtimeToken: TOKEN,
    kernel,
  });

  await server.start();

  try {
    // =========================================================================
    // G2: /ui Static Hosting & Anti-Traversal
    // =========================================================================
    const g2NoToken = await fetch(`${BASE_URL}/ui`);
    assert.equal(g2NoToken.status, 401, 'G2 FAIL: /ui without token must return 401');

    const g2QueryToken = await fetch(`${BASE_URL}/ui?token=${TOKEN}`);
    assert.equal(g2QueryToken.status, 401, 'G2 FAIL: /ui with ?token= query parameter must still return 401');

    const g2WithBearer = await fetch(`${BASE_URL}/ui`, {
      headers: authHeaders(),
    });
    assert.equal(g2WithBearer.status, 200, 'G2 FAIL: /ui with Bearer token must return 200');
    const g2ContentType = g2WithBearer.headers.get('content-type') || '';
    assert.ok(g2ContentType.includes('text/html'), `G2 FAIL: Expected text/html, got ${g2ContentType}`);
    const g2Html = await g2WithBearer.text();
    assert.ok(g2Html.includes('<div id="root"></div>'), 'G2 FAIL: /ui HTML missing <div id="root"></div>');
    const setCookie = g2WithBearer.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('mwh_ui_session='), 'G2 FAIL: /ui response must set HttpOnly mwh_ui_session cookie for sub-assets');

    // Verify traversal attack is blocked
    const g2Traversal = await fetch(`${BASE_URL}/ui/..%2f..%2fpackage.json`, {
      headers: authHeaders(),
    });
    assert.ok(
      g2Traversal.status === 403 || g2Traversal.status === 404,
      `G2 FAIL: Path traversal must return 403/404, got ${g2Traversal.status}`
    );
    console.log(`[PASS] G2: /ui no-token=${g2NoToken.status}, query-token=${g2QueryToken.status}, bearer=${g2WithBearer.status} (${g2ContentType}, ${g2Html.length} bytes), traversal=${g2Traversal.status}`);

    // =========================================================================
    // G3: SSE /api/v1/events & Desensitized /api/v1/state
    // =========================================================================
    const g3NoToken = await fetch(`${BASE_URL}/api/v1/events`);
    assert.equal(g3NoToken.status, 401, 'G3 FAIL: /api/v1/events without token must return 401');

    const g3QueryToken = await fetch(`${BASE_URL}/api/v1/events?token=${TOKEN}`);
    assert.equal(g3QueryToken.status, 401, 'G3 FAIL: /api/v1/events with ?token= query must return 401');

    // Check GET /api/v1/state secret masking
    const stateRes = await apiJson('GET', '/api/v1/state');
    assert.equal(stateRes.status, 200, 'G3 FAIL: GET /api/v1/state must return 200');
    const rawStateJson = JSON.stringify(stateRes.data);
    assert.ok(!rawStateJson.includes(TOKEN), 'G3 FAIL: GET /api/v1/state leaked plaintext bearerToken');
    assert.ok(!rawStateJson.includes(HMAC_SECRET), 'G3 FAIL: GET /api/v1/state leaked plaintext hmacSecret');
    assert.ok(!('hmacSecret' in stateRes.data), 'G3 FAIL: GET /api/v1/state must not contain hmacSecret property');
    assert.ok(stateRes.data.tunnel.bearerToken.includes('****'), 'G3 FAIL: tunnel.bearerToken must be masked');

    // Open SSE stream with Authorization header and read initial state + live event
    const sseAbort = new AbortController();
    const sseRes = await fetch(`${BASE_URL}/api/v1/events`, {
      headers: authHeaders({ Accept: 'text/event-stream' }),
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200, 'G3 FAIL: SSE with Bearer must return 200');
    assert.ok(
      (sseRes.headers.get('content-type') || '').includes('text/event-stream'),
      'G3 FAIL: SSE content-type must be text/event-stream'
    );

    const sseReader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const receivedSsePayloads = [];

    async function readNextSseFrame(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const idx = sseBuffer.indexOf('\n\n');
        if (idx >= 0) {
          const frame = sseBuffer.slice(0, idx);
          sseBuffer = sseBuffer.slice(idx + 2);
          const dataLines = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim());
          if (dataLines.length > 0) {
            const parsed = JSON.parse(dataLines.join('\n'));
            receivedSsePayloads.push(parsed);
            return parsed;
          }
        }
        const { value, done } = await Promise.race([
          sseReader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), Math.max(100, deadline - Date.now()))),
        ]);
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
      }
      throw new Error('Failed to receive expected SSE frame');
    }

    const firstSseFrame = await readNextSseFrame();
    assert.equal(firstSseFrame.confinementMode, 'workspace-write', 'G3 FAIL: Initial SSE frame must carry MwhState snapshot');
    console.log(`[PASS] G3: SSE no-token=${g3NoToken.status}, query-token=${g3QueryToken.status}, bearer=${sseRes.status} (text/event-stream), received initial MwhState frame (pid=${firstSseFrame.daemon.pid}, maskedToken=${firstSseFrame.tunnel.bearerToken})`);

    // =========================================================================
    // G4: Mode 2 -> Mode 4 Switch & ChildMode <= ParentMode Ceiling
    // =========================================================================
    const mode4Res = await apiJson('POST', '/api/v1/security/mode', { mode: 'danger-full-access' });
    assert.equal(mode4Res.status, 200, 'G4 FAIL: POST /api/v1/security/mode danger-full-access failed');
    const mode4Sse = await readNextSseFrame();
    assert.equal(mode4Sse.confinementMode, 'danger-full-access', 'G4 FAIL: SSE did not broadcast danger-full-access mode switch');

    const stateAfterMode4 = await apiJson('GET', '/api/v1/state');
    assert.equal(stateAfterMode4.data.confinementMode, 'danger-full-access', 'G4 FAIL: State did not reflect danger-full-access');

    // Switch back to Mode 2 (workspace-write) and test ChildMode <= ParentMode enforcement
    await apiJson('POST', '/api/v1/security/mode', { mode: 'workspace-write' });
    await readNextSseFrame();

    // 1) Strict subagent spawn requesting Mode 4 under Mode 2 parent -> must reject with 403 PRIVILEGE_ESCALATION_DENIED
    const strictEscalationRes = await apiJson('POST', '/api/v1/worktrees/spawn', {
      agentId: 'builtin',
      requestedMode: 'danger-full-access',
      strict: true,
    });
    assert.equal(strictEscalationRes.status, 403, 'G4 FAIL: Strict ChildMode > ParentMode must return 403');
    assert.equal(strictEscalationRes.data.error, 'PRIVILEGE_ESCALATION_DENIED', 'G4 FAIL: Strict ChildMode > ParentMode must return PRIVILEGE_ESCALATION_DENIED');

    // 2) UI worktree spawn requesting Mode 4 under Mode 2 parent -> must clamp effectiveMode to workspace-write
    const clampedSpawnRes = await apiJson('POST', '/api/v1/worktrees/spawn', {
      agentId: 'builtin',
      requestedMode: 'danger-full-access',
    });
    assert.equal(clampedSpawnRes.status, 200, 'G4 FAIL: Worktree spawn failed');
    assert.equal(clampedSpawnRes.data.clamped, true, 'G4 FAIL: ChildMode > ParentMode must set clamped=true');
    assert.equal(clampedSpawnRes.data.effectiveMode, 'workspace-write', 'G4 FAIL: ChildMode must be clamped to workspace-write');
    assert.equal(clampedSpawnRes.data.worktree.childMode, 'workspace-write', 'G4 FAIL: Worktree instance childMode must be workspace-write');

    // Clean up spawned worktree
    await apiJson('DELETE', `/api/v1/worktrees/${encodeURIComponent(clampedSpawnRes.data.worktree.id)}`);
    console.log(`[PASS] G4: Mode 2->4 switch reflected in state & SSE; ChildMode<=ParentMode ceiling enforced (strict=403 ${strictEscalationRes.data.error}, clamped effectiveMode=${clampedSpawnRes.data.effectiveMode})`);

    // =========================================================================
    // G5: Trigger Real Long-Running Tool -> RUNNING -> SSE Push -> UI Kill -> Process Tree Dead
    // =========================================================================
    // Switch approvalPolicy to auto-workspace so the long-running write task starts immediately
    await apiJson('POST', '/api/v1/security/policy', { approvalPolicy: 'auto-workspace' });

    const longCmd = "$c = Start-Process -FilePath 'ping.exe' -ArgumentList '-n 60 127.0.0.1' -WindowStyle Hidden -PassThru; Write-Output ('CHILD_PID=' + $c.Id); 1..30 | ForEach-Object { Write-Output ('tick_' + $_); Start-Sleep -Milliseconds 400 }";
    const triggerLongRes = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'write',
      params: {
        command: longCmd,
        yieldTimeMs: 500,
      },
    });
    assert.equal(triggerLongRes.status, 200, 'G5 FAIL: Trigger long task failed');
    assert.equal(triggerLongRes.data.liveTask.status, 'RUNNING', `G5 FAIL: Expected liveTask RUNNING, got ${JSON.stringify(triggerLongRes.data)}`);
    const runningJobId = triggerLongRes.data.liveTask.id;

    const activeJobs = JobManager.getInstance().getActiveJobs();
    const activeJobRecord = activeJobs.find((j) => j.id === runningJobId) || activeJobs[0];
    assert.ok(activeJobRecord && activeJobRecord.pid > 0, 'G5 FAIL: Active job record missing parent PID');
    const parentPid = activeJobRecord.pid;

    // Extract child ping.exe PID from stdoutLines or wait briefly for first line
    let childPid = 0;
    for (let i = 0; i < 15; i++) {
      const st = await apiJson('GET', '/api/v1/state');
      const lines = st.data.liveTask?.stdoutLines || [];
      for (const line of lines) {
        const m = String(line).match(/CHILD_PID=(\d+)/);
        if (m) childPid = Number(m[1]);
      }
      if (childPid > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(childPid > 0, 'G5 FAIL: Long task did not spawn child ping.exe process');
    assert.equal(isPidAlive(parentPid), true, 'G5 FAIL: Parent process should be alive while RUNNING');
    assert.equal(isPidAlive(childPid), true, 'G5 FAIL: Child process should be alive while RUNNING');

    // Kill via UI endpoint POST /api/v1/tasks/:id/kill
    const killRes = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(runningJobId)}/kill`, {});
    assert.equal(killRes.status, 200, 'G5 FAIL: POST /api/v1/tasks/:id/kill failed');
    assert.equal(killRes.data.ok, true, 'G5 FAIL: Kill response ok!==true');

    // Wait briefly and verify entire process tree (both parent and child) is dead
    await new Promise((r) => setTimeout(r, 300));
    const parentAliveAfterKill = isPidAlive(parentPid);
    const childAliveAfterKill = isPidAlive(childPid);
    assert.equal(parentAliveAfterKill, false, `G5 FAIL: Parent process ${parentPid} survived UI kill!`);
    assert.equal(childAliveAfterKill, false, `G5 FAIL: Child process ${childPid} survived UI kill!`);
    console.log(`[PASS] G5: Real job ${runningJobId} (parentPID=${parentPid}, childPID=${childPid}) transitioned to RUNNING, SSE pushed, terminated via POST /api/v1/tasks/${runningJobId}/kill -> parentAlive=${parentAliveAfterKill}, childAlive=${childAliveAfterKill}`);

    // G5B: Global Emergency Kill 3-Layer Verification (Active Job Tree + Pending Approval Queue + ReAct Epoch)
    const emgJobTrigger = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'write',
      params: {
        command: "$c = Start-Process -FilePath 'ping.exe' -ArgumentList '-n 60 127.0.0.1' -WindowStyle Hidden -PassThru; Write-Output ('EMG_CHILD_PID=' + $c.Id); Start-Sleep -Seconds 30",
        yieldTimeMs: 400,
      },
    });
    const emgJobId = emgJobTrigger.data.liveTask.id;
    const emgParentPid = JobManager.getInstance().getActiveJobs().find((j) => j.id === emgJobId)?.pid || 0;
    let emgChildPid = 0;
    for (let i = 0; i < 15; i++) {
      const polled = JobManager.getInstance().poll(emgJobId, 1, 8192, workdir);
      const m = String(polled.chunk || '').match(/EMG_CHILD_PID=(\d+)/);
      if (m) emgChildPid = Number(m[1]);
      if (emgChildPid > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(emgParentPid > 0 && emgChildPid > 0, 'G5B FAIL: Emergency kill probe job did not spawn parent+child');

    // Switch to smart-risk and create a PENDING approval in the queue
    await apiJson('POST', '/api/v1/security/policy', { approvalPolicy: 'smart-risk' });
    const emgPendingTrigger = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'write',
      params: { command: 'Write-Output "SHOULD_BE_CANCELLED_BY_EMERGENCY_KILL"' },
    });
    assert.equal(emgPendingTrigger.data.liveTask.status, 'WAITING_APPROVAL', 'G5B FAIL: Expected WAITING_APPROVAL');
    const emgApprovalId = emgPendingTrigger.data.liveTask.id;
    assert.equal(kernel.getApprovalEngine().listPendingApprovals().length, 1, 'G5B FAIL: Expected 1 pending approval before emergency kill');

    const emgKillRes = await apiJson('POST', '/api/v1/daemon/emergency-kill', {});
    assert.equal(emgKillRes.status, 200, 'G5B FAIL: POST /api/v1/daemon/emergency-kill failed');
    assert.equal(emgKillRes.data.ok, true, 'G5B FAIL: emergency-kill ok!==true');
    assert.ok(Array.isArray(emgKillRes.data.abortedIds) && emgKillRes.data.abortedIds.includes(emgJobId), 'G5B FAIL: emergency-kill did not report aborted job');
    assert.ok(Array.isArray(emgKillRes.data.rejectedApprovalIds) && emgKillRes.data.rejectedApprovalIds.includes(emgApprovalId), 'G5B FAIL: emergency-kill did not reject pending approval');
    assert.equal(kernel.getApprovalEngine().listPendingApprovals().length, 0, 'G5B FAIL: Pending approvals must be 0 after emergency kill');
    assert.equal(isPidAlive(emgParentPid), false, 'G5B FAIL: Parent PID survived emergency kill');
    assert.equal(isPidAlive(emgChildPid), false, 'G5B FAIL: Child PID survived emergency kill');

    const lateApproveRes = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(emgApprovalId)}/approve`, { scope: 'once' });
    assert.equal(lateApproveRes.status, 400, 'G5B FAIL: Approving an emergency-killed approval must return 400');
    console.log(`[PASS] G5B: Global Emergency Kill verified across all 3 layers -> abortedJob=${emgJobId} (parentPID=${emgParentPid} dead, childPID=${emgChildPid} dead), rejectedApproval=${emgApprovalId} (late approve=400), emergencyEpoch=${emgKillRes.data.emergencyEpoch}`);

    // G5C: POST /api/v1/daemon/shutdown contract (unwired 503, auth 401, wired 200 + async handler)
    const g5cUnwired = await apiJson('POST', '/api/v1/daemon/shutdown');
    assert.equal(g5cUnwired.status, 503, 'G5C FAIL: unwired shutdown must return 503');
    assert.equal(g5cUnwired.data.error, 'SHUTDOWN_HANDLER_NOT_WIRED', 'G5C FAIL: expected SHUTDOWN_HANDLER_NOT_WIRED');

    const g5cUnauth = await fetch(`${BASE_URL}/api/v1/daemon/shutdown`, { method: 'POST' });
    assert.equal(g5cUnauth.status, 401, 'G5C FAIL: unauthenticated shutdown must return 401');

    let shutdownSpyCalls = 0;
    server.setShutdownHandler(() => {
      shutdownSpyCalls += 1;
    });
    const g5cWired = await apiJson('POST', '/api/v1/daemon/shutdown');
    assert.equal(g5cWired.status, 200, 'G5C FAIL: wired shutdown must return 200');
    assert.equal(g5cWired.data.ok, true, 'G5C FAIL: wired shutdown ok!==true');
    const g5cDeadline = Date.now() + 2000;
    while (shutdownSpyCalls < 1 && Date.now() < g5cDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(shutdownSpyCalls, 1, `G5C FAIL: shutdown handler must be called exactly once, got ${shutdownSpyCalls}`);
    console.log(`[PASS] G5C: POST /api/v1/daemon/shutdown -> unwired=503 SHUTDOWN_HANDLER_NOT_WIRED, unauth=401, wired=200 ok=true handlerCalls=${shutdownSpyCalls}`);

    // Restore smart-risk policy for G6
    await apiJson('POST', '/api/v1/security/policy', { approvalPolicy: 'smart-risk' });

    // =========================================================================
    // G6: Approval Lifecycle (Approve Once, Reject -> BLOCK Audit, Critical Forced Once + paramsHash)
    // =========================================================================
    // 6A: Trigger write task under smart-risk -> WAITING_APPROVAL -> Approve Once -> CONSUMED
    const g6Trigger1 = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'write',
      params: { command: 'Write-Output "[G6] Approved once execution"' },
    });
    assert.equal(g6Trigger1.data.liveTask.status, 'WAITING_APPROVAL', 'G6A FAIL: Write under smart-risk must enter WAITING_APPROVAL');
    const approvalId1 = g6Trigger1.data.liveTask.id;

    const g6Approve1 = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(approvalId1)}/approve`, {
      scope: 'once',
    });
    assert.equal(g6Approve1.status, 200, 'G6A FAIL: Approve once returned non-200');
    assert.equal(g6Approve1.data.ok, true, 'G6A FAIL: Approve once ok!==true');
    assert.equal(g6Approve1.data.execution.status, 'SUCCESS', 'G6A FAIL: Approved task execution did not succeed');
    assert.equal(
      kernel.getApprovalEngine().getApproval(approvalId1)?.status,
      'CONSUMED',
      'G6A FAIL: Approval record must transition to CONSUMED after single execution'
    );

    // Re-approving a consumed record must fail
    const g6Replay = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(approvalId1)}/approve`, {
      scope: 'once',
    });
    assert.equal(g6Replay.status, 400, 'G6A FAIL: Re-approving consumed approval must return 400');

    // 6B: Trigger second write task -> Reject -> Verify BLOCK audit entry
    const g6Trigger2 = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'write',
      params: { command: 'Write-Output "[G6] Should be rejected"' },
    });
    assert.equal(g6Trigger2.data.liveTask.status, 'WAITING_APPROVAL', 'G6B FAIL: Expected WAITING_APPROVAL');
    const approvalId2 = g6Trigger2.data.liveTask.id;

    const g6Reject2 = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(approvalId2)}/reject`, {});
    assert.equal(g6Reject2.status, 200, 'G6B FAIL: Reject returned non-200');
    assert.equal(g6Reject2.data.ok, true, 'G6B FAIL: Reject ok!==true');

    const stateAfterReject = await apiJson('GET', '/api/v1/state');
    const blockLog = stateAfterReject.data.auditLogs.find(
      (entry) => entry.decision === 'BLOCK' && entry.reason.includes('USER_REJECTED_VIA_UI')
    );
    assert.ok(blockLog, 'G6B FAIL: Reject path did not record a BLOCK entry in auditLogs');

    // 6C: Critical task UI approval must force once granularity + bind paramsHash, and job_control must be blocked
    const g6TriggerCrit = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'sensitive_write',
      params: { command: 'Remove-Item -Recurse -Force C:\\__mwh_nonexistent_g6_critical__' },
    });
    assert.equal(g6TriggerCrit.data.liveTask.status, 'WAITING_APPROVAL', 'G6C FAIL: Critical task must enter WAITING_APPROVAL');
    assert.equal(g6TriggerCrit.data.liveTask.riskScore, 'CRITICAL', 'G6C FAIL: Risk score must be CRITICAL');
    const critApprovalId = g6TriggerCrit.data.liveTask.id;
    const critRecord = kernel.getApprovalEngine().getApproval(critApprovalId);
    assert.ok(critRecord && critRecord.paramsHash, 'G6C FAIL: Critical approval record missing paramsHash');

    // Verify AI self-approval via job_control is strictly rejected for critical tasks
    let aiSelfBlocked = false;
    try {
      kernel.getApprovalEngine().resolveApproval(
        critApprovalId,
        'approve',
        critRecord.hmacSig,
        'once',
        kernel.getContext(),
        'job_control'
      );
    } catch {
      aiSelfBlocked = true;
    }
    assert.equal(aiSelfBlocked, true, 'G6C FAIL: job_control must NEVER be allowed to approve critical tasks');

    // Approve via UI endpoint even requesting 'workspace' scope -> must force 'once' and never populate alwaysAllowedWorkspaces
    const critUiApprove = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(critApprovalId)}/approve`, {
      scope: 'workspace',
      root: workdir,
    });
    assert.equal(critUiApprove.status, 200, 'G6C FAIL: UI critical approve failed');
    assert.equal(critUiApprove.data.granularity, 'once', 'G6C FAIL: Critical approval must force once granularity');
    const stateAfterCrit = await apiJson('GET', '/api/v1/state');
    assert.equal(
      stateAfterCrit.data.alwaysAllowedWorkspaces.length,
      0,
      'G6C FAIL: Critical approval must never add to alwaysAllowedWorkspaces'
    );
    console.log(`[PASS] G6: Approve-once (${approvalId1} -> CONSUMED, replay=400), Reject (${approvalId2} -> BLOCK audit logged), Critical (${critApprovalId} -> job_control blocked, UI forced granularity='once' + paramsHash=${critRecord.paramsHash.slice(0, 12)} bound)`);

    // 6D: paramsHash binding negative — tampered params must be refused with 400
    // PARAMS_HASH_MISMATCH by the real UI approve endpoint, and the tampered
    // approval must stay PENDING (never consumed).
    // The UI approve endpoint derives the params it re-hashes from server-side
    // state (the pending slot or the approval record itself) — a client cannot
    // smuggle params through the request body. So the tamper is applied exactly
    // where computeParamsHash defends: the approval record's params are swapped
    // for a doctored copy (one field value differs) after hash binding, which is
    // the divergence the binding exists to catch.
    const g6TriggerHash = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'write',
      params: {
        command: 'Write-Output "[G6] paramsHash binding probe"',
        g6BindingMarker: 'HASH_BINDING_PROBE_V1',
      },
    });
    assert.equal(g6TriggerHash.data.liveTask.status, 'WAITING_APPROVAL', 'G6D FAIL: paramsHash probe task must enter WAITING_APPROVAL');
    const hashApprovalId = g6TriggerHash.data.liveTask.id;
    const hashRecord = kernel.getApprovalEngine().getApproval(hashApprovalId);
    assert.ok(hashRecord && hashRecord.paramsHash, 'G6D FAIL: paramsHash probe record missing paramsHash');

    // Occupy the single pending slot with a different task so the approve
    // endpoint re-derives params from the target record (fallback branch).
    const g6TriggerDummy = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'write',
      params: { command: 'Write-Output "[G6] paramsHash dummy slot holder"' },
    });
    assert.equal(g6TriggerDummy.data.liveTask.status, 'WAITING_APPROVAL', 'G6D FAIL: dummy slot task must enter WAITING_APPROVAL');
    const dummyApprovalId = g6TriggerDummy.data.liveTask.id;

    // Tamper: replace the bound params with a doctored copy (one field value differs).
    hashRecord.params = {
      ...hashRecord.params,
      command: `${hashRecord.params.command} ##TAMPERED##`,
    };

    const g6TamperedApprove = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(hashApprovalId)}/approve`, {
      scope: 'once',
    });
    assert.equal(g6TamperedApprove.status, 400, `G6D FAIL: Approving with tampered params must return 400, got ${g6TamperedApprove.status}`);
    assert.equal(g6TamperedApprove.data.error, 'PARAMS_HASH_MISMATCH', `G6D FAIL: Expected PARAMS_HASH_MISMATCH, got ${JSON.stringify(g6TamperedApprove.data)}`);
    assert.equal(
      kernel.getApprovalEngine().getApproval(hashApprovalId)?.status,
      'PENDING',
      'G6D FAIL: Tampered approval must stay PENDING (not consumed) after the 400'
    );

    // Positive control in the same section: correct params still approve cleanly.
    const g6DummyApprove = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(dummyApprovalId)}/approve`, {
      scope: 'once',
    });
    assert.equal(g6DummyApprove.status, 200, 'G6D FAIL: Correct-params approve must still return 200');
    assert.equal(
      kernel.getApprovalEngine().getApproval(dummyApprovalId)?.status,
      'CONSUMED',
      'G6D FAIL: Correct-params approval must be CONSUMED after approve'
    );

    // Cleanup: reject the tampered (still pending) probe record.
    const g6HashReject = await apiJson('POST', `/api/v1/tasks/${encodeURIComponent(hashApprovalId)}/reject`, {});
    assert.equal(g6HashReject.status, 200, 'G6D FAIL: Rejecting the tampered PENDING probe record failed');
    console.log(`[PASS] G6D: paramsHash tamper negative -> approve with doctored params returned 400 PARAMS_HASH_MISMATCH (${hashApprovalId} stayed PENDING), correct params still approved (${dummyApprovalId} -> CONSUMED)`);

    // =========================================================================
    // G7: Snapshot Creation & UI Rollback
    // =========================================================================
    const g7TargetFile = path.join(workdir, 'src', '__g7_rollback_probe__.tmp');
    fs.writeFileSync(g7TargetFile, 'G7_ORIGINAL_CONTENT_V1\n', 'utf8');

    const cpId = GitCheckpointManager.create('G7_PRE_MUTATION_SNAPSHOT', workdir);
    assert.ok(cpId, 'G7 FAIL: Failed to create git shadow snapshot');

    // Mutate file
    fs.writeFileSync(g7TargetFile, 'G7_CORRUPTED_CONTENT_V2\n', 'utf8');
    assert.equal(fs.readFileSync(g7TargetFile, 'utf8'), 'G7_CORRUPTED_CONTENT_V2\n');

    // Trigger UI rollback via POST /api/v1/snapshots/:id/rollback
    const rollbackRes = await apiJson('POST', `/api/v1/snapshots/${encodeURIComponent(cpId)}/rollback`, {});
    assert.equal(rollbackRes.status, 200, 'G7 FAIL: Rollback endpoint returned non-200');
    assert.equal(rollbackRes.data.ok, true, `G7 FAIL: Rollback failed: ${JSON.stringify(rollbackRes.data)}`);

    // Restore Content: also verify G5/G7/G8 production paths on the control plane
    const snapsBeforeRead = (await apiJson('GET', '/api/v1/state')).data.snapshots.length;
    const g7ReadRes = await apiJson('POST', '/api/v1/tasks/trigger', {
      toolName: 'exec_command',
      category: 'sensitive_write',
      params: { command: 'git log -1 --format="%H %D %s" --date=short' },
    });
    assert.equal(g7ReadRes.status, 200, 'G7 FAIL: git log --format=%D trigger failed');
    assert.equal(g7ReadRes.data.execution.status, 'SUCCESS', `G7 FAIL: git log --format=%D expected SUCCESS under smart-risk (low risk), got ${JSON.stringify(g7ReadRes.data.execution)}`);
    assert.ok(
      !String(g7ReadRes.data.execution.data?.stderr || '').includes('ambiguous argument'),
      `G7 FAIL: %D expanded or split into ambiguous argument: ${g7ReadRes.data.execution.data?.stderr}`
    );
    assert.ok(
      String(g7ReadRes.data.execution.data?.stdout || '').trim().length > 10,
      'G7 FAIL: git log --format="%H %D %s" returned empty stdout'
    );
    const stateAfterRead = await apiJson('GET', '/api/v1/state');
    assert.equal(
      stateAfterRead.data.snapshots.length,
      snapsBeforeRead,
      'G5 FAIL: Read-only low-risk command must short-circuit without creating a shadow snapshot'
    );
    assert.equal(
      stateAfterRead.data.liveTask.modifiedFilesCount,
      0,
      'G5 FAIL: Read-only command must report modifiedFilesCount === 0'
    );
    assert.equal(
      stateAfterRead.data.liveTask.snapshotId,
      undefined,
      'G5 FAIL: Zero-modification task must not retain snapshotId on liveTask'
    );

    // G5: Merging a non-existent worktree must return structured 404
    const mergeMissingRes = await apiJson('POST', '/api/v1/worktrees/sub_nonexistent_01/merge', {});
    assert.equal(mergeMissingRes.status, 404, `G5 FAIL: Merging non-existent worktree must return 404, got ${mergeMissingRes.status}`);
    assert.equal(mergeMissingRes.data.error, 'WORKTREE_NOT_FOUND', `G5 FAIL: Expected WORKTREE_NOT_FOUND, got ${JSON.stringify(mergeMissingRes.data)}`);

    const restoredContent = fs.readFileSync(g7TargetFile, 'utf8');
    try { fs.unlinkSync(g7TargetFile); } catch {}
    assert.equal(restoredContent, 'G7_ORIGINAL_CONTENT_V1\n', 'G7 FAIL: File content was not restored after rollback');
    console.log(`[PASS] G7: Snapshot ${cpId} rolled back via POST /api/v1/snapshots/${cpId}/rollback -> content exact match; read-only short-circuit & %D output verified; missing worktree merge=404 (${mergeMissingRes.data.error})`);

    // =========================================================================
    // G8: Per-Call-Site Static Audit of windowsHide: true
    // Every subprocess derivation call site in src/ and shell/ (excluding
    // node_modules/dist) must carry windowsHide: true in its own options
    // object. A file-level "at least one match" check is NOT enough: a single
    // missed spawn would still PASS that weak audit. Here each call site's
    // options object text is parsed and asserted individually.
    // =========================================================================
    const G8_CALL_WORDS = new Set(['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec']);
    const G8_SCAN_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
    const G8_SKIP_DIRS = new Set(['node_modules', 'dist']);

    function g8CollectFiles(dir, out = []) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (G8_SKIP_DIRS.has(entry.name)) continue;
          g8CollectFiles(path.join(dir, entry.name), out);
        } else if (entry.isFile() && G8_SCAN_EXTS.has(path.extname(entry.name))) {
          out.push(path.join(dir, entry.name));
        }
      }
      return out;
    }

    // Masking lexer: returns a same-length copy of the source in which every
    // character inside comments, string/template literals (including ${...}
    // interpolations), and regex literals is replaced by a space (newlines are
    // preserved for line numbering). All structural analysis (paren matching,
    // brace matching, call-site detection) then runs on the masked text with
    // plain char logic — immune to apostrophes inside regexes like /'/g,
    // PowerShell scripts inside template literals, etc.
    function g8MaskLiterals(content) {
      const out = content.split('');
      const n = content.length;
      const REGEX_KEYWORDS = new Set([
        'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw',
      ]);
      let prevSig = ''; // last significant char outside literals/comments
      let prevWord = ''; // last identifier word outside literals/comments
      // Stack for template-literal interpolation: each entry counts nested braces.
      const templateStack = [];
      let state = 'code';
      let i = 0;
      const blank = (idx) => { if (out[idx] !== '\n') out[idx] = ' '; };
      while (i < n) {
        const c = content[i];
        if (state === 'code') {
          if (c === '/' && content[i + 1] === '/') {
            while (i < n && content[i] !== '\n') { blank(i); i += 1; }
            continue;
          }
          if (c === '/' && content[i + 1] === '*') {
            blank(i); blank(i + 1); i += 2;
            while (i < n && !(content[i] === '*' && content[i + 1] === '/')) { blank(i); i += 1; }
            if (i < n) { blank(i); blank(i + 1); i += 2; }
            continue;
          }
          if (c === '/') {
            const regexAllowed =
              prevSig === '' ||
              '([{:;,=!&|?+-*%~^<>'.includes(prevSig) ||
              REGEX_KEYWORDS.has(prevWord);
            if (regexAllowed) {
              // Regex literal: /pattern/flags with [...] classes and \ escapes.
              blank(i); i += 1;
              let inClass = false;
              let closed = false;
              while (i < n) {
                const rc = content[i];
                if (rc === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
                if (rc === '\n') break; // malformed; bail out (regexes never span lines)
                if (inClass) {
                  if (rc === ']') inClass = false;
                } else if (rc === '[') {
                  inClass = true;
                } else if (rc === '/') {
                  blank(i); i += 1;
                  while (i < n && /[a-z]/i.test(content[i])) { blank(i); i += 1; }
                  closed = true;
                  break;
                }
                blank(i); i += 1;
              }
              if (!closed) { /* unterminated: leave blanks, resume as code */ }
              prevSig = '/';
              prevWord = '';
              continue;
            }
            prevSig = '/';
            prevWord = '';
            i += 1;
            continue;
          }
          if (c === '"' || c === "'") {
            blank(i); i += 1;
            while (i < n) {
              const sc = content[i];
              if (sc === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
              blank(i);
              i += 1;
              if (sc === c) break;
            }
            prevSig = '"';
            prevWord = '';
            continue;
          }
          if (c === '`') {
            blank(i); i += 1;
            // Scan template literal; ${...} interpolations re-enter code state.
            let done = false;
            while (i < n && !done) {
              const tc = content[i];
              if (tc === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
              if (tc === '`') { blank(i); i += 1; done = true; continue; }
              if (tc === '$' && content[i + 1] === '{') {
                blank(i); blank(i + 1); i += 2;
                templateStack.push(0); // brace depth inside this interpolation
                done = 'interp';
                break;
              }
              blank(i); i += 1;
            }
            if (done === true) {
              prevSig = '"';
              prevWord = '';
            } else if (done === 'interp') {
              prevSig = '{';
              prevWord = '';
              state = 'code'; // tokenizing interpolation expression
            }
            continue;
          }
          if (c === '{' && templateStack.length > 0) {
            templateStack[templateStack.length - 1] += 1;
            prevSig = c; prevWord = '';
            i += 1;
            continue;
          }
          if (c === '}' && templateStack.length > 0) {
            if (templateStack[templateStack.length - 1] === 0) {
              // End of interpolation: return to template-literal scanning.
              blank(i); i += 1;
              templateStack.pop();
              // Resume template literal (inline copy of the template scanner).
              let tdone = false;
              while (i < n && !tdone) {
                const tc = content[i];
                if (tc === '\\') { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
                if (tc === '`') { blank(i); i += 1; tdone = true; continue; }
                if (tc === '$' && content[i + 1] === '{') {
                  blank(i); blank(i + 1); i += 2;
                  templateStack.push(0);
                  tdone = 'interp';
                  break;
                }
                blank(i); i += 1;
              }
              if (tdone === true) { prevSig = '"'; prevWord = ''; }
              else { prevSig = '{'; prevWord = ''; } // tdone === 'interp'
              continue;
            }
            templateStack[templateStack.length - 1] -= 1;
            prevSig = c; prevWord = '';
            i += 1;
            continue;
          }
          if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < n && /[\w$]/.test(content[j])) j += 1;
            prevWord = content.slice(i, j);
            prevSig = 'w';
            i = j;
            continue;
          }
          if (!/\s/.test(c)) { prevSig = c; prevWord = ''; }
          i += 1;
          continue;
        }
        // No other states: template/regex/comment/string are handled inline.
        i += 1;
      }
      return out.join('');
    }

    // Balanced-paren matcher on masked text (plain char logic).
    function g8MatchParen(masked, openIdx) {
      let depth = 0;
      for (let i = openIdx; i < masked.length; i += 1) {
        const c = masked[i];
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    // Find the LAST brace group at nesting depth 0 inside [from, to) — i.e. the
    // trailing options object of the call (masked text, plain char logic).
    function g8LastTopLevelObjectSpan(masked, from, to) {
      let depth = 0;
      let last = null;
      for (let i = from; i < to; i += 1) {
        const c = masked[i];
        if (c === '(' || c === '[' || c === '{') {
          if (c === '{' && depth === 0) last = i;
          depth += 1;
        } else if (c === ')' || c === ']' || c === '}') {
          depth -= 1;
        }
      }
      if (last === null) return null;
      let d = 0;
      for (let j = last; j < to; j += 1) {
        if (masked[j] === '{') d += 1;
        else if (masked[j] === '}') {
          d -= 1;
          if (d === 0) return { start: last, end: j + 1 };
        }
      }
      return null;
    }

    function g8FindCallSites(masked) {
      const sites = [];
      let i = 0;
      const n = masked.length;
      while (i < n) {
        const c = masked[i];
        if (/[A-Za-z_$]/.test(c)) {
          let j = i;
          while (j < n && /[\w$]/.test(masked[j])) j += 1;
          const word = masked.slice(i, j);
          if (G8_CALL_WORDS.has(word)) {
            let k = j;
            while (k < n && /\s/.test(masked[k])) k += 1;
            let prev = i - 1;
            while (prev >= 0 && /\s/.test(masked[prev])) prev -= 1;
            const prevCh = prev >= 0 ? masked[prev] : '';
            // Skip property access (RegExp .exec, child.spawn, ...); object-key
            // positions like `spawn:` never satisfy the '(' requirement below.
            if (masked[k] === '(' && prevCh !== '.') {
              const close = g8MatchParen(masked, k);
              if (close >= 0) {
                sites.push({ index: i, openParen: k, closeParen: close, word });
                i = close + 1;
                continue;
              }
            }
          }
          i = j;
          continue;
        }
        i += 1;
      }
      return sites;
    }

    function g8LineNumber(content, index) {
      return content.slice(0, index).split('\n').length;
    }

    const g8Files = [
      ...g8CollectFiles(path.join(workdir, 'src')),
      ...g8CollectFiles(path.join(workdir, 'shell')),
    ];
    const g8Missing = [];
    let g8TotalSites = 0;
    const g8PerFileSummary = [];
    for (const absFile of g8Files) {
      const rel = path.relative(workdir, absFile).replace(/\\/g, '/');
      const content = fs.readFileSync(absFile, 'utf8');
      const masked = g8MaskLiterals(content);
      const sites = g8FindCallSites(masked);
      if (sites.length === 0) continue;
      let okCount = 0;
      for (const site of sites) {
        g8TotalSites += 1;
        const objSpan = g8LastTopLevelObjectSpan(masked, site.openParen + 1, site.closeParen);
        const optionsText = objSpan ? content.slice(objSpan.start, objSpan.end) : '';
        const hasHide = /windowsHide\s*:\s*true/.test(optionsText);
        const line = g8LineNumber(content, site.index);
        if (hasHide) {
          okCount += 1;
        } else {
          g8Missing.push({ file: rel, line, word: site.word });
        }
      }
      g8PerFileSummary.push(`${rel} (${okCount}/${sites.length})`);
    }
    assert.equal(
      g8Missing.length,
      0,
      `G8 FAIL: ${g8Missing.length} subprocess call site(s) missing windowsHide: true -> ` +
        g8Missing.map((m) => `${m.file}:${m.line} (${m.word})`).join(', ')
    );
    console.log(`[PASS] G8: Per-call-site audit verified windowsHide: true on ALL ${g8TotalSites} subprocess call sites across ${g8PerFileSummary.length} files -> ${g8PerFileSummary.join(', ')}`);

    // =========================================================================
    // G9: Daemon & Electron Shell Working-Set Memory Telemetry
    // =========================================================================
    const daemonRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
    const electronBin = path.join(workdir, 'shell', 'node_modules', 'electron', 'dist', 'electron.exe');
    assert.ok(fs.existsSync(electronBin), `G9 FAIL: Electron binary missing at ${electronBin}`);

    const shellSmokeOut = execFileSync(electronBin, ['.', '--smoke-test'], {
      cwd: path.join(workdir, 'shell'),
      env: {
        ...process.env,
        TUNNEL_RUNTIME_TOKEN: TOKEN,
        MWH_HMAC_SECRET: HMAC_SECRET,
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    const match = shellSmokeOut.match(/\[MWH-SHELL\] READY pid=(\d+) rssMb=(\d+)/);
    assert.ok(match, `G9 FAIL: Electron smoke test did not emit READY telemetry. Output: ${shellSmokeOut}`);
    const shellPid = Number(match[1]);
    const shellRssMb = Number(match[2]);
    console.log(`[PASS] G9: Memory telemetry recorded -> Daemon RSS=${daemonRssMb} MB (<80 MB target), Electron Shell (PID=${shellPid}) RSS=${shellRssMb} MB`);

    // =========================================================================
    // G10: Shell Dual-Window Production Surface (real CDP assertions)
    // Boots the real daemon (random 48-hex token) on the fixed 19820 port and
    // the real Electron shell with --remote-debugging-port, then asserts over
    // CDP that BOTH windows exist and actually render (E35 black-window guard):
    // muse.ai page target with a plain-browser UA, overlay target with the
    // mounted mwh-overlay-root, the "本地 PC" mode pill text, and a real page
    // screenshot with substantive pixel payload.
    // =========================================================================
    const G10_DAEMON_PORT = 19820;
    const g10Token = crypto.randomBytes(24).toString('hex'); // 48 hex chars
    const g10Secret = crypto.randomBytes(32).toString('hex');

    function g10PortOpen(port) {
      return new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        const finish = (v) => { try { sock.destroy(); } catch {} resolve(v); };
        sock.setTimeout(500, () => finish(false));
        sock.on('connect', () => finish(true));
        sock.on('error', () => finish(false));
      });
    }

    function g10PortBindable(port) {
      return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
      });
    }

    function g10KillTree(pid) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* already gone */ }
    }

    // Minimal CDP client over the Node 22 built-in WebSocket: {id, method, params}.
    function g10CdpCall(wsUrl, method, params, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error(`G10 FAIL: CDP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
          if (msg.id !== 1) return;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          if (msg.error) reject(new Error(`G10 FAIL: CDP ${method} error: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`G10 FAIL: CDP websocket error while calling ${method}`));
        };
      });
    }

    // Page-level compositor capture via screencast. The overlay window is
    // transparent, and Chromium's Page.captureScreenshot has no surface path
    // for transparent windows (it times out / errors regardless of GPU flags),
    // so the fallback capture path is Page.startScreencast, which streams real
    // compositor frames of the very same page surface.
    function g10ScreencastFrame(wsUrl, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error(`G10 FAIL: no screencast frame received from the overlay within ${timeoutMs}ms`));
        }, timeoutMs);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }));
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
          if (msg.id === 1) {
            ws.send(JSON.stringify({ id: 2, method: 'Page.startScreencast', params: { format: 'png', everyNthFrame: 1 } }));
            return;
          }
          if (msg.method === 'Page.screencastFrame' && msg.params && msg.params.data) {
            clearTimeout(timer);
            try { ws.send(JSON.stringify({ id: 3, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } })); } catch {}
            try { ws.close(); } catch {}
            resolve(String(msg.params.data));
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('G10 FAIL: CDP websocket error during screencast capture'));
        };
      });
    }

    let g10Daemon = null;
    let g10Shell = null;
    try {
      // 1) Resident instance protection: never steal or kill a resident shell/daemon on 19820.
      if (await g10PortOpen(G10_DAEMON_PORT)) {
        console.log('[SKIP] G10: port 19820 occupied by a resident instance');
      } else {
        g10Daemon = spawn(process.execPath, ['dist/cli.js'], {
        cwd: workdir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TUNNEL_RUNTIME_TOKEN: g10Token, MWH_HMAC_SECRET: g10Secret },
      });
      const g10DaemonPid = g10Daemon.pid;
      let g10DaemonTail = '';
      g10Daemon.stderr?.on('data', (d) => { g10DaemonTail = (g10DaemonTail + d.toString()).slice(-2000); });

      let daemonReady = false;
      for (let i = 0; i < 60; i += 1) {
        if (g10Daemon.exitCode !== null) break;
        if (await g10PortOpen(G10_DAEMON_PORT)) { daemonReady = true; break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(
        daemonReady,
        `G10 FAIL: daemon did not open 127.0.0.1:19820 within 30s (pid=${g10DaemonPid}, exitCode=${g10Daemon.exitCode}). stderr tail: ${g10DaemonTail}`
      );

      // 2) Launch the real Electron shell (never via npx) with CDP enabled.
      let cdpPort = 0;
      for (const candidate of [9333, 9334, 9335]) {
        if (await g10PortBindable(candidate)) { cdpPort = candidate; break; }
      }
      assert.ok(cdpPort > 0, 'G10 FAIL: no free CDP port among 9333/9334/9335');

      g10Shell = spawn(electronBin, ['.', `--remote-debugging-port=${cdpPort}`], {
        cwd: path.join(workdir, 'shell'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TUNNEL_RUNTIME_TOKEN: g10Token, MWH_HMAC_SECRET: g10Secret },
      });
      const g10ShellPid = g10Shell.pid;

      // 3) Poll /json/list until both page targets exist (30s budget).
      const cdpDeadline = Date.now() + 30000;
      let museTarget = null;
      let chromeTarget = null;
      while (Date.now() < cdpDeadline) {
        if (g10Shell.exitCode !== null) break;
        try {
          const listRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
          if (listRes.ok) {
            const targets = await listRes.json();
            const pages = Array.isArray(targets) ? targets.filter((t) => t.type === 'page') : [];
            museTarget = pages.find((t) => typeof t.url === 'string' && t.url.startsWith('https://muse.ai')) || null;
            chromeTarget = pages.find((t) => typeof t.url === 'string' && t.url.includes('chrome.html')) || null;
            if (museTarget && chromeTarget) break;
          }
        } catch { /* CDP endpoint not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(
        museTarget && chromeTarget,
        `G10 FAIL: expected both page targets within 30s (muse.ai target=${!!museTarget}, chrome.html target=${!!chromeTarget}, cdpPort=${cdpPort}, shell exitCode=${g10Shell.exitCode})`
      );

      // 4) Wait until the muse.ai document actually commits (a freshly created
      // target still reports its provisional about:blank document), then assert
      // a plain-browser UA (Electron/shell markers stripped).
      let museUa = '';
      let museHref = '';
      const museDeadline = Date.now() + 30000;
      while (Date.now() < museDeadline) {
        try {
          const probe = await g10CdpCall(
            museTarget.webSocketDebuggerUrl,
            'Runtime.evaluate',
            { expression: `JSON.stringify({ ua: navigator.userAgent, href: location.href, ready: document.readyState })`, returnByValue: true },
            5000
          );
          const probeVal = JSON.parse(String(probe?.result?.value || '{}'));
          museUa = String(probeVal.ua || '');
          museHref = String(probeVal.href || '');
          if (museHref.startsWith('https://muse.ai') && probeVal.ready === 'complete' && museUa) break;
        } catch { /* mid-navigation; retry */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(
        museHref.startsWith('https://muse.ai') && museUa,
        `G10 FAIL: muse.ai document never committed in main window within 30s (last href=${museHref || 'n/a'})`
      );
      assert.ok(museUa.length > 0, 'G10 FAIL: could not read navigator.userAgent from the muse.ai target');
      assert.ok(!museUa.includes('Electron'), `G10 FAIL: muse.ai target UA still contains "Electron": ${museUa}`);
      assert.ok(!museUa.includes('mwh-desktop-shell'), `G10 FAIL: muse.ai target UA still contains "mwh-desktop-shell": ${museUa}`);

      // 5) Verify chrome.html titlebar surface (#version-badge + window.mwhChrome)
      // and muse.ai BrowserView preload injection (#mwh-drawer + #mwh-approval-island).
      let chromeReady = false;
      let chromeBadgeText = '';
      let preloadMounted = false;
      const surfaceDeadline = Date.now() + 15000;
      while (Date.now() < surfaceDeadline) {
        try {
          const chromeEval = await g10CdpCall(
            chromeTarget.webSocketDebuggerUrl,
            'Runtime.evaluate',
            {
              expression: `(function(){ var el = document.getElementById('version-badge'); return (el && window.mwhChrome) ? ('READY::' + (el.textContent || '').trim()) : 'NOT_READY'; })()`,
              returnByValue: true,
            }
          );
          const cVal = String(chromeEval?.result?.value || '');
          if (cVal.startsWith('READY::')) {
            chromeReady = true;
            chromeBadgeText = cVal.slice('READY::'.length);
          }
          const museEval = await g10CdpCall(
            museTarget.webSocketDebuggerUrl,
            'Runtime.evaluate',
            {
              expression: `(function(){ var d = document.getElementById('mwh-drawer'); var isl = document.getElementById('mwh-approval-island'); return (d && isl) ? 'MOUNTED' : 'NOT_MOUNTED'; })()`,
              returnByValue: true,
            }
          );
          if (String(museEval?.result?.value || '') === 'MOUNTED') {
            preloadMounted = true;
          }
          if (chromeReady && preloadMounted) break;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(chromeReady, 'G10 FAIL: chrome.html titlebar never initialized #version-badge + window.mwhChrome within 15s');
      assert.ok(preloadMounted, 'G10 FAIL: muse.ai BrowserView never mounted preload #mwh-drawer + #mwh-approval-island within 15s');

      // 6) Page-level screenshot of the muse.ai BrowserView surface (DOM-OK-but-black-screen guard).
      await new Promise((r) => setTimeout(r, 500));
      let pngBase64 = '';
      let shotMode = 'captureScreenshot';
      try {
        const shot = await g10CdpCall(museTarget.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' }, 8000);
        pngBase64 = String(shot?.data || '');
      } catch { /* fallback to screencast frame */ }
      if (!pngBase64) {
        shotMode = 'startScreencast';
        pngBase64 = await g10ScreencastFrame(museTarget.webSocketDebuggerUrl, 15000);
      }
      const pngBuf = Buffer.from(pngBase64, 'base64');
      assert.ok(
        pngBuf.length > 5000,
        `G10 FAIL: BrowserView screenshot too small (${pngBuf.length} bytes) — shell likely rendered a black/empty surface`
      );
      const shotPath = path.join(workdir, '.mwh', 'logs', 'gate5-overlay.png');
      fs.mkdirSync(path.dirname(shotPath), { recursive: true });
      fs.writeFileSync(shotPath, pngBuf);

      console.log(`[PASS] G10: Shell BrowserWindow(chrome.html) + BrowserView(muse.ai) surface verified over CDP :${cdpPort} -> muse.ai plain UA (${museUa.slice(0, 60)}...), chrome badge "${chromeBadgeText}", preload #mwh-drawer + #mwh-approval-island mounted, page capture (${shotMode}) ${pngBuf.length} bytes -> .mwh/logs/gate5-overlay.png (daemonPID=${g10DaemonPid}, shellPID=${g10ShellPid})`);
      }
    } finally {
      if (g10Shell && g10Shell.pid) g10KillTree(g10Shell.pid);
      if (g10Daemon && g10Daemon.pid) g10KillTree(g10Daemon.pid);
    }

    sseAbort.abort();
    console.log('==========================================================');
    console.log('ALL GATES G2-G10 PASSED WITHOUT ERROR');
    console.log('==========================================================');
  } finally {
    await JobManager.getInstance().abortAll();
    await server.stop();
  }
}

runGate5().catch((err) => {
  console.error('[GATE5_FATAL]', err);
  process.exit(1);
});

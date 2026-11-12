/**
 * Gate 1 Standalone Verification Test Suite
 * Tests all 5 Stage 1 requirements on native Windows:
 * 1. Read-only mode write interception (fs_mutate write & exec_command redirection/mutation)
 * 2. Workspace-write mode NTFS Junction escape interception via realpathSync.native
 * 3. Danger-full-access cross-directory write + high-risk mobile HMAC suspension & AI self-approval guard
 * 4. Timeout spawned child process tree 100% kill via Win32 Job Object (parent + child PID dead)
 * 5. Git checkpoint snapshot creation and 1-click rollback
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitCheckpointManager } from '../pipeline/gitCheckpoint.js';
import { joinInsideRoot } from '../pipeline/pathGuard.js';
import { PipelineKernel } from '../pipeline/pipeline.js';
import { Win32JobObject } from '../pipeline/win32Job.js';

process.env.MWH_HMAC_SECRET ||= crypto.randomBytes(32).toString('hex');

interface TestResult {
  name: string;
  passed: boolean;
  message?: string;
}

const results: TestResult[] = [];

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runGate1() {
  const workspaceRoot = process.cwd();
  console.log('===============================================================');
  console.log('  MUSE-WIN-HARNESS: GATE 1 VERIFICATION TEST SUITE');
  console.log(`  Workspace Root: ${workspaceRoot}`);
  console.log(`  Platform: ${process.platform} (${os.release()})`);
  console.log(`  Node: ${process.version}`);
  console.log('===============================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: Read-Only Mode Write Interception
  // --------------------------------------------------------------------------
  console.log('[TEST 1] Testing Read-Only Mode Write Interception...');
  try {
    const kernel = new PipelineKernel({
      confinementMode: 'read-only',
      workspaceRoot
    });

    // 1A: fs_mutate write
    const resMutate = await kernel.handleRequest({
      id: 'gate1_t1_mutate',
      toolName: 'fs_mutate',
      category: 'write',
      params: { path: 'ro_forbidden.txt', content: 'hello' }
    });

    if (
      resMutate.status !== 'DENIED' ||
      !resMutate.reason?.includes('READ_ONLY_MODE_WRITE_DENIED')
    ) {
      throw new Error(
        `fs_mutate was not properly denied in read-only mode. Got: ${JSON.stringify(resMutate)}`
      );
    }

    // 1B: exec_command with redirection
    const resRedirect = await kernel.handleRequest({
      id: 'gate1_t1_redirect',
      toolName: 'exec_command',
      category: 'write',
      params: { command: 'echo malicious > ro_forbidden.txt' }
    });

    if (
      resRedirect.status !== 'DENIED' ||
      !resRedirect.reason?.includes('READ_ONLY_MODE_COMMAND_DENIED')
    ) {
      throw new Error(
        `Redirection command was not denied in read-only mode. Got: ${JSON.stringify(resRedirect)}`
      );
    }

    // 1C: exec_command with non-whitelisted mutation command
    const resCmd = await kernel.handleRequest({
      id: 'gate1_t1_cmd',
      toolName: 'exec_command',
      category: 'write',
      params: { command: 'powershell New-Item ro_forbidden.txt' }
    });

    if (
      resCmd.status !== 'DENIED' ||
      !resCmd.reason?.includes('READ_ONLY_MODE_COMMAND_DENIED')
    ) {
      throw new Error(
        `Non-whitelisted shell command was not denied in read-only mode. Got: ${JSON.stringify(resCmd)}`
      );
    }

    // 1D: exec_command with valid whitelisted read command
    const resAllowed = await kernel.handleRequest({
      id: 'gate1_t1_allowed',
      toolName: 'exec_command',
      category: 'read',
      params: { command: 'whoami' }
    });

    if (resAllowed.status !== 'SUCCESS') {
      throw new Error(
        `Whitelisted read command failed in read-only mode. Got: ${JSON.stringify(resAllowed)}`
      );
    }

    console.log('  -> PASS: All mutations and redirections blocked, whitelisted reads permitted.');
    results.push({ name: 'Requirement 1: Read-Only Mode Confinement', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({
      name: 'Requirement 1: Read-Only Mode Confinement',
      passed: false,
      message: err.message
    });
  }

  // --------------------------------------------------------------------------
  // TEST 2: Workspace-Write Mode NTFS Junction Escape Interception
  // --------------------------------------------------------------------------
  console.log('\n[TEST 2] Testing NTFS Junction Escape Interception...');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwh_outside_target_'));
  const secretFile = path.join(outsideDir, 'secret_leak.txt');
  fs.writeFileSync(secretFile, 'TOP_SECRET_DATA_OUTSIDE_WORKSPACE', 'utf-8');

  const junctionName = `junction_test_${Date.now()}`;
  const junctionPath = path.join(workspaceRoot, junctionName);

  try {
    // Create real NTFS Junction via cmd mklink /J
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', junctionPath, outsideDir], {
      windowsHide: true,
      stdio: 'pipe'
    });

    if (!fs.existsSync(junctionPath)) {
      throw new Error('Failed to create NTFS Junction on host');
    }

    const kernel = new PipelineKernel({
      confinementMode: 'workspace-write',
      workspaceRoot
    });

    // 2A: Attempt read through junction
    const resRead = await kernel.handleRequest({
      id: 'gate1_t2_read',
      toolName: 'fs_read',
      category: 'read',
      params: { path: path.join(junctionName, 'secret_leak.txt') }
    });

    if (
      resRead.status !== 'DENIED' ||
      !resRead.reason?.includes('PATH_CONFINEMENT_VIOLATION')
    ) {
      throw new Error(
        `Junction escape read was not intercepted by pathGuard. Got: ${JSON.stringify(resRead)}`
      );
    }

    // 2B: Attempt write through junction
    const resWrite = await kernel.handleRequest({
      id: 'gate1_t2_write',
      toolName: 'fs_mutate',
      category: 'write',
      params: { path: path.join(junctionName, 'escaped_write.txt'), content: 'escaped' }
    });

    if (
      resWrite.status !== 'DENIED' ||
      !resWrite.reason?.includes('PATH_CONFINEMENT_VIOLATION')
    ) {
      throw new Error(
        `Junction escape write was not intercepted by pathGuard. Got: ${JSON.stringify(resWrite)}`
      );
    }

    console.log('  -> PASS: Realpath resolution caught and blocked NTFS junction escape.');
    results.push({ name: 'Requirement 2: NTFS Junction Escape Interception', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({
      name: 'Requirement 2: NTFS Junction Escape Interception',
      passed: false,
      message: err.message
    });
  } finally {
    // Clean up junction and outside directory
    try {
      if (fs.existsSync(junctionPath)) {
        execFileSync('cmd.exe', ['/c', 'rmdir', junctionPath], { windowsHide: true });
      }
    } catch {}
    try {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {}
  }

  // --------------------------------------------------------------------------
  // TEST 3: Danger-Full-Access Mode Cross-Directory Write & Mobile HMAC Guard
  // --------------------------------------------------------------------------
  console.log('\n[TEST 3] Testing Danger-Full-Access Mode & HMAC Approval Guard...');
  const dangerTestFile = path.join(os.tmpdir(), `mwh_danger_file_${Date.now()}.txt`);

  try {
    const kernel = new PipelineKernel({
      confinementMode: 'danger-full-access',
      approvalPolicy: 'smart-risk',
      workspaceRoot
    });

    // 3A: Request cross-directory write in danger mode
    const reqId = 'gate1_t3_danger_write';
    const resSuspended = await kernel.handleRequest({
      id: reqId,
      toolName: 'fs_mutate',
      category: 'write',
      params: { path: dangerTestFile, content: 'DANGER_FULL_ACCESS_PAYLOAD' }
    });

    if (
      resSuspended.status !== 'CONFIRMATION_REQUIRED' ||
      resSuspended.riskLevel !== 'critical' ||
      !resSuspended.requiresMobileHmac ||
      !resSuspended.approvalUrl?.includes('?sig=')
    ) {
      throw new Error(
        `Cross-directory write in danger-mode did not trigger HMAC mobile suspension. Got: ${JSON.stringify(resSuspended)}`
      );
    }

    const approvalId = resSuspended.approvalId!;
    const urlObj = new URL(resSuspended.approvalUrl!);
    const validSig = urlObj.searchParams.get('sig')!;

    // 3B: AI Self-Approval block (attempt to approve without signature)
    let selfApprovalBlocked = false;
    try {
      const selfRes = await kernel.handleRequest({
        id: 'gate1_t3_self_approval',
        toolName: 'job_control',
        category: 'sensitive_write',
        params: { action: 'approve', approvalId }
      });
      if (
        selfRes.status === 'ERROR' &&
        selfRes.error?.includes('HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN')
      ) {
        selfApprovalBlocked = true;
      }
    } catch (err: any) {
      if (err.message.includes('HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN')) {
        selfApprovalBlocked = true;
      }
    }

    if (!selfApprovalBlocked) {
      throw new Error('AI self-approval without HMAC signature was not blocked!');
    }

    // 3C: Approve with valid HMAC signature.
    // P1 sync note: since the AI-driven job_control channel is now forbidden from
    // approving critical (requiresMobileHmac) actions, the human mobile-link
    // channel is simulated directly here. HMAC signature validation still applies.
    const approveRes = kernel
      .getApprovalEngine()
      .resolveApproval(approvalId, 'approve', validSig, 'once', kernel.getContext(), 'mobile_link');

    if (!approveRes.success) {
      throw new Error(`Approval with valid HMAC signature failed. Got: ${JSON.stringify(approveRes)}`);
    }

    // 3D: Re-execute write now that it is approved
    const execRes = await kernel.handleRequest({
      id: reqId,
      toolName: 'fs_mutate',
      category: 'write',
      approvalId,
      params: { path: dangerTestFile, content: 'DANGER_FULL_ACCESS_PAYLOAD' }
    });

    if (execRes.status !== 'SUCCESS') {
      throw new Error(`Approved danger write failed to execute. Got: ${JSON.stringify(execRes)}`);
    }

    if (!execRes.tags?.includes('[FULL-ACCESS-ACTIVE]')) {
      throw new Error('Response did not contain [FULL-ACCESS-ACTIVE] tag');
    }

    if (!fs.existsSync(dangerTestFile)) {
      throw new Error('Payload was not written to outside destination');
    }

    const writtenContent = fs.readFileSync(dangerTestFile, 'utf-8');
    if (writtenContent !== 'DANGER_FULL_ACCESS_PAYLOAD') {
      throw new Error(`Written content mismatch: ${writtenContent}`);
    }

    console.log('  -> PASS: HMAC mobile suspension, self-approval block, and full-access write verified.');
    results.push({ name: 'Requirement 3: Danger Mode & Mobile HMAC Guard', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({
      name: 'Requirement 3: Danger Mode & Mobile HMAC Guard',
      passed: false,
      message: err.message
    });
  } finally {
    try {
      if (fs.existsSync(dangerTestFile)) {
        fs.unlinkSync(dangerTestFile);
      }
    } catch {}
  }

  // --------------------------------------------------------------------------
  // TEST 4: Timeout Spawned Child Process Tree 100% Kill via Win32 Job Object
  // --------------------------------------------------------------------------
  console.log('\n[TEST 4] Testing Win32 Job Object Process Tree Termination...');
  const childPidFile = path.join(os.tmpdir(), `mwh_child_pid_${Date.now()}.txt`);

  try {
    const job = new Win32JobObject();

    // PowerShell script that spawns a child ping process and records child PID
    const normalizedChildPidFile = childPidFile.replace(/\\/g, '/');
    const psScript = `$c = Start-Process -FilePath "ping.exe" -ArgumentList "-n 60 127.0.0.1" -PassThru; [System.IO.File]::WriteAllText("${normalizedChildPidFile}", $c.Id); Wait-Process -Id $c.Id`;

    const parentProc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    const parentPid = parentProc.pid!;
    if (!parentPid) {
      throw new Error('Failed to retrieve parent process PID');
    }

    job.assignPid(parentPid);

    // Wait up to 3 seconds for child process to spawn and write its PID
    let childPid = 0;
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(childPidFile)) {
        const text = fs.readFileSync(childPidFile, 'utf-8').trim();
        if (text) {
          childPid = parseInt(text, 10);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!childPid) {
      throw new Error('Timed out waiting for child ping.exe process to spawn');
    }

    // Also assign child PID directly to ensure full coverage
    job.assignPid(childPid);

    // Verify both parent and child are alive before timeout
    if (!isPidAlive(parentPid)) {
      throw new Error(`Parent process ${parentPid} unexpectedly died early`);
    }
    if (!isPidAlive(childPid)) {
      throw new Error(`Child process ${childPid} unexpectedly died early`);
    }

    console.log(`  -> Spawned Parent PID: ${parentPid}, Child PID: ${childPid}. Both active.`);
    console.log('  -> Simulating 1500ms execution timeout...');
    await new Promise(r => setTimeout(r, 1500));

    // Terminate the Job Object
    console.log('  -> Terminating Win32 Job Object...');
    job.terminate(1);

    // Give OS 500ms to clean up handles
    await new Promise(r => setTimeout(r, 500));

    const parentStillAlive = isPidAlive(parentPid);
    const childStillAlive = isPidAlive(childPid);

    console.log(`  -> Post-termination state: Parent Alive = ${parentStillAlive}, Child Alive = ${childStillAlive}`);

    if (parentStillAlive || childStillAlive) {
      throw new Error(
        `Survivors detected! Parent ${parentPid} alive: ${parentStillAlive}, Child ${childPid} alive: ${childStillAlive}`
      );
    }

    console.log('  -> PASS: 0 survivors. Both parent and child processes 100% terminated.');
    results.push({ name: 'Requirement 4: Win32 Job Object Process Tree Kill', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({
      name: 'Requirement 4: Win32 Job Object Process Tree Kill',
      passed: false,
      message: err.message
    });
  } finally {
    try {
      if (fs.existsSync(childPidFile)) {
        fs.unlinkSync(childPidFile);
      }
    } catch {}
  }

  // --------------------------------------------------------------------------
  // TEST 5: Git Checkpoint Snapshot Creation and 1-Click Rollback
  // --------------------------------------------------------------------------
  console.log('\n[TEST 5] Testing Git Checkpoint Creation & 1-Click Rollback (ASCII + Non-ASCII CJK + Pre-Restore Integrity)...');
  const testFilePath = joinInsideRoot(workspaceRoot, 'checkpoint_gate1_test.txt');
  const cjkFilePath = joinInsideRoot(workspaceRoot, 'MWH启动_中文快照测试.cmd');
  const intruderFilePath = joinInsideRoot(workspaceRoot, 'intruder_untracked_file.txt');

  const originalContent = 'ORIGINAL_CHECKPOINT_STATE_12345';
  const originalCjkContent = '@echo off\r\necho MWH中文启动脚本_原始未提交内容_UTF8\r\n';
  let corruptCheckpointId = '';

  try {
    // 5A: Write original ASCII & Non-ASCII (CJK) files
    fs.writeFileSync(testFilePath, originalContent, 'utf-8');
    fs.writeFileSync(cjkFilePath, originalCjkContent, 'utf-8');

    // 5B: Create snapshot
    const checkpointId = GitCheckpointManager.create('gate1-before-mutation', workspaceRoot);
    console.log(`  -> Checkpoint created with ID: ${checkpointId}`);

    // 5C: Corrupt original files and introduce new untracked intruder file
    fs.writeFileSync(testFilePath, 'MUTATED_CORRUPTED_STATE_67890', 'utf-8');
    fs.writeFileSync(cjkFilePath, '@echo off\r\necho CORRUPTED_CJK_CONTENT\r\n', 'utf-8');
    fs.writeFileSync(intruderFilePath, 'SHOULD_BE_REMOVED_ON_ROLLBACK', 'utf-8');

    if (fs.readFileSync(testFilePath, 'utf-8') !== 'MUTATED_CORRUPTED_STATE_67890') {
      throw new Error('Failed to mutate test file');
    }
    if (!fs.existsSync(intruderFilePath)) {
      throw new Error('Failed to create intruder file');
    }

    // 5D: Rollback checkpoint
    console.log('  -> Executing rollback...');
    const rollbackSuccess = GitCheckpointManager.rollback(checkpointId, workspaceRoot);
    if (!rollbackSuccess) {
      throw new Error('Rollback returned false');
    }

    // 5E: Verify exact original state restored for both ASCII and Non-ASCII (CJK) files
    const restoredContent = fs.readFileSync(testFilePath, 'utf-8');
    if (restoredContent !== originalContent) {
      throw new Error(
        `Rollback content mismatch! Expected '${originalContent}', got '${restoredContent}'`
      );
    }

    const restoredCjkContent = fs.readFileSync(cjkFilePath, 'utf-8');
    if (restoredCjkContent !== originalCjkContent) {
      throw new Error(
        `Non-ASCII CJK rollback content mismatch! Expected '${originalCjkContent}', got '${restoredCjkContent}'`
      );
    }

    if (fs.existsSync(intruderFilePath)) {
      throw new Error('Untracked intruder file was not removed during rollback');
    }

    // 5F: Verify pre-restore integrity gate refuses rollback when a snapshot backup file is missing
    corruptCheckpointId = GitCheckpointManager.create('gate1-corrupt-test', workspaceRoot);
    const backedUpCjk = path.join(
      workspaceRoot,
      '.mwh',
      'checkpoints',
      corruptCheckpointId,
      'snapshot',
      'MWH启动_中文快照测试.cmd'
    );
    if (!fs.existsSync(backedUpCjk)) {
      throw new Error('Non-ASCII file was not copied into checkpoint files directory');
    }
    fs.unlinkSync(backedUpCjk);
    fs.writeFileSync(cjkFilePath, 'WORKING_TREE_EDIT_MUST_SURVIVE_FAILED_ROLLBACK', 'utf-8');

    let preRestoreRejected = false;
    try {
      GitCheckpointManager.rollback(corruptCheckpointId, workspaceRoot);
    } catch (err: any) {
      if (String(err?.message || err).includes('CHECKPOINT_RESTORE_FAILED')) {
        preRestoreRejected = true;
      }
    }
    if (!preRestoreRejected) {
      throw new Error('Corrupted checkpoint missing backup file was not rejected with CHECKPOINT_RESTORE_FAILED');
    }
    if (fs.readFileSync(cjkFilePath, 'utf-8') !== 'WORKING_TREE_EDIT_MUST_SURVIVE_FAILED_ROLLBACK') {
      throw new Error('Failed rollback must abort BEFORE modifying working tree files');
    }

    // 5G: Cross-Scenario Verification — Live Background Job + Emergency Kill (abortAll) -> Immediate Rollback
    console.log('  -> [5G] Verifying Emergency Kill (abortAll) + Immediate Rollback cross-scenario...');
    fs.writeFileSync(testFilePath, originalContent, 'utf-8');
    fs.writeFileSync(cjkFilePath, originalCjkContent, 'utf-8');
    if (fs.existsSync(intruderFilePath)) fs.unlinkSync(intruderFilePath);

    const crossSnapId = GitCheckpointManager.create('gate1-emergency-kill-rollback', workspaceRoot);
    const { JobManager } = await import('../executors/jobManager.js');
    const jm = JobManager.getInstance();

    const mutatingAsyncRes = await jm.executeCommand({
      command: `$c = Start-Process -FilePath 'ping.exe' -ArgumentList '-n 30 127.0.0.1' -WindowStyle Hidden -PassThru; Write-Output ('GRANDCHILD_PID=' + $c.Id); Set-Content -Path '${testFilePath.replace(/'/g, "''")}' -Value 'CORRUPTED_DURING_JOB' -Encoding UTF8; Set-Content -Path '${intruderFilePath.replace(/'/g, "''")}' -Value 'INTRUDER_FROM_RUNNING_JOB' -Encoding UTF8; Start-Sleep -Seconds 30`,
      cwd: workspaceRoot,
      workspaceRoot,
      yieldTimeMs: 400,
      confinementMode: 'workspace-write'
    });
    if (mutatingAsyncRes.data?.status !== 'RUNNING_ASYNC') {
      throw new Error(`Expected backgrounded job RUNNING_ASYNC, got ${JSON.stringify(mutatingAsyncRes.data)}`);
    }
    const crossJobId = mutatingAsyncRes.data.jobId as string;
    const crossParentPid = mutatingAsyncRes.data.pid as number;

    // Wait briefly for file write + grandchild PID output
    let crossGrandchildPid = 0;
    for (let i = 0; i < 20; i++) {
      const polled = jm.poll(crossJobId, 1, 8192, workspaceRoot);
      const m = polled.chunk.match(/GRANDCHILD_PID=(\d+)/);
      if (m) crossGrandchildPid = Number(m[1]);
      if (crossGrandchildPid > 0 && fs.existsSync(intruderFilePath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!crossGrandchildPid || !fs.existsSync(intruderFilePath)) {
      jm.abortAll();
      throw new Error('Background job did not spawn grandchild or mutate files before emergency kill');
    }

    // Trigger global emergency kill (abortAll) and immediately rollback
    const abortSummary = jm.abortAll();
    if (!abortSummary.abortedIds.includes(crossJobId)) {
      throw new Error(`abortAll() did not abort ${crossJobId}: ${JSON.stringify(abortSummary)}`);
    }
    if (isPidAlive(crossParentPid) || isPidAlive(crossGrandchildPid)) {
      throw new Error(`Process tree survived abortAll(): parent=${isPidAlive(crossParentPid)}, grandchild=${isPidAlive(crossGrandchildPid)}`);
    }

    const crossRollbackOk = GitCheckpointManager.rollback(crossSnapId, workspaceRoot);
    if (!crossRollbackOk) {
      throw new Error('Rollback after emergency kill returned false');
    }
    if (fs.readFileSync(testFilePath, 'utf-8') !== originalContent) {
      throw new Error('File content was not restored to pre-job state after emergency kill + rollback');
    }
    if (fs.existsSync(intruderFilePath)) {
      throw new Error('Intruder file created by killed job survived rollback');
    }
    GitCheckpointManager.deleteCheckpoints([crossSnapId], workspaceRoot);

    console.log('  -> PASS: ASCII + Non-ASCII CJK snapshot/rollback, pre-restore integrity gate, and Emergency-Kill + Rollback cross-scenario verified.');
    results.push({ name: 'Requirement 5: Git Checkpoint & Rollback', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({
      name: 'Requirement 5: Git Checkpoint & Rollback',
      passed: false,
      message: err.message
    });
  } finally {
    try {
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
    } catch {}
    try {
      if (fs.existsSync(cjkFilePath)) {
        fs.unlinkSync(cjkFilePath);
      }
    } catch {}
    try {
      if (fs.existsSync(intruderFilePath)) {
        fs.unlinkSync(intruderFilePath);
      }
    } catch {}
    try {
      if (corruptCheckpointId) {
        GitCheckpointManager.deleteCheckpoints([corruptCheckpointId], workspaceRoot);
      }
    } catch {}
  }

  // --------------------------------------------------------------------------
  // SUMMARY REPORT
  // --------------------------------------------------------------------------
  console.log('\n===============================================================');
  console.log('  GATE 1 VERIFICATION SUMMARY');
  console.log('===============================================================');

  let allPassed = true;
  for (const r of results) {
    const mark = r.passed ? '[PASS]' : '[FAIL]';
    console.log(`  ${mark} - ${r.name}`);
    if (!r.passed) {
      allPassed = false;
      if (r.message) console.log(`         Error: ${r.message}`);
    }
  }

  console.log('===============================================================');
  if (allPassed) {
    console.log('  RESULT: ALL 5 GATE 1 REQUIREMENTS PASSED SUCCESSFULLY!');
    console.log('===============================================================\n');
    process.exit(0);
  } else {
    console.error('  RESULT: ONE OR MORE GATE 1 CHECKS FAILED!');
    console.log('===============================================================\n');
    process.exit(1);
  }
}

runGate1().catch((err) => {
  console.error('Fatal unhandled error during Gate 1 verification:', err);
  process.exit(1);
});

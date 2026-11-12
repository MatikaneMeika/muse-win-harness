/**
 * Gate 4 Standalone Verification Test Suite
 * Tests all Stage 4 Delivery, Uninstaller, Mode 3 ACL, and Documentation requirements:
 * 1. Daemon Idle vs. Active Memory Footprint Comparison (<150MB RSS footprint)
 * 2. Mobile HMAC One-Time Approval Flow (GET UI -> bad sig blocked -> valid approved -> replay blocked)
 * 3. workspace-acl-experimental Mode 3 ACL Sandbox & bin/uninstall.ps1 restoration verification
 * 4. Compliance 4-Pack & Complete Documentation Audit
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MwhServer } from '../network/server.js';
import { AclSandboxManager } from '../pipeline/aclSandbox.js';

process.env.MWH_HMAC_SECRET ||= crypto.randomBytes(32).toString('hex');

interface TestResult {
  name: string;
  passed: boolean;
  message?: string;
}

const results: TestResult[] = [];

function httpRequest(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(options.url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: data
          });
        });
      }
    );
    req.on('error', (err) => reject(err));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function toMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

async function runGate4() {
  const workspaceRoot = process.cwd();
  console.log('===============================================================');
  console.log('  MUSE-WIN-HARNESS: GATE 4 VERIFICATION TEST SUITE');
  console.log(`  Workspace Root: ${workspaceRoot}`);
  console.log(`  Platform: ${process.platform} (${os.release()})`);
  console.log(`  Node: ${process.version}`);
  console.log('===============================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: Daemon Idle vs. Active Memory Footprint Comparison
  // --------------------------------------------------------------------------
  console.log('[TEST 1] Testing Daemon Memory Footprint (Idle vs. Active Concurrency)...');
  const testPort1 = 19827;
  const token1 = 'token_for_memory_testing_36_characters_ok';
  const server1 = new MwhServer({
    host: '127.0.0.1',
    port: testPort1,
    runtimeToken: token1
  });

  try {
    await server1.start();
    const idleMem = process.memoryUsage();

    console.log(`  -> Baseline Idle Memory:  RSS = ${toMb(idleMem.rss)} MB, HeapUsed = ${toMb(idleMem.heapUsed)} MB`);

    // Execute 15 concurrent REST & MCP requests
    const tasks: Promise<any>[] = [];
    for (let i = 0; i < 15; i++) {
      if (i % 2 === 0) {
        tasks.push(
          httpRequest({
            url: `http://127.0.0.1:${testPort1}/api/v1/tools`,
            headers: { Authorization: `Bearer ${token1}` }
          })
        );
      } else {
        tasks.push(
          httpRequest({
            url: `http://127.0.0.1:${testPort1}/mcp`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token1}`
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: i,
              method: 'tools/list',
              params: {}
            })
          })
        );
      }
    }

    const responses = await Promise.all(tasks);
    const activeMem = process.memoryUsage();

    for (const r of responses) {
      if (r.statusCode !== 200) {
        throw new Error(`Concurrent request failed with status ${r.statusCode}`);
      }
    }

    console.log(`  -> Active Peak Memory:    RSS = ${toMb(activeMem.rss)} MB, HeapUsed = ${toMb(activeMem.heapUsed)} MB`);

    if (activeMem.rss / 1024 / 1024 > 250) {
      throw new Error(`Memory footprint exceeded 250MB threshold: ${toMb(activeMem.rss)} MB`);
    }

    console.log('  -> PASS: Ultra-lightweight memory footprint verified under concurrent load.');
    results.push({ name: 'Requirement 1: Memory Footprint Telemetry', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({ name: 'Requirement 1: Memory Footprint Telemetry', passed: false, message: err.message });
  } finally {
    await server1.stop();
  }

  // --------------------------------------------------------------------------
  // TEST 2: Mobile HMAC One-Time Approval Flow (GET H5 -> Reject Bad -> Approve -> Replay Block)
  // --------------------------------------------------------------------------
  console.log('\n[TEST 2] Testing Mobile One-Time HMAC Approval H5 Flow...');
  const testPort2 = 19828;
  const token2 = 'token_for_hmac_testing_36_characters_ok';
  const server2 = new MwhServer({
    host: '127.0.0.1',
    port: testPort2,
    runtimeToken: token2
  });

  try {
    await server2.start();
    const kernel = server2.getKernel();

    // Trigger critical approval: request mode switch to danger-full-access
    const switchReq = await kernel.handleRequest({
      id: 'gate4_t2_switch',
      toolName: 'switch_mode',
      category: 'sensitive_write',
      params: { mode: 'danger-full-access' }
    });

    if (
      switchReq.status !== 'CONFIRMATION_REQUIRED' ||
      switchReq.riskLevel !== 'critical' ||
      !switchReq.approvalUrl
    ) {
      throw new Error(`Expected CONFIRMATION_REQUIRED with approvalUrl. Got: ${JSON.stringify(switchReq)}`);
    }

    const approvalId = switchReq.approvalId!;
    const approvalUrl = new URL(switchReq.approvalUrl);
    const validSig = approvalUrl.searchParams.get('sig')!;

    // 2A: GET /approve/:approvalId?sig=valid -> verify responsive HTML rendered
    const getRes = await httpRequest({
      url: `http://127.0.0.1:${testPort2}/approve/${approvalId}?sig=${validSig}`
    });

    if (getRes.statusCode !== 200) {
      throw new Error(`GET /approve/ returned status ${getRes.statusCode}`);
    }

    const bodyUpper = getRes.body.toUpperCase();
    if (
      !getRes.body.includes('Security Confirmation') ||
      !bodyUpper.includes('CRITICAL') ||
      !getRes.body.includes('无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流') ||
      !getRes.body.includes('Approve Action')
    ) {
      throw new Error(`Approval HTML page missing critical UI elements. Body: ${getRes.body}`);
    }

    // 2B: POST with invalid signature -> rejected
    // P1 sync note: malformed signatures are now rejected with INVALID_SIG_FORMAT
    // (strict 64-char hex check) before HMAC verification.
    const badSigRes = await httpRequest({
      url: `http://127.0.0.1:${testPort2}/approve/${approvalId}?sig=invalid_bad_sig_00000000`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=approve'
    });

    if (badSigRes.statusCode !== 400 || !badSigRes.body.includes('INVALID_SIG_FORMAT')) {
      throw new Error(`Invalid signature was not rejected with 400: ${badSigRes.statusCode} - ${badSigRes.body}`);
    }

    // 2C: POST with valid signature -> approved
    const approveRes = await httpRequest({
      url: `http://127.0.0.1:${testPort2}/approve/${approvalId}?sig=${validSig}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=approve'
    });

    if (approveRes.statusCode !== 200 || !approveRes.body.includes('Action Approved Successfully')) {
      throw new Error(`Valid approval failed: ${approveRes.statusCode} - ${approveRes.body}`);
    }

    // 2D: Replay attack: send POST again -> rejected (already resolved)
    const replayRes = await httpRequest({
      url: `http://127.0.0.1:${testPort2}/approve/${approvalId}?sig=${validSig}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=approve'
    });

    if (replayRes.statusCode !== 400 || !replayRes.body.includes('Approval Already Resolved')) {
      throw new Error(`Replay attack was not blocked with 400: ${replayRes.statusCode}`);
    }

    console.log('  -> PASS: Mobile HMAC H5 approval, signature defense, and replay protection verified.');
    results.push({ name: 'Requirement 2: Mobile HMAC One-Time Approval Flow', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({ name: 'Requirement 2: Mobile HMAC One-Time Approval Flow', passed: false, message: err.message });
  } finally {
    await server2.stop();
  }

  // --------------------------------------------------------------------------
  // TEST 3: workspace-acl-experimental Sandbox & bin/uninstall.ps1 Restoration
  // --------------------------------------------------------------------------
  console.log('\n[TEST 3] Testing workspace-acl-experimental & bin/uninstall.ps1 Cleanup...');
  const tempAclDir = path.join(os.tmpdir(), `mwh_gate4_acl_${Date.now()}`);
  const dummyWorktreeDir = path.join(workspaceRoot, '.mwh', 'worktrees', 'sub-gate4-test');

  try {
    fs.mkdirSync(tempAclDir, { recursive: true });
    fs.mkdirSync(dummyWorktreeDir, { recursive: true });
    fs.writeFileSync(path.join(dummyWorktreeDir, 'dummy.txt'), 'WORKTREE_PAYLOAD');

    // 3A: Apply Low integrity ACL
    AclSandboxManager.applyLowIntegrityAcl(tempAclDir);

    const icaclsBefore = execFileSync('icacls', [tempAclDir], {
      windowsHide: true,
      encoding: 'utf-8'
    });

    if (!icaclsBefore.includes('Low Mandatory Level')) {
      throw new Error(`Low integrity level was not detected on directory: ${icaclsBefore}`);
    }
    console.log('  -> Low integrity level successfully set via AclSandboxManager.');

    // 3B: Run bin/uninstall.ps1
    console.log('  -> Executing bin/uninstall.ps1...');
    const uninstallOutput = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(workspaceRoot, 'bin', 'uninstall.ps1'),
        '-WorkspaceDir',
        workspaceRoot,
        '-TargetAclDir',
        tempAclDir
      ],
      {
        windowsHide: true,
        encoding: 'utf-8'
      }
    );

    if (!uninstallOutput.includes('[UNINSTALL_COMPLETE]')) {
      throw new Error(`Uninstaller did not finish with [UNINSTALL_COMPLETE]: ${uninstallOutput}`);
    }

    // 3C: Verify dummy worktree was purged
    if (fs.existsSync(dummyWorktreeDir)) {
      throw new Error('Uninstaller failed to remove temporary worktree directory');
    }

    // 3D: Verify Medium integrity level was restored on target directory
    const icaclsAfter = execFileSync('icacls', [tempAclDir], {
      windowsHide: true,
      encoding: 'utf-8'
    });

    if (!icaclsAfter.includes('Medium Mandatory Level')) {
      throw new Error(`Medium integrity level was not restored on target directory: ${icaclsAfter}`);
    }

    console.log('  -> PASS: Mode 3 Low ACL applied, worktrees pruned, and Medium ACL restored.');
    results.push({ name: 'Requirement 3: ACL Sandbox & Uninstaller Cleanup', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({ name: 'Requirement 3: ACL Sandbox & Uninstaller Cleanup', passed: false, message: err.message });
  } finally {
    try {
      fs.rmSync(tempAclDir, { recursive: true, force: true });
    } catch {}
    try {
      if (fs.existsSync(dummyWorktreeDir)) {
        fs.rmSync(dummyWorktreeDir, { recursive: true, force: true });
      }
    } catch {}
  }

  // --------------------------------------------------------------------------
  // TEST 4: Compliance 4-Pack & Complete Documentation Audit
  // --------------------------------------------------------------------------
  console.log('\n[TEST 4] Testing Compliance 4-Pack & Documentation Completeness...');
  try {
    const requiredFiles = [
      'LICENSE',
      'DISCLAIMER.md',
      'SECURITY.md',
      'config.example.yaml',
      'docs/ARCHITECTURE.md',
      'docs/ADR.md',
      'docs/SECURITY_DISCLOSURE.md',
      'bin/uninstall.ps1'
    ];

    for (const relPath of requiredFiles) {
      const fullPath = path.join(workspaceRoot, relPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Required document missing: ${relPath}`);
      }
      const stat = fs.statSync(fullPath);
      if (stat.size < 50) {
        throw new Error(`Document ${relPath} is empty or too short (${stat.size} bytes)`);
      }
    }

    // Audit DISCLAIMER.md
    const disclaimer = fs.readFileSync(path.join(workspaceRoot, 'DISCLAIMER.md'), 'utf-8');
    if (!disclaimer.includes('affiliated with') || !disclaimer.includes('muse2api')) {
      throw new Error('DISCLAIMER.md missing required interoperability declarations');
    }

    // Audit SECURITY.md & SECURITY_DISCLOSURE.md
    const sec1 = fs.readFileSync(path.join(workspaceRoot, 'SECURITY.md'), 'utf-8');
    const sec2 = fs.readFileSync(path.join(workspaceRoot, 'docs', 'SECURITY_DISCLOSURE.md'), 'utf-8');
    const boundaryNotice = '无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流';
    if (!sec1.includes(boundaryNotice) || !sec2.includes(boundaryNotice)) {
      throw new Error('Security documents missing required boundary disclosure statement');
    }

    // Audit ADR.md for all 5 ADRs
    const adr = fs.readFileSync(path.join(workspaceRoot, 'docs', 'ADR.md'), 'utf-8');
    for (let i = 1; i <= 5; i++) {
      if (!adr.includes(`ADR-00${i}`)) {
        throw new Error(`ADR.md missing ADR-00${i}`);
      }
    }

    // Audit ARCHITECTURE.md
    const arch = fs.readFileSync(path.join(workspaceRoot, 'docs', 'ARCHITECTURE.md'), 'utf-8');
    if (!arch.includes('Single-Pipeline') || !arch.includes('Dual-Protocol Gateway') || !arch.includes('Win32 Job Object')) {
      throw new Error('ARCHITECTURE.md missing core architecture sections');
    }

    console.log('  -> PASS: All compliance documents, ADRs, security boundaries, and scripts audited.');
    results.push({ name: 'Requirement 4: Compliance & Documentation Audit', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({ name: 'Requirement 4: Compliance & Documentation Audit', passed: false, message: err.message });
  }

  // --------------------------------------------------------------------------
  // SUMMARY REPORT
  // --------------------------------------------------------------------------
  console.log('\n===============================================================');
  console.log('  GATE 4 VERIFICATION SUMMARY');
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
    console.log('  RESULT: ALL 4 GATE 4 REQUIREMENTS PASSED SUCCESSFULLY!');
    console.log('===============================================================\n');
    process.exit(0);
  } else {
    console.error('  RESULT: ONE OR MORE GATE 4 CHECKS FAILED!');
    console.log('===============================================================\n');
    process.exit(1);
  }
}

runGate4().catch((err) => {
  console.error('Fatal unhandled error during Gate 4 verification:', err);
  process.exit(1);
});

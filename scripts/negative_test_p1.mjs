/**
 * P1 Negative Security Test Suite (Approval Loop & Portal Hardening)
 * Run: node scripts/negative_test_p1.mjs  (requires `npm run build` beforehand)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ApprovalEngine, computeParamsHash } from '../dist/pipeline/approvalEngine.js';
import { PipelineKernel } from '../dist/pipeline/pipeline.js';
import { MwhServer } from '../dist/network/server.js';

const REAL_SECRET = 'negative_test_real_hmac_secret_value_0123456789abcdef';

function httpRequest(options) {
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
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data }));
      }
    );
    req.on('error', (err) => reject(err));
    if (options.body) req.write(options.body);
    req.end();
  });
}

const results = [];

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg || 'Assertion failed');
  }
}

function expectThrow(fn, code) {
  try {
    fn();
  } catch (err) {
    if (!String(err?.message).includes(code)) {
      throw new Error(`Expected error containing '${code}', got: ${err?.message}`);
    }
    return err.message;
  }
  throw new Error(`Expected error containing '${code}' but nothing was thrown`);
}

async function runCase(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`[PASS] ${name}`);
  } catch (err) {
    results.push({ name, passed: false, message: err.message });
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

// Server-side trusted secret for kernel-constructed engines
process.env.MWH_HMAC_SECRET = REAL_SECRET;

// ---------------------------------------------------------------------------
// Case 1: No MWH_HMAC_SECRET -> critical approval issuance must be refused
// ---------------------------------------------------------------------------
await runCase('C1 insecure mode refuses critical approval issuance (APPROVAL_HMAC_SECRET_MISSING)', () => {
  const saved = process.env.MWH_HMAC_SECRET;
  delete process.env.MWH_HMAC_SECRET;
  try {
    const engine = new ApprovalEngine();
    const ctx = { id: 'c1', confinementMode: 'workspace-write', approvalPolicy: 'always-ask', workspaceRoot: os.tmpdir() };
    expectThrow(
      () =>
        engine.createApproval(
          'req_c1', 'switch_mode', 'sensitive_write', { mode: 'danger-full-access' },
          'critical', 'Elevate mode', true, ctx
        ),
      'APPROVAL_HMAC_SECRET_MISSING'
    );
    // Normal (non-mobile-HMAC) approvals still work in insecure mode
    const normal = engine.createApproval(
      'req_c1b', 'fs_mutate', 'write', { path: 'a.txt', content: 'x' },
      'medium', 'Write file', false, ctx
    );
    assert(normal.approvalRecord.id && normal.approvalUrl.includes('?sig='), 'normal approval should still be issued in insecure mode');
  } finally {
    process.env.MWH_HMAC_SECRET = saved;
  }
});

// ---------------------------------------------------------------------------
// Case 2: requiresMobileHmac record cannot be approved via job_control source
// ---------------------------------------------------------------------------
await runCase('C2 job_control source approval of mobile-HMAC record forbidden (HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN)', () => {
  const engine = new ApprovalEngine(REAL_SECRET);
  const ctx = { id: 'c2', confinementMode: 'workspace-write', approvalPolicy: 'always-ask', workspaceRoot: os.tmpdir() };
  const { approvalRecord } = engine.createApproval(
    'req_c2', 'switch_mode', 'sensitive_write', { mode: 'danger-full-access' },
    'critical', 'Elevate mode', true, ctx
  );
  expectThrow(
    () => engine.resolveApproval(approvalRecord.id, 'approve', undefined, 'once', ctx, 'job_control'),
    'HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN'
  );
  // Even with a valid signature, the job_control channel must stay forbidden
  expectThrow(
    () => engine.resolveApproval(approvalRecord.id, 'approve', approvalRecord.hmacSig, 'once', ctx, 'job_control'),
    'HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN'
  );
});

// ---------------------------------------------------------------------------
// Case 3: Malformed signatures rejected with INVALID_SIG_FORMAT
// ---------------------------------------------------------------------------
await runCase('C3 bad sig (short / non-hex) rejected (INVALID_SIG_FORMAT)', () => {
  const engine = new ApprovalEngine(REAL_SECRET);
  const ctx = { id: 'c3', confinementMode: 'workspace-write', approvalPolicy: 'always-ask', workspaceRoot: os.tmpdir() };
  const { approvalRecord } = engine.createApproval(
    'req_c3', 'switch_mode', 'sensitive_write', { mode: 'danger-full-access' },
    'critical', 'Elevate mode', true, ctx
  );
  expectThrow(
    () => engine.resolveApproval(approvalRecord.id, 'approve', 'deadbeef', 'once', ctx, 'mobile_link'),
    'INVALID_SIG_FORMAT'
  );
  expectThrow(
    () => engine.resolveApproval(approvalRecord.id, 'approve', 'z'.repeat(64), 'once', ctx, 'mobile_link'),
    'INVALID_SIG_FORMAT'
  );
});

// ---------------------------------------------------------------------------
// Case 4: Expired approvals rejected with APPROVAL_EXPIRED
// ---------------------------------------------------------------------------
await runCase('C4 expired record rejected (APPROVAL_EXPIRED)', () => {
  const engine = new ApprovalEngine(REAL_SECRET);
  const ctx = { id: 'c4', confinementMode: 'workspace-write', approvalPolicy: 'always-ask', workspaceRoot: os.tmpdir() };
  const { approvalRecord } = engine.createApproval(
    'req_c4', 'switch_mode', 'sensitive_write', { mode: 'danger-full-access' },
    'critical', 'Elevate mode', true, ctx
  );
  approvalRecord.expiresAt = Date.now() - 1000;
  expectThrow(
    () => engine.resolveApproval(approvalRecord.id, 'approve', approvalRecord.hmacSig, 'once', ctx, 'mobile_link'),
    'APPROVAL_EXPIRED'
  );
  assert(approvalRecord.status === 'EXPIRED', 'record status should become EXPIRED');
});

// ---------------------------------------------------------------------------
// Case 5: One-time resolution - second resolve of same approvalId rejected
// ---------------------------------------------------------------------------
await runCase('C5 double resolve rejected (APPROVAL_ALREADY_RESOLVED)', () => {
  const engine = new ApprovalEngine(REAL_SECRET);
  const ctx = { id: 'c5', confinementMode: 'workspace-write', approvalPolicy: 'always-ask', workspaceRoot: os.tmpdir() };
  const { approvalRecord } = engine.createApproval(
    'req_c5', 'switch_mode', 'sensitive_write', { mode: 'danger-full-access' },
    'critical', 'Elevate mode', true, ctx
  );
  const first = engine.resolveApproval(approvalRecord.id, 'approve', approvalRecord.hmacSig, 'once', ctx, 'mobile_link');
  assert(first.success === true, 'first approval should succeed');
  expectThrow(
    () => engine.resolveApproval(approvalRecord.id, 'approve', approvalRecord.hmacSig, 'once', ctx, 'mobile_link'),
    'APPROVAL_ALREADY_RESOLVED'
  );
});

// ---------------------------------------------------------------------------
// Case 6: critical approval forces granularity once, no memory scopes written
// ---------------------------------------------------------------------------
await runCase('C6 critical approval granularity forced to once, memory sets stay empty', () => {
  const engine = new ApprovalEngine(REAL_SECRET);
  const ctx = {
    id: 'c6',
    confinementMode: 'workspace-write',
    approvalPolicy: 'always-ask',
    workspaceRoot: os.tmpdir(),
    sessionApprovedActions: new Set(),
    workspaceApprovedActions: new Set()
  };
  const { approvalRecord } = engine.createApproval(
    'req_c6', 'switch_mode', 'sensitive_write', { mode: 'danger-full-access' },
    'critical', 'Elevate mode', true, ctx
  );
  const res = engine.resolveApproval(approvalRecord.id, 'approve', approvalRecord.hmacSig, 'workspace', ctx, 'mobile_link');
  assert(res.record.granularity === 'once', `critical granularity must be forced to once, got ${res.record.granularity}`);
  assert(engine.sessionApprovedActions.size === 0, 'engine sessionApprovedActions must be empty');
  assert(engine.workspaceApprovedActions.size === 0, 'engine workspaceApprovedActions must be empty');
  assert(ctx.sessionApprovedActions.size === 0, 'context sessionApprovedActions must be empty');
  assert(ctx.workspaceApprovedActions.size === 0, 'context workspaceApprovedActions must be empty');
});

// ---------------------------------------------------------------------------
// Case 7: read-only mode command filtering (deny injection, allow whitelist)
// ---------------------------------------------------------------------------
await runCase('C7 read-only mode: injection commands DENIED, git status allowed', async () => {
  const kernel = new PipelineKernel({
    confinementMode: 'read-only',
    approvalPolicy: 'smart-risk',
    workspaceRoot: os.tmpdir()
  });

  const send = (cmd) =>
    kernel.handleRequest({
      id: `c7_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      toolName: 'exec_command',
      category: 'read',
      params: { command: cmd }
    });

  const deniedPipe = await send('whoami | Out-String');
  assert(deniedPipe.status === 'DENIED', `'whoami | Out-String' should be DENIED, got ${deniedPipe.status}`);

  const deniedSubst = await send('whoami $(whoami)');
  assert(deniedSubst.status === 'DENIED', `'whoami $(whoami)' should be DENIED, got ${deniedSubst.status}`);

  const deniedBacktick = await send('whoami `n whoami');
  assert(deniedBacktick.status === 'DENIED', 'backtick newline command should be DENIED');

  const deniedSemi = await send('whoami; whoami');
  assert(deniedSemi.status === 'DENIED', `'whoami; whoami' should be DENIED`);

  const deniedRedirect = await send('git status>1.txt');
  assert(deniedRedirect.status === 'DENIED', `'git status>1.txt' should be DENIED`);

  const allowed = await send('git status');
  assert(allowed.status === 'SUCCESS', `'git status' should be SUCCESS, got ${allowed.status} ${allowed.reason || ''}`);

  const allowedRg = await send('rg foo');
  assert(allowedRg.status === 'SUCCESS', `'rg foo' should be SUCCESS, got ${allowedRg.status} ${allowedRg.reason || ''}`);
});

// ---------------------------------------------------------------------------
// Case 8: request.context={hmacSecret:'x'} cannot influence the signing key
// ---------------------------------------------------------------------------
await runCase('C8 context hmacSecret injection does not affect verification key', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mwh_neg_c8_'));
  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'always-ask',
    workspaceRoot: tmpRoot
  });

  const res = await kernel.handleRequest({
    id: 'c8_switch',
    toolName: 'switch_mode',
    category: 'sensitive_write',
    context: { hmacSecret: 'x' },
    params: { mode: 'danger-full-access' }
  });
  assert(res.status === 'CONFIRMATION_REQUIRED', `expected CONFIRMATION_REQUIRED, got ${res.status}`);
  const approvalId = res.approvalId;
  const engine = kernel.getApprovalEngine();
  const record = engine.getApproval(approvalId);
  assert(record && record.requiresMobileHmac === true, 'record should require mobile HMAC');

  // Attacker-signed message using the injected secret 'x'
  const message = `${approvalId}:${record.toolName}:${record.riskLevel}:${record.paramsHash}`;
  const attackerSig = crypto.createHmac('sha256', 'x').update(message).digest('hex');
  expectThrow(
    () => engine.resolveApproval(approvalId, 'approve', attackerSig, 'once', kernel.getContext(), 'mobile_link'),
    'HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN'
  );

  // Signature computed with the real trusted secret is accepted, proving the
  // injected context key never influenced signing or verification.
  const realSig = crypto.createHmac('sha256', REAL_SECRET).update(message).digest('hex');
  const ok = engine.resolveApproval(approvalId, 'approve', realSig, 'once', kernel.getContext(), 'mobile_link');
  assert(ok.success === true, 'approval with the real-secret signature should succeed');
});

// ---------------------------------------------------------------------------
// Case 9: CONSUMED approval cannot authorize a second execution
// ---------------------------------------------------------------------------
await runCase('C9 CONSUMED approvalId reuse is refused', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mwh_neg_c9_'));
  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'always-ask',
    workspaceRoot: tmpRoot
  });

  const req = {
    toolName: 'fs_mutate',
    category: 'write',
    params: { path: 'nt9_target.txt', content: 'CONSUMED_TEST_V1' }
  };

  const req1 = await kernel.handleRequest({ id: 'c9_r1', ...req });
  assert(req1.status === 'CONFIRMATION_REQUIRED', `expected CONFIRMATION_REQUIRED, got ${req1.status}`);
  const approvalId = req1.approvalId;

  const approveRes = await kernel.handleRequest({
    id: 'c9_approve',
    toolName: 'job_control',
    category: 'write',
    params: { action: 'approve', approvalId }
  });
  assert(approveRes.status === 'SUCCESS', `job_control approve should succeed, got ${JSON.stringify(approveRes)}`);

  const req2 = await kernel.handleRequest({ id: 'c9_r2', approvalId, ...req });
  assert(req2.status === 'SUCCESS', `approved execution should succeed, got ${req2.status} ${req2.reason || ''}`);

  const req3 = await kernel.handleRequest({ id: 'c9_r3', approvalId, ...req });
  assert(req3.status !== 'SUCCESS', `reused CONSUMED approvalId must not execute, got ${req3.status}`);
  assert(req3.status === 'CONFIRMATION_REQUIRED', `reused approvalId should fall back to a new approval, got ${req3.status}`);

  const written = fs.readFileSync(path.join(tmpRoot, 'nt9_target.txt'), 'utf-8');
  assert(written === 'CONSUMED_TEST_V1', 'file must be written exactly once');
});

// ---------------------------------------------------------------------------
// Case 10: force-push regex must hit 'git push -f' / 'git push +main' etc.,
// without false-positives on plain 'git push' / 'git push origin main'
// ---------------------------------------------------------------------------
await runCase('C10 force-push detection: -f/+main/+refs hit, plain push not flagged', () => {
  const engine = new ApprovalEngine(REAL_SECRET);
  const ctx = { id: 'c10', confinementMode: 'workspace-write', approvalPolicy: 'smart-risk', workspaceRoot: os.tmpdir() };

  const hitCases = [
    'git push -f',
    'git push +main',
    'git push origin +refs/heads/main',
    'git push --force',
    'git push --force-with-lease'
  ];
  for (const cmd of hitCases) {
    const ev = engine.evaluateRisk('exec_command', 'sensitive_write', { command: cmd }, ctx);
    assert(
      ev.riskLevel === 'critical' && ev.requiresMobileHmac === true,
      `'${cmd}' must be critical+requiresMobileHmac, got ${ev.riskLevel}/${ev.requiresMobileHmac}`
    );
  }

  const cleanCases = ['git push', 'git push origin main'];
  for (const cmd of cleanCases) {
    const ev = engine.evaluateRisk('exec_command', 'sensitive_write', { command: cmd }, ctx);
    assert(
      ev.requiresMobileHmac === false,
      `'${cmd}' must NOT require mobile HMAC, got ${ev.riskLevel}/${ev.requiresMobileHmac}`
    );
  }

  // Fix 2: rd/del/rmdir with backslash separator ('\s') must also hit critical
  const backslashCases = ['rd foo \\s', 'del foo \\s', 'rmdir foo \\s', 'rd /s foo', 'del foo/s'];
  for (const cmd of backslashCases) {
    const ev = engine.evaluateRisk('exec_command', 'sensitive_write', { command: cmd }, ctx);
    assert(
      ev.riskLevel === 'critical' && ev.requiresMobileHmac === true,
      `'${cmd}' must be critical recursive deletion, got ${ev.riskLevel}/${ev.requiresMobileHmac}`
    );
  }
});

// ---------------------------------------------------------------------------
// Case 11: client-supplied forged _resolvedDestination must be stripped -> move rejected
// ---------------------------------------------------------------------------
await runCase('C11 forged _resolvedDestination move is refused (no fence bypass)', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mwh_neg_c11_'));
  fs.writeFileSync(path.join(tmpRoot, 'mwh_move_src.txt'), 'MOVE_PAYLOAD');

  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'auto-workspace',
    workspaceRoot: tmpRoot
  });

  const evilTarget = 'C:\\Windows\\Temp\\mwh_evil_c11.txt';
  const res = await kernel.handleRequest({
    id: 'c11_move',
    toolName: 'fs_mutate',
    category: 'write',
    params: {
      action: 'move',
      path: 'mwh_move_src.txt',
      destination: '',
      _resolvedDestination: evilTarget
    }
  });

  assert(res.status !== 'SUCCESS', `forged move must not succeed, got ${res.status}`);
  assert(
    !fs.existsSync(evilTarget),
    'evil destination file must not exist'
  );
  assert(
    fs.existsSync(path.join(tmpRoot, 'mwh_move_src.txt')),
    'source file must remain untouched'
  );
});

// ---------------------------------------------------------------------------
// Case 12: expired APPROVED release path -> DENIED with APPROVAL_EXPIRED, record EXPIRED
// ---------------------------------------------------------------------------
await runCase('C12 expired APPROVED approval: pipeline denies and marks EXPIRED', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mwh_neg_c12_'));
  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'always-ask',
    workspaceRoot: tmpRoot
  });

  const req = {
    toolName: 'fs_mutate',
    category: 'write',
    params: { path: 'c12_target.txt', content: 'EXPIRED_TEST_V1' }
  };

  const req1 = await kernel.handleRequest({ id: 'c12_r1', ...req });
  assert(req1.status === 'CONFIRMATION_REQUIRED', `expected CONFIRMATION_REQUIRED, got ${req1.status}`);
  const approvalId = req1.approvalId;

  const approveRes = await kernel.handleRequest({
    id: 'c12_approve',
    toolName: 'job_control',
    category: 'write',
    params: { action: 'approve', approvalId }
  });
  assert(approveRes.status === 'SUCCESS', `approve should succeed, got ${JSON.stringify(approveRes)}`);

  const engine = kernel.getApprovalEngine();
  const record = engine.getApproval(approvalId);
  assert(record && record.status === 'APPROVED', 'record should be APPROVED before expiry');

  // Force expiry, then attempt to ride the APPROVED release path
  record.expiresAt = Date.now() - 1000;
  const req2 = await kernel.handleRequest({ id: 'c12_r2', approvalId, ...req });
  assert(req2.status === 'DENIED', `expired approval must be DENIED, got ${req2.status}`);
  assert(
    (req2.reason || '').includes('APPROVAL_EXPIRED'),
    `reason must mention APPROVAL_EXPIRED, got: ${req2.reason}`
  );
  assert(record.status === 'EXPIRED', `record status must become EXPIRED, got ${record.status}`);
  assert(
    !fs.existsSync(path.join(tmpRoot, 'c12_target.txt')),
    'file must not be written via expired approval'
  );
});

// ---------------------------------------------------------------------------
// Case 13: quoted and -C force-push forms must be detected as critical
// ---------------------------------------------------------------------------
await runCase('C13 quoted / -C force-push forms are critical (requiresMobileHmac=true)', () => {
  const engine = new ApprovalEngine(REAL_SECRET);
  const ctx = { id: 'c13', confinementMode: 'workspace-write', approvalPolicy: 'smart-risk', workspaceRoot: os.tmpdir() };

  const hitCases = [
    'git push "+main"',
    'git push "-f"',
    'git -C repo push -f',
    'git -C "my repo" push "+main"'
  ];
  for (const cmd of hitCases) {
    const ev = engine.evaluateRisk('exec_command', 'sensitive_write', { command: cmd }, ctx);
    assert(
      ev.riskLevel === 'critical' && ev.requiresMobileHmac === true,
      `'${cmd}' must be critical+requiresMobileHmac, got ${ev.riskLevel}/${ev.requiresMobileHmac}`
    );
  }

  // -f outside a push context must not be flagged as force push
  const evLog = engine.evaluateRisk('exec_command', 'sensitive_write', { command: 'git log -f' }, ctx);
  assert(evLog.requiresMobileHmac === false, `'git log -f' must not be flagged as force push`);
});

// ---------------------------------------------------------------------------
// Case 14: loopback POST approve of a critical record -> 403 (exposed bind)
// ---------------------------------------------------------------------------
await runCase('C14 loopback approve of critical record rejected (403 LOOPBACK_SELF_APPROVAL_FORBIDDEN)', async () => {
  // Bind on a non-loopback address (exposed setup): loopback POST approvals of
  // critical records must be rejected. reject is not restricted, and
  // non-critical records are not affected.
  const port = 19833;
  const token = 'negative_test_runtime_token_36_chars_ok';
  const server = new MwhServer({ host: '0.0.0.0', port, runtimeToken: token });
  try {
    await server.start();
    const kernel = server.getKernel();

    // Critical record (requiresMobileHmac=true)
    const res1 = await kernel.handleRequest({
      id: 'c14_switch',
      toolName: 'switch_mode',
      category: 'sensitive_write',
      params: { mode: 'danger-full-access' }
    });
    assert(res1.status === 'CONFIRMATION_REQUIRED', `expected CONFIRMATION_REQUIRED, got ${res1.status}`);
    assert(res1.requiresMobileHmac === true, 'switch to danger-full-access must require mobile HMAC');
    const approvalId = res1.approvalId;
    const sig = new URL(res1.approvalUrl).searchParams.get('sig');

    const approveRes = await httpRequest({
      url: `http://127.0.0.1:${port}/approve/${approvalId}?sig=${sig}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=approve'
    });
    assert(approveRes.statusCode === 403, `expected 403 for loopback critical approve, got ${approveRes.statusCode}`);
    assert(
      approveRes.body.includes('LOOPBACK_SELF_APPROVAL_FORBIDDEN'),
      `body must mention LOOPBACK_SELF_APPROVAL_FORBIDDEN, got: ${approveRes.body.slice(0, 300)}`
    );

    // reject from loopback is NOT restricted
    const rejectRes = await httpRequest({
      url: `http://127.0.0.1:${port}/approve/${approvalId}?sig=${sig}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=reject'
    });
    assert(rejectRes.statusCode === 200, `loopback reject should be allowed, got ${rejectRes.statusCode}`);
    assert(rejectRes.body.includes('Action Rejected'), 'reject result page expected');

    // Non-critical record: loopback approve must NOT be blocked
    const res2 = await kernel.handleRequest({
      id: 'c14_write',
      toolName: 'fs_mutate',
      category: 'write',
      params: { path: 'c14_target.txt', content: 'non-critical' }
    });
    assert(res2.status === 'CONFIRMATION_REQUIRED', `expected CONFIRMATION_REQUIRED, got ${res2.status}`);
    const approve2 = await httpRequest({
      url: `http://127.0.0.1:${port}/approve/${res2.approvalId}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=approve'
    });
    assert(approve2.statusCode === 200, `non-critical loopback approve should succeed, got ${approve2.statusCode}`);
    assert(approve2.body.includes('Action Approved Successfully'), 'non-critical approve should complete');
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Case 15: read-only mode must block --textconv
// ---------------------------------------------------------------------------
await runCase('C15 read-only mode blocks git diff --textconv', async () => {
  const kernel = new PipelineKernel({
    confinementMode: 'read-only',
    approvalPolicy: 'smart-risk',
    workspaceRoot: os.tmpdir()
  });

  const denied = await kernel.handleRequest({
    id: 'c15_textconv',
    toolName: 'exec_command',
    category: 'read',
    params: { command: 'git diff --textconv' }
  });
  assert(denied.status === 'DENIED', `'git diff --textconv' must be DENIED, got ${denied.status}`);

  // sanity: harmless diff flags stay allowed
  const ok = await kernel.handleRequest({
    id: 'c15_stat',
    toolName: 'exec_command',
    category: 'read',
    params: { command: 'git diff --stat' }
  });
  assert(ok.status === 'SUCCESS', `'git diff --stat' must stay SUCCESS, got ${ok.status} ${ok.reason || ''}`);
});

// ---------------------------------------------------------------------------
// Case 16 (G6): Windows `format` regex anchoring — `git log --format=%D` must
// NOT be false-positived as critical, while `format d:` stays critical.
// ---------------------------------------------------------------------------
await runCase('C16 format regex anchoring: git log --format=%D non-critical, format d: critical', () => {
  const engine = new ApprovalEngine(REAL_SECRET);
  const ctx = { id: 'c16', confinementMode: 'workspace-write', approvalPolicy: 'smart-risk', workspaceRoot: os.tmpdir() };

  const nonCriticalCases = [
    { cmd: 'git log --format=%D --date=short', expectedRisk: 'low' },
    { cmd: 'git log -1 --format="%H %D %s"', expectedRisk: 'low' },
    { cmd: 'git -C C:\\Workspace\\DemoRepo log --format=%D', expectedRisk: 'medium' }
  ];
  for (const item of nonCriticalCases) {
    const ev = engine.evaluateRisk('exec_command', 'sensitive_write', { command: item.cmd }, ctx);
    assert(
      ev.riskLevel !== 'critical' && ev.requiresMobileHmac === false,
      `'${item.cmd}' must NOT be critical, got ${ev.riskLevel} (requiresMobileHmac=${ev.requiresMobileHmac})`
    );
    assert(
      ev.riskLevel === item.expectedRisk,
      `'${item.cmd}' expected riskLevel='${item.expectedRisk}', got '${ev.riskLevel}'`
    );
  }

  const criticalFormatCases = [
    'format d:',
    'format C: /q',
    'format /q E:',
    'echo ready & format d:'
  ];
  for (const cmd of criticalFormatCases) {
    const ev = engine.evaluateRisk('exec_command', 'sensitive_write', { command: cmd }, ctx);
    assert(
      ev.riskLevel === 'critical' && ev.requiresMobileHmac === true,
      `'${cmd}' must be critical+requiresMobileHmac, got ${ev.riskLevel}/${ev.requiresMobileHmac}`
    );
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n===============================================================');
console.log('  P1 NEGATIVE TEST SUMMARY');
console.log('===============================================================');
let allPassed = true;
for (const r of results) {
  console.log(`  ${r.passed ? '[PASS]' : '[FAIL]'} - ${r.name}`);
  if (!r.passed) {
    allPassed = false;
    if (r.message) console.log(`         Error: ${r.message}`);
  }
}
console.log('===============================================================');
if (allPassed) {
  console.log(`  RESULT: ALL ${results.length} NEGATIVE CASES PASSED!`);
  process.exit(0);
} else {
  console.error('  RESULT: ONE OR MORE NEGATIVE CASES FAILED!');
  process.exit(1);
}

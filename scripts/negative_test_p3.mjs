/**
 * P3 Negative Security Test Suite (Gateway / Tunnel / Subagent / Uninstall hardening)
 * Run: node scripts/negative_test_p3.mjs  (requires `npm run build` beforehand)
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Critical approvals require an HMAC secret at issuance (fail-closed); provide
// one so CONFIRMATION_REQUIRED (not issuance ERROR) is the deterministic outcome.
process.env.MWH_HMAC_SECRET = process.env.MWH_HMAC_SECRET || 'p3_negative_test_hmac_secret_0123456789abcdef';

const { BearerAuthGuard, normalizeClientIpKey } = await import('../dist/network/authGuard.js');
const {
  validateServerBindSecurity,
  assertTokenEntropy,
  QuickTunnelDriver,
  normalizeTunnelMode
} = await import('../dist/network/tunnels.js');
const { validateOutboundHostSync } = await import('../dist/security/outboundGuard.js');
const { SubagentDispatcher, stricterApprovalPolicy } = await import('../dist/subagents/dispatcher.js');
const { MwhServer } = await import('../dist/network/server.js');

const results = [];

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg || 'Assertion failed');
  }
}

function expectThrowSync(fn, code) {
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

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Case 1: unknown childMode ('workspace-evil') must be rejected outright
// (previously an `undefined > number` comparison silently let it pass).
// ---------------------------------------------------------------------------
await runCase('C1 unknown childMode rejected (PRIVILEGE_ESCALATION_DENIED)', async () => {
  const ws = tmpDir('mwh_p3_c1_');
  const parentCtx = {
    id: 'p3_c1_parent',
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    workspaceRoot: ws
  };
  let threw = '';
  try {
    await SubagentDispatcher.dispatch(
      { agent: 'builtin', prompt: 'escalate', childMode: 'workspace-evil' },
      parentCtx
    );
  } catch (err) {
    threw = String(err?.message || err);
  }
  assert(threw.includes('PRIVILEGE_ESCALATION_DENIED'), `expected PRIVILEGE_ESCALATION_DENIED, got: ${threw || 'no throw'}`);
  fs.rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 2: child approval policy can never be looser than the parent's.
// Parent 'always-ask' + child requests 'auto-workspace' -> effective is
// 'always-ask' (write step requires confirmation, file is NOT created).
// Critical ops are never policy-exempt (even under active unattended-yolo).
// ---------------------------------------------------------------------------
await runCase('C2 subagent policy never loosened + critical always requires approval', async () => {
  const ws = tmpDir('mwh_p3_c2_');
  const parentCtx = {
    id: 'p3_c2_parent',
    confinementMode: 'workspace-write',
    approvalPolicy: 'always-ask',
    workspaceRoot: ws
  };
  const writeFile = path.join(ws, 'p3_should_not_exist.txt');

  const summary = await SubagentDispatcher.dispatch(
    {
      agent: 'builtin',
      prompt: 'try to loosen policy',
      approvalPolicy: 'auto-workspace',
      maxSteps: 5,
      timeoutMs: 20000,
      steps: [{ tool: 'fs_mutate', params: { action: 'write', path: writeFile, content: 'nope' } }]
    },
    parentCtx
  );

  assert(summary.effectivePolicy === 'always-ask', `effectivePolicy expected 'always-ask', got '${summary.effectivePolicy}'`);
  assert(!fs.existsSync(writeFile), 'fs_mutate step must NOT have executed under the stricter parent policy');

  // Critical never exempt: active yolo + yolo request + recursive deletion
  // command must still surface CONFIRMATION_REQUIRED (never auto-executed).
  const yoloParent = {
    id: 'p3_c2_parent_yolo',
    confinementMode: 'workspace-write',
    approvalPolicy: 'unattended-yolo',
    yoloExpiresAt: Date.now() + 60000,
    workspaceRoot: ws
  };
  const yoloSummary = await SubagentDispatcher.dispatch(
    {
      agent: 'builtin',
      prompt: 'yolo critical attempt',
      approvalPolicy: 'unattended-yolo',
      maxSteps: 5,
      timeoutMs: 20000,
      steps: [
        { tool: 'exec_command', params: { command: 'Remove-Item -Recurse -Force C:\\__p3_no_such_target__' } }
      ]
    },
    yoloParent
  );
  assert(
    String(yoloSummary.summary).includes('CONFIRMATION_REQUIRED'),
    `critical op must require confirmation even under unattended-yolo, got: ${yoloSummary.summary}`
  );
  // P3-R2: a run stopped at a pending approval must NOT be reported COMPLETED
  assert(
    yoloSummary.status !== 'COMPLETED',
    `summary status must not be COMPLETED while an approval is pending, got: ${yoloSummary.status}`
  );

  // Helper sanity: stricter-of ordering
  assert(stricterApprovalPolicy('unattended-yolo', 'always-ask') === 'always-ask', 'stricter-of must pick always-ask');
  assert(stricterApprovalPolicy('always-ask', 'unattended-yolo') === 'always-ask', 'stricter-of must keep parent always-ask');
  assert(stricterApprovalPolicy('smart-risk', undefined) === 'smart-risk', 'missing child policy falls back to parent');

  fs.rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 3: subagent cwd outside the parent workspace must be rejected by the
// read-level path fence.
// ---------------------------------------------------------------------------
await runCase('C3 subagent cwd outside workspace rejected (SUBAGENT_CWD_OUT_OF_WORKSPACE)', async () => {
  const ws = tmpDir('mwh_p3_c3_ws_');
  const outside = tmpDir('mwh_p3_c3_out_');
  const parentCtx = {
    id: 'p3_c3_parent',
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    workspaceRoot: ws
  };
  let threw = '';
  try {
    await SubagentDispatcher.dispatch(
      { agent: 'builtin', prompt: 'escape cwd', cwd: outside },
      parentCtx
    );
  } catch (err) {
    threw = String(err?.message || err);
  }
  assert(
    threw.includes('SUBAGENT_CWD_OUT_OF_WORKSPACE'),
    `expected SUBAGENT_CWD_OUT_OF_WORKSPACE, got: ${threw || 'no throw'}`
  );
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 4: token entropy gate — 32 identical characters must be rejected with
// TOKEN_ENTROPY_TOO_WEAK; a proper token passes.
// ---------------------------------------------------------------------------
await runCase('C4 weak token entropy rejected (TOKEN_ENTROPY_TOO_WEAK)', () => {
  expectThrowSync(() => assertTokenEntropy('a'.repeat(32)), 'TOKEN_ENTROPY_TOO_WEAK');
  expectThrowSync(() => assertTokenEntropy('12345678901234567890123456789012'), 'TOKEN_ENTROPY_TOO_WEAK');
  expectThrowSync(() => assertTokenEntropy('short-but-diverse_!@#'), 'TOKEN_ENTROPY_TOO_WEAK');
  // Valid: >=32 chars, >=12 distinct characters
  assertTokenEntropy('Ab1!mnopQrStu34vwxy56789012zMWH#');
  // The bind-security length gate stays intact for reference (entropy is
  // enforced separately via assertTokenEntropy, wired in cli.ts for public binds)
  expectThrowSync(
    () => validateServerBindSecurity('0.0.0.0', 'a'.repeat(31)),
    'FAIL_CLOSED_INSECURE_PUBLIC_BIND'
  );
});

// ---------------------------------------------------------------------------
// Case 5: Tailscale CGNAT bind is only honored when listed in the measured
// allowedTailscaleIps; otherwise the public token requirement applies.
// ---------------------------------------------------------------------------
await runCase('C5 Tailscale bind fail-closed without measured allowedTailscaleIps', () => {
  // Not in list, no token -> rejected
  expectThrowSync(
    () => validateServerBindSecurity('100.64.1.1'),
    'FAIL_CLOSED_INSECURE_PUBLIC_BIND'
  );
  // Not in list, short token -> rejected
  expectThrowSync(
    () => validateServerBindSecurity('100.64.1.1', 'short'),
    'FAIL_CLOSED_INSECURE_PUBLIC_BIND'
  );
  // In the measured list -> allowed without a public token
  validateServerBindSecurity('100.64.1.1', undefined, ['100.64.1.1']);
  // Not in list but valid high-entropy token present -> allowed (public path)
  validateServerBindSecurity('100.64.1.1', 'Ab1!mnopQrStu34vwxy56789012zMWH#', ['100.64.2.2']);
  // Loopback remains always allowed
  validateServerBindSecurity('127.0.0.1', 'short');
});

// ---------------------------------------------------------------------------
// Case 6: outboundGuard BlockList coverage — loopback, IPv4-mapped, NAT64,
// documentation ranges and non-HTTP protocols are blocked; public HTTPS passes.
// ---------------------------------------------------------------------------
await runCase('C6 outboundGuard blocks loopback/mapped/NAT64/TEST-NET and non-HTTP', () => {
  expectThrowSync(() => validateOutboundHostSync('http://127.0.0.1/'), 'OUTBOUND_GUARD_BLOCKED');
  expectThrowSync(() => validateOutboundHostSync('http://[::ffff:127.0.0.1]/'), 'OUTBOUND_GUARD_BLOCKED');
  expectThrowSync(() => validateOutboundHostSync('http://[::ffff:7f00:1]/'), 'OUTBOUND_GUARD_BLOCKED');
  expectThrowSync(() => validateOutboundHostSync('http://[64:ff9b::7f00:1]/'), 'OUTBOUND_GUARD_BLOCKED');
  expectThrowSync(() => validateOutboundHostSync('http://192.0.2.1/'), 'OUTBOUND_GUARD_BLOCKED');
  expectThrowSync(() => validateOutboundHostSync('http://100.64.1.1/'), 'OUTBOUND_GUARD_BLOCKED');
  expectThrowSync(() => validateOutboundHostSync('ftp://x/'), 'OUTBOUND_GUARD_BLOCKED');
  // Public HTTPS passes (sync validation, no DNS involved)
  validateOutboundHostSync('https://example.com/');
});

// ---------------------------------------------------------------------------
// Case 7: authGuard — full IPv6 addresses never share a ban bucket, and
// failures older than the sliding window do not count towards a ban.
// ---------------------------------------------------------------------------
await runCase('C7 authGuard full-IPv6 buckets + sliding window', () => {
  assert(normalizeClientIpKey('::ffff:192.168.1.5') === '192.168.1.5', 'mapped IPv6 must normalize to IPv4');

  const guard = new BearerAuthGuard('secret-token-p3');
  // 4 failures from IPv6 address A
  for (let i = 0; i < 4; i++) {
    const r = guard.checkAuth('Bearer wrong', '2001:db8:1111::1');
    assert(r.statusCode === 401, `failure ${i + 1} expected 401, got ${r.statusCode}`);
  }
  // 1st failure from IPv6 address B — SAME last segment as A but different
  // prefix. The old truncation (`replace(/^.*:/,'')`) collapsed BOTH keys to
  // '1', so this request would have inherited A's 4 failures and returned 429.
  // Full-address keying must keep them in separate buckets (401 here).
  const rB = guard.checkAuth('Bearer wrong', '2001:db8:2222::1');
  assert(rB.statusCode === 401, `same-last-segment IPv6 must not share a bucket, got ${rB.statusCode}`);
  // Correct token still works for A (and resets its counter)
  const rOk = guard.checkAuth('Bearer secret-token-p3', '2001:db8:1111::1');
  assert(rOk.statusCode === 200 && rOk.authenticated, `correct token must authenticate, got ${rOk.statusCode}`);

  // Sliding window: 4 failures aged 16 minutes (outside the 15-minute window,
  // inside the 30-minute entry TTL) must not combine with a new failure into a ban.
  const guard2 = new BearerAuthGuard('t2');
  for (let i = 0; i < 4; i++) {
    guard2.checkAuth('Bearer wrong', '192.0.2.10');
  }
  const stale = Date.now() - 16 * 60 * 1000;
  const record = guard2.failedAttempts.get('192.0.2.10');
  assert(!!record, 'tracking record should exist (within 30min TTL)');
  record.failures = [stale, stale, stale, stale];
  const rStale = guard2.checkAuth('Bearer wrong', '192.0.2.10');
  assert(
    rStale.statusCode === 401,
    `stale failures must not trigger a ban, got ${rStale.statusCode}: ${rStale.message}`
  );
  // Fresh 4 failures DO ban
  for (let i = 0; i < 4; i++) {
    guard2.checkAuth('Bearer wrong', '192.0.2.10');
  }
  const rBanned = guard2.checkAuth('Bearer wrong', '192.0.2.10');
  assert(rBanned.statusCode === 429, `5 fresh failures must ban, got ${rBanned.statusCode}`);
});

// ---------------------------------------------------------------------------
// Case 8: cloudflared probe resolves a configured versions directory
// (newest version wins) via read-only filesystem probing.
// ---------------------------------------------------------------------------
await runCase('C8 cloudflared probe finds versions dir (newest)', () => {
  const savedEnv = process.env.CLOUDFLARED_PATH;
  const savedDirEnv = process.env.MWH_CLOUDFLARED_DIR;
  const fakeRoot = tmpDir('mwh_p3_c8_cf_');
  const versionsDir = path.join(fakeRoot, 'components', 'cloudflared', 'versions');
  const olderDir = path.join(versionsDir, '2026.9.1');
  const newerDir = path.join(versionsDir, '2026.10.7');
  fs.mkdirSync(olderDir, { recursive: true });
  fs.mkdirSync(newerDir, { recursive: true });
  fs.writeFileSync(path.join(olderDir, 'cloudflared.exe'), 'MZ-fake-old');
  fs.writeFileSync(path.join(newerDir, 'cloudflared.exe'), 'MZ-fake-new');

  delete process.env.CLOUDFLARED_PATH;
  process.env.MWH_CLOUDFLARED_DIR = versionsDir;
  try {
    const probe = QuickTunnelDriver.probeCloudflared();
    console.log(`    probe path: ${probe.path || 'none'}`);
    assert(probe.found === true, `probe should find cloudflared in MWH_CLOUDFLARED_DIR, got found=${probe.found}`);
    assert(
      /versions/i.test(probe.path || ''),
      `probe path should contain versions dir, got: ${probe.path}`
    );
    assert(
      (probe.path || '').includes('2026.10.7'),
      `probe should pick the newest version dir (2026.10.7), got: ${probe.path}`
    );
    assert(fs.existsSync(probe.path), 'probed path must exist on disk');
  } finally {
    if (savedEnv !== undefined) {
      process.env.CLOUDFLARED_PATH = savedEnv;
    }
    if (savedDirEnv !== undefined) {
      process.env.MWH_CLOUDFLARED_DIR = savedDirEnv;
    } else {
      delete process.env.MWH_CLOUDFLARED_DIR;
    }
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 9 (P3-R2): through the real HTTP entry, two client addresses that share
// the last segment but differ in prefix must NOT share a ban bucket — the old
// server-side `.replace(/^.*:/,'')` truncation collapsed '::1' and
// '::ffff:127.0.0.1' into the same bucket key '1'.
// ---------------------------------------------------------------------------
await runCase('C9 HTTP entry: no IPv6 last-segment bucket collision', async () => {
  const server = new MwhServer({
    host: '::',
    port: 0,
    runtimeToken: 'Ab1!mnopQrStu34vwxy56789012zMWH#'
  });
  const { server: httpServer, url } = await server.start();
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert(port > 0, `server must listen on an ephemeral port, got ${port}`);

  const request = (hostname, family, authHeader) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: hostname, family, port, path: '/api/v1/status', method: 'GET', headers: { Authorization: authHeader } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c.toString()));
          res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }
      );
      req.on('error', reject);
      req.end();
    });

  try {
    // 4 failures from ::1 (native IPv6; under the old truncation this key was '1')
    for (let i = 0; i < 4; i++) {
      const r = await request('::1', 6, 'Bearer wrong');
      assert(r.statusCode === 401, `::1 failure ${i + 1} expected 401, got ${r.statusCode}`);
    }
    // 1 failure from 127.0.0.1 (remoteAddress '::ffff:127.0.0.1' — normalizeClientIpKey
    // maps this to the IPv4 key '127.0.0.1', which must be a DIFFERENT bucket from ::1)
    const r4 = await request('127.0.0.1', 4, 'Bearer wrong');
    assert(
      r4.statusCode === 401,
      `mapped-IPv4 client must have its own bucket, got ${r4.statusCode}: ${r4.body}`
    );
    // 5th failure over ::1 completes ITS bucket -> 429
    const r5 = await request('::1', 6, 'Bearer wrong');
    assert(r5.statusCode === 429, `5th ::1 failure must ban, got ${r5.statusCode}`);
    // and the 127.0.0.1 bucket is still independent (not banned)
    const r6 = await request('127.0.0.1', 4, 'Bearer wrong');
    assert(r6.statusCode === 401, `127.0.0.1 client must not inherit ::1's ban, got ${r6.statusCode}`);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Case 10 (P3-R2): dispatcher default policy inherits the parent; an explicitly
// declared looser policy is clamped to the parent.
// ---------------------------------------------------------------------------
await runCase('C10 dispatcher default policy inherits parent, explicit looser clamped', async () => {
  const ws = tmpDir('mwh_p3_c10_');

  const dispatchWith = async (parentPolicy, requestPolicy) => {
    const parentCtx = {
      id: `p3_c10_${parentPolicy}`,
      confinementMode: 'workspace-write',
      approvalPolicy: parentPolicy,
      workspaceRoot: ws
    };
    const req = {
      agent: 'builtin',
      prompt: 'policy inheritance probe',
      maxSteps: 5,
      timeoutMs: 20000,
      steps: [{ tool: 'pc_status', params: {} }]
    };
    if (requestPolicy !== undefined) req.approvalPolicy = requestPolicy;
    return SubagentDispatcher.dispatch(req, parentCtx);
  };

  // no declaration -> inherit parent
  const s1 = await dispatchWith('always-ask', undefined);
  assert(s1.effectivePolicy === 'always-ask', `undeclared under always-ask parent must inherit 'always-ask', got '${s1.effectivePolicy}'`);
  const s2 = await dispatchWith('auto-workspace', undefined);
  assert(s2.effectivePolicy === 'auto-workspace', `undeclared under auto-workspace parent must inherit 'auto-workspace', got '${s2.effectivePolicy}'`);
  // explicit looser request -> clamped to parent
  const s3 = await dispatchWith('always-ask', 'unattended-yolo');
  assert(s3.effectivePolicy === 'always-ask', `explicit looser request must clamp to parent 'always-ask', got '${s3.effectivePolicy}'`);
  const s4 = await dispatchWith('smart-risk', 'unattended-yolo');
  assert(s4.effectivePolicy === 'smart-risk', `explicit looser request must clamp to parent 'smart-risk', got '${s4.effectivePolicy}'`);

  // and the clamp is real: under always-ask parent a write step needs approval
  const parentCtx = {
    id: 'p3_c10_blocker',
    confinementMode: 'workspace-write',
    approvalPolicy: 'always-ask',
    workspaceRoot: ws
  };
  const writeFile = path.join(ws, 'c10_should_not_exist.txt');
  const blocked = await SubagentDispatcher.dispatch(
    {
      agent: 'builtin',
      prompt: 'write probe',
      maxSteps: 5,
      timeoutMs: 20000,
      steps: [{ tool: 'fs_mutate', params: { action: 'write', path: writeFile, content: 'nope' } }]
    },
    parentCtx
  );
  assert(blocked.effectivePolicy === 'always-ask', 'undeclared child must inherit always-ask');
  assert(blocked.status !== 'COMPLETED', 'write step under inherited always-ask must not complete silently');
  assert(!fs.existsSync(writeFile), 'write must not have executed without approval');

  fs.rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 11 (P3-R2): outboundGuard mapped-form semantics — dotted mapped form
// follows IPv4 rules; hex mapped form hits the ::ffff:0:0/96 fail-closed rule.
// ---------------------------------------------------------------------------
await runCase('C11 outboundGuard mapped forms: decode-to-IPv4 + fail-closed malformed', () => {
  // dotted mapped public -> ALLOWED (IPv4 semantics)
  validateOutboundHostSync('http://[::ffff:8.8.8.8]/');
  // dotted mapped loopback/private -> denied via the IPv4 table
  expectThrowSync(() => validateOutboundHostSync('http://[::ffff:127.0.0.1]/'), 'OUTBOUND_GUARD_BLOCKED');
  expectThrowSync(() => validateOutboundHostSync('http://[::ffff:192.168.1.1]/'), 'OUTBOUND_GUARD_BLOCKED');
  expectThrowSync(() => validateOutboundHostSync('http://[::ffff:10.0.0.5]/'), 'OUTBOUND_GUARD_BLOCKED');
  // hex mapped -> decoded to the embedded IPv4 and judged by IPv4 rules
  // (7f00:1 == 127.0.0.1 -> loopback -> denied)
  expectThrowSync(() => validateOutboundHostSync('http://[::ffff:7f00:1]/'), 'OUTBOUND_GUARD_BLOCKED');
  // malformed pseudo-mapped form -> fail-closed (unknown address format blocked)
  expectThrowSync(() => validateOutboundHostSync('http://[::ffff:1.2.3]/'), 'OUTBOUND_GUARD_BLOCKED');
  // URL canonicalization: [::ffff:8.8.8.8] becomes hostname '::ffff:808:808' —
  // the decoded public IPv4 must still be allowed (8.8.8.8 semantics)
  validateOutboundHostSync('http://[::ffff:0808:0808]/');
});

// ---------------------------------------------------------------------------
// Case 12 (P3-R2): tunnel.mode normalization — missing/empty defaults to
// 'quick'; legacy aliases map; explicit 'off' is the only off switch.
// ---------------------------------------------------------------------------
await runCase('C12 tunnel.mode normalization defaults to quick', () => {
  assert(normalizeTunnelMode(undefined) === 'quick', `missing mode must default to 'quick', got '${normalizeTunnelMode(undefined)}'`);
  assert(normalizeTunnelMode(null) === 'quick', `null mode must default to 'quick'`);
  assert(normalizeTunnelMode('') === 'quick', `empty mode must default to 'quick'`);
  assert(normalizeTunnelMode('   ') === 'quick', `whitespace mode must default to 'quick'`);
  assert(normalizeTunnelMode('off') === 'off', `explicit 'off' must stay off`);
  assert(normalizeTunnelMode('quick-tunnel') === 'quick', 'legacy alias quick-tunnel -> quick');
  assert(normalizeTunnelMode('named-tunnel') === 'named', 'legacy alias named-tunnel -> named');
  assert(normalizeTunnelMode('custom-reverse-proxy') === 'custom', 'legacy alias custom-reverse-proxy -> custom');
  assert(normalizeTunnelMode('tailscale') === 'tailscale', 'tailscale passes through');
});

// ---------------------------------------------------------------------------
// Case 13: Global Emergency Kill 3-Layer Closure — rejects all PENDING approvals
// (preventing post-kill approval execution) and increments emergencyEpoch to
// interrupt in-flight builtin ReAct step loops mid-flight.
// ---------------------------------------------------------------------------
await runCase('C13 global emergency kill rejects pending approvals & aborts in-flight ReAct loops', async () => {
  const ws = tmpDir('mwh_p3_c13_');
  const { PipelineKernel } = await import('../dist/pipeline/pipeline.js');
  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'always-ask',
    workspaceRoot: ws
  });

  // 1) Create a pending approval and verify rejectAllPending('EMERGENCY_KILL')
  const r1 = await kernel.handleRequest({
    id: 'c13_req1',
    toolName: 'fs_mutate',
    category: 'write',
    params: { action: 'write', path: path.join(ws, 'after_emg.txt'), content: 'should_not_write' }
  });
  assert(r1.status === 'CONFIRMATION_REQUIRED' && r1.approvalId, 'expected CONFIRMATION_REQUIRED');
  const engine = kernel.getApprovalEngine();
  assert(engine.listPendingApprovals().length === 1, 'expected 1 pending approval');

  const rejected = engine.rejectAllPending('EMERGENCY_KILL');
  assert(rejected.includes(r1.approvalId), 'rejectAllPending must return the rejected approvalId');
  assert(engine.listPendingApprovals().length === 0, 'pending approvals must be 0 after rejectAllPending');

  const receipt = engine.getSanitizedReceipt(r1.approvalId);
  assert(receipt?.status === 'REJECTED' && receipt?.executionStatus === 'DENIED', 'receipt must be REJECTED/DENIED');

  // Attempting to resolve or execute with the rejected approvalId must fail
  expectThrowSync(
    () => engine.resolveApproval(r1.approvalId, 'approve', undefined, 'once', kernel.getContext(), 'ui_island'),
    'APPROVAL_ALREADY_RESOLVED'
  );

  // 2) Verify in-flight builtin ReAct loop aborts when triggerEmergencyStop() fires after step 1
  const step2File = path.join(ws, 'step2_must_not_run.txt');
  const parentCtx = {
    id: 'c13_react_parent',
    confinementMode: 'workspace-write',
    approvalPolicy: 'auto-workspace',
    workspaceRoot: ws
  };

  // Trigger emergency stop during step 1 (a short sleep command) so step 2 (fs_mutate) never executes
  setTimeout(() => {
    SubagentDispatcher.triggerEmergencyStop();
  }, 150);

  const reactSummary = await SubagentDispatcher.dispatch(
    {
      agent: 'builtin',
      prompt: 'multi-step emergency stop test',
      maxSteps: 5,
      timeoutMs: 10000,
      steps: [
        { tool: 'exec_command', params: { command: 'Start-Sleep -Milliseconds 450' } },
        { tool: 'fs_mutate', params: { action: 'write', path: step2File, content: 'LEAKED_AFTER_EMERGENCY' } }
      ]
    },
    parentCtx
  );

  assert(reactSummary.status === 'FAILED', `expected FAILED after emergency stop, got ${reactSummary.status}`);
  assert(
    String(reactSummary.error || '').includes('EMERGENCY_KILL_ABORTED'),
    `expected EMERGENCY_KILL_ABORTED, got ${reactSummary.error}`
  );
  assert(!fs.existsSync(step2File), 'Step 2 file must NOT be created after emergency stop');
  fs.rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 14: 4-Profile Permission Matrix (plan / confirm / autonomous / full-access)
// x 6 Core Action Classes — reproducible live verification of every cell.
// ---------------------------------------------------------------------------
await runCase('C14 4-profile permission matrix (plan/confirm/autonomous/full-access x 6 actions)', async () => {
  const ws = tmpDir('mwh_p3_c14_ws_');
  const outside = tmpDir('mwh_p3_c14_out_');
  fs.writeFileSync(path.join(ws, 'readme.txt'), 'HELLO_MWH', 'utf-8');
  fs.writeFileSync(path.join(outside, 'ext.txt'), 'EXT_DATA', 'utf-8');
  const { PipelineKernel } = await import('../dist/pipeline/pipeline.js');
  const { profileToConfinementAndPolicy } = await import('../dist/types.js');

  const makeKernel = (profile) => {
    const mapped = profileToConfinementAndPolicy(profile);
    return new PipelineKernel({
      confinementMode: mapped.confinementMode,
      approvalPolicy: mapped.approvalPolicy,
      yoloExpiresAt: profile === 'full-access' ? Date.now() + 3600_000 : undefined,
      workspaceRoot: ws,
      hmacSecret: 'matrix_hmac_secret_0123456789abcdef0123456789abcdef'
    });
  };

  // 1) PLAN profile (read-only / smart-risk)
  {
    const k = makeKernel('plan');
    const rRead = await k.handleRequest({ id: 'm_plan_read', toolName: 'fs_explore', category: 'read', params: { action: 'read', path: 'readme.txt' } });
    assert(rRead.status === 'SUCCESS', `plan read expected SUCCESS, got ${rRead.status}`);
    const rWrite = await k.handleRequest({ id: 'm_plan_write', toolName: 'fs_mutate', category: 'write', params: { action: 'write', path: 'a.txt', content: 'x' } });
    assert(rWrite.status === 'DENIED' && String(rWrite.reason).includes('READ_ONLY_MODE_WRITE_DENIED'), `plan write expected DENIED, got ${JSON.stringify(rWrite)}`);
    const rExecRo = await k.handleRequest({ id: 'm_plan_exec_ro', toolName: 'exec_command', category: 'read', params: { command: 'whoami' } });
    assert(rExecRo.status === 'SUCCESS', `plan whitelisted exec expected SUCCESS, got ${rExecRo.status}`);
    const rExecMut = await k.handleRequest({ id: 'm_plan_exec_mut', toolName: 'exec_command', category: 'sensitive_write', params: { command: 'Write-Output "mut"' } });
    assert(rExecMut.status === 'DENIED' && String(rExecMut.reason).includes('READ_ONLY_MODE_COMMAND_DENIED'), `plan mutating exec expected DENIED, got ${JSON.stringify(rExecMut)}`);
    const rSubEsc = await k.handleRequest({ id: 'm_plan_sub', toolName: 'subagent_dispatch', category: 'sensitive_write', params: { agent: 'builtin', prompt: 'test', childMode: 'workspace-write' } });
    assert((rSubEsc.status === 'CONFIRMATION_REQUIRED' || rSubEsc.status === 'DENIED' || rSubEsc.status === 'ERROR'), `plan subagent write must not succeed`);
    const rSnap = await k.handleRequest({ id: 'm_plan_snap', toolName: 'git_checkpoint', category: 'write', params: { action: 'create' } });
    assert(rSnap.status === 'DENIED' && String(rSnap.reason).includes('READ_ONLY_MODE_WRITE_DENIED'), `plan git_checkpoint write expected DENIED, got ${rSnap.status}`);
  }

  // 2) CONFIRM profile (workspace-write / smart-risk)
  {
    const k = makeKernel('confirm');
    const rRead = await k.handleRequest({ id: 'm_cf_read', toolName: 'fs_explore', category: 'read', params: { action: 'read', path: 'readme.txt' } });
    assert(rRead.status === 'SUCCESS', `confirm in-workspace read expected SUCCESS, got ${rRead.status}`);
    const rOutRead = await k.handleRequest({ id: 'm_cf_out', toolName: 'fs_explore', category: 'read', params: { action: 'read', path: path.join(outside, 'ext.txt') } });
    assert(rOutRead.status === 'DENIED' && String(rOutRead.reason).includes('PATH_CONFINEMENT_VIOLATION'), `confirm out-of-workspace read expected DENIED`);
    const rWrite = await k.handleRequest({ id: 'm_cf_write', toolName: 'fs_mutate', category: 'write', params: { action: 'write', path: 'cf.txt', content: 'x' } });
    assert(rWrite.status === 'CONFIRMATION_REQUIRED' && rWrite.riskLevel === 'medium', `confirm write expected CONFIRMATION_REQUIRED (medium), got ${rWrite.status}`);
    const rExec = await k.handleRequest({ id: 'm_cf_exec', toolName: 'exec_command', category: 'sensitive_write', params: { command: 'Write-Output "hi"' } });
    assert(rExec.status === 'CONFIRMATION_REQUIRED' && rExec.riskLevel === 'medium', `confirm exec expected CONFIRMATION_REQUIRED, got ${rExec.status}`);
    const rSub = await k.handleRequest({ id: 'm_cf_sub', toolName: 'subagent_dispatch', category: 'sensitive_write', params: { agent: 'builtin', prompt: 'run step', steps: [] } });
    assert(rSub.status === 'CONFIRMATION_REQUIRED', `confirm subagent_dispatch expected CONFIRMATION_REQUIRED, got ${rSub.status}`);
    const rCrit = await k.handleRequest({ id: 'm_cf_crit', toolName: 'exec_command', category: 'sensitive_write', params: { command: 'rm -rf ./build_tmp' } });
    assert(rCrit.status === 'CONFIRMATION_REQUIRED' && rCrit.riskLevel === 'critical' && rCrit.requiresMobileHmac === true, `confirm critical expected requiresMobileHmac=true`);
  }

  // 3) AUTONOMOUS profile (workspace-write / auto-workspace)
  {
    const k = makeKernel('autonomous');
    const rWrite = await k.handleRequest({ id: 'm_auto_write', toolName: 'fs_mutate', category: 'write', params: { action: 'write', path: path.join(ws, 'auto.txt'), content: 'AUTO_OK' } });
    assert(rWrite.status === 'SUCCESS' && fs.readFileSync(path.join(ws, 'auto.txt'), 'utf-8') === 'AUTO_OK', `autonomous in-workspace write expected SUCCESS`);
    const rExec = await k.handleRequest({ id: 'm_auto_exec', toolName: 'exec_command', category: 'sensitive_write', params: { command: 'Write-Output "AUTO_EXEC_OK"' } });
    assert(rExec.status === 'SUCCESS' && String(rExec.data?.stdout).includes('AUTO_EXEC_OK'), `autonomous in-workspace exec expected SUCCESS`);
    const rOutWrite = await k.handleRequest({ id: 'm_auto_out', toolName: 'fs_mutate', category: 'write', params: { action: 'write', path: path.join(outside, 'escape.txt'), content: 'no' } });
    assert(rOutWrite.status === 'DENIED' && String(rOutWrite.reason).includes('PATH_CONFINEMENT_VIOLATION'), `autonomous out-of-workspace write expected DENIED`);
    const rEnv = await k.handleRequest({ id: 'm_auto_env', toolName: 'fs_explore', category: 'read', params: { action: 'read', path: path.join(ws, '.env') } });
    assert(rEnv.status === 'DENIED' && String(rEnv.reason).includes('SENSITIVE_BLACKLIST'), `autonomous .env read expected DENIED`);
    const rSubEsc = await k.handleRequest({ id: 'm_auto_sub_esc', toolName: 'subagent_dispatch', category: 'sensitive_write', params: { agent: 'builtin', prompt: 'esc', childMode: 'danger-full-access', steps: [] } });
    assert(rSubEsc.status === 'CONFIRMATION_REQUIRED' && rSubEsc.riskLevel === 'high', `autonomous subagent_dispatch (sensitive_write=high) expected CONFIRMATION_REQUIRED first, got ${JSON.stringify(rSubEsc)}`);
    k.getApprovalEngine().resolveApproval(rSubEsc.approvalId, 'approve', undefined, 'once', k.getContext(), 'ui_island');
    const rSubEscExec = await k.handleRequest({ id: 'm_auto_sub_esc2', approvalId: rSubEsc.approvalId, toolName: 'subagent_dispatch', category: 'sensitive_write', params: { agent: 'builtin', prompt: 'esc', childMode: 'danger-full-access', steps: [] } });
    assert(rSubEscExec.status === 'ERROR' && String(rSubEscExec.error).includes('PRIVILEGE_ESCALATION_DENIED'), `even after human approval, childMode > parentMode must fail with PRIVILEGE_ESCALATION_DENIED, got ${JSON.stringify(rSubEscExec)}`);
    const rCrit = await k.handleRequest({ id: 'm_auto_crit', toolName: 'exec_command', category: 'sensitive_write', params: { command: 'git push --force origin main' } });
    assert(rCrit.status === 'CONFIRMATION_REQUIRED' && rCrit.riskLevel === 'critical' && rCrit.requiresMobileHmac === true, `autonomous critical force-push expected CONFIRMATION_REQUIRED+HMAC`);
  }

  // 4) FULL-ACCESS profile (danger-full-access / unattended-yolo)
  {
    const k = makeKernel('full-access');
    const extTarget = path.join(outside, 'full_access_ok.txt');
    const rOutWrite = await k.handleRequest({ id: 'm_full_out', toolName: 'fs_mutate', category: 'write', params: { action: 'write', path: extTarget, content: 'FULL_OK' } });
    assert(rOutWrite.status === 'SUCCESS' && fs.readFileSync(extTarget, 'utf-8') === 'FULL_OK', `full-access cross-directory ordinary write expected SUCCESS`);
    const rEnv = await k.handleRequest({ id: 'm_full_env', toolName: 'fs_mutate', category: 'write', params: { action: 'write', path: path.join(ws, '.env.production'), content: 'SECRET=1' } });
    assert(rEnv.status === 'CONFIRMATION_REQUIRED' && rEnv.riskLevel === 'critical' && rEnv.requiresMobileHmac === true, `full-access .env* write must be intercepted as critical + requiresMobileHmac=true, got ${JSON.stringify(rEnv)}`);
    const rCritDel = await k.handleRequest({ id: 'm_full_crit1', toolName: 'fs_mutate', category: 'write', params: { action: 'delete', path: path.join(ws, 'some_dir'), recursive: true } });
    assert(rCritDel.status === 'CONFIRMATION_REQUIRED' && rCritDel.riskLevel === 'critical' && rCritDel.requiresMobileHmac === true, `full-access recursive fs_mutate delete must require HMAC confirmation`);
    const rCritCmd = await k.handleRequest({ id: 'm_full_crit2', toolName: 'exec_command', category: 'sensitive_write', params: { command: 'Remove-Item -Recurse -Force C:\\__nonexistent_full__' } });
    assert(rCritCmd.status === 'CONFIRMATION_REQUIRED' && rCritCmd.riskLevel === 'critical' && rCritCmd.requiresMobileHmac === true, `full-access Remove-Item -Recurse must require HMAC confirmation`);
  }

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 15: Static-analysis closure & boundary hardening regression
// - normalizeClientIpKey pure string canonicalization (no regex exec, shell metacharacters inert)
// - probeCloudflared MWH_CLOUDFLARED_DIR exact 'cloudflared.exe' filename & traversal rejection
// - DesktopHands.execute coordinate finite validation
// ---------------------------------------------------------------------------
await runCase('C15 static-analysis closure: normalizeClientIpKey pure function, cloudflared filename fence & DesktopHands validation', async () => {
  const { DesktopHands } = await import('../dist/tools/desktopHands.js');

  // 1) normalizeClientIpKey canonicalizes mapped IPv4, bracketed IPv6, and keeps arbitrary strings inert
  assert(normalizeClientIpKey('::ffff:10.20.30.40') === '10.20.30.40', '::ffff: mapped IPv4 must canonicalize');
  assert(normalizeClientIpKey('0:0:0:0:0:ffff:172.16.0.9') === '172.16.0.9', 'long mapped IPv4 must canonicalize');
  assert(normalizeClientIpKey('[::ffff:192.168.0.1]') === '192.168.0.1', 'bracketed mapped IPv4 must canonicalize');
  assert(normalizeClientIpKey('[2001:db8::abcd]') === '2001:db8::abcd', 'bracketed native IPv6 must strip brackets');
  assert(normalizeClientIpKey('') === 'unknown', 'empty IP must fall back to unknown');
  assert(
    normalizeClientIpKey('::ffff:not-an-ip;whoami') === '::ffff:not-an-ip;whoami',
    'non-IPv4 suffix must not be stripped as valid IPv4'
  );

  // 2) probeCloudflared MWH_CLOUDFLARED_DIR file mode rejects non-cloudflared.exe files
  const savedCfPath = process.env.CLOUDFLARED_PATH;
  const savedCfDir = process.env.MWH_CLOUDFLARED_DIR;
  const savedPath = process.env.PATH;
  const savedProgFiles = process.env.ProgramFiles;
  const savedLocalAppData = process.env.LOCALAPPDATA;
  const tmpCfRoot = tmpDir('mwh_p3_c15_cf_');
  try {
    const decoyExe = path.join(tmpCfRoot, 'evil.exe');
    fs.writeFileSync(decoyExe, 'MZ-decoy');
    delete process.env.CLOUDFLARED_PATH;
    process.env.PATH = tmpCfRoot;
    process.env.ProgramFiles = path.join(tmpCfRoot, 'no_pf');
    process.env.LOCALAPPDATA = path.join(tmpCfRoot, 'no_lad');
    process.env.MWH_CLOUDFLARED_DIR = decoyExe;

    const rejectedDecoy = QuickTunnelDriver.probeCloudflared(undefined, tmpCfRoot);
    assert(
      rejectedDecoy.found === false,
      `MWH_CLOUDFLARED_DIR pointing to evil.exe must be rejected, got ${JSON.stringify(rejectedDecoy)}`
    );

    const validExe = path.join(tmpCfRoot, 'cloudflared.exe');
    fs.writeFileSync(validExe, 'MZ-valid');
    process.env.MWH_CLOUDFLARED_DIR = validExe;
    const acceptedExact = QuickTunnelDriver.probeCloudflared(undefined, tmpCfRoot);
    assert(
      acceptedExact.found === true && acceptedExact.path === validExe,
      `MWH_CLOUDFLARED_DIR pointing to cloudflared.exe must be accepted, got ${JSON.stringify(acceptedExact)}`
    );
  } finally {
    if (savedCfPath !== undefined) process.env.CLOUDFLARED_PATH = savedCfPath;
    else delete process.env.CLOUDFLARED_PATH;
    if (savedCfDir !== undefined) process.env.MWH_CLOUDFLARED_DIR = savedCfDir;
    else delete process.env.MWH_CLOUDFLARED_DIR;
    if (savedPath !== undefined) process.env.PATH = savedPath;
    if (savedProgFiles !== undefined) process.env.ProgramFiles = savedProgFiles;
    if (savedLocalAppData !== undefined) process.env.LOCALAPPDATA = savedLocalAppData;
    fs.rmSync(tmpCfRoot, { recursive: true, force: true });
  }

  // 3) DesktopHands rejects non-finite coordinates before invoking Win32/UIA
  if (process.platform === 'win32') {
    let caught = '';
    try {
      await DesktopHands.execute({ action: 'mouse_move', x: Number.NaN, y: 10 }, true);
    } catch (err) {
      caught = String(err?.message || err);
    }
    assert(
      caught.includes('INVALID_COORDINATES'),
      `Expected INVALID_COORDINATES for NaN mouse_move, got: ${caught}`
    );

    // 3b) S3: zero-coordinate click must be rejected fail-closed (no blind cursor click)
    let zeroCoordMsg = '';
    try {
      await DesktopHands.execute({ action: 'click' }, true);
    } catch (err) {
      zeroCoordMsg = String(err?.message || err);
    }
    assert(
      zeroCoordMsg.includes('INVALID_COORDINATES'),
      `Expected INVALID_COORDINATES for zero-coord click, got: ${zeroCoordMsg}`
    );

    // 3c) F3: DesktopHands disabled by default (fail-closed)
    let disabledMsg = '';
    try {
      await DesktopHands.execute({ action: 'windows' }, false);
    } catch (err) {
      disabledMsg = String(err?.message || err);
    }
    assert(
      disabledMsg.includes('DESKTOP_HANDS_DISABLED'),
      `Expected DESKTOP_HANDS_DISABLED when enabled=false, got: ${disabledMsg}`
    );
  }

  // 4) F3 + S2 + S4: desktop_hands hidden by default, foreground risk alignment, and job_control self-approval blocked
  const { getExposedMuseTools } = await import('../dist/tools/definitions.js');
  assert(
    !getExposedMuseTools(false).some((t) => t.name === 'desktop_hands'),
    'getExposedMuseTools(false) must hide desktop_hands'
  );
  assert(
    getExposedMuseTools(true).some((t) => t.name === 'desktop_hands'),
    'getExposedMuseTools(true) must expose desktop_hands'
  );

  const { ApprovalEngine } = await import('../dist/pipeline/approvalEngine.js');
  const ae = new ApprovalEngine('p3_c15_hmac_secret_0123456789abcdef0123456789abcdef');
  const fgMoveEval = ae.evaluateRisk(
    'desktop_hands',
    'sensitive_write',
    { action: 'act', op: 'move', x: 100, y: 100 },
    { confinementMode: 'workspace-write', approvalPolicy: 'auto-workspace', workspaceRoot: process.cwd() }
  );
  assert(fgMoveEval.riskLevel === 'high', `act(move) must evaluate as high risk, got ${fgMoveEval.riskLevel}`);
  const autoFallbackEval = ae.evaluateRisk(
    'desktop_hands',
    'sensitive_write',
    { action: 'act', op: 'click', x: 100, y: 100, delivery: 'auto' },
    { confinementMode: 'workspace-write', approvalPolicy: 'auto-workspace', workspaceRoot: process.cwd() }
  );
  assert(
    autoFallbackEval.riskLevel === 'high',
    `act(click, auto, no hwnd) must evaluate as high risk, got ${autoFallbackEval.riskLevel}`
  );
  const { approvalRecord: pendingDh } = ae.createApproval(
    'req_c15_dh_1',
    'desktop_hands',
    'sensitive_write',
    { action: 'act', op: 'click', hwnd: 12345, x: 100, y: 100 },
    'medium',
    'Desktop background act:click',
    false,
    { confinementMode: 'workspace-write', approvalPolicy: 'smart-risk', workspaceRoot: process.cwd() }
  );
  expectThrowSync(
    () => ae.resolveApproval(pendingDh.id, 'approve', undefined, 'session', undefined, 'job_control'),
    'HIGH_RISK_AI_SELF_APPROVAL_FORBIDDEN'
  );
});

// ---------------------------------------------------------------------------
// Case 16: Bearer Token & Secret Defense Line (6 Gaps)
// 1. DPAPI secretStore (`mwh-secrets/v2-dpapi`) round-trip + legacy plaintext auto-upgrade
// 2. Token TTL expiry in BearerAuthGuard (`401 TOKEN_EXPIRED`) + `postRotateToken` DPAPI persistence & UI cookie invalidation
// 3. `/api/v1/tunnel/token` blocks cross-origin `Origin`, `Sec-Fetch-Site: cross-site`, proxy headers (`CF-Connecting-IP`), and omits `Access-Control-Allow-Origin`
// 4. REST `POST /api/v1/tasks/:id/approve` blocks `body.source='ui_island'` spoofing from MCP/tunnel/cross-origin and enforces `403 LOOPBACK_SELF_APPROVAL_FORBIDDEN` for critical tasks when `MWH_BLOCK_LOOPBACK_CRITICAL_APPROVAL=1`
// 5. `CF-Connecting-IP` spoofing on loopback without an active Cloudflare tunnel cannot bypass the 5-attempt IP ban bucket
// 6. `mwh_ui_session` cookie uses CSPRNG secret (not hardcoded `'mwh_ui_session_v1'`) and includes `Max-Age=86400`
// ---------------------------------------------------------------------------
await runCase('C16 Bearer token & secret defense line: DPAPI store, token TTL & rotation persistence, loopback token Origin/CORS guard, REST approval anti-bypass, CF-Connecting-IP anti-spoof, CSPRNG UI cookie', async () => {
  const nodeCrypto = await import('node:crypto');
  const { PipelineKernel } = await import('../dist/pipeline/pipeline.js');
  const {
    SECRETS_SCHEMA_V2,
    loadPersistedSecrets,
    savePersistedSecrets
  } = await import('../dist/security/secretStore.js');
  const { mintUiSessionCookie } = await import('../dist/network/uiStatic.js');

  const tmpWs = tmpDir('mwh_p3_c16_ws_');
  const port = 29910 + Math.floor(Math.random() * 200);
  const initialToken = 'mwh_rt_' + nodeCrypto.randomBytes(24).toString('hex');
  const initialSigningKey = nodeCrypto.randomBytes(32).toString('hex');
  let srv = null;

  try {
    // (1) Legacy plaintext auto-detection & DPAPI v2 round-trip encryption
    const secretsDir = path.join(tmpWs, '.mwh');
    fs.mkdirSync(secretsDir, { recursive: true });
    const secretsFile = path.join(secretsDir, 'secrets.json');
    fs.writeFileSync(
      secretsFile,
      JSON.stringify({ token: initialToken, signingKey: initialSigningKey }, null, 2),
      'utf-8'
    );
    const loadedLegacy = loadPersistedSecrets(tmpWs);
    assert(
      loadedLegacy && loadedLegacy.token === initialToken && loadedLegacy.legacyPlaintext === true,
      `legacy plaintext secrets.json must load with legacyPlaintext=true, got ${JSON.stringify(loadedLegacy)}`
    );

    const savedV2 = savePersistedSecrets(tmpWs, {
      token: initialToken,
      signingKey: initialSigningKey
    });
    const rawDisk = fs.readFileSync(secretsFile, 'utf-8');
    const parsedDisk = JSON.parse(rawDisk);
    assert(
      parsedDisk.schema === SECRETS_SCHEMA_V2 &&
        typeof parsedDisk.dpapi === 'string' &&
        parsedDisk.dpapi.length > 64 &&
        !rawDisk.includes(initialToken) &&
        !rawDisk.includes(initialSigningKey),
      'secrets.json on disk must be encrypted with DPAPI v2 and contain zero plaintext token/signingKey'
    );
    const loadedV2 = loadPersistedSecrets(tmpWs);
    assert(
      loadedV2 &&
        loadedV2.token === initialToken &&
        loadedV2.signingKey === initialSigningKey &&
        loadedV2.cookieSecret === savedV2.cookieSecret &&
        loadedV2.legacyPlaintext === false,
      'DPAPI v2 secrets.json must decrypt back to exact token, signingKey, and cookieSecret'
    );

    // (2) Token TTL expiry check in BearerAuthGuard
    const expiringGuard = new BearerAuthGuard(initialToken, Date.now() - 1000);
    const expiredRes = expiringGuard.checkAuth(`Bearer ${initialToken}`, '127.0.0.1');
    assert(
      expiredRes.authenticated === false &&
        expiredRes.statusCode === 401 &&
        String(expiredRes.message).includes('TOKEN_EXPIRED'),
      `expired token must be rejected with 401 TOKEN_EXPIRED, got ${JSON.stringify(expiredRes)}`
    );

    // Boot a live MwhServer in tmpWs for HTTP-level security checks (Gaps 2, 3, 4, 5, 6)
    const kernel = new PipelineKernel({
      confinementMode: 'workspace-write',
      approvalPolicy: 'smart-risk',
      workspaceRoot: tmpWs,
      desktopHandsEnabled: false
    });
    srv = new MwhServer({
      host: '127.0.0.1',
      port,
      runtimeToken: initialToken,
      tokenExpiresAt: Date.now() + 60_000,
      kernel
    });
    await srv.start();

    // (6) Hardcoded 'mwh_ui_session_v1' HMAC forgery must fail; valid header sets Max-Age=86400
    const forgedLegacyCookie = nodeCrypto
      .createHmac('sha256', 'mwh_ui_session_v1')
      .update(initialToken)
      .digest('hex');
    const forgedUiRes = await fetch(`http://127.0.0.1:${port}/ui`, {
      headers: { Cookie: `mwh_ui_session=${forgedLegacyCookie}` }
    });
    assert(
      forgedUiRes.status === 401,
      `offline-forged mwh_ui_session_v1 cookie must be rejected with 401, got ${forgedUiRes.status}`
    );

    const validUiRes = await fetch(`http://127.0.0.1:${port}/ui`, {
      headers: { Authorization: `Bearer ${initialToken}` }
    });
    const setCookieHeader = validUiRes.headers.get('set-cookie') || '';
    assert(
      validUiRes.status === 200 &&
        setCookieHeader.includes('Max-Age=86400') &&
        setCookieHeader.includes('HttpOnly') &&
        setCookieHeader.includes('SameSite=Strict'),
      `/ui Set-Cookie must include Max-Age=86400, HttpOnly, SameSite=Strict; got ${setCookieHeader}`
    );
    const mintedCookieVal = mintUiSessionCookie(initialToken);

    // (3) Loopback token endpoint blocks cross-origin Origin, Sec-Fetch-Site: cross-site, and proxy headers
    const crossOriginTokenRes = await fetch(`http://127.0.0.1:${port}/api/v1/tunnel/token`, {
      headers: { Origin: 'https://evil.example.com' }
    });
    assert(
      crossOriginTokenRes.status === 403 &&
        crossOriginTokenRes.headers.get('access-control-allow-origin') === null,
      `foreign Origin on /api/v1/tunnel/token must return 403 without CORS header, got ${crossOriginTokenRes.status}`
    );

    const crossSiteFetchRes = await fetch(`http://127.0.0.1:${port}/api/v1/tunnel/token`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' }
    });
    assert(
      crossSiteFetchRes.status === 403,
      `Sec-Fetch-Site: cross-site on /api/v1/tunnel/token must return 403, got ${crossSiteFetchRes.status}`
    );

    const proxiedTokenRes = await fetch(`http://127.0.0.1:${port}/api/v1/tunnel/token`, {
      headers: { 'CF-Connecting-IP': '203.0.113.9' }
    });
    assert(
      proxiedTokenRes.status === 403,
      `proxied /api/v1/tunnel/token with CF-Connecting-IP must return 403 LOOPBACK_ONLY, got ${proxiedTokenRes.status}`
    );

    const legitTokenRes = await fetch(`http://127.0.0.1:${port}/api/v1/tunnel/token`, {
      headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }
    });
    const legitTokenBody = await legitTokenRes.json();
    assert(
      legitTokenRes.status === 200 &&
        legitTokenBody.bearerToken === initialToken &&
        legitTokenRes.headers.get('cache-control') === 'no-store' &&
        legitTokenRes.headers.get('access-control-allow-origin') === null,
      `legitimate local same-origin /api/v1/tunnel/token must return 200 with Cache-Control: no-store and no wildcard CORS`
    );

    // (4) REST approval bypass protections:
    // Trigger a critical task via /api/v1/tasks/trigger
    const savedHmac = process.env.MWH_HMAC_SECRET;
    process.env.MWH_HMAC_SECRET = initialSigningKey;
    let critId = '';
    try {
      const trigRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${initialToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          toolName: 'exec_command',
          category: 'sensitive_write',
          params: { command: 'Remove-Item -Recurse -Force C:\\__mwh_c16_nonexistent__' }
        })
      });
      const trigData = await trigRes.json();
      critId = trigData?.liveTask?.id || '';
      assert(critId.length > 0, `critical trigger must produce pending approval id, got ${JSON.stringify(trigData)}`);

      // 4a: Caller with Mcp-Session-Id spoofing body.source='ui_island' must be rejected with 403 REMOTE_UI_APPROVAL_FORBIDDEN
      const mcpSpoofRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${encodeURIComponent(critId)}/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${initialToken}`,
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'mcp_spoof_session_1'
        },
        body: JSON.stringify({ scope: 'once', source: 'ui_island' })
      });
      const mcpSpoofData = await mcpSpoofRes.json();
      assert(
        mcpSpoofRes.status === 403 && mcpSpoofData.error === 'REMOTE_UI_APPROVAL_FORBIDDEN',
        `MCP caller spoofing source='ui_island' must be rejected with 403 REMOTE_UI_APPROVAL_FORBIDDEN, got ${mcpSpoofRes.status} ${JSON.stringify(mcpSpoofData)}`
      );

      // 4b: Cross-origin browser request spoofing body.source='ui_island' must be rejected with 403 REMOTE_UI_APPROVAL_FORBIDDEN
      const xssOriginRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${encodeURIComponent(critId)}/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${initialToken}`,
          'Content-Type': 'application/json',
          Origin: 'https://attacker.example.com'
        },
        body: JSON.stringify({ scope: 'once', source: 'ui_island' })
      });
      const xssOriginData = await xssOriginRes.json();
      assert(
        xssOriginRes.status === 403 && xssOriginData.error === 'REMOTE_UI_APPROVAL_FORBIDDEN',
        `foreign Origin spoofing source='ui_island' must be rejected with 403 REMOTE_UI_APPROVAL_FORBIDDEN, got ${xssOriginRes.status}`
      );

      // 4c: Loopback critical self-approval guard when MWH_BLOCK_LOOPBACK_CRITICAL_APPROVAL=1
      process.env.MWH_BLOCK_LOOPBACK_CRITICAL_APPROVAL = '1';
      try {
        const selfApproveRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${encodeURIComponent(critId)}/approve`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${initialToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ scope: 'once', source: 'ui_island' })
        });
        const selfApproveData = await selfApproveRes.json();
        assert(
          selfApproveRes.status === 403 && selfApproveData.error === 'LOOPBACK_SELF_APPROVAL_FORBIDDEN',
          `REST critical self-approval on loopback must return 403 LOOPBACK_SELF_APPROVAL_FORBIDDEN when blocked, got ${selfApproveRes.status} ${JSON.stringify(selfApproveData)}`
        );
      } finally {
        delete process.env.MWH_BLOCK_LOOPBACK_CRITICAL_APPROVAL;
      }
    } finally {
      if (savedHmac !== undefined) process.env.MWH_HMAC_SECRET = savedHmac;
      else delete process.env.MWH_HMAC_SECRET;
    }

    // (2b) postRotateToken persists new token to DPAPI `.mwh/secrets.json`, revokes old token immediately, and invalidates old UI cookie
    const rotRes = await fetch(`http://127.0.0.1:${port}/api/v1/tunnel/rotate-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${initialToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ source: 'ui_island' })
    });
    const rotData = await rotRes.json();
    const rotatedToken = rotData.bearerToken;
    assert(
      rotRes.status === 200 && typeof rotatedToken === 'string' && rotatedToken !== initialToken,
      `rotate-token must return a new token, got ${rotRes.status} ${JSON.stringify(rotData)}`
    );

    const persistedAfterRot = loadPersistedSecrets(tmpWs);
    assert(
      persistedAfterRot &&
        persistedAfterRot.token === rotatedToken &&
        persistedAfterRot.cookieSecret !== savedV2.cookieSecret &&
        persistedAfterRot.legacyPlaintext === false,
      'postRotateToken must persist new token and rotated cookieSecret to DPAPI .mwh/secrets.json'
    );

    const oldCookieAfterRot = await fetch(`http://127.0.0.1:${port}/ui`, {
      headers: { Cookie: `mwh_ui_session=${mintedCookieVal}` }
    });
    assert(
      oldCookieAfterRot.status === 401,
      `old mwh_ui_session cookie must be invalidated after token rotation, got ${oldCookieAfterRot.status}`
    );

    // Reset failure counter on 127.0.0.1 with valid rotatedToken before testing 5-attempt ban
    const resetAuthRes = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
      headers: { Authorization: `Bearer ${rotatedToken}` }
    });
    assert(resetAuthRes.status === 200, 'valid rotatedToken must authenticate and reset failure count');

    // (5) CF-Connecting-IP spoofing on loopback (no active Cloudflare tunnel) cannot evade 5-attempt IP ban
    for (let i = 1; i <= 5; i++) {
      const badRes = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
        headers: {
          Authorization: `Bearer wrong_token_attempt_${i}`,
          'CF-Connecting-IP': `198.51.100.${i}`,
          'CF-Ray': `89abcdef0123456${i}-SJC`
        }
      });
      if (i < 5) {
        assert(badRes.status === 401, `spoofed CF-Connecting-IP attempt ${i} expected 401, got ${badRes.status}`);
      } else {
        assert(
          badRes.status === 429,
          `5th failed attempt with spoofed CF-Connecting-IP (no active tunnel) must trigger 429 IP ban on 127.0.0.1, got ${badRes.status}`
        );
      }
    }
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// C17: 「多端审批」开关。默认关闭保持原浮岛；开启后 medium 与非 HMAC high
// 不再 CONFIRMATION_REQUIRED，critical 仍 HMAC；request.context 不得私自打开。
// ---------------------------------------------------------------------------
await runCase('C17 multi-device approval switch defers non-HMAC, keeps critical, ignores context injection', async () => {
  const ws = tmpDir('mwh_p3_c17_');
  const { PipelineKernel } = await import('../dist/pipeline/pipeline.js');
  const { loadUserSettings, saveUserSettings } = await import('../dist/config/userSettings.js');

  const kOff = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    workspaceRoot: ws
  });
  const offWrite = await kOff.handleRequest({
    id: 'c17_off_write',
    toolName: 'fs_mutate',
    category: 'write',
    params: { action: 'write', path: 'off.txt', content: 'nope' }
  });
  assert(
    offWrite.status === 'CONFIRMATION_REQUIRED' && offWrite.riskLevel === 'medium',
    `default-off write expected CONFIRMATION_REQUIRED, got ${offWrite.status}`
  );
  assert(!fs.existsSync(path.join(ws, 'off.txt')), 'default-off must not write the file');

  const injected = await kOff.handleRequest({
    id: 'c17_inject',
    toolName: 'fs_mutate',
    category: 'write',
    params: { action: 'write', path: 'inject.txt', content: 'hack' },
    context: { multiDeviceApproval: true }
  });
  assert(
    injected.status === 'CONFIRMATION_REQUIRED',
    `request.context must not enable multi-device approval, got ${injected.status}`
  );
  assert(!fs.existsSync(path.join(ws, 'inject.txt')), 'injection must not write');

  const kOn = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    workspaceRoot: ws,
    multiDeviceApproval: true
  });
  const onWrite = await kOn.handleRequest({
    id: 'c17_on_write',
    toolName: 'fs_mutate',
    category: 'write',
    params: { action: 'write', path: 'on.txt', content: 'yes' }
  });
  assert(
    onWrite.status === 'SUCCESS' &&
      onWrite.riskLevel === 'medium' &&
      fs.readFileSync(path.join(ws, 'on.txt'), 'utf-8') === 'yes',
    `switch-on write expected SUCCESS, got ${onWrite.status}`
  );

  const onExec = await kOn.handleRequest({
    id: 'c17_on_exec',
    toolName: 'exec_command',
    category: 'sensitive_write',
    params: { command: 'Write-Output "mda-hi"' }
  });
  assert(
    onExec.status === 'SUCCESS' &&
      onExec.riskLevel === 'medium' &&
      String(onExec.data?.stdout).includes('mda-hi'),
    `switch-on exec expected SUCCESS, got ${onExec.status} ${onExec.reason || onExec.error || ''}`
  );

  const onHigh = await kOn.handleRequest({
    id: 'c17_on_high',
    toolName: 'fake_sensitive_probe',
    category: 'sensitive_write',
    params: {}
  });
  assert(
    onHigh.status !== 'CONFIRMATION_REQUIRED' &&
      onHigh.riskLevel === 'high' &&
      onHigh.requiresMobileHmac !== true,
    `switch-on high must not park on the island, got ${onHigh.status} ${onHigh.reason || onHigh.error || ''}`
  );

  const onCrit = await kOn.handleRequest({
    id: 'c17_on_crit',
    toolName: 'exec_command',
    category: 'sensitive_write',
    params: { command: 'rm -rf /' }
  });
  assert(
    onCrit.status === 'CONFIRMATION_REQUIRED' &&
      onCrit.riskLevel === 'critical' &&
      onCrit.requiresMobileHmac === true,
    `switch-on critical must still require HMAC, got ${onCrit.status} hmac=${onCrit.requiresMobileHmac}`
  );

  kOff.updateContext({ multiDeviceApproval: true });
  const liveOn = await kOff.handleRequest({
    id: 'c17_live_on',
    toolName: 'fs_mutate',
    category: 'write',
    params: { action: 'write', path: 'live.txt', content: 'live' }
  });
  assert(
    liveOn.status === 'SUCCESS' && fs.readFileSync(path.join(ws, 'live.txt'), 'utf-8') === 'live',
    `updateContext(true) should execute medium writes, got ${liveOn.status}`
  );
  kOff.updateContext({ multiDeviceApproval: false });
  const liveOff = await kOff.handleRequest({
    id: 'c17_live_off',
    toolName: 'fs_mutate',
    category: 'write',
    params: { action: 'write', path: 'live-off.txt', content: 'x' }
  });
  assert(
    liveOff.status === 'CONFIRMATION_REQUIRED',
    `updateContext(false) should restore the island, got ${liveOff.status}`
  );
  assert(!fs.existsSync(path.join(ws, 'live-off.txt')), 'live-off must not write');

  const saved = saveUserSettings(ws, { multiDeviceApproval: true });
  assert(saved.multiDeviceApproval === true, 'save must return enabled');
  const loaded = loadUserSettings(ws);
  assert(loaded.multiDeviceApproval === true, 'load must read enabled back');
  const settingsFile = path.join(ws, '.mwh', 'settings.json');
  fs.writeFileSync(settingsFile, '{not-json', 'utf-8');
  const corrupt = loadUserSettings(ws);
  assert(corrupt.multiDeviceApproval === false, 'corrupt settings must fail closed to off');
  const missing = loadUserSettings(path.join(ws, 'no-such-ws'));
  assert(missing.multiDeviceApproval === false, 'missing file must default off');
});

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
console.log('\n===============================================================');
let allPassed = true;
for (const r of results) {
  if (!r.passed) {
    allPassed = false;
    console.error(`[FAIL] ${r.name}: ${r.message}`);
  }
}
console.log(`  P3 NEGATIVE TESTS: ${results.filter((r) => r.passed).length}/${results.length} passed`);
console.log('===============================================================');
if (!allPassed) {
  process.exit(1);
}
process.exit(0);

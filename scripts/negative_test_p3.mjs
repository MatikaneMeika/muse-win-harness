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

  // 5) S5: string hwnd must fail closed to foreground-high (runtime normalizes
  // non-number hwnd to undefined -> SendInput), numeric hwnd stays bg-medium
  const strHwndEval = ae.evaluateRisk(
    'desktop_hands',
    'sensitive_write',
    { action: 'act', op: 'click', hwnd: '12345', x: 100, y: 100 },
    { confinementMode: 'workspace-write', approvalPolicy: 'auto-workspace', workspaceRoot: process.cwd() }
  );
  assert(
    strHwndEval.riskLevel === 'high',
    `act(click, string hwnd) must evaluate as high risk, got ${strHwndEval.riskLevel}`
  );
  const numHwndEval = ae.evaluateRisk(
    'desktop_hands',
    'sensitive_write',
    { action: 'act', op: 'click', hwnd: 12345, x: 100, y: 100, delivery: 'auto' },
    { confinementMode: 'workspace-write', approvalPolicy: 'auto-workspace', workspaceRoot: process.cwd() }
  );
  assert(
    numHwndEval.riskLevel === 'medium',
    `act(click, numeric hwnd, auto) must evaluate as medium risk, got ${numHwndEval.riskLevel}`
  );

  // 6) S6: fg session approval covers same-hwnd bg delivery (one-way: fg ⊇ bg)
  const c15FgCtx = { sessionApprovedActions: new Set() };
  const { approvalRecord: fgDhApproval } = ae.createApproval(
    'req_c15_dh_fg_1',
    'desktop_hands',
    'sensitive_write',
    { action: 'act', op: 'click', hwnd: 777, x: 1, y: 1, delivery: 'foreground' },
    'high',
    'Desktop foreground act:click',
    false,
    { confinementMode: 'workspace-write', approvalPolicy: 'smart-risk', workspaceRoot: process.cwd() }
  );
  ae.resolveApproval(fgDhApproval.id, 'approve', undefined, 'session', c15FgCtx, 'ui_island');
  const c15IsPreApproved = (ctx, params) =>
    ae.isActionPreApproved(
      'desktop_hands',
      'desktop_hands:act:click',
      'medium',
      'smart-risk',
      ctx,
      params
    );
  assert(
    c15IsPreApproved(c15FgCtx, { action: 'act', op: 'click', hwnd: 777, x: 1, y: 1, delivery: 'foreground' }),
    'fg session approval must cover same-hwnd fg delivery'
  );
  assert(
    c15IsPreApproved(c15FgCtx, { action: 'act', op: 'click', hwnd: 777, x: 1, y: 1, delivery: 'background' }),
    'fg session approval must cover same-hwnd bg delivery'
  );

  // bg-only session approval must NOT cover fg delivery for the same hwnd
  const c15BgCtx = { sessionApprovedActions: new Set() };
  const { approvalRecord: bgDhApproval } = ae.createApproval(
    'req_c15_dh_bg_1',
    'desktop_hands',
    'sensitive_write',
    { action: 'act', op: 'click', hwnd: 888, x: 1, y: 1, delivery: 'background' },
    'medium',
    'Desktop background act:click',
    false,
    { confinementMode: 'workspace-write', approvalPolicy: 'smart-risk', workspaceRoot: process.cwd() }
  );
  ae.resolveApproval(bgDhApproval.id, 'approve', undefined, 'session', c15BgCtx, 'ui_island');
  assert(
    c15IsPreApproved(c15BgCtx, { action: 'act', op: 'click', hwnd: 888, x: 1, y: 1, delivery: 'background' }),
    'bg session approval must cover same-hwnd bg delivery'
  );
  assert(
    !c15IsPreApproved(c15BgCtx, { action: 'act', op: 'click', hwnd: 888, x: 1, y: 1, delivery: 'foreground' }),
    'bg session approval must NOT cover same-hwnd fg delivery'
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
// C18: Mimosa hardening regression — new error codes get real negative
// assertions (UNKNOWN_WORKSPACE / INVALID_SNAPSHOT_ID / INVALID_KEEP_RECENT /
// INVALID_COMMAND / UNKNOWN_PROFILE) and the keepRecent two-layer semantics.
// ---------------------------------------------------------------------------
await runCase('C18 Mimosa hardening regression: batch-reject snapshot delete, keepRecent clamp, probeCommand whitelist, UNKNOWN_PROFILE, UNKNOWN_WORKSPACE', async () => {
  const { GitCheckpointManager } = await import('../dist/pipeline/gitCheckpoint.js');
  const { AcpConfigManager } = await import('../dist/config/acpConfig.js');

  const mkCheckpoint = (root, id, ts) => {
    const dir = path.join(root, '.mwh', 'checkpoints', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'metadata.json'),
      JSON.stringify({ id, timestamp: ts, workspacePath: root }),
      'utf-8'
    );
  };

  // (a) deleteCheckpoints batch fail-closed: every id is validated BEFORE any
  // on-disk deletion, so a batch mixing a valid id with a bad one must reject
  // as a whole and leave the valid snapshot untouched. Two rejection paths:
  //   - malformed id          -> CHECKPOINT_INVALID_ID (the INVALID_SNAPSHOT_ID
  //                              equivalent code for format violations)
  //   - well-formed, absent id -> INVALID_SNAPSHOT_ID (not in the index)
  const rootA = tmpDir('mwh_p3_c18_a_');
  try {
    mkCheckpoint(rootA, 'chk_1001_abc', 1000);
    expectThrowSync(
      () => GitCheckpointManager.deleteCheckpoints(['chk_1001_abc', 'not_a_chk_id'], rootA),
      'CHECKPOINT_INVALID_ID'
    );
    assert(
      fs.existsSync(path.join(rootA, '.mwh', 'checkpoints', 'chk_1001_abc', 'metadata.json')),
      'malformed-id batch rejection must leave the valid snapshot untouched'
    );
    expectThrowSync(
      () => GitCheckpointManager.deleteCheckpoints(['chk_1001_abc', 'chk_9999_absent'], rootA),
      'INVALID_SNAPSHOT_ID'
    );
    assert(
      fs.existsSync(path.join(rootA, '.mwh', 'checkpoints', 'chk_1001_abc', 'metadata.json')),
      'absent-id batch rejection must leave the valid snapshot untouched'
    );
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
  }

  // (b) pruneCheckpoints keepRecent: the manager layer clamps to [1, 100]
  // (Math.max(1, Math.min(100, Math.floor(keepRecent || 5)))) instead of
  // throwing INVALID_KEEP_RECENT — test the clamp semantics as implemented.
  // 5 fixtures make each clamp value distinguishable:
  //   0   -> || 5 -> 5   : keeps all 5, deletes nothing (would delete 4 if clamped to 1)
  //   101 -> 100         : keeps all 5, deletes nothing (would delete 4 if clamped to 1)
  //   1.5 -> floor -> 1   : keeps only the newest, deletes the 4 oldest
  const rootB = tmpDir('mwh_p3_c18_b_');
  try {
    const idsB = ['chk_2001_a', 'chk_2002_b', 'chk_2003_c', 'chk_2004_d', 'chk_2005_e'];
    idsB.forEach((id, i) => mkCheckpoint(rootB, id, 2000 + i));
    const dirOf = (id) => path.join(rootB, '.mwh', 'checkpoints', id);

    const prunedZero = GitCheckpointManager.pruneCheckpoints(0, rootB);
    assert(
      Array.isArray(prunedZero) && prunedZero.length === 0 &&
        idsB.every((id) => fs.existsSync(dirOf(id))),
      `pruneCheckpoints(0) must clamp to 5 and keep all 5, got ${JSON.stringify(prunedZero)}`
    );

    const prunedHigh = GitCheckpointManager.pruneCheckpoints(101, rootB);
    assert(
      Array.isArray(prunedHigh) && prunedHigh.length === 0 &&
        idsB.every((id) => fs.existsSync(dirOf(id))),
      `pruneCheckpoints(101) must clamp to 100 and keep all 5, got ${JSON.stringify(prunedHigh)}`
    );

    const prunedFrac = GitCheckpointManager.pruneCheckpoints(1.5, rootB);
    assert(
      Array.isArray(prunedFrac) && prunedFrac.length === 4 &&
        idsB.slice(0, 4).every((id) => prunedFrac.includes(id)) &&
        fs.existsSync(dirOf('chk_2005_e')) &&
        idsB.slice(0, 4).every((id) => !fs.existsSync(dirOf(id))),
      `pruneCheckpoints(1.5) must clamp to 1 (floor) and delete the 4 oldest, got ${JSON.stringify(prunedFrac)}`
    );
  } finally {
    fs.rmSync(rootB, { recursive: true, force: true });
  }

  // (c) probeCommand shell-metacharacter whitelist: '&' is rejected
  // fail-closed with INVALID_COMMAND before any where.exe/execution.
  const acp = AcpConfigManager.getInstance();
  const probeRes = acp.probeCommand('cmd & calc');
  assert(
    probeRes.available === false && probeRes.error === 'INVALID_COMMAND',
    `probeCommand('cmd & calc') must return available:false INVALID_COMMAND, got ${JSON.stringify(probeRes)}`
  );

  // (d) toggleProfile with an unknown id must fail closed with UNKNOWN_PROFILE
  const toggleRes = acp.toggleProfile('no_such_profile', true);
  assert(
    toggleRes.success === false && toggleRes.error === 'UNKNOWN_PROFILE',
    `toggleProfile('no_such_profile') must return UNKNOWN_PROFILE, got ${JSON.stringify(toggleRes)}`
  );

  // (e) UNKNOWN_WORKSPACE through the real HTTP entry: removing a path that is
  // not a registered workspace root must 400 without any fs operation.
  const server = new MwhServer({
    host: '127.0.0.1',
    port: 0,
    runtimeToken: 'Ab1!mnopQrStu34vwxy56789012zMWH#'
  });
  const { server: httpServer } = await server.start();
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert(port > 0, `server must listen on an ephemeral port, got ${port}`);
  try {
    const unregistered = tmpDir('mwh_p3_c18_e_');
    try {
      const wsRemoveRes = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/remove`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer Ab1!mnopQrStu34vwxy56789012zMWH#',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: unregistered })
      });
      const wsRemoveData = await wsRemoveRes.json();
      assert(
        wsRemoveRes.status === 400 && wsRemoveData.error === 'UNKNOWN_WORKSPACE',
        `unregistered workspace remove must 400 UNKNOWN_WORKSPACE, got ${wsRemoveRes.status} ${JSON.stringify(wsRemoveData)}`
      );
    } finally {
      fs.rmSync(unregistered, { recursive: true, force: true });
    }
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// C19: desktop_hands control-plane remote lock and snapshot prune HTTP
// validation. Remote (mcp) actors must get 403 REMOTE_DESKTOP_HANDS_CONFIG_
// FORBIDDEN / REMOTE_PROTECT_HWND_FORBIDDEN; the loopback no-header fallback
// (ui_island) must still succeed as a positive control; and an out-of-range
// keepRecent must 400 INVALID_KEEP_RECENT at the HTTP boundary.
// ---------------------------------------------------------------------------
await runCase('C19 desktop-hands control-plane 403 for remote actors and snapshot prune HTTP INVALID_KEEP_RECENT validation', async () => {
  const server = new MwhServer({
    host: '127.0.0.1',
    port: 0,
    runtimeToken: 'Ab1!mnopQrStu34vwxy56789012zMWH#'
  });
  const { server: httpServer } = await server.start();
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert(port > 0, `server must listen on an ephemeral port, got ${port}`);
  try {
    const authHeaders = {
      Authorization: 'Bearer Ab1!mnopQrStu34vwxy56789012zMWH#',
      'Content-Type': 'application/json'
    };

    // (a) A request carrying an mcp-session-id header resolves to the 'mcp'
    // actor, which must be denied desktop_hands configuration (403).
    const handsRes = await fetch(`http://127.0.0.1:${port}/api/v1/security/desktop-hands`, {
      method: 'POST',
      headers: { ...authHeaders, 'mcp-session-id': 'c19-forged-mcp-session' },
      body: JSON.stringify({ enabled: true })
    });
    const handsData = await handsRes.json();
    assert(
      handsRes.status === 403 && handsData.error === 'REMOTE_DESKTOP_HANDS_CONFIG_FORBIDDEN',
      `remote desktop-hands toggle must 403 REMOTE_DESKTOP_HANDS_CONFIG_FORBIDDEN, got ${handsRes.status} ${JSON.stringify(handsData)}`
    );

    // (b) Same actor rule for protected HWND registration: 'mcp' is not the
    // local UI island -> 403 REMOTE_PROTECT_HWND_FORBIDDEN.
    const protectRes = await fetch(`http://127.0.0.1:${port}/api/v1/desktop-hands/protect-hwnd`, {
      method: 'POST',
      headers: { ...authHeaders, 'mcp-session-id': 'c19-forged-mcp-session' },
      body: JSON.stringify({ hwnd: 12345, pid: 678 })
    });
    const protectData = await protectRes.json();
    assert(
      protectRes.status === 403 && protectData.error === 'REMOTE_PROTECT_HWND_FORBIDDEN',
      `remote protect-hwnd must 403 REMOTE_PROTECT_HWND_FORBIDDEN, got ${protectRes.status} ${JSON.stringify(protectData)}`
    );

    // (c) Positive control: on the same server, without mcp-session-id, the
    // loopback fallback resolves to 'ui_island' and the toggle succeeds
    // (200 ok:true). The enabled state lives in the in-memory test server.
    const localRes = await fetch(`http://127.0.0.1:${port}/api/v1/security/desktop-hands`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true })
    });
    const localData = await localRes.json();
    assert(
      localRes.status === 200 && localData.ok === true,
      `local ui_island desktop-hands toggle must succeed with ok:true, got ${localRes.status} ${JSON.stringify(localData)}`
    );

    // (d) keepRecent=5000 is outside [1, 100]: the HTTP boundary must reject
    // with 400 INVALID_KEEP_RECENT instead of silently clamping.
    const pruneRes = await fetch(`http://127.0.0.1:${port}/api/v1/snapshots/prune`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ keepRecent: 5000 })
    });
    const pruneData = await pruneRes.json();
    assert(
      pruneRes.status === 400 && pruneData.error === 'INVALID_KEEP_RECENT',
      `prune keepRecent=5000 must 400 INVALID_KEEP_RECENT, got ${pruneRes.status} ${JSON.stringify(pruneData)}`
    );
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// C20: Desktop Hands v2 E0/E1/E5 regression —
// - E0: action-omitted `{ op: 'wait', hwnd }` and `{ steps: [...] }` normalize to
//   `act` / `batch`, pass paramsHash verification, and execute cleanly after
//   `/api/v1/tasks/:id/approve` without `UNKNOWN_DESKTOP_HANDS_ACTION: undefined`.
// - E1: when `multiDeviceApproval=true` under `confirm` (smart-risk), desktop_hands
//   perception (`windows`) stays exempt while manipulation (`act`/`batch`) STILL
//   returns `CONFIRMATION_REQUIRED` (never silently deferred); under `full-access`
//   manipulation remains pre-approved.
// - E5: approving via UI island with `scope: 'session'` (or `'app_session'`) writes
//   `desktop_hands:hwnd:<n>:bg` so subsequent background calls on the same hwnd
//   execute without a second approval card, and `/api/v1/daemon/emergency-kill`
//   clears the session hwnd authorization immediately.
// ---------------------------------------------------------------------------
await runCase('C20 desktop_hands E0/E1/E5: action normalization & replay, multiDeviceApproval guard, and UI app_session hwnd authorization', async () => {
  const ws = tmpDir('mwh_p3_c20_');
  const { PipelineKernel } = await import('../dist/pipeline/pipeline.js');
  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    workspaceRoot: ws,
    desktopHandsEnabled: true,
    desktopHandsForegroundFallback: false,
    multiDeviceApproval: true
  });
  const port = 29610 + Math.floor(Math.random() * 200);
  const server = new MwhServer({
    host: '127.0.0.1',
    port,
    runtimeToken: 'Ab1!mnopQrStu34vwxy56789012zMWH#',
    kernel
  });
  await server.start();

  try {
    const authHeaders = {
      Authorization: 'Bearer Ab1!mnopQrStu34vwxy56789012zMWH#',
      'Content-Type': 'application/json'
    };

    // (1) E1: With multiDeviceApproval=true + confirm (smart-risk):
    // Perception ('windows') is low-risk and exempt:
    if (process.platform === 'win32') {
      const winRes = await kernel.handleRequest({
        id: 'c20_win_percept',
        toolName: 'desktop_hands',
        category: 'sensitive_write',
        params: { action: 'windows' }
      });
      assert(winRes.status === 'SUCCESS', `perception windows must succeed without confirmation, got ${winRes.status}`);
    }

    // Manipulation with omitted `action` (`{ op: 'wait', durationMs: 20, hwnd: 68752 }`)
    // MUST normalize to `action: 'act'` and MUST NOT be deferred by multiDeviceApproval=true!
    const triggerRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        toolName: 'desktop_hands',
        category: 'sensitive_write',
        params: { hwnd: 68752, op: 'wait', durationMs: 20, delivery: 'background' }
      })
    });
    const triggerData = await triggerRes.json();
    assert(
      triggerRes.status === 200 &&
        triggerData.execution?.status === 'CONFIRMATION_REQUIRED' &&
        typeof triggerData.execution?.approvalId === 'string',
      `E1/E0: omitted-action desktop_hands op under multiDeviceApproval=true must require confirmation, got ${JSON.stringify(triggerData)}`
    );
    assert(
      String(triggerData.execution.summary).includes('act:wait'),
      `E0: normalized summary must include 'act:wait', got '${triggerData.execution.summary}'`
    );
    assert(
      triggerData.liveTask?.targetHwnd === 68752,
      `E5: liveTask must expose targetHwnd=68752 for app_session button, got ${JSON.stringify(triggerData.liveTask)}`
    );

    const approvalId = triggerData.execution.approvalId;

    // (2) E0 + E5: Approve via UI island with `scope: 'session'` -> replay must succeed
    // with zero UNKNOWN_DESKTOP_HANDS_ACTION: undefined and write hwnd session scope!
    if (process.platform === 'win32') {
      const approveRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${encodeURIComponent(approvalId)}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ scope: 'session', source: 'ui_island' })
      });
      const approveData = await approveRes.json();
      assert(
        approveRes.status === 200 &&
          approveData.ok === true &&
          approveData.granularity === 'session' &&
          approveData.execution?.status === 'SUCCESS' &&
          approveData.execution?.data?.action === 'act' &&
          approveData.execution?.data?.op === 'wait',
        `E0/E5: postApprove replay must succeed with action='act', op='wait', got ${JSON.stringify(approveData)}`
      );

      // (3) E5: Second background call on the same hwnd=68752 must now be pre-approved (no second card!)
      const secondRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          toolName: 'desktop_hands',
          category: 'sensitive_write',
          params: { hwnd: 68752, steps: [{ op: 'wait', durationMs: 10 }], delivery: 'background' }
        })
      });
      const secondData = await secondRes.json();
      assert(
        secondRes.status === 200 &&
          secondData.execution?.status === 'SUCCESS' &&
          secondData.execution?.data?.action === 'batch' &&
          secondData.execution?.data?.status === 'COMPLETED',
        `E0/E5: second background call (omitted action batch) on session-approved hwnd=68752 must execute without confirmation, got ${JSON.stringify(secondData)}`
      );

      // Foreground call (`move` requires no hwnd/Win32 window handle) must STILL require confirmation
      const fgRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          toolName: 'desktop_hands',
          category: 'sensitive_write',
          params: { hwnd: 68752, op: 'move', x: 100, y: 100, delivery: 'foreground' }
        })
      });
      const fgData = await fgRes.json();
      assert(
        fgData.execution?.status === 'CONFIRMATION_REQUIRED' && fgData.execution?.riskLevel === 'high',
        `E5: bg session approval must not exempt foreground call on hwnd=68752, got ${JSON.stringify(fgData)}`
      );

      // (4) Emergency kill must clear the session hwnd authorization
      const emgRes = await fetch(`http://127.0.0.1:${port}/api/v1/daemon/emergency-kill`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ source: 'ui_island' })
      });
      assert(emgRes.status === 200, 'emergency-kill must return 200');

      const afterEmgRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          toolName: 'desktop_hands',
          category: 'sensitive_write',
          params: { hwnd: 68752, op: 'wait', durationMs: 10, delivery: 'background' }
        })
      });
      const afterEmgData = await afterEmgRes.json();
      assert(
        afterEmgData.execution?.status === 'CONFIRMATION_REQUIRED',
        `E5: after emergency-kill, hwnd=68752 session approval must be cleared and require confirmation again, got ${JSON.stringify(afterEmgData)}`
      );
    }

    // (5) E1 positive control: under full-access (danger-full-access + unattended-yolo),
    // desktop_hands manipulation is pre-approved by policy.
    kernel.updateContext({
      confinementMode: 'danger-full-access',
      approvalPolicy: 'unattended-yolo',
      yoloExpiresAt: Date.now() + 60000
    });
    if (process.platform === 'win32') {
      const fullAccessRes = await kernel.handleRequest({
        id: 'c20_full_access_dh',
        toolName: 'desktop_hands',
        category: 'sensitive_write',
        params: { hwnd: 68752, op: 'wait', durationMs: 10 }
      });
      assert(
        fullAccessRes.status === 'SUCCESS' && fullAccessRes.data?.op === 'wait',
        `E1: full-access desktop_hands wait must execute without confirmation, got ${JSON.stringify(fullAccessRes)}`
      );
    }
  } finally {
    await server.stop();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C21: Desktop Hands v2 E2/E3/E4 regression —
// - E2: `downsampleBgraIfNeeded` downsamples oversized multi-monitor 4160x2560
//   buffers to <= 3840x2160 after source-pixel redaction, and `captureScreenshot`
//   succeeds on both default virtual screen and oversized region(0,0,99999,99999).
// - E3: `UiaBridge.registerElementToken` / `resolveElementToken` issues `el_...`
//   tokens, resolves center coordinates for pointer ops, and throws
//   `STALE_ELEMENT_TOKEN` on unknown/mismatched tokens.
// - E4: long-running `desktop_hands` batch sets `liveTask.status === 'RUNNING'`
//   with `dh_...` id and can be aborted mid-flight via `/api/v1/tasks/:id/kill`.
// ---------------------------------------------------------------------------
await runCase('C21 desktop_hands E2/E3/E4: screenshot downsampling after redaction, elementToken & STALE_ELEMENT_TOKEN, and liveTask RUNNING kill switch', async () => {
  const ws = tmpDir('mwh_p3_c21_');
  const { downsampleBgraIfNeeded, redactBgraRects, captureScreenshot } = await import('../dist/desktop/win32Native.js');
  const { UiaBridge } = await import('../dist/desktop/uiaBridge.js');
  const { PipelineKernel } = await import('../dist/pipeline/pipeline.js');

  // (1) E2: 4160x2560 (10.65 MP > 8.29 MP) redaction + proportional downsampling unit verification
  const srcW = 4160;
  const srcH = 2560;
  const rawBgra = Buffer.alloc(srcW * srcH * 4, 0xff);
  const redacted = redactBgraRects(
    rawBgra,
    { x: 0, y: -648, width: srcW, height: srcH },
    [{ left: 100, top: -500, right: 500, bottom: -100 }]
  );
  assert(redacted === 1, `expected 1 redacted rect in source space, got ${redacted}`);
  const scaled = downsampleBgraIfNeeded(rawBgra, srcW, srcH);
  assert(
    scaled.width <= 3840 &&
      scaled.height <= 2160 &&
      scaled.width * scaled.height <= 3840 * 2160 &&
      scaled.scaleFactor > 0 &&
      scaled.scaleFactor < 1,
    `E2: 4160x2560 must downsample within 3840x2160 budget, got ${scaled.width}x${scaled.height} (scaleFactor=${scaled.scaleFactor})`
  );

  if (process.platform === 'win32') {
    const shotDefault = await captureScreenshot({});
    const shotSentinel = await captureScreenshot({ region: { x: 0, y: 0, width: 99999, height: 99999 } });
    assert(
      shotDefault.width === shotSentinel.width &&
        shotDefault.height === shotSentinel.height &&
        shotDefault.bounds.width === shotSentinel.bounds.width &&
        shotDefault.bounds.height === shotSentinel.bounds.height,
      `E2: default screenshot (${shotDefault.width}x${shotDefault.height}, bounds=${JSON.stringify(shotDefault.bounds)}) and sentinel region(0,0,99999,99999) (${shotSentinel.width}x${shotSentinel.height}, bounds=${JSON.stringify(shotSentinel.bounds)}) must be consistent`
    );
  }

  // (2) E3: elementToken registration, resolution, and STALE_ELEMENT_TOKEN rejection
  UiaBridge.clearElementTokens();
  const tok = UiaBridge.registerElementToken({
    hwnd: 4242,
    seqIndex: 1,
    name: 'Save',
    automationId: 'btnSave',
    controlType: 'Button',
    bounds: { x: 200, y: 300, width: 80, height: 40 },
    patterns: ['Invoke']
  });
  assert(tok.startsWith('el_4242_1_'), `expected el_4242_1_ prefix, got ${tok}`);
  const resolved = UiaBridge.resolveElementToken(tok, 4242);
  assert(resolved.name === 'Save' && resolved.bounds.x === 200, 'resolved token metadata must match');
  expectThrowSync(
    () => UiaBridge.resolveElementToken('el_9999_99_deadbeef'),
    'STALE_ELEMENT_TOKEN'
  );
  expectThrowSync(
    () => UiaBridge.resolveElementToken(tok, 9999),
    'STALE_ELEMENT_TOKEN'
  );

  // (3) E4: Long batch exposes RUNNING liveTask with dh_... id and aborts immediately via /api/v1/tasks/:id/kill
  if (process.platform === 'win32') {
    const kernel = new PipelineKernel({
      confinementMode: 'workspace-write',
      approvalPolicy: 'auto-workspace',
      workspaceRoot: ws,
      desktopHandsEnabled: true
    });
    const port = 29410 + Math.floor(Math.random() * 190);
    const server = new MwhServer({
      host: '127.0.0.1',
      port,
      runtimeToken: 'Ab1!mnopQrStu34vwxy56789012zMWH#',
      kernel
    });
    await server.start();
    const authHeaders = {
      Authorization: 'Bearer Ab1!mnopQrStu34vwxy56789012zMWH#',
      'Content-Type': 'application/json'
    };
    try {
      const batchPromise = fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          toolName: 'desktop_hands',
          category: 'sensitive_write',
          params: {
            action: 'batch',
            steps: [
              { op: 'wait', durationMs: 5000 },
              { op: 'wait', durationMs: 5000 }
            ]
          }
        })
      }).then((r) => r.json());

      await new Promise((r) => setTimeout(r, 180));
      const stateRes = await fetch(`http://127.0.0.1:${port}/api/v1/state`, { headers: authHeaders });
      const stateData = await stateRes.json();
      const runningId = stateData.liveTask?.id || '';
      assert(
        stateData.liveTask?.status === 'RUNNING' && runningId.startsWith('dh_'),
        `E4: in-flight desktop_hands batch must set liveTask.status='RUNNING' with dh_ id, got ${JSON.stringify(stateData.liveTask)}`
      );

      const killRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${encodeURIComponent(runningId)}/kill`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ source: 'ui_island' })
      });
      const killData = await killRes.json();
      assert(
        killRes.status === 200 && killData.ok === true && killData.status === 'TERMINATED',
        `E4: killing running desktop_hands task must return 200 TERMINATED, got ${killRes.status} ${JSON.stringify(killData)}`
      );

      const batchOutcome = await batchPromise;
      assert(
        batchOutcome.execution?.data?.status === 'ABORTED',
        `E4: killed batch must settle promptly with status='ABORTED', got ${JSON.stringify(batchOutcome)}`
      );
      assert(
        String(batchOutcome.execution?.summary || '').startsWith('[ABORTED]') &&
          String(batchOutcome.execution?.error || '').includes('EMERGENCY_STOP_ABORTED'),
        `Defect 4: aborted batch outer PipelineResponse must carry [ABORTED] summary and error, got ${JSON.stringify(batchOutcome.execution)}`
      );
    } finally {
      await server.stop();
    }
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 22: Defect 1/2/3 — job_control poll never overwrites WAITING_APPROVAL with
// a ghost RUNNING panel, postKill fail-safe resets stale RUNNING frames, and
// audit.jsonl records approvalId across the entire approval lifecycle.
// ---------------------------------------------------------------------------
await runCase('C22 ghost RUNNING prevention on job_control poll, fail-safe kill reset, and audit.jsonl approvalId traceability', async () => {
  const ws = tmpDir('mwh_p3_c22_');
  const { PipelineKernel } = await import('../dist/pipeline/pipeline.js');

  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    workspaceRoot: ws,
    desktopHandsEnabled: true
  });
  const port = 29610 + Math.floor(Math.random() * 180);
  const server = new MwhServer({
    host: '127.0.0.1',
    port,
    runtimeToken: 'Ab1!mnopQrStu34vwxy56789012zMWH#',
    kernel
  });
  await server.start();
  const authHeaders = {
    Authorization: 'Bearer Ab1!mnopQrStu34vwxy56789012zMWH#',
    'Content-Type': 'application/json'
  };

  try {
    // 1) Trigger a sensitive_write exec_command that requires local confirmation
    const trigRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        toolName: 'exec_command',
        category: 'sensitive_write',
        params: { command: 'Write-Output "APPROVAL_GHOST_GUARD_OK"' }
      })
    }).then((r) => r.json());

    const approvalId = trigRes.execution?.approvalId;
    assert(
      trigRes.execution?.status === 'CONFIRMATION_REQUIRED' &&
        typeof approvalId === 'string' &&
        approvalId.startsWith('appr_'),
      `C22: expected CONFIRMATION_REQUIRED with appr_ id, got ${JSON.stringify(trigRes)}`
    );
    assert(
      trigRes.liveTask?.status === 'WAITING_APPROVAL' && trigRes.liveTask?.id === approvalId,
      `C22: liveTask must be WAITING_APPROVAL for ${approvalId}, got ${JSON.stringify(trigRes.liveTask)}`
    );

    // 2) Poll job_control(action='poll', approvalId) just like Muse does while waiting for user approval
    const pollRes = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        toolName: 'job_control',
        category: 'write',
        params: { action: 'poll', approvalId }
      })
    }).then((r) => r.json());

    assert(
      pollRes.execution?.status === 'SUCCESS' &&
        pollRes.execution?.data?.status === 'RUNNING_ASYNC' &&
        pollRes.execution?.data?.approvalStatus === 'PENDING',
      `C22: job_control poll on PENDING approval must return RUNNING_ASYNC + PENDING, got ${JSON.stringify(pollRes.execution)}`
    );

    // Crucial assertion for Defect 1: liveTask MUST stay WAITING_APPROVAL, NEVER overwritten to RUNNING!
    const stateAfterPoll = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
      headers: authHeaders
    }).then((r) => r.json());
    assert(
      stateAfterPoll.liveTask?.status === 'WAITING_APPROVAL' &&
        stateAfterPoll.liveTask?.id === approvalId,
      `C22 (Defect 1): job_control poll must NOT overwrite WAITING_APPROVAL with ghost RUNNING frame, got ${JSON.stringify(stateAfterPoll.liveTask)}`
    );

    // Also run a fast read-only command while approval is pending — WAITING_APPROVAL must remain intact
    await fetch(`http://127.0.0.1:${port}/api/v1/tasks/trigger`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        toolName: 'exec_command',
        category: 'read',
        params: { command: 'whoami' }
      })
    }).then((r) => r.json());
    const stateAfterRo = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
      headers: authHeaders
    }).then((r) => r.json());
    assert(
      stateAfterRo.liveTask?.status === 'WAITING_APPROVAL' &&
        stateAfterRo.liveTask?.id === approvalId,
      `C22 (Defect 1): background read-only completion must not clobber pending WAITING_APPROVAL card, got ${JSON.stringify(stateAfterRo.liveTask)}`
    );

    // 3) Approve the pending task and verify audit.jsonl carries approvalId across all entries
    const appRes = await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/${encodeURIComponent(approvalId)}/approve`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ scope: 'once', source: 'ui_island' })
      }
    ).then((r) => r.json());
    assert(
      appRes.ok === true && appRes.execution?.status === 'SUCCESS',
      `C22: approval replay expected SUCCESS, got ${JSON.stringify(appRes)}`
    );

    const auditFile = path.join(ws, '.mwh', 'logs', 'audit.jsonl');
    const auditLines = fs
      .readFileSync(auditFile, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const matchingAudit = auditLines.filter((row) => row.approvalId === approvalId);
    assert(
      matchingAudit.length >= 3 &&
        matchingAudit.some((r) => r.status === 'CONFIRMATION_REQUIRED') &&
        matchingAudit.some((r) => r.status === 'SUCCESS'),
      `C22 (Defect 3): audit.jsonl must record approvalId=${approvalId} on CONFIRMATION_REQUIRED, replay SUCCESS, and UI approval entries (found ${matchingAudit.length}: ${JSON.stringify(matchingAudit)})`
    );

    // 4) Defect 2: Inject a simulated stale RUNNING frame into controlPlane and verify fail-safe reset via postKill
    server.controlPlane.liveTask = {
      ...server.controlPlane.liveTask,
      id: 'appr_stale_ghost_frame_999',
      status: 'RUNNING',
      stepLabel: '后台运行中',
      stepIndex: 2,
      totalSteps: 3
    };
    const killGhostRes = await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/appr_stale_ghost_frame_999/kill`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ source: 'ui_island' })
      }
    );
    const killGhostData = await killGhostRes.json();
    assert(
      killGhostRes.status === 200 &&
        killGhostData.ok === true &&
        killGhostData.failSafeReset === true &&
        killGhostData.status === 'IDLE_RESET',
      `C22 (Defect 2): killing a stale/ghost RUNNING frame from UI island must fail-safe reset with 200 IDLE_RESET, got ${killGhostRes.status} ${JSON.stringify(killGhostData)}`
    );
    const stateAfterReset = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
      headers: authHeaders
    }).then((r) => r.json());
    assert(
      stateAfterReset.liveTask?.status === 'IDLE',
      `C22 (Defect 2): liveTask must be IDLE after fail-safe kill reset, got ${JSON.stringify(stateAfterReset.liveTask)}`
    );
  } finally {
    await server.stop();
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 23: Defect 4/5/6 — inspect value head+tail preservation (no 200-char blind
// spot), E2 screenshot contract in tool definitions & SKILL, and workspace-scope
// approval revocation without daemon restart.
// ---------------------------------------------------------------------------
await runCase('C23 inspect value head+tail preservation, E2 contract docs, and workspace approval revocation', async () => {
  const ws = tmpDir('mwh_p3_c23_');
  const { formatUiaNodeValue } = await import('../dist/desktop/uiaBridge.js');
  const { getExposedMuseTools } = await import('../dist/tools/definitions.js');
  const { PipelineKernel } = await import('../dist/pipeline/pipeline.js');

  // 1) Defect 5: Value <= 1000 chars preserved in full; > 1000 chars preserves 500 head + 500 tail + valueLength
  const mediumText = 'A'.repeat(250) + '_APPENDED_AT_300_CHARS';
  const formattedMed = formatUiaNodeValue(mediumText);
  assert(
    formattedMed.value === mediumText &&
      formattedMed.valueLength === mediumText.length &&
      formattedMed.value.endsWith('_APPENDED_AT_300_CHARS'),
    `C23 (Defect 5): >200 char value (${mediumText.length} chars) must not be truncated at 200 chars, got ${JSON.stringify(formattedMed)}`
  );

  const longText = 'HEAD_START_' + 'M'.repeat(1400) + '_TAIL_TYPED_END';
  const formattedLong = formatUiaNodeValue(longText);
  assert(
    formattedLong.valueLength === longText.length &&
      formattedLong.value.startsWith('HEAD_START_') &&
      formattedLong.value.endsWith('_TAIL_TYPED_END') &&
      formattedLong.value.includes('...[+'),
    `C23 (Defect 5): >1000 char value must preserve both head and tail with valueLength=${longText.length}, got ${JSON.stringify(formattedLong)}`
  );

  // 2) Defect 6a: E2 screenshot contract documented in definitions.ts and SKILL.example.md
  const dhTool = getExposedMuseTools(true).find((t) => t.name === 'desktop_hands');
  assert(
    dhTool &&
      dhTool.description.includes('3840x2160') &&
      dhTool.description.includes('scaleFactor') &&
      String(dhTool.inputSchema?.properties?.region?.description || '').includes('scaleFactor'),
    `C23 (Defect 6): desktop_hands tool definition must document <=3840x2160 downsampling and scaleFactor`
  );
  const skillExample = fs.readFileSync(
    path.resolve(process.cwd(), 'connectors', 'muse-skill-template', 'SKILL.example.md'),
    'utf-8'
  );
  assert(
    skillExample.includes('3840x2160') && skillExample.includes('scaleFactor'),
    'C23 (Defect 6): SKILL.example.md must document <=3840x2160 downsampling and scaleFactor'
  );

  // 3) Defect 6b: Workspace-level approval revocation via /api/v1/security/revoke-approvals and emergency-kill
  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    workspaceRoot: ws,
    desktopHandsEnabled: true
  });
  const port = 29800 + Math.floor(Math.random() * 150);
  const server = new MwhServer({
    host: '127.0.0.1',
    port,
    runtimeToken: 'Ab1!mnopQrStu34vwxy56789012zMWH#',
    kernel
  });
  await server.start();
  const authHeaders = {
    Authorization: 'Bearer Ab1!mnopQrStu34vwxy56789012zMWH#',
    'Content-Type': 'application/json'
  };
  try {
    const engine = kernel.getApprovalEngine();
    const ctx = kernel.getContext();
    const callParams = { action: 'act', op: 'click', hwnd: 77889, x: 50, y: 50, delivery: 'background' };
    const actionKey = engine.getActionKey('desktop_hands', callParams);
    const { approvalRecord } = engine.createApproval('ws_rev_1', 'desktop_hands', 'sensitive_write', callParams, 'medium', 'bg click', false, ctx);
    engine.resolveApproval(approvalRecord.id, 'approve', undefined, 'workspace', ctx, 'ui_island');

    assert(
      engine.isActionPreApproved('desktop_hands', actionKey, 'medium', 'smart-risk', ctx, callParams) === true,
      'C23: workspace approval must pre-approve matching action before revocation'
    );

    const revRes = await fetch(`http://127.0.0.1:${port}/api/v1/security/revoke-approvals`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ scope: 'workspace', source: 'ui_island' })
    }).then((r) => r.json());
    assert(
      revRes.ok === true && revRes.workspaceRemovedCount >= 1,
      `C23 (Defect 6): /api/v1/security/revoke-approvals must remove workspace approvals, got ${JSON.stringify(revRes)}`
    );
    assert(
      engine.isActionPreApproved('desktop_hands', actionKey, 'medium', 'smart-risk', ctx, callParams) === false,
      'C23 (Defect 6): workspace approval must be revoked immediately without restarting daemon'
    );
  } finally {
    await server.stop();
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 24: Desktop Hands background type_text child-surface resolution,
// atomic append + read-back verification (verified/tailMatched/readBackLength),
// surrogate-pair safety, and fail-closed BACKGROUND_TYPE_TEXT_UNVERIFIED.
// ---------------------------------------------------------------------------
await runCase('C24 desktop_hands background type_text child Edit roundtrip, surrogate safety, and fail-closed BACKGROUND_TYPE_TEXT_UNVERIFIED', async () => {
  const {
    toSurrogateSafeUtf16Units,
    sanitizeSurrogateString,
    matchesTextTail,
    readWindowText,
    resolveTextInputTargetHwnd
  } = await import('../dist/desktop/win32Native.js');
  const { DesktopHands } = await import('../dist/tools/desktopHands.js');
  const { getExposedMuseTools } = await import('../dist/tools/definitions.js');

  // 1) Surrogate-pair safety & line-ending normalized tail matching
  const emojiText = 'A\uD83D\uDE80B';
  const emojiUnits = toSurrogateSafeUtf16Units(emojiText);
  assert(
    emojiUnits.length === 4 && emojiUnits[1] === 0xd83d && emojiUnits[2] === 0xde80,
    `C24: valid surrogate pair must stay intact in order, got ${JSON.stringify(emojiUnits)}`
  );
  const brokenSurrogate = 'X\uD800Y\uDC00Z';
  const sanitized = sanitizeSurrogateString(brokenSurrogate);
  assert(
    sanitized === 'X\uFFFDY\uFFFDZ',
    `C24: isolated high/low surrogates must be replaced with U+FFFD, got ${JSON.stringify(sanitized)}`
  );
  assert(
    matchesTextTail('line1\rline2\rMWH-FINAL-TAIL', 'line2\nMWH-FINAL-TAIL') &&
      matchesTextTail('line1\r\nline2\r\nMWH-FINAL-TAIL', 'line2\nMWH-FINAL-TAIL'),
    'C24: matchesTextTail must match across CR, LF, and CRLF line-ending representations'
  );

  // 2) Tool schema & SKILL.example.md contract sync
  const dhTool = getExposedMuseTools(true).find((t) => t.name === 'desktop_hands');
  assert(
    dhTool &&
      dhTool.description.includes('BACKGROUND_TYPE_TEXT_UNVERIFIED') &&
      dhTool.description.includes('tailMatched') &&
      dhTool.description.includes('[ABORTED]') &&
      String(dhTool.inputSchema?.properties?.text?.description || '').includes('tailMatched'),
    'C24: desktop_hands tool definition must document verified/tailMatched/BACKGROUND_TYPE_TEXT_UNVERIFIED and [ABORTED] receipt semantics'
  );
  const skillExample = fs.readFileSync(
    path.resolve(process.cwd(), 'connectors', 'muse-skill-template', 'SKILL.example.md'),
    'utf-8'
  );
  assert(
    skillExample.includes('BACKGROUND_TYPE_TEXT_UNVERIFIED') &&
      skillExample.includes('tailMatched') &&
      skillExample.includes('[ABORTED]'),
    'C24: SKILL.example.md must document verified/tailMatched/BACKGROUND_TYPE_TEXT_UNVERIFIED and [ABORTED]'
  );

  // 3) Win32 cross-process hidden parent + child Edit roundtrip & unverified rejection
  // (Spawned in a child process so its PID != process.pid and passes WinGuard's self-PID fence,
  // while also exercising true cross-process SendMessageTimeoutW marshaling.)
  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process');
    const initial277 =
      'ec18420 snake: playable grid\r\n## main\r\n?? .mwh/\r\nec18420 snake: playable grid\r\n README.md      |  11 ++++\r\n docs/RULES.md  |   6 ++\r\n src/game.js    | 183 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++\r\n src/index.html |  33 +++++++++++\r\n 4 files changed, 233 insertions(+)\r\n';

    const childScript = `
      import koffi from 'koffi';
      const u32 = koffi.load('user32.dll');
      const CreateWindowExW = u32.func('intptr_t __stdcall CreateWindowExW(uint32 dwExStyle, str16 lpClassName, str16 lpWindowName, uint32 dwStyle, int32 X, int32 Y, int32 nWidth, int32 nHeight, intptr_t hWndParent, intptr_t hMenu, intptr_t hInstance, intptr_t lpParam)');
      const SendMessageW = u32.func('intptr_t __stdcall SendMessageW(intptr_t hWnd, uint32 Msg, intptr_t wParam, intptr_t lParam)');
      const PeekMessageW = u32.func('bool __stdcall PeekMessageW(void* lpMsg, intptr_t hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax, uint32 wRemoveMsg)');
      const TranslateMessage = u32.func('bool __stdcall TranslateMessage(void* lpMsg)');
      const DispatchMessageW = u32.func('intptr_t __stdcall DispatchMessageW(void* lpMsg)');

      const WS_POPUP = 0x80000000;
      const WS_CHILD = 0x40000000;
      const WS_VISIBLE = 0x10000000;
      const ES_MULTILINE = 0x0004;
      const ES_AUTOVSCROLL = 0x0040;
      const ES_AUTOHSCROLL = 0x0080;

      const initText = ${JSON.stringify(initial277)};
      const parentHwnd = Number(CreateWindowExW(0, 'Static', 'MWH_C24_ParentHost', WS_POPUP, -32000, -32000, 400, 300, 0, 0, 0, 0));
      const childEditHwnd = Number(CreateWindowExW(0, 'Edit', initText, WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_AUTOVSCROLL | ES_AUTOHSCROLL, 0, 0, 400, 300, parentHwnd, 0, 0, 0));
      const nonEditHwnd = Number(CreateWindowExW(0, 'Static', 'MWH_C24_NonEditableStatic', WS_POPUP, -32000, -32000, 200, 100, 0, 0, 0, 0));
      SendMessageW(childEditHwnd, 0x00b1, 0, 0);

      console.log(JSON.stringify({ parentHwnd, childEditHwnd, nonEditHwnd }));
      const msgBuf = Buffer.alloc(64);
      setInterval(() => {
        while (PeekMessageW(msgBuf, 0, 0, 0, 1)) {
          TranslateMessage(msgBuf);
          DispatchMessageW(msgBuf);
        }
      }, 15);
      process.stdin.on('end', () => process.exit(0));
      process.stdin.resume();
    `;

    const helper = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    try {
      const handles = await new Promise((resolve, reject) => {
        let out = '';
        let errOut = '';
        const timer = setTimeout(() => reject(new Error(`C24 helper timed out: ${errOut}`)), 8000);
        helper.stdout.on('data', (chunk) => {
          out += chunk.toString();
          const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
          if (line) {
            clearTimeout(timer);
            resolve(JSON.parse(line.trim()));
          }
        });
        helper.stderr.on('data', (c) => (errOut += c.toString()));
        helper.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`C24 helper exited prematurely (${code}): ${errOut}`));
        });
      });

      const { parentHwnd, childEditHwnd, nonEditHwnd } = handles;
      assert(parentHwnd > 0 && childEditHwnd > 0, `C24: failed to create test windows (${parentHwnd}, ${childEditHwnd})`);

      const resolvedSurface = resolveTextInputTargetHwnd(parentHwnd);
      assert(
        resolvedSurface.targetHwnd === childEditHwnd &&
          resolvedSurface.targetClassName.toLowerCase() === 'edit',
        `C24: resolveTextInputTargetHwnd(${parentHwnd}) must resolve child Edit (${childEditHwnd}), got ${JSON.stringify(resolvedSurface)}`
      );

      const t2Payload =
        'T2 FINAL CHECK 2026-11-14: typing a long paragraph into the same Notepad window to verify head-plus-tail preservation in inspect. The quick brown fox jumps over the lazy dog and runs across the open field while the river keeps flowing under the old wooden bridge. This paragraph is intentionally long so the total length passes three hundred characters before the end marker appears. MWH-FINAL-TAIL';
      const typeRes = await DesktopHands.execute(
        {
          action: 'act',
          op: 'type_text',
          hwnd: parentHwnd,
          delivery: 'background',
          text: t2Payload
        },
        true
      );
      assert(
        typeRes.verified === true &&
          typeRes.tailMatched === true &&
          typeRes.targetHwnd === childEditHwnd &&
          typeRes.length === t2Payload.length &&
          typeRes.readBackLength === initial277.length + t2Payload.length,
        `C24: background type_text on parentHwnd must verify child Edit roundtrip, got ${JSON.stringify(typeRes)}`
      );

      const readBack1 = readWindowText(childEditHwnd);
      assert(
        readBack1.ok &&
          readBack1.text.startsWith('ec18420 snake: playable grid') &&
          readBack1.text.endsWith('MWH-FINAL-TAIL'),
        `C24: child Edit text must preserve initial head and end with MWH-FINAL-TAIL, got len=${readBack1.text.length}`
      );

      // Append supplementary-plane emoji + CJK text and verify roundtrip
      const emojiTail = ' 🚀✨ 记事本后台验证-TAIL2';
      const typeRes2 = await DesktopHands.execute(
        {
          action: 'type_text',
          hwnd: parentHwnd,
          delivery: 'background',
          text: emojiTail
        },
        true
      );
      assert(
        typeRes2.verified === true &&
          typeRes2.tailMatched === true &&
          readWindowText(childEditHwnd).text.endsWith(emojiTail),
        `C24: second background type_text with emoji/CJK must append and verify tail, got ${JSON.stringify(typeRes2)}`
      );

      // Negative check: non-editable window with no Edit child and no ValuePattern must fail closed
      let unverifiedErr = '';
      try {
        await DesktopHands.execute(
          {
            action: 'act',
            op: 'type_text',
            hwnd: nonEditHwnd,
            delivery: 'background',
            text: 'SHOULD_NOT_FAKE_SUCCESS'
          },
          true
        );
      } catch (err) {
        unverifiedErr = String(err?.message || err);
      }
      assert(
        unverifiedErr.includes('BACKGROUND_TYPE_TEXT_UNVERIFIED'),
        `C24: unverified background type_text must throw BACKGROUND_TYPE_TEXT_UNVERIFIED (never silent SUCCESS), got: ${unverifiedErr || 'no throw'}`
      );
    } finally {
      try {
        helper.stdin.end();
      } catch {}
      try {
        helper.kill();
      } catch {}
    }
  }
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

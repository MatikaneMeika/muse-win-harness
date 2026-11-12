/**
 * Gate 2 Standalone Verification Test Suite
 * Tests all Stage 2 Dual-Protocol Gateway & Network Channel requirements:
 * 1. Fail-closed public bind security check (rejects non-loopback bind without >=32-char token)
 * 2. Streamable HTTP MCP (/mcp): initialize, tools/list (all 8 tools), tools/call (pc_status, fs_explore)
 * 3. Bearer token brute-force protection: 5 failures -> 6th request gets HTTP 429
 * 4. Fast/Slow Dual-Track: long task (>8000ms) transitions to RUNNING_ASYNC, and poll fetches <=8KB chunks
 * 5. cloudflared probe honest reporting & SkillTemplateGenerator refreshing connectors/muse-skill-template/SKILL.md
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MwhServer } from '../network/server.js';
import { QuickTunnelDriver, SkillTemplateGenerator, validateServerBindSecurity } from '../network/tunnels.js';
import { getExposedMuseTools, MUSE_TOOLS } from '../tools/definitions.js';

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

async function runGate2() {
  const workspaceRoot = process.cwd();
  console.log('===============================================================');
  console.log('  MUSE-WIN-HARNESS: GATE 2 VERIFICATION TEST SUITE');
  console.log(`  Workspace Root: ${workspaceRoot}`);
  console.log(`  Platform: ${process.platform} (${os.release()})`);
  console.log(`  Node: ${process.version}`);
  console.log('===============================================================\n');

  const testPort = 19825;
  const testToken = 'a_very_secure_high_entropy_36_character_token';
  const server = new MwhServer({
    host: '127.0.0.1',
    port: testPort,
    runtimeToken: testToken
  });

  try {
    await server.start();
    console.log(`  -> Test server running at http://127.0.0.1:${testPort}`);

    // ------------------------------------------------------------------------
    // TEST 1: Fail-Closed Public Bind Security Check
    // ------------------------------------------------------------------------
    console.log('\n[TEST 1] Testing Fail-Closed Public Bind Security...');
    try {
      let threwOnShort = false;
      try {
        validateServerBindSecurity('0.0.0.0', 'short-token-under-32');
      } catch (err: any) {
        if (err.message.includes('FAIL_CLOSED_INSECURE_PUBLIC_BIND')) {
          threwOnShort = true;
        }
      }

      if (!threwOnShort) {
        throw new Error('Server did not reject public 0.0.0.0 bind with short token');
      }

      // Loopback is allowed
      validateServerBindSecurity('127.0.0.1', 'short');

      // 32-char token on public is allowed
      validateServerBindSecurity('0.0.0.0', '12345678901234567890123456789012');

      console.log('  -> PASS: Insecure public bind rejected fail-closed, valid configurations accepted.');
      results.push({ name: 'Requirement 1: Fail-Closed Bind Security', passed: true });
    } catch (err: any) {
      console.error(`  -> FAIL: ${err.message}`);
      results.push({ name: 'Requirement 1: Fail-Closed Bind Security', passed: false, message: err.message });
    }

    // ------------------------------------------------------------------------
    // TEST 2: Streamable HTTP MCP (/mcp) Verification
    // ------------------------------------------------------------------------
    console.log('\n[TEST 2] Testing MCP /mcp Protocol (initialize, tools/list, tools/call)...');
    try {
      const authHeader = `Bearer ${testToken}`;

      // 2A: initialize
      const initRes = await httpRequest({
        url: `http://127.0.0.1:${testPort}/mcp`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {}
        })
      });

      if (initRes.statusCode !== 200) {
        throw new Error(`MCP initialize returned status ${initRes.statusCode}: ${initRes.body}`);
      }

      const initData = JSON.parse(initRes.body);
      if (initData.result?.protocolVersion !== '2024-11-05') {
        throw new Error(`Unexpected MCP protocolVersion: ${JSON.stringify(initData)}`);
      }

      // 2B: tools/list (default desktopHandsEnabled = false -> 7 tools; enabled = true -> 8 tools)
      const listRes = await httpRequest({
        url: `http://127.0.0.1:${testPort}/mcp`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        })
      });

      const listData = JSON.parse(listRes.body);
      const tools: any[] = listData.result?.tools || [];
      const defaultExpectedTools = getExposedMuseTools(false);
      if (tools.length !== defaultExpectedTools.length) {
        throw new Error(`Expected ${defaultExpectedTools.length} default Muse tools (desktop_hands disabled), got ${tools.length}`);
      }
      if (tools.find((t) => t.name === 'desktop_hands')) {
        throw new Error(`Tool 'desktop_hands' must be hidden when desktopHandsEnabled is false`);
      }
      for (const expected of defaultExpectedTools) {
        if (!tools.find((t) => t.name === expected.name)) {
          throw new Error(`Tool '${expected.name}' not found in tools/list`);
        }
      }

      // Verify conditional registration: enabling desktopHandsEnabled exposes all 8 tools
      server.getKernel().updateContext({ desktopHandsEnabled: true });
      const listEnabledRes = await httpRequest({
        url: `http://127.0.0.1:${testPort}/mcp`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/list',
          params: {}
        })
      });
      const listEnabledData = JSON.parse(listEnabledRes.body);
      const enabledTools: any[] = listEnabledData.result?.tools || [];
      if (enabledTools.length !== 8 || !enabledTools.find((t) => t.name === 'desktop_hands')) {
        throw new Error(`Expected 8 tools including 'desktop_hands' when desktopHandsEnabled=true, got ${enabledTools.length}`);
      }
      server.getKernel().updateContext({ desktopHandsEnabled: false });

      // 2C: tools/call -> pc_status
      const pcCallRes = await httpRequest({
        url: `http://127.0.0.1:${testPort}/mcp`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'pc_status', arguments: {} }
        })
      });

      const pcData = JSON.parse(pcCallRes.body);
      const textContent = pcData.result?.content?.[0]?.text;
      if (!textContent || !textContent.includes('securityBoundary')) {
        throw new Error(`pc_status output missing securityBoundary: ${pcCallRes.body}`);
      }

      // 2D: tools/call -> fs_explore list
      const fsCallRes = await httpRequest({
        url: `http://127.0.0.1:${testPort}/mcp`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'fs_explore', arguments: { action: 'list', path: '.' } }
        })
      });

      const fsData = JSON.parse(fsCallRes.body);
      if (!fsData.result?.content?.[0]?.text?.includes('package.json')) {
        throw new Error(`fs_explore output missing workspace items: ${fsCallRes.body}`);
      }

      console.log('  -> PASS: MCP JSON-RPC 2.0 initialize, tools/list (8 tools), and tools/call verified.');
      results.push({ name: 'Requirement 2: Streamable HTTP MCP (/mcp)', passed: true });
    } catch (err: any) {
      console.error(`  -> FAIL: ${err.message}`);
      results.push({ name: 'Requirement 2: Streamable HTTP MCP (/mcp)', passed: false, message: err.message });
    }

    // ------------------------------------------------------------------------
    // TEST 3: Bearer Token Brute-Force Protection (5 Failures -> HTTP 429)
    // ------------------------------------------------------------------------
    console.log('\n[TEST 3] Testing Bearer Token Brute-Force IP Ban...');
    try {
      // Send 5 failed requests
      for (let i = 1; i <= 5; i++) {
        const res = await httpRequest({
          url: `http://127.0.0.1:${testPort}/api/v1/status`,
          headers: { Authorization: `Bearer WRONG_TOKEN_${i}` }
        });
        if (i < 5 && res.statusCode !== 401) {
          throw new Error(`Attempt ${i} expected 401, got ${res.statusCode}`);
        }
        if (i === 5 && res.statusCode !== 429) {
          throw new Error(`5th failure expected 429, got ${res.statusCode}`);
        }
      }

      // 6th request with the CORRECT token must still be blocked with 429
      const sixthRes = await httpRequest({
        url: `http://127.0.0.1:${testPort}/api/v1/status`,
        headers: { Authorization: `Bearer ${testToken}` }
      });

      if (sixthRes.statusCode !== 429) {
        throw new Error(`6th request expected HTTP 429 (IP banned), got ${sixthRes.statusCode}`);
      }

      if (!sixthRes.body.includes('IP_BANNED_TOO_MANY_FAILURES')) {
        throw new Error(`Response did not mention IP_BANNED_TOO_MANY_FAILURES: ${sixthRes.body}`);
      }

      console.log('  -> PASS: 5 consecutive failed attempts trigger 15-minute IP ban (HTTP 429).');
      results.push({ name: 'Requirement 3: Bearer Brute-Force Protection (429)', passed: true });
    } catch (err: any) {
      console.error(`  -> FAIL: ${err.message}`);
      results.push({ name: 'Requirement 3: Bearer Brute-Force Protection (429)', passed: false, message: err.message });
    } finally {
      // Reset IP tracking so subsequent test requests succeed
      server.getAuthGuard().resetIp('127.0.0.1');
      server.getAuthGuard().resetIp('::1');
    }

    // ------------------------------------------------------------------------
    // TEST 4: Fast/Slow Dual-Track Execution (>8000ms -> RUNNING_ASYNC + Poll <=8KB)
    // ------------------------------------------------------------------------
    console.log('\n[TEST 4] Testing Fast/Slow Dual-Track & Paginated Log Polling...');
    try {
      console.log('  -> Launching 10s command with 8000ms foreground threshold...');
      const kernel = server.getKernel();

      // P1 sync note: approvalPolicy can no longer be injected via request.context
      // (security-sensitive context keys are stripped before merge), so the policy
      // is configured on the server-side kernel instead.
      kernel.updateContext({ approvalPolicy: 'auto-workspace' });

      // Launch command that runs for 10 seconds and prints lines
      const cmd = "1..10 | ForEach-Object { Write-Output ('dual_track_output_line_' + $_); Start-Sleep -Seconds 1 }";
      const dualRes = await kernel.handleRequest({
        id: 'gate2_t4_dual_track',
        toolName: 'exec_command',
        category: 'sensitive_write',
        context: { approvalPolicy: 'auto-workspace' },
        params: {
          command: cmd,
          yieldTimeMs: 8000,
          timeoutMs: 30000
        }
      });

      if (dualRes.status !== 'SUCCESS') {
        throw new Error(`exec_command request failed: ${JSON.stringify(dualRes)}`);
      }

      const jobData = dualRes.data;
      if (jobData?.status !== 'RUNNING_ASYNC' || !jobData?.jobId) {
        throw new Error(
          `Command did not transition to RUNNING_ASYNC after 8000ms threshold. Got: ${JSON.stringify(jobData)}`
        );
      }

      const jobId = jobData.jobId;
      console.log(`  -> Command transitioned to RUNNING_ASYNC with Job ID: ${jobId}`);

      // Wait 1.5 seconds for more lines to be written
      await new Promise((r) => setTimeout(r, 1500));

      // Poll page 1 with pageSize = 8192
      const pollRes = await kernel.handleRequest({
        id: 'gate2_t4_poll',
        toolName: 'job_control',
        category: 'write',
        params: {
          action: 'poll',
          jobId,
          page: 1,
          pageSize: 8192
        }
      });

      if (pollRes.status !== 'SUCCESS') {
        throw new Error(`job_control poll failed: ${JSON.stringify(pollRes)}`);
      }

      const pollData = pollRes.data;
      if (!pollData.chunk || !pollData.chunk.includes('dual_track_output_line_')) {
        throw new Error(`Poll log chunk does not contain expected output: ${JSON.stringify(pollData)}`);
      }

      if (Buffer.byteLength(pollData.chunk, 'utf-8') > 8192) {
        throw new Error(`Poll chunk exceeded 8192 byte maximum page limit`);
      }

      // Abort job to clean up process
      await kernel.handleRequest({
        id: 'gate2_t4_abort',
        toolName: 'job_control',
        category: 'write',
        params: { action: 'abort', jobId }
      });

      console.log('  -> PASS: Fast/Slow dual-track transition and paginated log polling verified.');
      results.push({ name: 'Requirement 4: Fast/Slow Dual-Track & Polling', passed: true });
    } catch (err: any) {
      console.error(`  -> FAIL: ${err.message}`);
      results.push({ name: 'Requirement 4: Fast/Slow Dual-Track & Polling', passed: false, message: err.message });
    }

    // ------------------------------------------------------------------------
    // TEST 5: cloudflared Detection & SKILL.md Refresh
    // ------------------------------------------------------------------------
    console.log('\n[TEST 5] Testing cloudflared Probe & SKILL.md Generation...');
    try {
      const probe = QuickTunnelDriver.probeCloudflared();
      console.log(`  -> cloudflared probe status: found=${probe.found}, path=${probe.path || 'none'}`);
      if (!probe.found) {
        if (!probe.message?.includes('CLOUDFLARED_MISSING')) {
          throw new Error('Missing cloudflared did not provide CLOUDFLARED_MISSING error message');
        }
      }

      // P3: the generated SKILL.md is written to a TEMP directory (mkdtemp) so
      // the verification never pollutes repository files. Assertion logic unchanged.
      const tempSkillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwh_gate2_skill_'));
      const testSkillPath = path.join(tempSkillDir, 'SKILL.md');
      const testTunnelUrl = 'https://gate2-verification-tunnel.trycloudflare.com';
      SkillTemplateGenerator.refreshSkillMd(testTunnelUrl, testSkillPath);

      if (!fs.existsSync(testSkillPath)) {
        throw new Error('Skill template was not created at expected output path');
      }

      const skillContent = fs.readFileSync(testSkillPath, 'utf-8');
      if (
        !skillContent.includes(`${testTunnelUrl}/mcp`) ||
        !skillContent.includes(`${testTunnelUrl}/api/v1`) ||
        !skillContent.includes('Authorization: Bearer <TUNNEL_RUNTIME_TOKEN>')
      ) {
        throw new Error('Generated SKILL.md missing endpoint definitions');
      }

      // Verify default 7 tools documented when desktopHandsEnabled=false, and 8 when true
      for (const t of getExposedMuseTools(false)) {
        if (!skillContent.includes(`### \`${t.name}\``)) {
          throw new Error(`SKILL.md does not document default tool '${t.name}'`);
        }
      }
      if (skillContent.includes('### `desktop_hands`')) {
        throw new Error(`SKILL.md must not document 'desktop_hands' when desktopHandsEnabled=false`);
      }
      SkillTemplateGenerator.refreshSkillMd(testTunnelUrl, testSkillPath, true);
      const skillContentFull = fs.readFileSync(testSkillPath, 'utf-8');
      for (const t of MUSE_TOOLS) {
        if (!skillContentFull.includes(`### \`${t.name}\``)) {
          throw new Error(`SKILL.md (desktopHandsEnabled=true) does not document tool '${t.name}'`);
        }
      }

      // Best-effort cleanup of the temp verification directory
      try {
        fs.rmSync(tempSkillDir, { recursive: true, force: true });
      } catch {}

      console.log('  -> PASS: cloudflared honestly probed and SKILL.md generation verified (temp dir output).');
      results.push({ name: 'Requirement 5: cloudflared Probe & SKILL.md Generation', passed: true });
    } catch (err: any) {
      console.error(`  -> FAIL: ${err.message}`);
      results.push({
        name: 'Requirement 5: cloudflared Probe & SKILL.md Generation',
        passed: false,
        message: err.message
      });
    }
  } finally {
    await server.stop();
  }

  // --------------------------------------------------------------------------
  // SUMMARY REPORT
  // --------------------------------------------------------------------------
  console.log('\n===============================================================');
  console.log('  GATE 2 VERIFICATION SUMMARY');
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
    console.log('  RESULT: ALL 5 GATE 2 REQUIREMENTS PASSED SUCCESSFULLY!');
    console.log('===============================================================\n');
    process.exit(0);
  } else {
    console.error('  RESULT: ONE OR MORE GATE 2 CHECKS FAILED!');
    console.log('===============================================================\n');
    process.exit(1);
  }
}

runGate2().catch((err) => {
  console.error('Fatal unhandled error during Gate 2 verification:', err);
  process.exit(1);
});

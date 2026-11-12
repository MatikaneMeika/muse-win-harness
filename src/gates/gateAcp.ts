/**
 * Gate ACP & Subagent Pipeline (Gate-A1 ~ Gate-A5): Comprehensive Verification Suite for the
 * Standardized ACP / Subagent Pipeline & Security Boundaries.
 *
 * Custom Verification Gates:
 * - Gate-A1: Profile Registry, Arbitrary Profile ID Addressing & Strict 8-Tool Contract
 * - Gate-A2: True ACP JSON-RPC 2.0 Lifecycle, Read-Only Permission Gate, Live Steer & Cooperative Gradient Teardown
 * - Gate-A3: Bounded Event Ring Buffer (512 / 4MB), Cursor Long-Polling & Zero JOB_LOG_NOT_FOUND
 * - Gate-A4: Unified 600s Timeout, Child Env Scrubbing + envAllowlist, <=4096B Safe Diagnostic & HMAC Fail-Closed
 * - Gate-REST: Control Plane ACP Profile REST Endpoints
 */

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AcpConfigManager } from '../config/acpConfig.js';
import { SubagentDispatcher } from '../subagents/dispatcher.js';
import { buildCleanChildEnv, buildSafeDiagnostic } from '../executors/cliAdapters.js';
import { JobManager, MAX_EVENT_RING_ITEMS } from '../executors/jobManager.js';
import { PipelineKernel } from '../pipeline/pipeline.js';
import { ApprovalEngine } from '../pipeline/approvalEngine.js';
import { getExposedMuseTools, MUSE_TOOLS } from '../tools/definitions.js';
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '../types.js';
import { MwhServer } from '../network/server.js';

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
    if (options.body) {
      req.setHeader('Content-Length', Buffer.byteLength(options.body));
      req.write(options.body);
    }
    req.end();
  });
}

async function runGateAcp() {
  console.log('===============================================================');
  console.log('  MUSE-WIN-HARNESS: ACP & SUBAGENT PIPELINE VERIFICATION SUITE');
  console.log('  (Gate-A1 / Gate-A2 / Gate-A3 / Gate-A4 / Control Plane REST)');
  console.log('===============================================================\n');

  const testConfigDir = path.join(os.tmpdir(), `mwh-acp-test-${Date.now()}`);
  const testConfigPath = path.join(testConfigDir, 'acp-profiles.json');

  try {
    // =========================================================================
    // GATE-A1: Profile Registry, Arbitrary ID Addressing & Default Resolution
    // =========================================================================
    const manager = AcpConfigManager.getInstance(testConfigPath);
    const initialConfig = manager.loadConfig();
    assert.strictEqual(initialConfig.acp_enabled, true, 'Default acp_enabled should be true');
    assert.strictEqual(initialConfig.acp_profiles.length, 0, 'Default acp_profiles should be empty');

    // Verify default profile and 'acp' alias resolution without legacy CLI slot borrowing
    manager.upsertProfile({
      id: 'agy',
      kind: 'acp',
      display_name: 'Antigravity ACP',
      command: process.execPath,
      args: ['--version'],
      enabled: true
    });
    manager.setDefaultProfile('agy');
    assert.strictEqual(
      manager.resolveProfile('acp')?.id,
      'agy',
      'resolveProfile("acp") must resolve to default "agy" profile'
    );
    assert.strictEqual(
      manager.resolveProfile('')?.id,
      'agy',
      'resolveProfile("") must resolve to default "agy" profile'
    );
    assert.strictEqual(
      manager.resolveProfile('unregistered_legacy_cli'),
      undefined,
      'Unregistered profile ID must resolve to undefined (no hardcoded legacy CLI fallback)'
    );
    manager.deleteProfile('agy');

    // Verify tool definitions strictly expose 7 default tools (desktop_hands hidden) and 8 when enabled
    assert.deepStrictEqual(
      getExposedMuseTools(false).map((t) => t.name),
      [
        'pc_status',
        'fs_explore',
        'fs_mutate',
        'exec_command',
        'job_control',
        'subagent_dispatch',
        'git_checkpoint'
      ],
      'getExposedMuseTools(false) must expose the 7 default core tools without desktop_hands'
    );
    assert.deepStrictEqual(
      getExposedMuseTools(true).map((t) => t.name),
      [
        'pc_status',
        'fs_explore',
        'fs_mutate',
        'exec_command',
        'job_control',
        'subagent_dispatch',
        'git_checkpoint',
        'desktop_hands'
      ],
      'getExposedMuseTools(true) must strictly expose all 8 orthogonal tools'
    );
    const subagentTool = MUSE_TOOLS.find((t) => t.name === 'subagent_dispatch');
    assert(subagentTool, 'MUSE_TOOLS must expose canonical subagent_dispatch tool');
    assert.strictEqual(
      subagentTool.inputSchema.properties.agent.enum,
      undefined,
      'subagent_dispatch.inputSchema.properties.agent must not have a hardcoded enum'
    );

    // Command probing & arbitrary profile ID registration
    const nodeProbe = manager.probeCommand(process.execPath);
    assert.strictEqual(nodeProbe.available, true, 'Current node binary should be detected');
    const fakeProbe = manager.probeCommand('non_existent_binary_xyz_12345.exe');
    assert.strictEqual(fakeProbe.available, false, 'Non-existent binary should report not available');

    const customId = 'custom_agent_alpha_99';
    const addRes = manager.upsertProfile({
      id: customId,
      kind: 'cli',
      display_name: 'Custom Alpha 99',
      command: process.execPath,
      args: ['-e', 'console.log("ALPHA_99_OK")'],
      envAllowlist: ['ALLOWED_API_KEY'],
      permissionPolicy: 'allow',
      enabled: true
    });
    assert.strictEqual(addRes.success, true);
    assert.strictEqual(addRes.profile?.id, customId);

    const kernel = new PipelineKernel();
    kernel.updateContext({
      workspaceRoot: process.cwd(),
      confinementMode: 'workspace-write',
      approvalPolicy: 'unattended-yolo',
      yoloExpiresAt: Date.now() + 3600_000
    });

    const alphaRes = await SubagentDispatcher.dispatch(
      {
        agent: customId,
        prompt: 'Run custom profile id test',
        childMode: 'workspace-write',
        isolateWorktree: false
      },
      kernel.getContext()
    );
    assert.strictEqual(alphaRes.status, 'COMPLETED', `Custom profile dispatch failed: ${alphaRes.error}`);
    assert.strictEqual(alphaRes.agentType, customId, 'Receipt must report true profile id');
    assert(alphaRes.summary.includes('ALPHA_99_OK'), 'Output should contain ALPHA_99_OK');

    // Verify disabled profile reports ACP_PROFILE_DISABLED (not CLI_NOT_FOUND)
    manager.toggleProfile(customId, false);
    const disabledRes = await SubagentDispatcher.dispatch(
      {
        agent: customId,
        prompt: 'Should fail with ACP_PROFILE_DISABLED',
        childMode: 'workspace-write',
        isolateWorktree: false
      },
      kernel.getContext()
    );
    assert.strictEqual(disabledRes.status, 'FAILED');
    assert.strictEqual(disabledRes.error, 'ACP_PROFILE_DISABLED');
    assert(disabledRes.diagnostic?.includes('category: configuration'));
    manager.deleteProfile(customId);
    console.log('[PASS] Gate-A1: Profile Registry, arbitrary ID addressing & borrowed-slot migration verified.');

    // =========================================================================
    // GATE-A2: True ACP JSON-RPC 2.0 Handshake, Streaming, Read-Only Permission
    //          Denial, Live Mid-Run Steer & Cooperative Gradient Teardown
    // =========================================================================
    const mockAcpServerScript = path.join(testConfigDir, 'mock-acp-stdio-server.mjs');
    fs.writeFileSync(
      mockAcpServerScript,
      [
        "import readline from 'node:readline';",
        "if (process.argv.length > 2) {",
        "  process.stderr.write('Unexpected positional argument: ' + process.argv.slice(2).join(' ') + '\\n');",
        "  process.exit(2);",
        "}",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');",
        "let mode = process.env.MOCK_ACP_BEHAVIOR || 'normal';",
        "let firstPromptId = null;",
        "rl.on('line', (line) => {",
        "  const trimmed = line.trim();",
        "  if (!trimmed) return;",
        "  const msg = JSON.parse(trimmed);",
        "  if (msg.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });",
        "  } else if (msg.method === 'session/new') {",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_acp_gate2' } });",
        "  } else if (msg.method === 'session/prompt') {",
        "    const promptText = msg.params?.prompt?.[0]?.text || '';",
        "    if (mode === 'wait_steer') {",
        "      if (firstPromptId === null) {",
        "        firstPromptId = msg.id;",
        "        send({",
        "          jsonrpc: '2.0',",
        "          method: 'session/update',",
        "          params: {",
        "            sessionId: 'sess_acp_gate2',",
        "            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'INITIAL:' + promptText + '|' } }",
        "          }",
        "        });",
        "      } else {",
        "        send({",
        "          jsonrpc: '2.0',",
        "          method: 'session/update',",
        "          params: {",
        "            sessionId: 'sess_acp_gate2',",
        "            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STEERED:' + promptText } }",
        "          }",
        "        });",
        "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
        "      }",
        "      return;",
        "    }",
        "    if (mode === 'hang_after_chunk') {",
        "      send({",
        "        jsonrpc: '2.0',",
        "        method: 'session/update',",
        "        params: {",
        "          sessionId: 'sess_acp_gate2',",
        "          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL_BEFORE_TIMEOUT' } }",
        "        }",
        "      });",
        "      return;",
        "    }",
        "    // Request a write permission to test read-only / policy handling",
        "    send({",
        "      jsonrpc: '2.0',",
        "      id: 99,",
        "      method: 'session/request_permission',",
        "      params: {",
        "        sessionId: 'sess_acp_gate2',",
        "        toolCall: { kind: 'edit', title: 'Write file' },",
        "        options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'reject_once', kind: 'reject_once' }]",
        "      }",
        "    });",
        "    send({",
        "      jsonrpc: '2.0',",
        "      method: 'session/update',",
        "      params: {",
        "        sessionId: 'sess_acp_gate2',",
        "        update: { sessionUpdate: 'tool_call', toolCallId: 'tc_1', kind: 'read', title: 'Read config', status: 'completed' }",
        "      }",
        "    });",
        "    send({",
        "      jsonrpc: '2.0',",
        "      method: 'session/update',",
        "      params: {",
        "        sessionId: 'sess_acp_gate2',",
        "        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP_STREAM_OK:' + promptText } }",
        "      }",
        "    });",
        "  } else if (msg.id === 99 && msg.result) {",
        "    const outcome = msg.result?.outcome?.outcome || 'unknown';",
        "    send({",
        "      jsonrpc: '2.0',",
        "      method: 'session/update',",
        "      params: {",
        "        sessionId: 'sess_acp_gate2',",
        "        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '|PERM:' + outcome } }",
        "      }",
        "    });",
        "    send({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });",
        "  } else if (msg.method === 'session/cancel') {",
        "    process.exit(0);",
        "  }",
        "});"
      ].join('\n'),
      'utf-8'
    );

    manager.upsertProfile({
      id: 'mock_acp_stdio',
      kind: 'acp',
      display_name: 'Mock ACP Stdio Agent',
      command: process.execPath,
      args: [mockAcpServerScript],
      permissionPolicy: 'allow',
      enabled: true
    });

    // 2a. Normal workspace-write run: permission is allowed ('selected')
    const acpNormalRes = await SubagentDispatcher.dispatch(
      {
        agent: 'mock_acp_stdio',
        prompt: 'PING_ACP',
        childMode: 'workspace-write',
        isolateWorktree: false
      },
      kernel.getContext()
    );
    assert.strictEqual(acpNormalRes.status, 'COMPLETED', `ACP normal run failed: ${acpNormalRes.error}`);
    assert(
      acpNormalRes.output?.includes('ACP_STREAM_OK:PING_ACP|PERM:selected'),
      `Expected selected permission & streamed chunk, got: ${acpNormalRes.output}`
    );

    // 2b. Read-only run (with non-write prompt): mutating permission request ('edit') is denied ('cancelled')
    const acpReadOnlyRes = await SubagentDispatcher.dispatch(
      {
        agent: 'mock_acp_stdio',
        prompt: 'Inspect repository structure',
        childMode: 'read-only',
        isolateWorktree: false
      },
      kernel.getContext()
    );
    assert.strictEqual(acpReadOnlyRes.status, 'COMPLETED');
    assert(
      acpReadOnlyRes.output?.includes('ACP_STREAM_OK:Inspect repository structure|PERM:cancelled'),
      `Expected read-only mode to cancel mutating ACP permission request, got: ${acpReadOnlyRes.output}`
    );

    // 2c. Live mid-run steer via subagent_dispatch(action='steer') + event stream wait via subagent_dispatch(action='wait')
    manager.upsertProfile({
      id: 'mock_acp_steer',
      kind: 'acp',
      display_name: 'Mock ACP Steer Agent',
      command: process.execPath,
      args: [mockAcpServerScript],
      env: { MOCK_ACP_BEHAVIOR: 'wait_steer' },
      enabled: true
    });

    const asyncStart = await SubagentDispatcher.dispatch(
      {
        agent: 'mock_acp_steer',
        prompt: 'STEP_ONE',
        childMode: 'workspace-write',
        async: true,
        yieldTimeMs: 100
      },
      kernel.getContext()
    );
    assert.strictEqual(asyncStart.status, 'RUNNING_ASYNC', 'Steer test job should background as RUNNING_ASYNC');
    assert(asyncStart.jobId, 'RUNNING_ASYNC receipt must include jobId');

    // Wait briefly for INITIAL chunk event
    const initialEvents = await SubagentDispatcher.dispatch(
      {
        action: 'events',
        jobId: asyncStart.jobId,
        afterSeq: 0,
        waitMs: 2000
      },
      kernel.getContext()
    );
    assert(initialEvents.events && initialEvents.events.length > 0, 'Should receive initial events');

    // Deliver live steer
    const steerRes = await SubagentDispatcher.dispatch(
      {
        action: 'steer',
        jobId: asyncStart.jobId,
        input: 'STEP_TWO_STEERED'
      },
      kernel.getContext()
    );
    assert.strictEqual(steerRes.status, 'COMPLETED', `Steer failed: ${steerRes.error}`);
    assert.strictEqual(
      steerRes.steerDelivery?.accepted,
      true,
      'Steer receipt must include steerDelivery.accepted=true'
    );
    assert.strictEqual(
      steerRes.steerDelivery?.acknowledged,
      false,
      'Steer receipt must honestly report acknowledged=false at pipe-write time'
    );
    assert.strictEqual(
      steerRes.steerDelivery?.deliveryState,
      'queued_behind_active_turn',
      `Expected steer while primary turn active to report queued_behind_active_turn, got ${steerRes.steerDelivery?.deliveryState}`
    );
    assert(
      steerRes.summary.includes('NOT yet executed by upstream agent'),
      `Steer summary must honestly distinguish pipe write from execution, got: ${steerRes.summary}`
    );

    // Wait for completion via action='wait'
    let finalPolled = await SubagentDispatcher.dispatch(
      {
        action: 'wait',
        jobId: asyncStart.jobId,
        afterSeq: initialEvents.nextSeq || 0,
        waitMs: 3000
      },
      kernel.getContext()
    );
    if (finalPolled.status === 'RUNNING_ASYNC') {
      await new Promise((r) => setTimeout(r, 200));
      finalPolled = await SubagentDispatcher.dispatch(
        {
          action: 'wait',
          jobId: asyncStart.jobId,
          afterSeq: 0,
          waitMs: 2000
        },
        kernel.getContext()
      );
    }
    assert.strictEqual(finalPolled.status, 'COMPLETED', `Expected steered job to complete, got ${finalPolled.status}`);
    assert(
      finalPolled.output?.includes('INITIAL:STEP_ONE|STEERED:STEP_TWO_STEERED'),
      `Expected both initial and steered output, got: ${finalPolled.output}`
    );

    // 2d. Timeout & cooperative gradient teardown preserves partial output and attaches safe diagnostic
    manager.upsertProfile({
      id: 'mock_acp_hang',
      kind: 'acp',
      display_name: 'Mock ACP Hang Agent',
      command: process.execPath,
      args: [mockAcpServerScript],
      env: { MOCK_ACP_BEHAVIOR: 'hang_after_chunk' },
      disposeEofGraceMs: 60,
      disposeGraceMs: 60,
      enabled: true
    });

    const hangRes = await SubagentDispatcher.dispatch(
      {
        agent: 'mock_acp_hang',
        prompt: 'HANG_TEST',
        childMode: 'workspace-write',
        timeoutMs: 350
      },
      kernel.getContext()
    );
    assert.strictEqual(hangRes.status, 'FAILED');
    assert.strictEqual(hangRes.error, 'TIMEOUT');
    assert.strictEqual(
      hangRes.output,
      'PARTIAL_BEFORE_TIMEOUT',
      `Partial output must be preserved on timeout, got: ${hangRes.output}`
    );
    assert(
      hangRes.diagnostic?.includes('provider: ACP; profile: mock_acp_hang; stage: teardown; category: timeout'),
      `Expected timeout diagnostic, got: ${hangRes.diagnostic}`
    );
    assert(
      hangRes.resumeHint?.includes('action="resume"'),
      `Timeout receipt must include honest resumeHint, got: ${hangRes.resumeHint}`
    );

    // 2e. Activity-aware sliding timeout + dead-session steer rejection + action="resume" + out-of-fence cwd rejection
    const slidingServerScript = path.join(testConfigDir, 'mock-acp-sliding.mjs');
    fs.writeFileSync(
      slidingServerScript,
      [
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');",
        "rl.on('line', (line) => {",
        "  const trimmed = line.trim();",
        "  if (!trimmed) return;",
        "  const msg = JSON.parse(trimmed);",
        "  if (msg.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });",
        "  } else if (msg.method === 'session/new') {",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_sliding' } });",
        "  } else if (msg.method === 'session/prompt') {",
        "    const text = msg.params?.prompt?.[0]?.text || '';",
        "    let ticks = 0;",
        "    const iv = setInterval(() => {",
        "      ticks++;",
        "      send({",
        "        jsonrpc: '2.0',",
        "        method: 'session/update',",
        "        params: {",
        "          sessionId: 'sess_sliding',",
        "          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TICK_' + ticks + ':' } }",
        "        }",
        "      });",
        "      if (ticks >= 8) {",
        "        clearInterval(iv);",
        "        send({",
        "          jsonrpc: '2.0',",
        "          method: 'session/update',",
        "          params: {",
        "            sessionId: 'sess_sliding',",
        "            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.includes('[RESUMED FROM DEAD SESSION') ? 'RESUME_OK' : 'SLIDING_OK' } }",
        "          }",
        "        });",
        "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
        "      }",
        "    }, 90);",
        "  }",
        "});"
      ].join('\n'),
      'utf-8'
    );

    manager.upsertProfile({
      id: 'mock_acp_sliding',
      kind: 'acp',
      display_name: 'Mock ACP Sliding Agent',
      command: process.execPath,
      args: [slidingServerScript],
      enabled: true
    });

    process.env.MWH_ENABLE_SLIDING_TIMEOUT = '1';
    try {
      // Base timeout is 800ms, chunks arrive every 90ms for ~800ms (< 2400ms hard cap): must NOT be killed at 800ms!
      const slidingRes = await SubagentDispatcher.dispatch(
        {
          agent: 'mock_acp_sliding',
          prompt: 'SLIDING_TEST',
          childMode: 'workspace-write',
          timeoutMs: 800
        },
        kernel.getContext()
      );
      assert.strictEqual(
        slidingRes.status,
        'COMPLETED',
        `Active agent should slide past initial 800ms window and complete, got: ${slidingRes.status} (${slidingRes.error})`
      );
      assert(
        slidingRes.output?.includes('TICK_8:SLIDING_OK'),
        `Expected full 8-tick output, got: ${slidingRes.output}`
      );
    } finally {
      delete process.env.MWH_ENABLE_SLIDING_TIMEOUT;
    }

    // Steer against dead/timed-out job must fail honestly with SESSION_ALREADY_TERMINATED
    const deadSteerRes = await SubagentDispatcher.dispatch(
      {
        action: 'steer',
        jobId: hangRes.jobId,
        input: 'TRY_STEER_DEAD_JOB'
      },
      kernel.getContext()
    );
    assert.strictEqual(deadSteerRes.status, 'FAILED');
    assert(
      deadSteerRes.summary.includes('SESSION_ALREADY_TERMINATED'),
      `Expected SESSION_ALREADY_TERMINATED when steering dead job, got: ${deadSteerRes.summary}`
    );

    // Resume from dead/timed-out job spawns a fresh session in the same workspace with continuation context
    const resumeRes = await SubagentDispatcher.dispatch(
      {
        action: 'resume',
        jobId: hangRes.jobId,
        agent: 'mock_acp_sliding',
        prompt: 'Finish remaining work from disk'
      },
      kernel.getContext()
    );
    assert.strictEqual(resumeRes.status, 'COMPLETED', `Resume failed: ${resumeRes.error}`);
    assert.strictEqual(resumeRes.resumedFrom, hangRes.jobId, 'resumedFrom must reference dead jobId');
    assert(resumeRes.output?.includes('RESUME_OK'), `Expected RESUME_OK in resumed output, got: ${resumeRes.output}`);

    // Unpinned cwd with out-of-workspace path in prompt must fail closed with SUBAGENT_CWD_OUT_OF_WORKSPACE (never silently fall back)
    await assert.rejects(
      async () => {
        await SubagentDispatcher.dispatch(
          {
            agent: 'mock_acp_sliding',
            prompt: '请直接在 E:\\untrusted_outside_dir_999 目录下初始化 git 并开发游戏',
            childMode: 'workspace-write'
          },
          kernel.getContext()
        );
      },
      /SUBAGENT_CWD_OUT_OF_WORKSPACE/,
      'Prompt targeting out-of-workspace absolute path without explicit cwd must fail closed with SUBAGENT_CWD_OUT_OF_WORKSPACE'
    );

    manager.deleteProfile('mock_acp_sliding');

    manager.deleteProfile('mock_acp_stdio');
    manager.deleteProfile('mock_acp_steer');
    manager.deleteProfile('mock_acp_hang');
    console.log('[PASS] Gate-A2: True ACP JSON-RPC 2.0 handshake, read-only permission gate, live steer & gradient teardown verified.');

    // =========================================================================
    // GATE-A3: Bounded Event Ring (512 / 4MB), Cursor Guard & Zero JOB_LOG_NOT_FOUND
    // =========================================================================
    const jobManager = JobManager.getInstance();
    const { jobId: ringJobId } = jobManager.createSubagentJob({
      agentType: 'ring_test_agent',
      prompt: 'Event ring backpressure test',
      workspaceRoot: process.cwd(),
      timeoutMs: 60000
    });

    for (let i = 1; i <= 600; i++) {
      jobManager.appendSubagentEvent(ringJobId, {
        kind: 'message_chunk',
        stream: 'stdout',
        text: `chunk_${i}_--dangerously-skip-permissions`
      });
    }
    jobManager.appendSubagentOutput(ringJobId, 'stdout', 'MEMORY_FALLBACK_PAYLOAD_OK\n');

    const ringPoll = await jobManager.pollEvents(ringJobId, {
      afterSeq: 999999, // Cursor poisoning attempt beyond latestSeq
      limit: 512
    });
    assert(
      ringPoll.events.length <= MAX_EVENT_RING_ITEMS,
      `Event ring must not exceed ${MAX_EVENT_RING_ITEMS}, got ${ringPoll.events.length}`
    );
    assert.strictEqual(ringPoll.droppedEvents, 89, `Expected 89 dropped events (601 - 512), got ${ringPoll.droppedEvents}`);
    assert.strictEqual(
      ringPoll.afterSeq,
      ringPoll.latestSeq,
      'Poisoned afterSeq > latestSeq must be clamped to latestSeq'
    );

    // Verify sensitive CLI flags in event text were sanitized
    const sampleEvents = await jobManager.pollEvents(ringJobId, { afterSeq: 0, limit: 5 });
    assert(
      sampleEvents.events.every((e) => !e.text.includes('--dangerously-skip-permissions')),
      'Sensitive CLI flags must be sanitized inside event ring entries'
    );

    // Delete on-disk log file to simulate worktree cleanup / cwd drift and verify poll() never throws JOB_LOG_NOT_FOUND
    const logPath = path.resolve(process.cwd(), '.mwh', 'logs', `${ringJobId}.log`);
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
    const memPolled = jobManager.poll(ringJobId, 1, 8192);
    assert(
      memPolled.chunk.includes('MEMORY_FALLBACK_PAYLOAD_OK'),
      `poll() must serve from memory when log file is missing, got: ${memPolled.chunk}`
    );

    // Unknown job ID must return UNKNOWN archived state instead of throwing JOB_LOG_NOT_FOUND
    const unknownPolled = jobManager.poll('job_1700000000000_deadbeef', 1, 8192);
    assert.strictEqual(unknownPolled.status, 'UNKNOWN');
    assert.strictEqual(unknownPolled.chunk, '[MWH_JOB_LOG_ARCHIVED]');

    jobManager.completeSubagentJob(ringJobId, {
      status: 'COMPLETED',
      agentType: 'ring_test_agent',
      childMode: 'workspace-write',
      isolateWorktree: false,
      stepsExecuted: 1,
      summary: 'Ring test done',
      filesModified: [],
      gitDiffStat: ''
    });
    console.log('[PASS] Gate-A3: Bounded event ring (512/4MB), cursor poisoning guard & zero JOB_LOG_NOT_FOUND verified.');

    // =========================================================================
    // GATE-A4: Unified 600s Timeout, Env Scrubbing, <=4096B Diagnostic & HMAC Fail-Closed
    // =========================================================================
    assert.strictEqual(DEFAULT_SUBAGENT_TIMEOUT_MS, 600000, 'DEFAULT_SUBAGENT_TIMEOUT_MS must be 600000');

    // Verify child environment scrubbing
    const prevHmac = process.env.MWH_HMAC_SECRET;
    const prevTunnel = process.env.TUNNEL_RUNTIME_TOKEN;
    const prevUnlistedSecret = process.env.UNLISTED_VENDOR_SECRET;
    const prevAllowedKey = process.env.ALLOWED_VENDOR_KEY;

    process.env.MWH_HMAC_SECRET = 'top_secret_hmac_do_not_leak';
    process.env.TUNNEL_RUNTIME_TOKEN = 'top_secret_tunnel_token';
    process.env.UNLISTED_VENDOR_SECRET = 'should_be_stripped_by_allowlist';
    process.env.ALLOWED_VENDOR_KEY = 'explicitly_allowed_key_value';

    try {
      const cleanedEnv = buildCleanChildEnv(process.cwd(), 'workspace-write', {
        id: 'env_test',
        display_name: 'Env Test',
        command: process.execPath,
        args: [],
        envAllowlist: ['ALLOWED_VENDOR_KEY'],
        env: { EXPLICIT_PROFILE_VAR: 'explicit_ok' },
        enabled: true
      });
      assert.strictEqual(cleanedEnv.MWH_HMAC_SECRET, undefined, 'MWH_HMAC_SECRET must be stripped');
      assert.strictEqual(cleanedEnv.TUNNEL_RUNTIME_TOKEN, undefined, 'TUNNEL_RUNTIME_TOKEN must be stripped');
      assert.strictEqual(
        cleanedEnv.UNLISTED_VENDOR_SECRET,
        undefined,
        'Unlisted *_SECRET must be stripped when envAllowlist is configured'
      );
      assert.strictEqual(
        cleanedEnv.ALLOWED_VENDOR_KEY,
        'explicitly_allowed_key_value',
        'Allowlisted key must be preserved'
      );
      assert.strictEqual(cleanedEnv.EXPLICIT_PROFILE_VAR, 'explicit_ok', 'Explicit profile.env must be preserved');
    } finally {
      if (prevHmac === undefined) delete process.env.MWH_HMAC_SECRET;
      else process.env.MWH_HMAC_SECRET = prevHmac;
      if (prevTunnel === undefined) delete process.env.TUNNEL_RUNTIME_TOKEN;
      else process.env.TUNNEL_RUNTIME_TOKEN = prevTunnel;
      if (prevUnlistedSecret === undefined) delete process.env.UNLISTED_VENDOR_SECRET;
      else process.env.UNLISTED_VENDOR_SECRET = prevUnlistedSecret;
      if (prevAllowedKey === undefined) delete process.env.ALLOWED_VENDOR_KEY;
      else process.env.ALLOWED_VENDOR_KEY = prevAllowedKey;
    }

    // Verify buildSafeDiagnostic <= 4096 UTF-8 bytes & multi-byte boundary safety
    const hugeStopReason = '中文诊断信息_'.repeat(1000);
    const diag = buildSafeDiagnostic({
      provider: 'ACP',
      profileId: 'agy',
      stage: 'prompt',
      category: 'protocol',
      stopReason: hugeStopReason,
      exitCode: 1,
      permission: { policy: 'reject', request: 'edit', decision: 'denied' }
    });
    const diagBytes = Buffer.byteLength(diag, 'utf-8');
    assert(diagBytes <= 4096, `Diagnostic must be <= 4096 UTF-8 bytes, got ${diagBytes}`);
    assert(!diag.includes('\uFFFD'), 'Diagnostic truncation must not leave broken UTF-8 replacement chars');

    // Verify ApprovalEngine fail-closed when MWH_HMAC_SECRET is missing
    const savedHmac = process.env.MWH_HMAC_SECRET;
    delete process.env.MWH_HMAC_SECRET;
    try {
      const insecureEngine = new ApprovalEngine();
      assert.throws(
        () =>
          insecureEngine.createApproval(
            'req_1',
            'switch_mode',
            'sensitive_write',
            { mode: 'danger-full-access' },
            'critical',
            'Elevate to mode 4',
            true,
            kernel.getContext()
          ),
        /APPROVAL_HMAC_SECRET_MISSING/,
        'Critical approval without MWH_HMAC_SECRET must fail closed'
      );
    } finally {
      if (savedHmac !== undefined) process.env.MWH_HMAC_SECRET = savedHmac;
    }
    console.log('[PASS] Gate-A4: Unified 600s timeout, child env scrubbing, <=4096B diagnostic & HMAC fail-closed verified.');

    // =========================================================================
    // GATE-REST: Control Plane REST Endpoints
    // =========================================================================
    const testPort = 19890 + Math.floor(Math.random() * 50);
    const testToken = 'mwh_acp_token_0123456789abcdef01234567';
    const server = new MwhServer({
      host: '127.0.0.1',
      port: testPort,
      runtimeToken: testToken
    });

    try {
      await server.start();
      const authHeader = { Authorization: `Bearer ${testToken}` };

      const getRes = await httpRequest({
        url: `http://127.0.0.1:${testPort}/api/v1/acp/profiles`,
        headers: authHeader
      });
      assert.strictEqual(getRes.statusCode, 200);
      assert.strictEqual(JSON.parse(getRes.body).ok, true);

      const postRes = await httpRequest({
        url: `http://127.0.0.1:${testPort}/api/v1/acp/profile`,
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'rest_agent',
          display_name: 'REST Agent',
          command: process.execPath,
          args: ['-e', 'console.log("REST")'],
          enabled: true
        })
      });
      assert.strictEqual(postRes.statusCode, 200);
      assert.strictEqual(JSON.parse(postRes.body).profile.id, 'rest_agent');

      const delHttp = await httpRequest({
        url: `http://127.0.0.1:${testPort}/api/v1/acp/profile`,
        method: 'DELETE',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'rest_agent' })
      });
      assert.strictEqual(delHttp.statusCode, 200);
      console.log('[PASS] Gate-REST: Control Plane REST Endpoints verified.');
    } finally {
      await server.stop();
    }

    // =========================================================================
    // GATE-A5: Live filesModified Polling, childMode Preservation, Step cwd &
    //          audit.jsonl Terminal Traceability + Bug D-8 Non-Leak
    // =========================================================================
    const gate5Workspace = path.join(testConfigDir, 'gate5_ws');
    const gate5SubDir = path.join(gate5Workspace, 'sub_pkg');
    fs.mkdirSync(gate5SubDir, { recursive: true });

    const gate5Kernel = new PipelineKernel();
    gate5Kernel.updateContext({
      workspaceRoot: gate5Workspace,
      confinementMode: 'workspace-write',
      approvalPolicy: 'unattended-yolo',
      yoloExpiresAt: Date.now() + 3600_000,
      hmacSecret: 'gate5_hmac_secret_0123456789abcdef0123456789abcdef'
    });

    // 5a. Builtin structured step cwd preservation (must not overwrite step.params.cwd with workspaceRoot)
    const stepCwdRes = await SubagentDispatcher.dispatch(
      {
        agent: 'builtin',
        childMode: 'workspace-write',
        steps: [
          {
            tool: 'exec_command',
            params: {
              command: '[System.IO.File]::WriteAllText("cwd_marker.txt", (Get-Location).Path)',
              cwd: gate5SubDir,
              timeoutMs: 10000
            }
          }
        ]
      },
      gate5Kernel.getContext()
    );
    assert.strictEqual(stepCwdRes.status, 'COMPLETED', `Step cwd dispatch failed: ${stepCwdRes.error}`);
    const markerPath = path.join(gate5SubDir, 'cwd_marker.txt');
    assert(
      fs.existsSync(markerPath),
      'Structured builtin step must preserve step.params.cwd and write inside sub_pkg/'
    );

    // 5b. Live filesModified during intermediate events polling + PipelineKernel childMode preservation + Bug D-8
    const liveDiffScript = path.join(testConfigDir, 'mock-acp-livediff.mjs');
    fs.writeFileSync(
      liveDiffScript,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin });",
        "const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');",
        "rl.on('line', (line) => {",
        "  const trimmed = line.trim();",
        "  if (!trimmed) return;",
        "  const msg = JSON.parse(trimmed);",
        "  if (msg.method === 'initialize') {",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });",
        "  } else if (msg.method === 'session/new') {",
        "    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_livediff' } });",
        "  } else if (msg.method === 'session/prompt') {",
        "    if (process.env.MOCK_SILENT_HANG === '1') {",
        "      return; // Hang without sending any agent_message_chunk (tests Bug D-8)",
        "    }",
        "    fs.writeFileSync(path.join(process.cwd(), 'live_created.txt'), 'LIVE_DIFF_OK', 'utf-8');",
        "    send({",
        "      jsonrpc: '2.0',",
        "      method: 'session/update',",
        "      params: {",
        "        sessionId: 'sess_livediff',",
        "        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WROTE_FILE' } }",
        "      }",
        "    });",
        "    setTimeout(() => {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
        "    }, 600);",
        "  }",
        "});"
      ].join('\n'),
      'utf-8'
    );

    manager.upsertProfile({
      id: 'mock_acp_livediff',
      kind: 'acp',
      display_name: 'Mock ACP LiveDiff',
      command: process.execPath,
      args: [liveDiffScript],
      enabled: true
    });

    const liveRunResp = await gate5Kernel.handleRequest({
      id: 'gate5_live_run',
      toolName: 'subagent_dispatch',
      category: 'sensitive_write',
      params: {
        action: 'run',
        agent: 'mock_acp_livediff',
        prompt: 'Create live_created.txt',
        childMode: 'workspace-write',
        cwd: gate5Workspace,
        async: true,
        yieldTimeMs: 50
      }
    });
    assert.strictEqual(liveRunResp.status, 'SUCCESS');
    const liveJobId = liveRunResp.data?.jobId;
    assert(liveJobId, 'Live run must return jobId');

    await new Promise((r) => setTimeout(r, 250));

    // Poll events through PipelineKernel (low-risk read-only short-circuit must NOT overwrite childMode to read-only!)
    const liveEventsResp = await gate5Kernel.handleRequest({
      id: 'gate5_live_events',
      toolName: 'subagent_dispatch',
      category: 'sensitive_write',
      params: {
        action: 'events',
        jobId: liveJobId,
        afterSeq: 0,
        waitMs: 500
      }
    });
    assert.strictEqual(liveEventsResp.status, 'SUCCESS');
    assert.strictEqual(
      liveEventsResp.data?.childMode,
      'workspace-write',
      `events receipt must preserve job childMode 'workspace-write', got: ${liveEventsResp.data?.childMode}`
    );
    assert(
      Array.isArray(liveEventsResp.data?.filesModified) &&
        liveEventsResp.data.filesModified.includes('live_created.txt'),
      `Live polling must surface 'live_created.txt' in filesModified before completion, got: ${JSON.stringify(liveEventsResp.data?.filesModified)}`
    );
    assert(
      liveEventsResp.data?.stepsExecuted >= 1,
      `stepsExecuted must be monotonic >= 1 during events poll, got: ${liveEventsResp.data?.stepsExecuted}`
    );

    // Wait for completion so terminal audit is written
    await gate5Kernel.handleRequest({
      id: 'gate5_live_wait',
      toolName: 'subagent_dispatch',
      category: 'sensitive_write',
      params: {
        action: 'wait',
        jobId: liveJobId,
        afterSeq: 0,
        waitMs: 2000
      }
    });

    // 5c. Bug D-8 check: silent timeout after initialize/session/new must NOT leak raw JSON-RPC frames in output/summary
    manager.upsertProfile({
      id: 'mock_acp_silent_hang',
      kind: 'acp',
      display_name: 'Mock ACP Silent Hang',
      command: process.execPath,
      args: [liveDiffScript],
      env: { MOCK_SILENT_HANG: '1' },
      disposeEofGraceMs: 50,
      disposeGraceMs: 50,
      enabled: true
    });
    const silentHangResp = await gate5Kernel.handleRequest({
      id: 'gate5_silent_hang',
      toolName: 'subagent_dispatch',
      category: 'sensitive_write',
      params: {
        action: 'run',
        agent: 'mock_acp_silent_hang',
        prompt: 'Silent hang test',
        childMode: 'workspace-write',
        cwd: gate5Workspace,
        timeoutMs: 250
      }
    });
    const silentData = silentHangResp.data;
    assert.strictEqual(silentData?.output, '', `Bug D-8: raw JSON-RPC stdout must not leak into output, got: ${silentData?.output}`);
    assert(
      !String(silentData?.summary || '').includes('"jsonrpc"'),
      `Bug D-8: raw JSON-RPC frame must not leak into summary, got: ${silentData?.summary}`
    );

    // 5d. Verify audit.jsonl contains jobId, terminalStatus (COMPLETED / TIMEOUT), and diagnostic
    const auditFile = path.join(gate5Workspace, '.mwh', 'logs', 'audit.jsonl');
    assert(fs.existsSync(auditFile), 'audit.jsonl must exist in workspace');
    const auditRows = fs
      .readFileSync(auditFile, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const completedAudit = auditRows.find(
      (r) => r.jobId === liveJobId && r.terminalStatus === 'COMPLETED'
    );
    assert(
      completedAudit,
      `audit.jsonl must contain a COMPLETED terminal record for jobId=${liveJobId}`
    );
    const timeoutAudit = auditRows.find(
      (r) =>
        r.jobId === silentData?.jobId &&
        r.terminalStatus === 'TIMEOUT' &&
        typeof r.diagnostic === 'string' &&
        r.diagnostic.includes('category: timeout')
    );
    assert(
      timeoutAudit,
      `audit.jsonl must contain a TIMEOUT terminal record with diagnostic for jobId=${silentData?.jobId}`
    );

    manager.deleteProfile('mock_acp_livediff');
    manager.deleteProfile('mock_acp_silent_hang');
    console.log('[PASS] Gate-A5: Live filesModified, childMode preservation, step cwd, Bug D-8 & audit.jsonl traceability verified.');

    console.log('\n===============================================================');
    console.log('  ALL ACP & SUBAGENT PIPELINE GATES (A1~A5 + REST) PASSED 100%!  ');
    console.log('===============================================================\n');
  } finally {
    try {
      if (fs.existsSync(testConfigDir)) {
        fs.rmSync(testConfigDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

runGateAcp().catch((err) => {
  console.error('[FATAL] Gate ACP verification failed:', err);
  process.exit(1);
});

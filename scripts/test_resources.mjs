#!/usr/bin/env node
/**
 * Minimal, dependency-free verification for the local MCP / Skill resource library.
 *
 * Covers (see the implementation plan, task list 1-4):
 *   1. exposed tool-name sanitization (legal identifiers, never shadow pc_status)
 *   2. enable -> tools appear on the aggregated tool list; disable -> withdrawn
 *   3. fault -> withdrawn while the switch stays on; recovery -> back
 *   4. skill_read: enabled is readable, disabled is rejected, tool appears/disappears
 *   5. scan: read-only against fixtures, newly discovered entries default to disabled,
 *      and a second scan never resets user state
 *
 * Run after `tsc`:  node scripts/test_resources.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ResourcesManager, __setResourcesManagerForTests } from '../dist/resources/manager.js';
import { PipelineKernel } from '../dist/pipeline/pipeline.js';
import { scanLocalResources } from '../dist/resources/scan.js';
import { MAX_EXPOSED_TOOL_NAME_LENGTH, makeExposedToolName } from '../dist/resources/toolNames.js';
import { MUSE_TOOLS, getExposedMuseTools } from '../dist/tools/definitions.js';
import { readSkillContent } from '../dist/resources/skillRead.js';
import { toStandardMcpJson, toStandardSkillsJson } from '../dist/resources/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.stack ? err.stack.split('\n').join('\n        ') : String(err)}`);
  }
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`TIMEOUT waiting for ${label || 'condition'}`);
}

function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out.set(path.relative(root, full), {
          content: fs.readFileSync(full, 'utf-8'),
          mtimeMs: stat.mtimeMs,
          size: stat.size
        });
      }
    }
  };
  walk(root);
  return out;
}

/** Minimal stdio MCP server: initialize / notifications / tools/list / tools/call. */
const FAKE_MCP_SOURCE = `#!/usr/bin/env node
let buffer = '';
process.stdin.setEncoding('utf8');

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
function replyError(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\\n');
}

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' }
      });
    } else if (msg.method === 'notifications/initialized') {
      // notification: no response
    } else if (msg.method === 'tools/list') {
      reply(msg.id, {
        tools: [
          {
            name: 'echo',
            description: 'Echoes the provided text',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
          },
          {
            name: 'crash',
            description: 'Terminates the server to simulate a lost session',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'pc/status lookalike',
            description: 'Illegal characters in the remote tool name',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      });
    } else if (msg.method === 'tools/call') {
      const toolName = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (toolName === 'echo') {
        reply(msg.id, { content: [{ type: 'text', text: String(args.text) }], isError: false });
      } else if (toolName === 'crash') {
        process.exit(1);
      } else if (toolName === 'pc/status lookalike') {
        reply(msg.id, { content: [{ type: 'text', text: 'not pc_status' }], isError: false });
      } else {
        replyError(msg.id, 'unknown tool: ' + toolName);
      }
    } else if (msg.id !== undefined) {
      reply(msg.id, {});
    }
  }
});
`;

async function main() {
  console.log('Resource library tests\n');

  const fakeDir = mkTemp('mwh_res_fake_');
  const fakeMcpPath = path.join(fakeDir, 'fake-mcp.mjs');
  fs.writeFileSync(fakeMcpPath, FAKE_MCP_SOURCE, 'utf-8');

  const workspaceA = mkTemp('mwh_res_ws_a_');
  const manager = new ResourcesManager({
    workspaceRoot: workspaceA,
    homeDir: path.join(workspaceA, 'home'),
    appDataDir: path.join(workspaceA, 'appdata'),
    retryDelaysMs: [700],
    startTimeoutMs: 15000,
    callTimeoutMs: 15000
  });

  const auditEvents = [];
  manager.setAuditSink((event) => auditEvents.push(event));

  // ---------------------------------------------------------------- 1. naming
  await test('exposed tool names are legal identifiers and never shadow built-ins', () => {
    const reserved = new Set(MUSE_TOOLS.map((tool) => tool.name));
    const name = makeExposedToolName('my server/1', 'read file.txt', new Set(reserved));
    assert.match(name, /^[A-Za-z0-9_-]+$/);
    assert.ok(!MUSE_TOOLS.some((tool) => tool.name === name), 'must not shadow a built-in tool');
    assert.ok(name.startsWith('my_server_1_'), `unexpected prefix: ${name}`);

    const clash = makeExposedToolName('pc', 'status', new Set(['pc_status']));
    assert.equal(clash, 'pc_status_2', 'collision must get a numeric suffix, not overwrite pc_status');

    const longOriginal = 'very_long_tool_name_' + 'x'.repeat(200);
    const truncated = makeExposedToolName('server', longOriginal, new Set());
    assert.ok(
      truncated.length <= MAX_EXPOSED_TOOL_NAME_LENGTH,
      `name too long: ${truncated.length}`
    );
    assert.match(truncated, /^[A-Za-z0-9_-]+$/);

    const cjk = makeExposedToolName('server', '读取文件', new Set());
    assert.match(cjk, /^[A-Za-z0-9_-]+$/);
  });

  // ----------------------------------------------- 2. enable / disable exposure
  let mcpEntryId = '';
  await test('enabling a stdio MCP exposes prefixed tools on the aggregated list', async () => {
    const entry = await manager.add({
      kind: 'mcp',
      displayName: 'Fake MCP',
      transport: 'stdio',
      command: process.execPath,
      args: [fakeMcpPath],
      enable: true
    });
    mcpEntryId = entry.id;

    await waitFor(
      () => manager.getStatusSummary().mcp.some((item) => item.status === 'running'),
      20000,
      'fake MCP to become running'
    );

    const serverId = 'fake_mcp';
    const definitions = manager.getExposedToolDefinitions();
    const names = definitions.map((tool) => tool.name);
    assert.ok(names.includes(`${serverId}_echo`), `missing ${serverId}_echo in ${names.join(',')}`);
    assert.ok(names.includes(`${serverId}_crash`));
    // Illegally advertised names are sanitized, never em-dash / slash passthrough.
    assert.ok(names.some((name) => name.startsWith(`${serverId}_pc_status_lookalike`)));

    const exposed = getExposedMuseTools(false, definitions).map((tool) => tool.name);
    assert.ok(exposed.includes(`${serverId}_echo`));
    assert.ok(exposed.includes('pc_status'), 'built-ins still present');
    assert.equal(new Set(exposed).size, exposed.length, 'exposed names must stay unique');

    const echo = definitions.find((tool) => tool.name === `${serverId}_echo`);
    assert.equal(echo.category, 'sensitive_write', 'third-party tools default to sensitive_write');
  });

  await test('third-party tool calls are routed to the owning MCP session', async () => {
    const result = await manager.callTool('fake_mcp_echo', { text: 'hello-resource' });
    assert.equal(result?.content?.[0]?.text, 'hello-resource');
  });

  await test('disabling a server withdraws its tools immediately', async () => {
    await manager.toggle(mcpEntryId, false);
    const names = manager.getExposedToolDefinitions().map((tool) => tool.name);
    assert.ok(!names.some((name) => name.startsWith('fake_mcp_')), `still exposed: ${names.join(',')}`);
    assert.equal(manager.getEntry(mcpEntryId).runtimeStatus, 'stopped');
  });

  // ------------------------------------------------------ 3. fault & recovery
  await test('a fault withdraws tools while the switch stays on, then recovers', async () => {
    await manager.toggle(mcpEntryId, true);
    await waitFor(
      () => manager.getEntry(mcpEntryId).runtimeStatus === 'running',
      20000,
      'server to restart'
    );
    assert.equal(manager.getEntry(mcpEntryId).enabled, true);

    // The fake server exits while the session is live -> fault + retry schedule.
    await assert.rejects(() => manager.callTool('fake_mcp_crash', {}));
    await waitFor(
      () => manager.getEntry(mcpEntryId).runtimeStatus === 'fault',
      5000,
      'fault state after a lost session'
    );
    assert.equal(manager.getEntry(mcpEntryId).enabled, true, 'switch must stay on');
    assert.ok(
      !manager.getExposedToolDefinitions().some((tool) => tool.name === 'fake_mcp_echo'),
      'faulted tools must be withdrawn from tools/list'
    );

    // Bounded retry brings the server (and its tools) back on its own.
    await waitFor(
      () => manager.getExposedToolDefinitions().some((tool) => tool.name === 'fake_mcp_echo'),
      20000,
      'tools to come back after recovery'
    );
    assert.equal(manager.getEntry(mcpEntryId).runtimeStatus, 'running');
  });

  await test('read-only marks downgrade the tool category to read', async () => {
    await manager.update(mcpEntryId, { readonly: true });
    const echo = manager.getExposedToolDefinitions().find((tool) => tool.name === 'fake_mcp_echo');
    assert.ok(echo, 'tool should still be exposed');
    assert.equal(echo.category, 'read');
    await manager.update(mcpEntryId, { readonly: false });
  });

  // ---------------------------------------- 3b. PipelineKernel integration
  await test('third-party tools flow through the unified PipelineKernel tiers', async () => {
    __setResourcesManagerForTests(manager);
    try {
      const planMode = new PipelineKernel({
        workspaceRoot: workspaceA,
        confinementMode: 'read-only',
        approvalPolicy: 'smart-risk'
      });
      const denied = await planMode.handleRequest({
        id: 'res_plan',
        toolName: 'fake_mcp_echo',
        category: 'sensitive_write',
        params: { text: 'blocked' }
      });
      assert.equal(denied.status, 'DENIED');
      assert.match(denied.reason || '', /READ_ONLY_MODE/);

      const confirmMode = new PipelineKernel({
        workspaceRoot: workspaceA,
        confinementMode: 'workspace-write',
        approvalPolicy: 'smart-risk'
      });
      const pending = await confirmMode.handleRequest({
        id: 'res_confirm',
        toolName: 'fake_mcp_echo',
        category: 'sensitive_write',
        params: { text: 'needs-approval' }
      });
      assert.equal(pending.status, 'CONFIRMATION_REQUIRED');
      assert.ok(pending.approvalId, 'confirmation must carry an approval id for the floating island');

      const fullAccess = new PipelineKernel({
        workspaceRoot: workspaceA,
        confinementMode: 'danger-full-access',
        approvalPolicy: 'unattended-yolo',
        yoloExpiresAt: Date.now() + 3600_000
      });
      const ok = await fullAccess.handleRequest({
        id: 'res_auto',
        toolName: 'fake_mcp_echo',
        category: 'sensitive_write',
        params: { text: 'through-kernel' }
      });
      assert.equal(ok.status, 'SUCCESS');
      assert.equal(ok.data?.content?.[0]?.text, 'through-kernel');
    } finally {
      __setResourcesManagerForTests(null);
    }
  });

  // ------------------------------------------------------------- 4. skill_read
  const skillDir = path.join(workspaceA, 'skills', 'review');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    ['---', 'name: review', 'description: Reviews a diff and lists concrete defects.', '---', '', '# Review', '', 'Step 1. Read the diff.'].join('\n'),
    'utf-8'
  );

  let skillEntryId = '';
  await test('skill_read rejects disabled Skills and stays out of tools/list', async () => {
    const entry = await manager.add({
      kind: 'skill',
      displayName: 'review',
      skillDir
    });
    skillEntryId = entry.id;
    assert.equal(entry.enabled, false);
    assert.equal(entry.skillDescription, 'Reviews a diff and lists concrete defects.');

    assert.throws(() => manager.readSkill('review'), /SKILL_NOT_ENABLED/);
    assert.ok(!manager.getExposedToolDefinitions().some((tool) => tool.name === 'skill_read'));
  });

  await test('skill_read returns the full SKILL.md once enabled', async () => {
    await manager.toggle(skillEntryId, true);
    const definitions = manager.getExposedToolDefinitions();
    assert.ok(definitions.some((tool) => tool.name === 'skill_read'));
    const skillRead = definitions.find((tool) => tool.name === 'skill_read');
    assert.equal(skillRead.category, 'read');

    const result = manager.readSkill('review');
    assert.ok(result.content.includes('Step 1. Read the diff.'));
    assert.equal(result.description, 'Reviews a diff and lists concrete defects.');
    assert.ok(!path.isAbsolute(result.path), 'the reported path must be the ~ form');

    const status = manager.getStatusSummary();
    assert.equal(status.skills.length, 1);
    assert.equal(status.skills[0].name, 'review');

    await manager.toggle(skillEntryId, false);
    assert.throws(() => manager.readSkill('review'), /SKILL_NOT_ENABLED/);
  });

  await test('a deleted SKILL.md faults the entry and withdraws skill_read', async () => {
    const dir = path.join(workspaceA, 'skills', 'vanish');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Vanish\n\nTemporary skill.\n', 'utf-8');
    const entry = await manager.add({ kind: 'skill', displayName: 'vanish', skillDir: dir });
    await manager.toggle(entry.id, true);
    assert.ok(manager.getExposedToolDefinitions().some((tool) => tool.name === 'skill_read'));

    fs.unlinkSync(path.join(dir, 'SKILL.md'));
    assert.ok(!manager.getExposedToolDefinitions().some((tool) => tool.name === 'skill_read'));
    assert.equal(manager.getEntry(entry.id).runtimeStatus, 'fault');
    assert.equal(manager.getEntry(entry.id).enabled, true);
    assert.equal(manager.getStatusSummary().skills.length, 0);
    // The switch still counts as enabled (amber row in the UI).
    assert.equal(manager.getStatusSummary().enabledCount, 2); // mcp + faulting skill
    await manager.toggle(entry.id, false);
  });

  // ----------------------------------------------------------------- 5. scan
  await test('scan is read-only, defaults to disabled, and preserves existing state', async () => {
    const fixtureRoot = mkTemp('mwh_res_fixture_');
    const home = path.join(fixtureRoot, 'home');
    const appdata = path.join(fixtureRoot, 'appdata');
    // Kept outside the fixture tree: the registry writes .mwh/ and must not be
    // mistaken for a fixture mutation.
    const workspace = mkTemp('mwh_res_scan_ws_');
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'fixture-skill'), { recursive: true });
    fs.mkdirSync(path.join(appdata, 'Claude'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            fs: { command: 'node', args: ['fs-server.js'] },
            remote: { url: 'http://127.0.0.1:3333/mcp' }
          }
        },
        null,
        2
      ),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(appdata, 'Claude', 'claude_desktop_config.json'),
      JSON.stringify({ mcpServers: { desktop: { command: 'node', args: ['desktop.js'] } } }, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(home, '.claude', 'skills', 'fixture-skill', 'SKILL.md'),
      '# Fixture Skill\n\nA fixture description.\n',
      'utf-8'
    );

    const before = snapshotTree(fixtureRoot);

    const scanManager = new ResourcesManager({
      workspaceRoot: workspace,
      homeDir: home,
      appDataDir: appdata
    });
    scanManager.setAuditSink((event) => auditEvents.push(event));
    const outcome = scanManager.scan();
    assert.ok(outcome.discovered.length >= 4, `expected >=4 entries, got ${outcome.discovered.length}`);
    const allEntries = scanManager.getEntries();
    assert.ok(allEntries.every((entry) => entry.enabled === false), 'scanned entries must default to disabled');
    assert.ok(allEntries.some((entry) => entry.id === 'scan_cursor_remote' && entry.transport === 'http'));
    assert.ok(allEntries.some((entry) => entry.kind === 'skill' && entry.displayName === 'fixture-skill'));

    const after = snapshotTree(fixtureRoot);
    assert.equal(after.size, before.size, 'scan must not create or delete fixture files');
    for (const [rel, snapshot] of before) {
      const current = after.get(rel);
      assert.ok(current, `fixture file disappeared: ${rel}`);
      assert.equal(current.content, snapshot.content, `fixture file rewritten: ${rel}`);
      assert.equal(current.mtimeMs, snapshot.mtimeMs, `fixture file touched: ${rel}`);
    }

    // Second scan: no duplicates, no reset of user changes (enabled + renamed).
    const skillEntry = scanManager.getEntries().find((entry) => entry.displayName === 'fixture-skill');
    assert.ok(skillEntry);
    await scanManager.toggle(skillEntry.id, true);
    await scanManager.update(skillEntry.id, { displayName: 'renamed-fixture' });
    const countBefore = scanManager.getEntries().length;
    const second = scanManager.scan();
    assert.equal(second.added.length, 0, 'rescan must not add duplicates');
    assert.equal(scanManager.getEntries().length, countBefore);
    const preserved = scanManager.getEntry(skillEntry.id);
    assert.equal(preserved.enabled, true, 'rescan must not disable an enabled entry');
    assert.equal(preserved.displayName, 'renamed-fixture', 'rescan must not reset a user rename');

    // The catalogue lives in .mwh and only references secret keys, never values.
    const registryFile = path.join(workspace, '.mwh', 'resources.json');
    assert.ok(fs.existsSync(registryFile), 'registry must be persisted under .mwh');
    const registryText = fs.readFileSync(registryFile, 'utf-8');
    assert.ok(registryText.includes('mwh-resources/v1'));

    // Enabled Skill is also projected to the standard skills.json pointer file.
    const skillsFile = path.join(workspace, '.mwh', 'skills.json');
    assert.ok(fs.existsSync(skillsFile), 'enabled Skills must be projected to .mwh/skills.json');
    const skillsJson = JSON.parse(fs.readFileSync(skillsFile, 'utf-8'));
    const skillPaths = Object.values(skillsJson.skills || {}).map((item) => item.path);
    assert.ok(
      skillPaths.includes(preserved.skillDir),
      `enabled Skill path missing from skills.json: ${JSON.stringify(skillsJson)}`
    );
    const mcpJson = JSON.parse(fs.readFileSync(path.join(workspace, '.mwh', 'mcp.json'), 'utf-8'));
    assert.ok(mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object');
    assert.ok(!JSON.stringify(mcpJson).toLowerCase().includes('dpapi'), 'mcp.json must not contain secrets');

    scanManager.disposeAll();
    rmrf(fixtureRoot);
    rmrf(workspace);
  });

  // Direct scanner reuse must agree with the manager's view (pure function).
  await test('scanLocalResources returns only disabled entries', () => {
    const fixtureRoot = mkTemp('mwh_res_direct_');
    const home = path.join(fixtureRoot, 'home');
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'node', args: ['a.js'] } } }),
      'utf-8'
    );
    const outcome = scanLocalResources({ workspaceRoot: fixtureRoot, homeDir: home, appDataDir: path.join(fixtureRoot, 'appdata') });
    assert.equal(outcome.discovered.length, 1);
    assert.equal(outcome.discovered[0].enabled, false);
    assert.equal(outcome.discovered[0].readonly, false);
    rmrf(fixtureRoot);
  });

  // -------------------------------------- 5b. standard mcp.json / skills.json
  await test('toStandardMcpJson emits Claude/Cursor-shaped mcpServers without secrets', () => {
    const used = toStandardMcpJson([
      {
        id: 'off',
        kind: 'mcp',
        displayName: 'Off Server',
        enabled: false,
        source: 'manual',
        sourceLabel: '手动添加',
        readonly: false,
        transport: 'stdio',
        command: 'C:\\hidden\\mcp.exe',
        args: ['serve']
      },
      {
        id: 'stdio1',
        kind: 'mcp',
        displayName: 'Windows-MCP',
        enabled: true,
        source: 'manual',
        sourceLabel: '手动添加',
        readonly: false,
        transport: 'stdio',
        command: 'C:\\tools\\windows-mcp.exe',
        args: ['serve'],
        cwd: 'C:\\tools',
        envSecretKeys: ['API_TOKEN']
      },
      {
        id: 'http1',
        kind: 'mcp',
        displayName: 'Local HTTP',
        enabled: true,
        source: 'manual',
        sourceLabel: '手动添加',
        readonly: false,
        transport: 'http',
        httpUrl: 'http://127.0.0.1:8000/mcp',
        httpHeaderSecretKey: 'http1::headers'
      }
    ]);
    assert.deepEqual(Object.keys(used.mcpServers).sort(), ['Local-HTTP', 'Windows-MCP']);
    assert.deepEqual(used.mcpServers['Windows-MCP'], {
      command: 'C:\\tools\\windows-mcp.exe',
      args: ['serve'],
      cwd: 'C:\\tools'
    });
    assert.deepEqual(used.mcpServers['Local-HTTP'], { url: 'http://127.0.0.1:8000/mcp' });
    const dumped = JSON.stringify(used);
    assert.ok(!dumped.includes('API_TOKEN'), 'env secret key names must not appear in mcp.json');
    assert.ok(!dumped.includes('headers'), 'header secret refs must not appear in mcp.json');
    assert.ok(!dumped.includes('Off Server') && !dumped.includes('hidden'), 'disabled MCP must be omitted');
  });

  await test('enabling projects a standard mcp.json and disabling withdraws it', async () => {
    const workspace = mkTemp('mwh_res_std_');
    const skillDir = path.join(workspace, 'a-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# A\n\nA fixture skill.\n', 'utf-8');

    const mgr = new ResourcesManager({
      workspaceRoot: workspace,
      homeDir: path.join(workspace, 'home'),
      appDataDir: path.join(workspace, 'appdata'),
      retryDelaysMs: [700],
      startTimeoutMs: 15000,
      callTimeoutMs: 15000
    });

    await mgr.add({
      kind: 'mcp',
      displayName: 'Idle Server',
      transport: 'stdio',
      command: process.execPath,
      args: ['--version'],
      enable: false
    });
    let mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.mwh', 'mcp.json'), 'utf-8'));
    assert.deepEqual(mcp.mcpServers, {}, 'disabled MCP must not appear in mcp.json');

    const running = await mgr.add({
      kind: 'mcp',
      displayName: 'Fake MCP',
      transport: 'stdio',
      command: process.execPath,
      args: [fakeMcpPath],
      enable: true
    });
    await waitFor(
      () => mgr.getStatusSummary().mcp.some((item) => item.id === running.id && item.status === 'running'),
      20000,
      'projected fake MCP to become running'
    );
    mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.mwh', 'mcp.json'), 'utf-8'));
    const server = mcp.mcpServers['Fake-MCP'] || mcp.mcpServers[Object.keys(mcp.mcpServers)[0]];
    assert.ok(server, `expected a stdio server in ${JSON.stringify(mcp)}`);
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [fakeMcpPath]);
    assert.ok(!('env' in server), 'mcp.json must not carry env secrets');

    const skill = await mgr.add({
      kind: 'skill',
      displayName: 'a-skill',
      skillDir,
      enable: true
    });
    const skills = JSON.parse(fs.readFileSync(path.join(workspace, '.mwh', 'skills.json'), 'utf-8'));
    assert.equal(skills.skills['a-skill'].path, path.resolve(skillDir));

    await mgr.toggle(running.id, false);
    mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.mwh', 'mcp.json'), 'utf-8'));
    assert.deepEqual(mcp.mcpServers, {}, 'disabled MCP must be withdrawn from mcp.json');
    await mgr.toggle(skill.id, false);
    const skillsOff = JSON.parse(fs.readFileSync(path.join(workspace, '.mwh', 'skills.json'), 'utf-8'));
    assert.deepEqual(skillsOff.skills, {}, 'disabled Skill must be withdrawn from skills.json');

    mgr.disposeAll();
    rmrf(workspace);
  });

  await test('mcp.json alone can bootstrap the catalogue', () => {
    const workspace = mkTemp('mwh_res_boot_');
    fs.mkdirSync(path.join(workspace, '.mwh'), { recursive: true });
    const command = 'C:\\tools\\windows-mcp.exe';
    fs.writeFileSync(
      path.join(workspace, '.mwh', 'mcp.json'),
      JSON.stringify({ mcpServers: { 'Windows-MCP': { command, args: ['serve'] } } }),
      'utf-8'
    );
    const mgr = new ResourcesManager({
      workspaceRoot: workspace,
      homeDir: path.join(workspace, 'home'),
      appDataDir: path.join(workspace, 'appdata')
    });
    const entries = mgr.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].displayName, 'Windows-MCP');
    assert.equal(entries[0].enabled, true);
    assert.equal(entries[0].command, command);
    assert.deepEqual(entries[0].args, ['serve']);
    mgr.disposeAll();
    rmrf(workspace);
  });

  // ---------------------------------------------------------------- 6. audits
  await test('resource mutations are audited', () => {
    const tools = new Set(auditEvents.map((event) => event.toolName));
    for (const expected of ['resources_add', 'resources_toggle', 'resources_update', 'resources_scan']) {
      assert.ok(tools.has(expected), `missing audit event: ${expected}`);
    }
  });

  await test('skill_read refuses paths outside the recorded directory', () => {
    const outside = mkTemp('mwh_res_outside_');
    assert.throws(
      () =>
        readSkillContent({
          id: 'x',
          kind: 'skill',
          displayName: 'x',
          enabled: true,
          source: 'manual',
          sourceLabel: '手动添加',
          readonly: true,
          skillDir: path.join(outside, 'missing')
        }),
      /SKILL_NOT_AVAILABLE/
    );
    rmrf(outside);
  });

  manager.disposeAll();
  rmrf(workspaceA);
  rmrf(fakeDir);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});

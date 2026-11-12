#!/usr/bin/env node
/**
 * MWH Smart Domain-Routed Verification Runner
 *
 * Governance goals:
 *   1. Auto-build guard: compares newest mtime in `src/` against `dist/cli.js`
 *      and runs local TypeScript (`node_modules/typescript/bin/tsc`) via
 *      `process.execPath` whenever `dist/` is missing or stale — eliminating
 *      the "edited src/ but ran gates against stale dist/" hazard and bypassing
 *      broken global npm.cmd shims.
 *   2. Change-domain routing: maps `git status --porcelain` / `git diff` touched
 *      paths to the minimal sufficient verification suites so routine edits do
 *      not require blind full-suite runs.
 *
 * Usage:
 *   node scripts/verify.mjs                   # auto-select suites from git diff
 *   node scripts/verify.mjs --scope ui        # UI / shell / docs contract only
 *   node scripts/verify.mjs --scope network   # network + tunnel + p3 negative
 *   node scripts/verify.mjs --scope pipeline  # path fence + approval + p1/p2/p3
 *   node scripts/verify.mjs --scope acp       # executors + ACP + gate2/gate4/gateAcp
 *   node scripts/verify.mjs --scope all       # all non-E2E suites
 *   node scripts/verify.mjs --e2e             # include gate5 Electron E2E
 *   node scripts/verify.mjs --list            # dry-run: print selected suites only
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const LIST_ONLY = args.includes('--list');
const INCLUDE_E2E = args.includes('--e2e');
const FORCE_BUILD = args.includes('--build');
const scopeIdx = args.indexOf('--scope');
const EXPLICIT_SCOPE = scopeIdx !== -1 ? String(args[scopeIdx + 1] || '').toLowerCase() : '';

const SUITES = {
  'ui-contract': {
    id: 'ui-contract',
    label: 'UI & Shell & Docs Contract (scripts/test_ui_contract.mjs)',
    script: path.join(root, 'scripts', 'test_ui_contract.mjs'),
    needsDist: false
  },
  'negative-p1': {
    id: 'negative-p1',
    label: 'Negative Security P1 — Approval & HMAC (scripts/negative_test_p1.mjs)',
    script: path.join(root, 'scripts', 'negative_test_p1.mjs'),
    needsDist: true
  },
  'negative-p2': {
    id: 'negative-p2',
    label: 'Negative Security P2 — Path Fence & Job Containment (scripts/negative_test_p2.mjs)',
    script: path.join(root, 'scripts', 'negative_test_p2.mjs'),
    needsDist: true
  },
  'negative-p3': {
    id: 'negative-p3',
    label: 'Negative Security P3 — Auth, Tunnel, Subagent & Matrix (scripts/negative_test_p3.mjs)',
    script: path.join(root, 'scripts', 'negative_test_p3.mjs'),
    needsDist: true
  },
  gate1: {
    id: 'gate1',
    label: 'Gate 1 — Path Guard, Job Object & Git Checkpoint (dist/gates/gate1.js)',
    script: path.join(root, 'dist', 'gates', 'gate1.js'),
    needsDist: true
  },
  gate2: {
    id: 'gate2',
    label: 'Gate 2 — Confinement Modes & Approval Engine (dist/gates/gate2.js)',
    script: path.join(root, 'dist', 'gates', 'gate2.js'),
    needsDist: true
  },
  gate3: {
    id: 'gate3',
    label: 'Gate 3 — HTTP/MCP Gateway, Auth & Tunnels (dist/gates/gate3.js)',
    script: path.join(root, 'dist', 'gates', 'gate3.js'),
    needsDist: true
  },
  gate4: {
    id: 'gate4',
    label: 'Gate 4 — Memory, Mobile HMAC, Mode 3 ACL & Delivery (dist/gates/gate4.js)',
    script: path.join(root, 'dist', 'gates', 'gate4.js'),
    needsDist: true
  },
  'gate:acp': {
    id: 'gate:acp',
    label: 'Gate ACP — ACP JSON-RPC 2.0 & Subagent Lifecycle (dist/gates/gateAcp.js)',
    script: path.join(root, 'dist', 'gates', 'gateAcp.js'),
    needsDist: true
  },
  gate5: {
    id: 'gate5',
    label: 'Gate 5 — Full Desktop Shell & Control Plane E2E (scripts/gate5_ui_e2e.mjs)',
    script: path.join(root, 'scripts', 'gate5_ui_e2e.mjs'),
    needsDist: true
  }
};

function newestMtimeMs(dir) {
  if (!fs.existsSync(dir)) return 0;
  let max = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(full);
      if (sub > max) max = sub;
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > max) max = mtime;
    }
  }
  return max;
}

function isDistStale() {
  const distCli = path.join(root, 'dist', 'cli.js');
  if (!fs.existsSync(distCli)) return true;
  const distMtime = fs.statSync(distCli).mtimeMs;
  const srcNewest = newestMtimeMs(path.join(root, 'src'));
  return srcNewest > distMtime;
}

function ensureBuilt(force = false) {
  if (!force && !isDistStale()) {
    console.log('[verify] dist/ is up-to-date with src/.');
    return;
  }
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  console.log('[verify] Compiling TypeScript (src/ -> dist/)...');
  execFileSync(process.execPath, [tscBin, '-p', path.join(root, 'tsconfig.json')], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  });
}

function getChangedFiles() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

function selectSuitesFromScope(scope) {
  switch (scope) {
    case 'ui':
      return ['ui-contract'];
    case 'network':
      return ['ui-contract', 'negative-p3', 'gate3'];
    case 'pipeline':
      return ['negative-p1', 'negative-p2', 'negative-p3', 'gate1', 'gate2'];
    case 'acp':
      return ['negative-p2', 'negative-p3', 'gate2', 'gate4', 'gate:acp'];
    case 'negative':
      return ['negative-p1', 'negative-p2', 'negative-p3'];
    case 'kernel':
      return ['gate1', 'gate2', 'gate3', 'gate4', 'gate:acp'];
    case 'all':
      return [
        'ui-contract',
        'negative-p1',
        'negative-p2',
        'negative-p3',
        'gate1',
        'gate2',
        'gate3',
        'gate4',
        'gate:acp',
        ...(INCLUDE_E2E ? ['gate5'] : [])
      ];
    default:
      throw new Error(`Unknown --scope '${scope}'. Supported: ui | network | pipeline | acp | negative | kernel | all`);
  }
}

function selectSuitesFromDiff(changedFiles) {
  if (changedFiles.length === 0) {
    return ['ui-contract', 'negative-p3'];
  }
  const selected = new Set(['ui-contract']);
  for (const file of changedFiles) {
    if (
      file.startsWith('src/network/') ||
      file.startsWith('src/security/') ||
      file === 'src/cli.ts' ||
      file === 'scripts/doctor.mjs' ||
      file === 'scripts/negative_test_p3.mjs'
    ) {
      selected.add('negative-p3');
      selected.add('gate3');
    }
    if (
      file.startsWith('src/pipeline/') ||
      file.startsWith('src/tools/') ||
      file === 'src/types.ts' ||
      file === 'scripts/negative_test_p1.mjs' ||
      file === 'scripts/negative_test_p2.mjs'
    ) {
      selected.add('negative-p1');
      selected.add('negative-p2');
      selected.add('negative-p3');
      selected.add('gate1');
    }
    if (
      file.startsWith('src/executors/') ||
      file.startsWith('src/subagents/') ||
      file.startsWith('src/config/')
    ) {
      selected.add('negative-p2');
      selected.add('negative-p3');
      selected.add('gate:acp');
    }
    if (file === 'src/gates/gate1.ts') selected.add('gate1');
    if (file === 'src/gates/gate2.ts') selected.add('gate2');
    if (file === 'src/gates/gate3.ts') selected.add('gate3');
    if (file === 'src/gates/gate4.ts') selected.add('gate4');
    if (file === 'src/gates/gateAcp.ts') selected.add('gate:acp');
    if (file === 'scripts/gate5_ui_e2e.mjs' && INCLUDE_E2E) selected.add('gate5');
  }
  if (INCLUDE_E2E) selected.add('gate5');
  return [...selected];
}

const changedFiles = getChangedFiles();
const suiteIds = EXPLICIT_SCOPE
  ? selectSuitesFromScope(EXPLICIT_SCOPE)
  : selectSuitesFromDiff(changedFiles);

console.log('===============================================================');
console.log('  MWH SMART VERIFICATION ROUTER');
console.log(`  Mode: ${EXPLICIT_SCOPE ? `explicit (--scope ${EXPLICIT_SCOPE})` : `git-diff routed (${changedFiles.length} touched files)`}`);
console.log(`  Selected Suites (${suiteIds.length}): ${suiteIds.join(', ')}`);
console.log('===============================================================');

if (LIST_ONLY) {
  for (const id of suiteIds) {
    console.log(`  - ${id}: ${SUITES[id].label}`);
  }
  process.exit(0);
}

const anyNeedsDist = suiteIds.some((id) => SUITES[id]?.needsDist);
if (anyNeedsDist || FORCE_BUILD) {
  ensureBuilt(FORCE_BUILD);
}

const summary = [];
for (const id of suiteIds) {
  const suite = SUITES[id];
  if (!suite) continue;
  console.log(`\n>>> [RUN] ${suite.label}`);
  const start = Date.now();
  try {
    execFileSync(process.execPath, [suite.script], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true
    });
    const elapsedMs = Date.now() - start;
    summary.push({ id, passed: true, elapsedMs });
  } catch (err) {
    const elapsedMs = Date.now() - start;
    summary.push({ id, passed: false, elapsedMs, error: err?.message || String(err) });
  }
}

console.log('\n===============================================================');
for (const item of summary) {
  console.log(`  [${item.passed ? 'PASS' : 'FAIL'}] ${item.id} (${(item.elapsedMs / 1000).toFixed(2)}s)`);
}
console.log('===============================================================');

if (summary.some((s) => !s.passed)) {
  process.exit(1);
}
process.exit(0);

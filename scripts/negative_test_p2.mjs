/**
 * P2 Negative Security Test Suite (Path Fence & Process Containment Hardening)
 * Run: node scripts/negative_test_p2.mjs  (requires `npm run build` beforehand)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkPathAccess } from '../dist/pipeline/pathGuard.js';
import { FsTools } from '../dist/tools/fsTools.js';
import { GitCheckpointManager } from '../dist/pipeline/gitCheckpoint.js';
import { JobManager } from '../dist/executors/jobManager.js';
import { PipelineKernel } from '../dist/pipeline/pipeline.js';

const results = [];

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg || 'Assertion failed');
  }
}

function isSubPathLexical(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function expectThrowAsync(fn, code) {
  return (async () => {
    try {
      await fn();
    } catch (err) {
      if (!String(err?.message).includes(code)) {
        throw new Error(`Expected error containing '${code}', got: ${err?.message}`);
      }
      return err.message;
    }
    throw new Error(`Expected error containing '${code}' but nothing was thrown`);
  })();
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
// Case 1: dangling junction -> realpath failure is rejected (PATH_REALPATH_FAILED)
// ---------------------------------------------------------------------------
await runCase('C1 dangling junction realpath failure rejected (PATH_REALPATH_FAILED)', () => {
  const ws = tmpDir('mwh_p2_c1_');
  const dangling = path.join(ws, 'dangling_junction');
  fs.symlinkSync(path.join(ws, 'no_such_target_dir'), dangling, 'junction');

  const res = checkPathAccess(dangling, 'write', 'workspace-write', ws);
  assert(res.allowed === false, `dangling junction must be rejected, got ${JSON.stringify(res)}`);
  assert(
    String(res.reason).includes('PATH_REALPATH_FAILED'),
    `reason must mention PATH_REALPATH_FAILED, got: ${res.reason}`
  );
});

// ---------------------------------------------------------------------------
// Case 2: in-workspace junction pointing outside -> glob/grep skip it and its
// content never leaks (skippedOutOfBounds >= 1)
// ---------------------------------------------------------------------------
await runCase('C2 junction escape skipped in glob/grep, content not leaked (skippedOutOfBounds>=1)', () => {
  const ws = tmpDir('mwh_p2_c2_');
  const extDir = tmpDir('mwh_p2_c2_ext_');
  fs.writeFileSync(path.join(extDir, 'secret.txt'), 'TOP_SECRET_P2_CONTENT');
  fs.writeFileSync(path.join(ws, 'inside_ok.txt'), 'INSIDE_CONTENT');

  const junction = path.join(ws, 'evil_junction');
  fs.symlinkSync(extDir, junction, 'junction');

  // glob: the junction child must be fenced out
  const glob = FsTools.explore({ action: 'glob', path: ws, pattern: '*.txt' }, ws, 'workspace-write');
  assert(glob.skippedOutOfBounds >= 1, `glob must report skippedOutOfBounds>=1, got ${JSON.stringify(glob)}`);
  assert(
    glob.matches.includes(path.join(ws, 'inside_ok.txt')),
    'in-workspace match must still be returned'
  );
  assert(
    glob.matches.every((m) => isSubPathLexical(m, ws)),
    `no match may escape the workspace, got: ${JSON.stringify(glob.matches)}`
  );

  // grep: secret content outside must not leak
  const grep = FsTools.explore(
    { action: 'grep', path: ws, pattern: 'TOP_SECRET_P2_CONTENT' },
    ws,
    'workspace-write'
  );
  assert(grep.skippedOutOfBounds >= 1, `grep must report skippedOutOfBounds>=1, got ${JSON.stringify(grep)}`);
  assert(grep.matches.length === 0, `secret content must not leak, got ${JSON.stringify(grep.matches)}`);
  assert(
    !JSON.stringify(grep).includes(extDir),
    'external directory path must not appear in grep results'
  );
});

// ---------------------------------------------------------------------------
// Case 3: trailing-space / trailing-dot components are rejected
// ---------------------------------------------------------------------------
await runCase('C3 trailing space/dot components rejected (PATH_SUSPICIOUS_COMPONENT)', () => {
  const ws = tmpDir('mwh_p2_c3_');
  for (const name of ['foo. ', 'foo.', '.env ']) {
    const res = checkPathAccess(path.join(ws, name), 'write', 'workspace-write', ws);
    assert(res.allowed === false, `'${name}' must be rejected, got ${JSON.stringify(res)}`);
    assert(
      String(res.reason).includes('PATH_SUSPICIOUS_COMPONENT'),
      `'${name}' reason must mention PATH_SUSPICIOUS_COMPONENT, got: ${res.reason}`
    );
  }
  // sanity: plain '.env' is blocked by the sensitive blacklist
  const env = checkPathAccess(path.join(ws, '.env'), 'write', 'workspace-write', ws);
  assert(env.allowed === false, "'.env' must be blocked by the blacklist");
  assert(String(env.reason).includes('SENSITIVE_BLACKLIST'), `got: ${env.reason}`);
});

// ---------------------------------------------------------------------------
// Case 4: exec_command cwd outside workspace -> EXEC_CWD_OUT_OF_WORKSPACE
// (danger-full-access bypasses the fence)
// ---------------------------------------------------------------------------
await runCase('C4 exec cwd outside workspace rejected (EXEC_CWD_OUT_OF_WORKSPACE)', async () => {
  const ws = tmpDir('mwh_p2_c4_');
  const outside = tmpDir('mwh_p2_c4_out_');
  const jm = JobManager.getInstance();

  await expectThrowAsync(
    () => jm.executeCommand({ command: 'whoami', cwd: outside, workspaceRoot: ws }),
    'EXEC_CWD_OUT_OF_WORKSPACE'
  );

  // explicit 'workspace-write' is fenced as well
  await expectThrowAsync(
    () =>
      jm.executeCommand({
        command: 'whoami',
        cwd: outside,
        workspaceRoot: ws,
        confinementMode: 'workspace-write'
      }),
    'EXEC_CWD_OUT_OF_WORKSPACE'
  );

  // danger-full-access skips the cwd fence (positive control)
  const full = await jm.executeCommand({
    command: 'echo P2_FULLACCESS_OK',
    cwd: outside,
    workspaceRoot: ws,
    confinementMode: 'danger-full-access'
  });
  assert(
    full.completedInline === true && String(full.data.stdout).includes('P2_FULLACCESS_OK'),
    `danger-full-access cwd outside workspace should execute, got ${JSON.stringify(full.data)}`
  );
});

// ---------------------------------------------------------------------------
// Case 5: jobId traversal ('../x') rejected on every entry point
// ---------------------------------------------------------------------------
await runCase('C5 jobId traversal rejected (JOB_INVALID_ID)', () => {
  const ws = tmpDir('mwh_p2_c5_');
  const jm = JobManager.getInstance();

  expectThrowSync(() => jm.poll('../x', 1, 8192, ws), 'JOB_INVALID_ID');
  expectThrowSync(() => jm.poll('job_../../evil', 1, 8192, ws), 'JOB_INVALID_ID');
  expectThrowSync(() => jm.writeStdin('../x', 'hi'), 'JOB_INVALID_ID');
  expectThrowSync(() => jm.abort('../x'), 'JOB_INVALID_ID');
  expectThrowSync(() => jm.getJob('../x'), 'JOB_INVALID_ID');
  expectThrowSync(() => jm.getJob('job_bad dash'), 'JOB_INVALID_ID');
});

// ---------------------------------------------------------------------------
// Case 6: checkpointId traversal rejected (CHECKPOINT_INVALID_ID)
// ---------------------------------------------------------------------------
await runCase('C6 checkpointId traversal rejected (CHECKPOINT_INVALID_ID)', () => {
  const ws = tmpDir('mwh_p2_c6_');
  expectThrowSync(() => GitCheckpointManager.rollback('chk_../../evil', ws), 'CHECKPOINT_INVALID_ID');
  expectThrowSync(() => GitCheckpointManager.rollback('chk_..', ws), 'CHECKPOINT_INVALID_ID');
  expectThrowSync(() => GitCheckpointManager.rollback('not_a_chk_id', ws), 'CHECKPOINT_INVALID_ID');
});

// ---------------------------------------------------------------------------
// Case 7: Mode 3 switch fails closed (MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED)
// and the confinement mode stays unchanged
// ---------------------------------------------------------------------------
await runCase('C7 Mode 3 switch fails closed, mode unchanged (MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED)', async () => {
  const ws = tmpDir('mwh_p2_c7_');
  const kernel = new PipelineKernel({
    confinementMode: 'workspace-write',
    approvalPolicy: 'always-ask',
    workspaceRoot: ws
  });

  const req = {
    toolName: 'switch_mode',
    category: 'sensitive_write',
    params: { mode: 'workspace-acl-experimental' }
  };

  const r1 = await kernel.handleRequest({ id: 'c7_r1', ...req });
  assert(
    r1.status === 'CONFIRMATION_REQUIRED',
    `expected CONFIRMATION_REQUIRED first, got ${r1.status}`
  );
  const approvalId = r1.approvalId;

  const approveRes = await kernel.handleRequest({
    id: 'c7_approve',
    toolName: 'job_control',
    category: 'write',
    params: { action: 'approve', approvalId }
  });
  assert(approveRes.status === 'SUCCESS', `approve should succeed, got ${JSON.stringify(approveRes)}`);

  const r2 = await kernel.handleRequest({ id: 'c7_r2', approvalId, ...req });
  assert(r2.status === 'ERROR', `Mode 3 switch must fail with ERROR, got ${r2.status} ${JSON.stringify(r2)}`);
  assert(
    String(r2.error || '').includes('MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED'),
    `error must mention MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED, got: ${r2.error}`
  );
  assert(
    kernel.getContext().confinementMode === 'workspace-write',
    `confinement mode must stay workspace-write, got ${kernel.getContext().confinementMode}`
  );

  // sanity: switching to workspace-write still works (fail-closed is Mode 3 only)
  const r3 = await kernel.handleRequest({
    id: 'c7_r3',
    toolName: 'switch_mode',
    category: 'sensitive_write',
    params: { mode: 'workspace-write' }
  });
  assert(r3.status !== 'ERROR', `plain mode switch should not be affected, got ${JSON.stringify(r3)}`);
});

// ---------------------------------------------------------------------------
// Case 8: poll page boundaries never split multi-byte UTF-8 characters
// ---------------------------------------------------------------------------
await runCase('C8 poll page boundary preserves multi-byte UTF-8 (no U+FFFD, lossless)', () => {
  const ws = tmpDir('mwh_p2_c8_');
  const logDir = path.join(ws, '.mwh', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const jobId = 'job_p2utf8bnd1';
  const logPath = path.join(logDir, `${jobId}.log`);

  // '中' (3 bytes) straddles the 8192-byte page boundary: bytes 8190..8193.
  const content = 'A'.repeat(8190) + '中' + 'B'.repeat(100) + '尾字符测试';
  fs.writeFileSync(logPath, Buffer.from(content, 'utf-8'));

  const jm = JobManager.getInstance();
  const page1 = jm.poll(jobId, 1, 8192, ws);
  const page2 = jm.poll(jobId, 2, 8192, ws);

  assert(page1.totalPages === 2, `expected 2 pages, got ${page1.totalPages}`);
  assert(!page1.chunk.includes('\uFFFD'), `page1 contains U+FFFD: ${JSON.stringify(page1.chunk.slice(-10))}`);
  assert(!page2.chunk.includes('\uFFFD'), `page2 contains U+FFFD: ${JSON.stringify(page2.chunk.slice(0, 10))}`);
  assert(
    page1.chunk + page2.chunk === content,
    'page1+page2 concatenation must reproduce the original content losslessly'
  );
  assert(page2.chunk.startsWith('中'), 'page2 must start with the straddling character');

  // multi-page Chinese log: every page stays clean
  const jobId2 = 'job_p2utf8bnd2';
  const content2 = '中文内容重复。'.repeat(2000); // 7 chars * 3+ bytes each * 2000
  fs.writeFileSync(path.join(logDir, `${jobId2}.log`), Buffer.from(content2, 'utf-8'));
  let joined = '';
  const first = jm.poll(jobId2, 1, 8192, ws);
  for (let p = 1; p <= first.totalPages; p++) {
    const pg = jm.poll(jobId2, p, 8192, ws);
    assert(!pg.chunk.includes('\uFFFD'), `page ${p} contains U+FFFD`);
    joined += pg.chunk;
  }
  assert(joined === content2, 'multi-page concatenation must be lossless');
});

// ---------------------------------------------------------------------------
// Case 9: pre-mutation snapshot failure -> write rejected (fail-closed)
// ---------------------------------------------------------------------------
await runCase('C9 snapshot failure rejects the mutation (CHECKPOINT_SNAPSHOT_FAILED)', () => {
  const ws = tmpDir('mwh_p2_c9_');
  // Sabotage: '.mwh/checkpoints' exists as a FILE, so snapshot creation fails.
  fs.mkdirSync(path.join(ws, '.mwh'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.mwh', 'checkpoints'), 'not a directory');

  const victim = path.join(ws, 'victim.txt');
  expectThrowSync(
    () => FsTools.mutate({ action: 'write', path: victim, content: 'SHOULD_NOT_BE_WRITTEN' }, ws),
    'CHECKPOINT_SNAPSHOT_FAILED'
  );
  assert(!fs.existsSync(victim), 'the write must be rejected — no file may be created');

  // edit on an existing file must equally be rejected
  fs.writeFileSync(path.join(ws, 'existing.txt'), 'ORIGINAL');
  expectThrowSync(
    () =>
      FsTools.mutate(
        { action: 'edit', path: path.join(ws, 'existing.txt'), oldText: 'ORIGINAL', newText: 'TAMPERED' },
        ws
      ),
    'CHECKPOINT_SNAPSHOT_FAILED'
  );
  assert(
    fs.readFileSync(path.join(ws, 'existing.txt'), 'utf-8') === 'ORIGINAL',
    'existing file must remain untouched after snapshot failure'
  );
});

// ---------------------------------------------------------------------------
// Case 10: pagination clamping and jobId validation unit assertions
// ---------------------------------------------------------------------------
await runCase('C10 pagination clamping + jobId validation unit assertions', () => {
  const ws = tmpDir('mwh_p2_c10_');
  const logDir = path.join(ws, '.mwh', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const jobId = 'job_p2pages0001';
  fs.writeFileSync(path.join(logDir, `${jobId}.log`), 'x'.repeat(10000), 'utf-8');

  const jm = JobManager.getInstance();
  const clamped = jm.poll(jobId, 1, 100000, ws); // pageSize clamps to 8192
  assert(clamped.totalPages === 2, `pageSize clamp: expected 2 pages, got ${clamped.totalPages}`);
  assert(clamped.chunk.length === 8192, `page1 chunk length expected 8192, got ${clamped.chunk.length}`);

  const far = jm.poll(jobId, 999, 8192, ws); // page clamps to totalPages
  assert(far.page === 2, `page clamp: expected 2, got ${far.page}`);
  const zero = jm.poll(jobId, 0, 8192, ws); // page clamps up to 1
  assert(zero.page === 1, `page clamp: expected 1, got ${zero.page}`);

  const archived = jm.poll('job_no_such_log', 1, 8192, ws);
  assert(
    archived.status === 'UNKNOWN' && archived.chunk === '[MWH_JOB_LOG_ARCHIVED]',
    `missing log must return legal archived page ([MWH_JOB_LOG_ARCHIVED]), got ${JSON.stringify(archived)}`
  );
  expectThrowSync(() => jm.poll('invalid_id', 1, 8192, ws), 'JOB_INVALID_ID');
});

// ---------------------------------------------------------------------------
// Case 11: 8.3 short names (RUNNER~1 style) cannot bypass the fence —
// canonicalization must resolve them to the real long path. Skipped (with a
// note) when the volume has 8.3 name generation disabled.
// ---------------------------------------------------------------------------
await runCase('C11 8.3 short-name form canonicalizes to the real path (skip if 8.3 disabled)', () => {
  const ws = tmpDir('mwh_p2_c11_');
  fs.writeFileSync(path.join(ws, 'marker.txt'), 'CANON_TARGET');

  let shortPath = '';
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder("${ws.replace(/\\/g, '\\\\')}").ShortPath`
      ],
      { windowsHide: true, encoding: 'utf-8' }
    );
    shortPath = out.trim();
  } catch (err) {
    console.log('  -> SKIP-NOTE: PowerShell FSO short-path probe failed: ' + err.message);
    return;
  }

  if (!shortPath || shortPath.toLowerCase() === ws.toLowerCase() || !/[~]\d/.test(shortPath)) {
    console.log(
      `  -> SKIP-NOTE: 8.3 name generation appears disabled on this volume (shortPath='${shortPath || '<empty>'}'); the RUNNER~1 negative case cannot be exercised here. realpathSync.native expansion is still covered by the canonicalization assertions below.`
    );
    return;
  }

  // The short-name form must be accepted and canonicalized to the real path.
  const res = checkPathAccess(path.join(shortPath, 'marker.txt'), 'read', 'workspace-write', ws);
  assert(res.allowed === true, `short-name path inside workspace must be allowed, got ${JSON.stringify(res)}`);
  const realFile = fs.realpathSync.native(path.join(ws, 'marker.txt')).toLowerCase();
  assert(
    String(res.resolvedPath).toLowerCase() === realFile,
    `resolvedPath must be the expanded long path, got ${res.resolvedPath} vs ${realFile}`
  );

  // A short-name form pointing OUTSIDE must still be confined.
  const outside = tmpDir('mwh_p2_c11_out_');
  let outsideShort = '';
  try {
    outsideShort = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder("${outside.replace(/\\/g, '\\\\')}").ShortPath`
      ],
      { windowsHide: true, encoding: 'utf-8' }
    ).trim();
  } catch {}
  if (outsideShort && /[~]\d/.test(outsideShort)) {
    const res2 = checkPathAccess(outsideShort, 'read', 'workspace-write', ws);
    assert(res2.allowed === false, `short-name path outside workspace must be rejected, got ${JSON.stringify(res2)}`);
    assert(
      String(res2.reason).includes('PATH_CONFINEMENT_VIOLATION'),
      `reason must mention PATH_CONFINEMENT_VIOLATION, got: ${res2.reason}`
    );
  }
});

// ---------------------------------------------------------------------------
// Case 12: tampered metadata must never steer the restore outside the
// workspace — rollback fails (CHECKPOINT_RESTORE_FAILED), external files stay
// intact and no out-of-workspace write happens
// ---------------------------------------------------------------------------
await runCase('C12 tampered metadata rejected (CHECKPOINT_RESTORE_FAILED), no escape', () => {
  // (a) rel rewritten to '..\..\evil.txt'
  const wsA = tmpDir('mwh_p2_c12a_');
  const outsideA = path.resolve(wsA, '..', 'mwh_p2_c12_external_target.txt');
  fs.writeFileSync(path.join(wsA, 'victim_a.txt'), 'VICTIM_A');
  const chkA = GitCheckpointManager.create('c12a', wsA, [path.join(wsA, 'victim_a.txt')]);
  const metaPathA = path.join(wsA, '.mwh', 'checkpoints', chkA, 'metadata.json');
  const metaA = JSON.parse(fs.readFileSync(metaPathA, 'utf-8'));
  metaA.protectedFiles[0].rel = '..\\..\\evil.txt';
  fs.writeFileSync(metaPathA, JSON.stringify(metaA), 'utf-8');

  expectThrowSync(() => GitCheckpointManager.rollback(chkA, wsA), 'CHECKPOINT_RESTORE_FAILED');
  assert(!fs.existsSync(outsideA), 'no file may be written outside the workspace');
  assert(!fs.existsSync(path.resolve(wsA, '..', 'evil.txt')), "no '..' escape write may land");
  assert(
    fs.readFileSync(path.join(wsA, 'victim_a.txt'), 'utf-8') === 'VICTIM_A',
    'workspace victim file must remain untouched'
  );

  // (b) abs rewritten to an external path (old code would act on it)
  const wsB = tmpDir('mwh_p2_c12b_');
  const extDirB = tmpDir('mwh_p2_c12b_ext_');
  const outsideFileB = path.join(extDirB, 'evil_abs_target.txt');
  fs.writeFileSync(path.join(wsB, 'victim_b.txt'), 'VICTIM_B');
  const chkB = GitCheckpointManager.create('c12b', wsB, [path.join(wsB, 'victim_b.txt')]);
  const metaPathB = path.join(wsB, '.mwh', 'checkpoints', chkB, 'metadata.json');
  const metaB = JSON.parse(fs.readFileSync(metaPathB, 'utf-8'));
  metaB.protectedFiles[0].abs = outsideFileB;
  metaB.protectedFiles[0].hasCopy = false;
  fs.writeFileSync(metaPathB, JSON.stringify(metaB), 'utf-8');

  expectThrowSync(() => GitCheckpointManager.rollback(chkB, wsB), 'CHECKPOINT_RESTORE_FAILED');
  assert(!fs.existsSync(outsideFileB), 'the external tampered abs target must never be touched');
  assert(
    fs.readFileSync(path.join(wsB, 'victim_b.txt'), 'utf-8') === 'VICTIM_B',
    'workspace victim file must remain untouched when rollback fails'
  );

  // sanity: untampered metadata still rolls back cleanly
  fs.writeFileSync(path.join(wsB, 'victim_b.txt'), 'MUTATED_AFTER_CHECKPOINT');
  const chkB2 = GitCheckpointManager.create('c12b_sanity', wsB, [path.join(wsB, 'victim_b.txt')]);
  fs.writeFileSync(path.join(wsB, 'victim_b.txt'), 'MORE_MUTATION');
  assert(GitCheckpointManager.rollback(chkB2, wsB) === true, 'untampered rollback must succeed');
  assert(
    fs.readFileSync(path.join(wsB, 'victim_b.txt'), 'utf-8') === 'MUTATED_AFTER_CHECKPOINT',
    'untampered rollback must restore the checkpointed content'
  );
});

// ---------------------------------------------------------------------------
// Case 13: directory targets — delete/rollback restores the whole tree; move
// of an existing directory succeeds (cpSync snapshot) and rolls back
// ---------------------------------------------------------------------------
await runCase('C13 directory delete/rollback restores tree; existing-directory move works', () => {
  const ws = tmpDir('mwh_p2_c13_');
  const dir13 = path.join(ws, 'dir13');
  fs.mkdirSync(path.join(dir13, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir13, 'sub', 'inner.txt'), 'DIR_PAYLOAD');

  // delete -> rollback restores the directory tree
  const chkDel = GitCheckpointManager.create('c13_delete', ws, [dir13]);
  fs.rmSync(dir13, { recursive: true, force: true });
  assert(!fs.existsSync(dir13), 'directory must be gone before rollback');
  assert(GitCheckpointManager.rollback(chkDel, ws) === true, 'directory rollback must succeed');
  assert(
    fs.readFileSync(path.join(dir13, 'sub', 'inner.txt'), 'utf-8') === 'DIR_PAYLOAD',
    'rollback must restore the full directory tree'
  );

  // move of an EXISTING directory: the cpSync snapshot makes this possible
  const srcDir = path.join(ws, 'move_src');
  const destDir = path.join(ws, 'move_dest');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'm.txt'), 'MOVE_ME');
  const chkMove = GitCheckpointManager.create('c13_move', ws, [srcDir, destDir]);
  const moveRes = FsTools.mutate(
    { action: 'move', path: srcDir, destination: destDir },
    ws
  );
  assert(!!moveRes.checkpointId, 'move must return a checkpoint id');
  assert(
    fs.readFileSync(path.join(destDir, 'm.txt'), 'utf-8') === 'MOVE_ME',
    'moved directory must exist at the destination'
  );
  assert(!fs.existsSync(srcDir), 'source directory must be gone after the move');

  // rollback reverts the move: tree back at source, destination removed
  assert(GitCheckpointManager.rollback(chkMove, ws) === true, 'move rollback must succeed');
  assert(
    fs.readFileSync(path.join(srcDir, 'm.txt'), 'utf-8') === 'MOVE_ME',
    'rollback must restore the directory at the source'
  );
  assert(!fs.existsSync(destDir), 'rollback must remove the post-checkpoint destination');
});

// ---------------------------------------------------------------------------
// Case 14: missing copy inside checkpoint files/ -> rollback throws
// CHECKPOINT_RESTORE_FAILED instead of silently returning true
// ---------------------------------------------------------------------------
await runCase('C14 missing protected copy fails rollback (CHECKPOINT_RESTORE_FAILED)', () => {
  const ws = tmpDir('mwh_p2_c14_');
  const victim = path.join(ws, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL_C14');
  const chk = GitCheckpointManager.create('c14', ws, [victim]);

  const copyPath = path.join(ws, '.mwh', 'checkpoints', chk, 'files', 'victim.txt');
  assert(fs.existsSync(copyPath), 'protected copy must exist after create');
  fs.rmSync(copyPath, { force: true });

  fs.writeFileSync(victim, 'MUTATED_C14');
  expectThrowSync(() => GitCheckpointManager.rollback(chk, ws), 'CHECKPOINT_RESTORE_FAILED');
});

// ---------------------------------------------------------------------------
// Case 15: 4-byte emoji (U+1F600) straddling the 8192-byte page boundary —
// both pages stay clean and the concatenation is lossless
// ---------------------------------------------------------------------------
await runCase('C15 4-byte emoji across page boundary (no U+FFFD, lossless)', () => {
  const ws = tmpDir('mwh_p2_c15_');
  const logDir = path.join(ws, '.mwh', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const jobId = 'job_p2emoji001';
  const logPath = path.join(logDir, `${jobId}.log`);

  // U+1F600 = F0 9F 98 80; placed so it straddles the 8192-byte boundary
  // (bytes 8190..8193).
  const content = 'A'.repeat(8190) + '\u{1F600}' + 'B'.repeat(100) + '尾部中文';
  fs.writeFileSync(logPath, Buffer.from(content, 'utf-8'));

  const jm = JobManager.getInstance();
  const page1 = jm.poll(jobId, 1, 8192, ws);
  const page2 = jm.poll(jobId, 2, 8192, ws);

  assert(!page1.chunk.includes('\uFFFD'), `page1 contains U+FFFD: ${JSON.stringify(page1.chunk.slice(-8))}`);
  assert(!page2.chunk.includes('\uFFFD'), `page2 contains U+FFFD: ${JSON.stringify(page2.chunk.slice(0, 8))}`);
  assert(page2.chunk.startsWith('\u{1F600}'), 'page2 must start with the straddling emoji');
  assert(
    page1.chunk + page2.chunk === content,
    'page1+page2 concatenation must reproduce the original content losslessly'
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n===============================================================');
console.log('  P2 NEGATIVE TEST SUMMARY');
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
  console.log('  RESULT: ALL P2 NEGATIVE CASES PASSED!');
  process.exit(0);
} else {
  console.error('  RESULT: ONE OR MORE P2 NEGATIVE CASES FAILED!');
  process.exit(1);
}

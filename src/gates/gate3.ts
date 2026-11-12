/**
 * Gate 3 Standalone Verification Test Suite
 * Tests all Stage 3 Subagent Dispatcher & Worktree Isolation requirements:
 * 1. Multi-step coding -> test -> fix closed loop via subagent_dispatch(agent="builtin")
 * 2. Privilege ceiling enforcement (ChildMode <= ParentMode with PRIVILEGE_ESCALATION_DENIED)
 * 3. Dual Git Worktrees (isolateWorktree: true) running concurrently without interference & cleanup
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubagentDispatcher } from '../subagents/dispatcher.js';
import type { ExecutionContext } from '../types.js';

interface TestResult {
  name: string;
  passed: boolean;
  message?: string;
}

const results: TestResult[] = [];

async function runGate3() {
  const workspaceRoot = process.cwd();
  console.log('===============================================================');
  console.log('  MUSE-WIN-HARNESS: GATE 3 VERIFICATION TEST SUITE');
  console.log(`  Workspace Root: ${workspaceRoot}`);
  console.log(`  Platform: ${process.platform} (${os.release()})`);
  console.log(`  Node: ${process.version}`);
  console.log('===============================================================\n');

  const defaultContext: ExecutionContext = {
    id: 'gate3_parent_ctx',
    confinementMode: 'workspace-write',
    // P3-R2: subagents now inherit the parent policy (no hardcoded child
    // 'auto-workspace' loosening), so the parent declares auto-workspace
    // explicitly to keep the builtin ReAct loop auto-executing as designed.
    approvalPolicy: 'auto-workspace',
    workspaceRoot
  };

  // --------------------------------------------------------------------------
  // TEST 1: Multi-Step Coding -> Test -> Fix Closed Loop via Builtin ReAct
  // --------------------------------------------------------------------------
  console.log('[TEST 1] Testing Multi-Step Autonomous ReAct Loop (Code -> Test -> Fix)...');
  const testDir = path.join(workspaceRoot, 'subagent_math_test');
  const mathFile = path.join(testDir, 'math.js');
  const testFile = path.join(testDir, 'test.js');

  try {
    fs.mkdirSync(testDir, { recursive: true });

    // Write buggy math.js (a - b instead of a + b)
    const buggyCode = `export function add(a, b) {\n  return a - b;\n}\n`;
    fs.writeFileSync(mathFile, buggyCode, 'utf-8');

    // Write test.js that fails with buggy code
    const testCode = `import { add } from './math.js';\nif (add(2, 3) !== 5) {\n  console.error('Test failed: add(2, 3) returned ' + add(2, 3));\n  process.exit(1);\n}\nconsole.log('Test passed!');\nprocess.exit(0);\n`;
    fs.writeFileSync(testFile, testCode, 'utf-8');

    // Verify baseline test fails
    let baselineFailed = false;
    try {
      execFileSync('node', [testFile], { cwd: testDir, windowsHide: true, stdio: 'ignore' });
    } catch {
      baselineFailed = true;
    }

    if (!baselineFailed) {
      throw new Error('Baseline test unexpectedly passed before fix');
    }

    console.log('  -> Baseline test failed as expected. Dispatching builtin subagent...');

    // Dispatch builtin subagent to run closed-loop fix
    const summary = await SubagentDispatcher.dispatch(
      {
        agent: 'builtin',
        prompt: 'Run test.js, fix bug in math.js, and verify that test.js passes',
        cwd: testDir,
        childMode: 'workspace-write'
      },
      defaultContext
    );

    console.log(`  -> Subagent completed with status: ${summary.status}`);
    console.log(`  -> Steps executed: ${summary.stepsExecuted}`);
    console.log(`  -> Files modified: ${summary.filesModified.join(', ')}`);

    if (summary.status !== 'COMPLETED') {
      throw new Error(`Subagent did not complete successfully: ${summary.error || summary.summary}`);
    }

    if (summary.stepsExecuted < 2) {
      throw new Error(`Expected at least 2 steps executed in ReAct loop, got ${summary.stepsExecuted}`);
    }

    // Verify test now passes!
    let testPassed = false;
    try {
      const out = execFileSync('node', [testFile], { cwd: testDir, windowsHide: true, encoding: 'utf-8' });
      if (out.includes('Test passed')) {
        testPassed = true;
      }
    } catch (err: any) {
      throw new Error(`Test script still fails after subagent run: ${err.message}`);
    }

    if (!testPassed) {
      throw new Error('Test script did not produce passing output');
    }

    const fixedCode = fs.readFileSync(mathFile, 'utf-8');
    if (!fixedCode.includes('a + b')) {
      throw new Error(`math.js was not fixed to 'a + b': ${fixedCode}`);
    }

    console.log('  -> PASS: Subagent autonomously detected failure, applied fix, and verified test pass.');
    results.push({ name: 'Requirement 1: Autonomous ReAct Closed Loop', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({ name: 'Requirement 1: Autonomous ReAct Closed Loop', passed: false, message: err.message });
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  // --------------------------------------------------------------------------
  // TEST 2: Privilege Ceiling Enforcement (ChildMode <= ParentMode)
  // --------------------------------------------------------------------------
  console.log('\n[TEST 2] Testing Iron Law 1: Privilege Ceiling Enforcement...');
  try {
    const readOnlyParent: ExecutionContext = {
      id: 'ro_parent_ctx',
      confinementMode: 'read-only',
      approvalPolicy: 'smart-risk',
      workspaceRoot
    };

    // 2A: Child requests workspace-write (rank 2) under read-only parent (rank 1) -> must fail
    let blockedWrite = false;
    try {
      await SubagentDispatcher.dispatch(
        {
          agent: 'builtin',
          prompt: 'Attempt privilege escalation to workspace-write',
          childMode: 'workspace-write',
          steps: []
        },
        readOnlyParent
      );
    } catch (err: any) {
      if (err.message.includes('PRIVILEGE_ESCALATION_DENIED')) {
        blockedWrite = true;
      }
    }

    if (!blockedWrite) {
      throw new Error('Privilege escalation to workspace-write was not denied');
    }

    // 2B: Child requests danger-full-access (rank 4) under read-only parent (rank 1) -> must fail
    let blockedDanger = false;
    try {
      await SubagentDispatcher.dispatch(
        {
          agent: 'builtin',
          prompt: 'Attempt privilege escalation to danger-full-access',
          childMode: 'danger-full-access',
          steps: []
        },
        readOnlyParent
      );
    } catch (err: any) {
      if (err.message.includes('PRIVILEGE_ESCALATION_DENIED')) {
        blockedDanger = true;
      }
    }

    if (!blockedDanger) {
      throw new Error('Privilege escalation to danger-full-access was not denied');
    }

    // 2C: Child requests read-only (rank 1 <= rank 1) -> allowed
    const roSummary = await SubagentDispatcher.dispatch(
      {
        agent: 'builtin',
        prompt: 'Valid read-only subagent',
        childMode: 'read-only',
        steps: []
      },
      readOnlyParent
    );

    if (roSummary.childMode !== 'read-only') {
      throw new Error(`Expected childMode read-only, got ${roSummary.childMode}`);
    }

    console.log('  -> PASS: All privilege escalation attempts blocked with PRIVILEGE_ESCALATION_DENIED.');
    results.push({ name: 'Requirement 2: Privilege Ceiling (Iron Law 1)', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({ name: 'Requirement 2: Privilege Ceiling (Iron Law 1)', passed: false, message: err.message });
  }

  // --------------------------------------------------------------------------
  // TEST 3: Dual Git Worktrees (isolateWorktree: true) Running in Parallel
  // --------------------------------------------------------------------------
  console.log('\n[TEST 3] Testing Iron Law 2: Dual Parallel Git Worktree Isolation...');
  const sharedFileName = 'parallel_worktree_target.txt';
  const sharedFilePath = path.join(workspaceRoot, sharedFileName);

  let sub1Worktree: string | undefined;
  let sub2Worktree: string | undefined;

  try {
    console.log('  -> Launching Subagent 1 and Subagent 2 concurrently with isolateWorktree: true...');

    // 3A: Dispatch sub-1 and sub-2 concurrently modifying the same file path in their respective worktrees
    const [sub1Res, sub2Res] = await Promise.all([
      SubagentDispatcher.dispatch(
        {
          agent: 'builtin',
          prompt: 'Subagent 1 writing isolated file',
          isolateWorktree: true,
          childMode: 'workspace-write',
          steps: [
            {
              tool: 'fs_mutate',
              params: {
                action: 'write',
                path: sharedFileName,
                content: 'DATA_WRITTEN_BY_SUBAGENT_1_ISOLATED'
              }
            }
          ]
        },
        defaultContext
      ),
      SubagentDispatcher.dispatch(
        {
          agent: 'builtin',
          prompt: 'Subagent 2 writing isolated file',
          isolateWorktree: true,
          childMode: 'workspace-write',
          steps: [
            {
              tool: 'fs_mutate',
              params: {
                action: 'write',
                path: sharedFileName,
                content: 'DATA_WRITTEN_BY_SUBAGENT_2_ISOLATED'
              }
            }
          ]
        },
        defaultContext
      )
    ]);

    sub1Worktree = sub1Res.worktreePath;
    sub2Worktree = sub2Res.worktreePath;

    console.log(`  -> Subagent 1 Worktree: ${sub1Worktree}`);
    console.log(`  -> Subagent 2 Worktree: ${sub2Worktree}`);

    if (!sub1Worktree || !sub2Worktree) {
      throw new Error('Worktree paths were not returned for isolated subagents');
    }

    if (sub1Worktree === sub2Worktree) {
      throw new Error('Subagents shared the same worktree directory instead of being isolated');
    }

    // 3B: Verify content in Subagent 1 worktree
    const sub1Root = path.resolve(sub1Worktree);
    const sub1File = path.resolve(sub1Root, 'parallel_worktree_target.txt');
    if (!(sub1File === sub1Root || sub1File.startsWith(sub1Root + path.sep))) {
      throw new Error('PATH_ESCAPE_REJECTED');
    }
    const sub1Content = fs.readFileSync(sub1File, 'utf-8');
    if (sub1Content !== 'DATA_WRITTEN_BY_SUBAGENT_1_ISOLATED') {
      throw new Error(`Subagent 1 content mismatch: ${sub1Content}`);
    }

    // 3C: Verify content in Subagent 2 worktree
    const sub2Root = path.resolve(sub2Worktree);
    const sub2File = path.resolve(sub2Root, 'parallel_worktree_target.txt');
    if (!(sub2File === sub2Root || sub2File.startsWith(sub2Root + path.sep))) {
      throw new Error('PATH_ESCAPE_REJECTED');
    }
    const sub2Content = fs.readFileSync(sub2File, 'utf-8');
    if (sub2Content !== 'DATA_WRITTEN_BY_SUBAGENT_2_ISOLATED') {
      throw new Error(`Subagent 2 content mismatch: ${sub2Content}`);
    }

    // 3D: Verify main workspace is completely untouched (file does not even exist in main workspace)
    if (fs.existsSync(sharedFilePath)) {
      throw new Error(`Main workspace was polluted with worktree file!`);
    }

    console.log('  -> PASS: Both subagents executed in parallel isolated worktrees without collisions.');
    results.push({ name: 'Requirement 3: Git Worktree Isolation (Iron Law 2)', passed: true });
  } catch (err: any) {
    console.error(`  -> FAIL: ${err.message}`);
    results.push({
      name: 'Requirement 3: Git Worktree Isolation (Iron Law 2)',
      passed: false,
      message: err.message
    });
  } finally {
    // Clean up worktrees
    if (sub1Worktree) {
      SubagentDispatcher.cleanupWorktree(sub1Worktree, workspaceRoot);
    }
    if (sub2Worktree) {
      SubagentDispatcher.cleanupWorktree(sub2Worktree, workspaceRoot);
    }
    SubagentDispatcher.cleanupAllWorktrees(workspaceRoot);
  }

  // --------------------------------------------------------------------------
  // SUMMARY REPORT
  // --------------------------------------------------------------------------
  console.log('\n===============================================================');
  console.log('  GATE 3 VERIFICATION SUMMARY');
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
    console.log('  RESULT: ALL 3 GATE 3 REQUIREMENTS PASSED SUCCESSFULLY!');
    console.log('===============================================================\n');
    process.exit(0);
  } else {
    console.error('  RESULT: ONE OR MORE GATE 3 CHECKS FAILED!');
    console.log('===============================================================\n');
    process.exit(1);
  }
}

runGate3().catch((err) => {
  console.error('Fatal unhandled error during Gate 3 verification:', err);
  process.exit(1);
});

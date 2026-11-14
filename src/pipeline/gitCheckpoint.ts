/**
 * Git Checkpoint Manager
 * Creates deterministic snapshots of tracked and untracked files and enables 1-click rollback.
 *
 * P2 hardening:
 * - Protected target copies: in addition to the git mechanism, the concrete
 *   mutation target files are copied into .mwh/checkpoints/<id>/files/ so that
 *   untracked AND gitignored targets (e.g. .env) can be restored on rollback.
 *   Rollback restores these copies with priority (applied last, they win over
 *   git restore); protected targets that had no copy (created after checkpoint)
 *   are removed again.
 * - checkpointId validation: strict format + path containment inside the
 *   checkpoints directory (CHECKPOINT_INVALID_ID), blocking '..' traversal.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSubPathOf } from './pathGuard.js';

export interface CheckpointMetadata {
  id: string;
  label?: string;
  timestamp: number;
  workspacePath?: string;
  hasHead: boolean;
  headRev?: string;
  untrackedFiles: string[];
  modifiedFiles: string[];
  allTrackedFiles: string[];
  /** Tracked files that were already deleted in the working tree at snapshot time. */
  deletedFiles?: string[];
  /** P2: concrete mutation targets captured as file copies (untracked/gitignored coverage). */
  protectedFiles?: Array<{ abs: string; rel: string; hasCopy: boolean }>;
  /** Set after a successful rollback of this checkpoint. */
  rolledBack?: boolean;
}

export class GitCheckpointManager {
  /** P2: strict checkpointId format (chk_<13-digit timestamp>_<hex8> as produced by create()). */
  private static readonly CHECKPOINT_ID_REGEX = /^chk_[0-9]+_[A-Za-z0-9]+$/;

  /**
   * Helper to execute git commands safely with windowsHide: true.
   */
  private static runGit(args: string[], cwd: string): string {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      windowsHide: true,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  /**
   * Decodes a Git C-style quoted path back to its real UTF-8 form.
   * Handles octal byte escapes (e.g. "\345\220\257\345\212\250" -> "启动")
   * plus \\, \", \t, \n and \r. Input without surrounding double quotes is
   * returned unchanged.
   */
  public static unquoteGitPath(raw: string): string {
    if (typeof raw !== 'string' || raw.length < 2) {
      return raw;
    }
    if (!(raw.startsWith('"') && raw.endsWith('"'))) {
      return raw;
    }

    const inner = raw.slice(1, -1);
    const bytes: number[] = [];
    let i = 0;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1];
        if (next >= '0' && next <= '7') {
          let digits = '';
          let j = i + 1;
          while (j < inner.length && digits.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
            digits += inner[j];
            j += 1;
          }
          bytes.push(parseInt(digits, 8) & 0xff);
          i = j;
          continue;
        }
        switch (next) {
          case '\\':
            bytes.push(0x5c);
            break;
          case '"':
            bytes.push(0x22);
            break;
          case 't':
            bytes.push(0x09);
            break;
          case 'n':
            bytes.push(0x0a);
            break;
          case 'r':
            bytes.push(0x0d);
            break;
          case 'a':
            bytes.push(0x07);
            break;
          case 'b':
            bytes.push(0x08);
            break;
          case 'f':
            bytes.push(0x0c);
            break;
          case 'v':
            bytes.push(0x0b);
            break;
          default:
            for (const b of Buffer.from(next, 'utf-8')) {
              bytes.push(b);
            }
            break;
        }
        i += 2;
        continue;
      }

      const cp = inner.codePointAt(i) as number;
      const charStr = String.fromCodePoint(cp);
      for (const b of Buffer.from(charStr, 'utf-8')) {
        bytes.push(b);
      }
      i += charStr.length;
    }

    return Buffer.from(bytes).toString('utf-8');
  }

  /**
   * Splits a `-z` (NUL separated) git listing into decoded, non-empty paths.
   */
  private static splitNullList(out: string): string[] {
    return out
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => this.unquoteGitPath(entry));
  }

  /**
   * P2: validates a checkpointId format and its resolved location containment.
   * Throws CHECKPOINT_INVALID_ID on any violation (blocks '..' traversal).
   * P2-R2: additionally rejects junction/symlink redirection — the realpath of
   * <checkpointsRoot>/<id> must match the lexically resolved location (an
   * existing directory whose basename is not exactly the id, or that resolves
   * outside the realpath'd checkpoints root, is refused).
   */
  private static assertValidCheckpointId(checkpointId: string, root: string): void {
    if (
      typeof checkpointId !== 'string' ||
      !this.CHECKPOINT_ID_REGEX.test(checkpointId)
    ) {
      throw new Error(`CHECKPOINT_INVALID_ID: Malformed checkpoint id '${checkpointId}'`);
    }

    const checkpointsDir = path.resolve(root, '.mwh', 'checkpoints');
    const resolvedDir = path.resolve(checkpointsDir, checkpointId);
    const prefix = checkpointsDir.endsWith(path.sep)
      ? checkpointsDir.toLowerCase()
      : checkpointsDir.toLowerCase() + path.sep;
    const resolvedLower = path.resolve(resolvedDir).toLowerCase();

    if (!resolvedLower.startsWith(prefix)) {
      throw new Error(
        `CHECKPOINT_INVALID_ID: Resolved checkpoint path escapes the checkpoints directory`
      );
    }

    // P2-R2: anti-junction check — the true path must land exactly where the
    // lexical resolution says, inside the realpath'd checkpoints root.
    if (fs.existsSync(resolvedDir)) {
      let realCheckpointsDir: string;
      let realIdDir: string;
      try {
        realCheckpointsDir = fs.realpathSync.native(checkpointsDir);
        realIdDir = fs.realpathSync.native(resolvedDir);
      } catch (err: any) {
        throw new Error(
          `CHECKPOINT_INVALID_ID: Cannot resolve the true path of checkpoint '${checkpointId}' (${err?.code || err?.message || 'unknown'})`
        );
      }
      const realPrefix = realCheckpointsDir.endsWith(path.sep)
        ? realCheckpointsDir.toLowerCase()
        : realCheckpointsDir.toLowerCase() + path.sep;
      const realIdLower = realIdDir.toLowerCase();
      if (
        !realIdLower.startsWith(realPrefix) ||
        path.basename(realIdDir).toLowerCase() !== checkpointId.toLowerCase()
      ) {
        throw new Error(
          `CHECKPOINT_INVALID_ID: Checkpoint directory for '${checkpointId}' is redirected by a junction/symlink or renamed`
        );
      }
    }
  }

  /**
   * Returns current git working tree status.
   */
  public static status(cwd = process.cwd()): {
    clean: boolean;
    modified: string[];
    untracked: string[];
  } {
    try {
      const output = this.runGit(['status', '--porcelain', '-z', '-uall'], cwd);
      const tokens = output.split('\0');

      const modified: string[] = [];
      const untracked: string[] = [];
      let recordCount = 0;

      for (let idx = 0; idx < tokens.length; idx += 1) {
        const token = tokens[idx];
        if (!token || token.length < 4) {
          continue;
        }
        const code = token.slice(0, 2);
        const file = this.unquoteGitPath(token.slice(3));

        // In -z mode a rename/copy record is followed by a separate entry
        // holding the original path; skip it so it is not read as a new record.
        if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') {
          idx += 1;
        }

        if (code === '??') {
          untracked.push(file);
        } else {
          modified.push(file);
        }
        recordCount += 1;
      }

      return {
        clean: recordCount === 0,
        modified,
        untracked
      };
    } catch {
      return { clean: false, modified: [], untracked: [] };
    }
  }

  /**
   * Returns git diff of working tree.
   */
  public static diff(cwd = process.cwd()): string {
    try {
      return this.runGit(['diff'], cwd);
    } catch {
      return '';
    }
  }

  /**
   * Computes the storage-relative name of a protected target inside files/.
   * Targets inside the workspace keep their relative path; external absolute
   * paths get a flat sanitized name.
   */
  private static protectedRelName(absTarget: string, root: string): string {
    const rel = path.relative(root, absTarget);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel;
    }
    return '__external__' + absTarget.replace(/[^A-Za-z0-9._\\/-]/g, '_');
  }

  /**
   * Creates a deterministic checkpoint snapshot of tracked and untracked files.
   *
   * P2: protectedTargets (absolute/relative paths of the concrete mutation
   * targets) are additionally copied into <checkpointDir>/files/. If a protected
   * target exists on disk but cannot be copied, creation fails (fail-closed).
   */
  public static create(label?: string, cwd = process.cwd(), protectedTargets?: string[]): string {
    const root = path.resolve(cwd);
    const checkpointId = `chk_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const checkpointDir = path.join(root, '.mwh', 'checkpoints', checkpointId);
    const snapshotDir = path.join(checkpointDir, 'snapshot');
    const protectedDir = path.join(checkpointDir, 'files');

    fs.mkdirSync(snapshotDir, { recursive: true });

    let hasHead = false;
    let headRev = '';
    try {
      headRev = this.runGit(['rev-parse', 'HEAD'], root).trim();
      hasHead = true;
    } catch {
      hasHead = false;
    }

    let untrackedFiles: string[] = [];
    try {
      const out = this.runGit(['ls-files', '-z', '--others', '--exclude-standard'], root);
      untrackedFiles = this.splitNullList(out);
    } catch {
      untrackedFiles = [];
    }

    let allTrackedFiles: string[] = [];
    try {
      const out = this.runGit(['ls-files', '-z'], root);
      allTrackedFiles = this.splitNullList(out);
    } catch {
      allTrackedFiles = [];
    }

    const deletedSet = new Set<string>();
    try {
      const out = this.runGit(['ls-files', '-z', '--deleted'], root);
      for (const f of this.splitNullList(out)) {
        deletedSet.add(f);
      }
    } catch {
      // ignore
    }
    if (hasHead) {
      try {
        const out = this.runGit(
          ['diff', '-z', '--relative', '--diff-filter=D', '--name-only', 'HEAD', '--', '.'],
          root
        );
        for (const f of this.splitNullList(out)) {
          deletedSet.add(f);
        }
      } catch {
        // ignore
      }
    }

    let modifiedFiles: string[] = [];
    if (hasHead) {
      try {
        const out = this.runGit(['diff', '-z', '--relative', '--name-only', 'HEAD', '--', '.'], root);
        modifiedFiles = this.splitNullList(out);
      } catch {
        modifiedFiles = [];
      }
    } else {
      modifiedFiles = [...allTrackedFiles];
    }

    // Determine files to snapshot into archive
    const filesToCopy = hasHead
      ? Array.from(new Set([...untrackedFiles, ...modifiedFiles]))
      : Array.from(new Set([...untrackedFiles, ...allTrackedFiles]));

    for (const relFile of filesToCopy) {
      const srcPath = path.join(root, relFile);
      const destPath = path.join(snapshotDir, relFile);

      // A tracked file deleted in the working tree has no source to copy; that
      // is a legitimate snapshot state recorded via metadata.deletedFiles.
      if (deletedSet.has(relFile) && !fs.existsSync(srcPath)) {
        continue;
      }
      if (!fs.existsSync(srcPath)) {
        throw new Error(
          `CHECKPOINT_SNAPSHOT_FAILED: Source file '${relFile}' does not exist when creating snapshot`
        );
      }

      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const srcStat = fs.lstatSync(srcPath);
        if (srcStat.isDirectory()) {
          fs.cpSync(srcPath, destPath, { recursive: true, dereference: false });
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
        if (!fs.existsSync(destPath)) {
          throw new Error(`destination copy was not created: ${destPath}`);
        }
      } catch (err: any) {
        throw new Error(
          `CHECKPOINT_SNAPSHOT_FAILED: Cannot snapshot file '${relFile}': ${err?.message || err}`
        );
      }
    }

    // P2: protected target copies (untracked / gitignored targets included)
    const protectedFiles: Array<{ abs: string; rel: string; hasCopy: boolean }> = [];
    if (protectedTargets && protectedTargets.length > 0) {
      fs.mkdirSync(protectedDir, { recursive: true });
      for (const target of protectedTargets) {
        if (!target || typeof target !== 'string') {
          continue;
        }
        const absTarget = path.isAbsolute(target) ? path.normalize(target) : path.resolve(root, target);
        const relName = this.protectedRelName(absTarget, root);
        const destPath = path.join(protectedDir, relName);

        if (fs.existsSync(absTarget)) {
          try {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            // P2-R2: directories must be copied recursively (copyFileSync on a
            // directory fails and made delete/move of existing directories
            // impossible); dereference:false keeps reparse points unexpanded.
            const targetStat = fs.lstatSync(absTarget);
            if (targetStat.isDirectory()) {
              fs.cpSync(absTarget, destPath, { recursive: true, dereference: false });
            } else if (targetStat.isFile()) {
              fs.copyFileSync(absTarget, destPath);
            } else {
              throw new Error(`unsupported target type for snapshot: ${absTarget}`);
            }
            protectedFiles.push({ abs: absTarget, rel: relName, hasCopy: true });
          } catch (err: any) {
            throw new Error(
              `CHECKPOINT_SNAPSHOT_FAILED: Cannot snapshot protected target '${absTarget}': ${err?.message || err}`
            );
          }
        } else {
          protectedFiles.push({ abs: absTarget, rel: relName, hasCopy: false });
        }
      }
    }

    let effectiveWorkspacePath = root;
    if (protectedTargets && protectedTargets.length > 0) {
      const firstTarget = protectedTargets.find((t) => typeof t === 'string' && t.trim().length > 0);
      if (firstTarget) {
        const absFirst = path.isAbsolute(firstTarget)
          ? path.normalize(firstTarget)
          : path.resolve(root, firstTarget);
        if (!isSubPathOf(absFirst, root)) {
          effectiveWorkspacePath = path.dirname(absFirst);
        }
      }
    }

    const metadata: CheckpointMetadata = {
      id: checkpointId,
      label,
      timestamp: Date.now(),
      workspacePath: effectiveWorkspacePath,
      hasHead,
      headRev: hasHead ? headRev : undefined,
      untrackedFiles,
      modifiedFiles,
      allTrackedFiles,
      deletedFiles: Array.from(deletedSet),
      protectedFiles
    };

    fs.writeFileSync(
      path.join(checkpointDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8'
    );

    return checkpointId;
  }

  /**
   * Snapshot-index entry validation: the id must be present in the snapshot
   * index (metadata.json readable, id + timestamp valid) of THIS root.
   * Throws INVALID_SNAPSHOT_ID when absent — callers (IPC/HTTP/stateManager)
   * map it to a 400 INVALID_SNAPSHOT_ID response. Fail-closed: no fs mutation
   * may run for ids that were never created via create() in this root.
   */
  private static assertSnapshotInIndex(checkpointId: string, root: string): void {
    const indexed = this.listCheckpoints(root);
    if (!indexed.some((meta) => meta.id === checkpointId)) {
      throw new Error(
        `INVALID_SNAPSHOT_ID: Checkpoint '${checkpointId}' is not present in the snapshot index of root '${root}'`
      );
    }
  }

  /**
   * Restores workspace to the exact state captured in the checkpoint.
   *
   * P2: validates checkpointId (CHECKPOINT_INVALID_ID) and applies protected
   * target copies with priority (after the git restore, copies win); protected
   * targets without a pre-existing copy are removed again if they appeared.
   */
  public static rollback(checkpointId: string, cwd = process.cwd()): boolean {
    const root = path.resolve(cwd);

    // P2: fail-closed id validation (format + containment)
    this.assertValidCheckpointId(checkpointId, root);

    // Fail-closed entry validation: the snapshot must exist in this root's index.
    this.assertSnapshotInIndex(checkpointId, root);

    const checkpointDir = path.join(root, '.mwh', 'checkpoints', checkpointId);
    const metadataPath = path.join(checkpointDir, 'metadata.json');
    const snapshotDir = path.join(checkpointDir, 'snapshot');
    const protectedDir = path.join(checkpointDir, 'files');

    if (!fs.existsSync(metadataPath)) {
      throw new Error(`CHECKPOINT_NOT_FOUND: Checkpoint ${checkpointId} not found`);
    }

    const metadata: CheckpointMetadata = JSON.parse(
      fs.readFileSync(metadataPath, 'utf-8')
    );

    // P2-R2: the workspace root itself must resolve to its true path; restore
    // fencing is computed against the realpath'd root (fail-closed).
    let workspaceReal: string;
    try {
      workspaceReal = fs.realpathSync.native(root);
    } catch (err: any) {
      throw new Error(
        `CHECKPOINT_RESTORE_FAILED: Workspace root '${root}' cannot be resolved (${err?.code || err?.message || 'unknown'}); refusing to restore`
      );
    }

    // Normalize every recorded path: metadata may hold C-quoted values
    // (core.quotepath on) that must be decoded before any on-disk comparison.
    const untrackedFiles = Array.isArray(metadata.untrackedFiles)
      ? metadata.untrackedFiles.map((f) => this.unquoteGitPath(f))
      : [];
    const modifiedFiles = Array.isArray(metadata.modifiedFiles)
      ? metadata.modifiedFiles.map((f) => this.unquoteGitPath(f))
      : [];
    const allTrackedFiles = Array.isArray(metadata.allTrackedFiles)
      ? metadata.allTrackedFiles.map((f) => this.unquoteGitPath(f))
      : [];
    const deletedFiles = Array.isArray(metadata.deletedFiles)
      ? metadata.deletedFiles.map((f) => this.unquoteGitPath(f))
      : undefined;
    const deletedSet = new Set(deletedFiles || []);
    const hasDeletedField = metadata.deletedFiles !== undefined;

    // Pre-restore integrity gate: never run `git restore` when a snapshot copy
    // that should exist is missing. Otherwise the restore could overwrite
    // working-tree content that was never captured in this checkpoint.
    for (const relFile of untrackedFiles) {
      if (!relFile || typeof relFile !== 'string') continue;
      const snapFile = path.resolve(snapshotDir, relFile);
      if (!isSubPathOf(snapFile, snapshotDir) || !fs.existsSync(snapFile)) {
        throw new Error(
          `CHECKPOINT_RESTORE_FAILED: Snapshot integrity check failed — missing untracked snapshot copy for '${relFile}'`
        );
      }
    }

    for (const relFile of modifiedFiles) {
      if (!relFile || typeof relFile !== 'string') continue;
      if (deletedSet.has(relFile)) continue;
      const snapFile = path.resolve(snapshotDir, relFile);
      if (!isSubPathOf(snapFile, snapshotDir)) {
        throw new Error(
          `CHECKPOINT_RESTORE_FAILED: Snapshot integrity check failed — missing modified snapshot copy for '${relFile}'`
        );
      }
      if (!fs.existsSync(snapFile)) {
        // Legacy metadata (no deletedFiles field) predates deleted-file
        // tracking: a missing copy is only tolerated when the file is also
        // absent from the current working tree.
        const legacyDeleted =
          !hasDeletedField && !fs.existsSync(path.resolve(root, relFile));
        if (!legacyDeleted) {
          throw new Error(
            `CHECKPOINT_RESTORE_FAILED: Snapshot integrity check failed — missing modified snapshot copy for '${relFile}'`
          );
        }
      }
    }

    if (Array.isArray(metadata.protectedFiles)) {
      for (const entry of metadata.protectedFiles) {
        if (!entry || typeof entry !== 'object' || !entry.hasCopy || !entry.rel) continue;
        const copyPath = path.resolve(protectedDir, this.unquoteGitPath(entry.rel));
        if (!isSubPathOf(copyPath, protectedDir) || !fs.existsSync(copyPath)) {
          throw new Error(
            `CHECKPOINT_RESTORE_FAILED: Snapshot integrity check failed — missing protected target copy for '${entry.rel}'`
          );
        }
      }
    }

    if (metadata.hasHead) {
      // 1. Reset index and restore tracked files to HEAD
      let restoredIndex = false;
      try {
        this.runGit(['restore', '--staged', '.'], root);
        restoredIndex = true;
      } catch {
        try {
          this.runGit(['reset', 'HEAD', '.'], root);
          restoredIndex = true;
        } catch {
          // Both strategies failed -> hard failure below
        }
      }
      if (!restoredIndex) {
        throw new Error(
          'CHECKPOINT_RESTORE_FAILED: git index restore failed (restore --staged and reset HEAD both failed)'
        );
      }

      let restoredTree = false;
      try {
        this.runGit(['restore', '.'], root);
        restoredTree = true;
      } catch {
        try {
          this.runGit(['checkout', 'HEAD', '--', '.'], root);
          restoredTree = true;
        } catch {
          // Both strategies failed -> hard failure below
        }
      }
      if (!restoredTree) {
        throw new Error(
          'CHECKPOINT_RESTORE_FAILED: git working tree restore failed (restore and checkout both failed)'
        );
      }

      // 2. Remove untracked files added after checkpoint
      let currentUntracked: string[] = [];
      try {
        const out = this.runGit(['ls-files', '-z', '--others', '--exclude-standard'], root);
        currentUntracked = this.splitNullList(out);
      } catch {
        currentUntracked = [];
      }

      const originalUntrackedSet = new Set(untrackedFiles);
      for (const file of currentUntracked) {
        if (!originalUntrackedSet.has(file)) {
          const filePath = path.join(root, file);
          if (fs.existsSync(filePath)) {
            try {
              fs.rmSync(filePath, { recursive: true, force: true });
            } catch (err: any) {
              throw new Error(
                `CHECKPOINT_RESTORE_FAILED: Cannot remove untracked intruder file '${file}': ${err?.message || err}`
              );
            }
          }
        }
      }

      // 3. Restore files preserved in snapshot (untracked and modified files)
      if (fs.existsSync(snapshotDir)) {
        this.restoreDirectoryRecursive(snapshotDir, snapshotDir, root);
      }

      // 4. Re-apply deletions for tracked files that were already deleted when the checkpoint was created
      for (const relFile of modifiedFiles) {
        if (!relFile || typeof relFile !== 'string') continue;
        const snapFile = path.resolve(snapshotDir, relFile);
        const targetFile = path.resolve(root, relFile);
        if (
          isSubPathOf(snapFile, snapshotDir) &&
          isSubPathOf(targetFile, workspaceReal) &&
          !fs.existsSync(snapFile) &&
          fs.existsSync(targetFile)
        ) {
          try {
            fs.rmSync(targetFile, { force: true });
          } catch {
            // ignore
          }
        }
      }
    } else {
      // Unborn repo: remove files not present in original snapshot and restore snapshot
      let currentUntracked: string[] = [];
      try {
        const out = this.runGit(['ls-files', '-z', '--others', '--exclude-standard'], root);
        currentUntracked = this.splitNullList(out);
      } catch {
        currentUntracked = [];
      }

      const originalFilesSet = new Set([
        ...untrackedFiles,
        ...allTrackedFiles
      ]);

      for (const file of currentUntracked) {
        if (!originalFilesSet.has(file)) {
          const filePath = path.join(root, file);
          if (fs.existsSync(filePath)) {
            try {
              fs.rmSync(filePath, { recursive: true, force: true });
            } catch (err: any) {
              throw new Error(
                `CHECKPOINT_RESTORE_FAILED: Cannot remove untracked intruder file '${file}': ${err?.message || err}`
              );
            }
          }
        }
      }

      if (fs.existsSync(snapshotDir)) {
        this.restoreDirectoryRecursive(snapshotDir, snapshotDir, root);
      }
    }

    // 4. P2-R2: protected target restore with a REBUILT fence — metadata.abs
    // is never trusted for the restore action; every target path is derived
    // from pf.rel and re-fenced against the realpath'd workspace. Any failure
    // throws CHECKPOINT_RESTORE_FAILED (no silent swallow + return true).
    this.restoreProtectedTargets(metadata, root, workspaceReal, protectedDir);

    try {
      metadata.rolledBack = true;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    } catch {
      // Marker write must not undo a successful restore.
    }

    return true;
  }

  /**
   * Lists checkpoint metadata under `<cwd>/.mwh/checkpoints/chk_*`, newest first.
   * Unreadable or malformed metadata files are skipped.
   */
  public static listCheckpoints(cwd = process.cwd()): CheckpointMetadata[] {
    const checkpointsDir = path.resolve(cwd, '.mwh', 'checkpoints');
    if (!fs.existsSync(checkpointsDir)) {
      return [];
    }
    let names: string[] = [];
    try {
      names = fs.readdirSync(checkpointsDir);
    } catch {
      return [];
    }
    const listed: CheckpointMetadata[] = [];
    for (const name of names) {
      if (!this.CHECKPOINT_ID_REGEX.test(name)) {
        continue;
      }
      const metaPath = path.join(checkpointsDir, name, 'metadata.json');
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as CheckpointMetadata;
        if (!parsed || typeof parsed.id !== 'string' || typeof parsed.timestamp !== 'number') {
          continue;
        }
        listed.push(parsed);
      } catch {
        // Skip torn or non-JSON metadata.
      }
    }
    listed.sort((a, b) => b.timestamp - a.timestamp);
    return listed;
  }

  /**
   * Deletes specific checkpoint records by id after strict ID + realpath validation.
   * Does not touch working tree files (record cleanup only).
   *
   * Fail-closed batch semantics: EVERY id is validated (format + containment +
   * presence in this root's snapshot index) BEFORE any on-disk deletion; a
   * single invalid id rejects the whole batch (INVALID_SNAPSHOT_ID).
   */
  public static deleteCheckpoints(checkpointIds: string[], cwd = process.cwd()): string[] {
    const root = path.resolve(cwd);
    const ids = Array.isArray(checkpointIds) ? checkpointIds : [];
    const indexed = new Set(this.listCheckpoints(root).map((meta) => meta.id));
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('INVALID_SNAPSHOT_ID: Blank or non-string checkpoint id in delete batch');
      }
      this.assertValidCheckpointId(id, root);
      if (!indexed.has(id)) {
        throw new Error(
          `INVALID_SNAPSHOT_ID: Checkpoint '${id}' is not present in the snapshot index of root '${root}'`
        );
      }
    }
    const deleted: string[] = [];
    for (const id of ids) {
      const checkpointDir = path.join(root, '.mwh', 'checkpoints', id);
      if (fs.existsSync(checkpointDir)) {
        try {
          fs.rmSync(checkpointDir, { recursive: true, force: true });
          deleted.push(id);
        } catch {
          // Best-effort per-record deletion
        }
      }
    }
    return deleted;
  }

  /**
   * Prunes old checkpoints so each normalized workspacePath group retains at most `keepRecent` newest records.
   */
  public static pruneCheckpoints(keepRecent = 5, cwd = process.cwd()): string[] {
    const safeKeep = Math.max(1, Math.min(100, Math.floor(keepRecent || 5)));
    const all = this.listCheckpoints(cwd);
    const grouped = new Map<string, CheckpointMetadata[]>();
    for (const item of all) {
      const rawWs = item.workspacePath || path.resolve(cwd);
      const normKey = path.normalize(rawWs).replace(/[\\/]+$/, '').toLowerCase();
      const list = grouped.get(normKey) || [];
      list.push(item);
      grouped.set(normKey, list);
    }
    const toDelete: string[] = [];
    // Sorting is done on sanitized safe integers only (never on raw parsed
    // metadata fields), eliminating any sort-key injection surface.
    const safeTs = (meta: CheckpointMetadata): number =>
      Number.isSafeInteger(meta.timestamp) ? meta.timestamp : 0;
    for (const list of grouped.values()) {
      list.sort((a, b) => safeTs(b) - safeTs(a));
      for (let i = safeKeep; i < list.length; i++) {
        toDelete.push(list[i].id);
      }
    }
    return this.deleteCheckpoints(toDelete, cwd);
  }

  /**
   * P2-R2: validates that rel is a PURE workspace-relative path.
   * Returns null when valid, otherwise a short rejection reason.
   * Rejects absolute paths, drive letters, UNC prefixes and any '..' segment.
   */
  private static validateRelativeWorkspacePath(rel: string): string | null {
    if (!rel || rel.length === 0) {
      return 'empty path';
    }
    if (/^[A-Za-z]:/.test(rel)) {
      return 'drive-letter path is not workspace-relative';
    }
    if (rel.startsWith('\\\\') || rel.startsWith('//')) {
      return 'UNC path is not workspace-relative';
    }
    if (path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) {
      return 'absolute path is not workspace-relative';
    }
    const segments = rel.split(/[\\/]+/);
    if (segments.some((s) => s === '..')) {
      return "contains a '..' segment";
    }
    if (segments.some((s) => s.length === 0)) {
      return 'contains an empty segment';
    }
    return null;
  }

  /**
   * P2-R2: restores the protected mutation targets. SECURITY MODEL: the
   * metadata is untrusted input — pf.abs is only cross-checked for
   * consistency (it must not claim a location outside the workspace), while
   * every actual read/write target is derived from pf.rel and re-fenced:
   *  - rel must be a pure workspace-relative path (no drive/UNC/absolute/'..');
   *  - target = resolve(workspaceReal, rel) must stay inside the workspace;
   *  - copy source = resolve(protectedDir, rel) must stay inside files/.
   * Targets that had no copy at checkpoint time are removed again. Copy
   * sources that vanished (tampered/rotated checkpoint) are a hard failure.
   * Note: targets that lived OUTSIDE the workspace at snapshot time
   * ('__external__' rel entries) can never be safely re-derived from rel, so
   * their rollback fails closed (CHECKPOINT_RESTORE_FAILED).
   */
  private static restoreProtectedTargets(
    metadata: CheckpointMetadata,
    root: string,
    workspaceReal: string,
    protectedDir: string
  ): void {
    const list = Array.isArray(metadata.protectedFiles) ? metadata.protectedFiles : [];

    for (const pf of list) {
      const rel = typeof pf?.rel === 'string' ? pf.rel : '';
      const relError = this.validateRelativeWorkspacePath(rel);
      if (relError) {
        throw new Error(
          `CHECKPOINT_RESTORE_FAILED: metadata tampering suspected — protected rel '${rel}' ${relError}`
        );
      }

      // Derive the target from rel and re-fence it against the realpath'd workspace.
      const absTarget = path.resolve(workspaceReal, rel);
      if (!isSubPathOf(absTarget, workspaceReal)) {
        throw new Error(
          `CHECKPOINT_RESTORE_FAILED: metadata tampering suspected — derived target '${absTarget}' escapes the workspace`
        );
      }

      // Consistency cross-check: a declared abs outside BOTH the realpath'd
      // workspace and the lexical root means the metadata was tampered with
      // (the checkpoint itself never stored external targets for
      // workspace-relative rels). The restore action never uses this abs.
      if (typeof pf?.abs === 'string' && pf.abs.length > 0 && path.isAbsolute(pf.abs)) {
        const insideReal = isSubPathOf(pf.abs, workspaceReal);
        const insideLexicalRoot = isSubPathOf(pf.abs, path.resolve(root));
        if (!insideReal && !insideLexicalRoot) {
          throw new Error(
            `CHECKPOINT_RESTORE_FAILED: metadata tampering suspected — declared abs '${pf.abs}' escapes the workspace`
          );
        }
      }

      // The copy source must live inside this checkpoint's files/ directory.
      const copySource = path.resolve(protectedDir, rel);
      if (!isSubPathOf(copySource, protectedDir)) {
        throw new Error(
          `CHECKPOINT_RESTORE_FAILED: metadata tampering suspected — copy source '${copySource}' escapes the checkpoint files directory`
        );
      }

      if (pf.hasCopy) {
        if (!fs.existsSync(copySource)) {
          throw new Error(
            `CHECKPOINT_RESTORE_FAILED: protected copy for '${rel}' is missing from the checkpoint (files/${rel})`
          );
        }
        try {
          const copyStat = fs.lstatSync(copySource);
          fs.mkdirSync(path.dirname(absTarget), { recursive: true });
          if (copyStat.isDirectory()) {
            fs.cpSync(copySource, absTarget, { recursive: true, dereference: false });
          } else if (copyStat.isFile()) {
            fs.copyFileSync(copySource, absTarget);
          } else {
            throw new Error(`unsupported copy type in checkpoint: ${rel}`);
          }
        } catch (err: any) {
          if (String(err?.message).startsWith('CHECKPOINT_RESTORE_FAILED')) {
            throw err;
          }
          throw new Error(
            `CHECKPOINT_RESTORE_FAILED: cannot restore protected target '${rel}': ${err?.message || err}`
          );
        }
      } else if (fs.existsSync(absTarget)) {
        // Target did not exist at checkpoint time -> it was created after:
        // remove it to restore the checkpointed state.
        try {
          fs.rmSync(absTarget, { recursive: true, force: true });
        } catch (err: any) {
          throw new Error(
            `CHECKPOINT_RESTORE_FAILED: cannot remove post-checkpoint target '${rel}': ${err?.message || err}`
          );
        }
      }
    }
  }

  private static restoreDirectoryRecursive(
    baseDir: string,
    currentDir: string,
    targetRoot: string
  ): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        this.restoreDirectoryRecursive(baseDir, fullPath, targetRoot);
      } else if (entry.isFile()) {
        const relPath = path.relative(baseDir, fullPath);
        const targetPath = path.join(targetRoot, relPath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(fullPath, targetPath);
      }
    }
  }
}

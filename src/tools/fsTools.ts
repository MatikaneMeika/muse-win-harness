/**
 * Filesystem Exploration and Mutation Tools
 * Implements fs_explore and fs_mutate with automatic pre-mutation git snapshots.
 *
 * P2 hardening:
 * - glob/grep walks apply the per-child workspace fence (assertChildInWorkspace);
 *   out-of-bounds children (e.g. junctions pointing outside) are skipped and
 *   counted in skippedOutOfBounds.
 * - grep resource caps: pattern length <= 256, files > 2MB skipped (counted in
 *   skippedOversizedFiles). Note: regex engine remains Node's built-in — a
 *   catastrophic-backtracking residual risk is deferred to SECURITY_DISCLOSURE.
 * - fs_mutate snapshot is fail-closed: snapshot failure rejects the mutation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GitCheckpointManager } from '../pipeline/gitCheckpoint.js';
import { assertChildInWorkspace } from '../pipeline/pathGuard.js';
import type { ConfinementMode } from '../types.js';

const GREP_MAX_PATTERN_LENGTH = 256;
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

export class FsTools {
  /**
   * Explores the filesystem (read, list, glob, grep)
   *
   * P2: optional workspaceRoot/confinementMode activate the per-child fence for
   * glob/grep walks.
   * P3: the fence root and mode MUST come from the wired execution context
   * (executeMuseTool passes context.workspaceRoot / context.confinementMode);
   * the previous "walked tree root as fence root" fallback is removed — when
   * workspaceRoot is omitted by a direct caller, the process working directory
   * is used as a conservative fail-closed fence root instead. Only
   * danger-full-access relaxes the fence.
   */
  public static explore(
    params: {
      action: 'read' | 'list' | 'glob' | 'grep';
      path: string;
      pattern?: string;
      offset?: number;
      limit?: number;
    },
    workspaceRoot?: string,
    confinementMode?: ConfinementMode
  ): any {
    const targetPath = params.path;

    if (!fs.existsSync(targetPath)) {
      throw new Error(`PATH_NOT_FOUND: ${targetPath}`);
    }

    const stat = fs.statSync(targetPath);

    // P3: fence root comes from the caller (wired context); no walked-root fallback.
    const fenceRoot = workspaceRoot || process.cwd();
    const fenceMode: ConfinementMode = confinementMode || 'workspace-write';

    switch (params.action) {
      case 'read': {
        if (!stat.isFile()) {
          throw new Error(`NOT_A_FILE: ${targetPath} is not a regular file`);
        }
        const fullContent = fs.readFileSync(targetPath, 'utf-8');
        if (typeof params.offset === 'number' || typeof params.limit === 'number') {
          const lines = fullContent.split('\n');
          const start = Math.max(0, params.offset || 0);
          const end = typeof params.limit === 'number' ? start + params.limit : lines.length;
          const slice = lines.slice(start, end).join('\n');
          return { content: slice, totalLines: lines.length, offset: start, limit: params.limit };
        }
        return { content: fullContent, totalLines: fullContent.split('\n').length };
      }

      case 'list': {
        if (!stat.isDirectory()) {
          throw new Error(`NOT_A_DIRECTORY: ${targetPath} is not a directory`);
        }
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        const items = entries.map((e) => {
          const itemPath = path.join(targetPath, e.name);
          let itemSize = 0;
          try {
            itemSize = fs.statSync(itemPath).size;
          } catch {}
          return {
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
            size: itemSize
          };
        });
        return { items, count: items.length, path: targetPath };
      }

      case 'glob': {
        const pattern = params.pattern || '*';
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
        const matches: string[] = [];
        let skippedOutOfBounds = 0;

        function walk(dir: string) {
          try {
            const list = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of list) {
              const full = path.join(dir, item.name);
              // P2: per-child workspace fence — skip anything escaping the root.
              const fence = assertChildInWorkspace(full, fenceRoot, fenceMode);
              if (!fence.allowed) {
                skippedOutOfBounds++;
                continue;
              }
              if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                walk(full);
              } else if (item.isFile() && regex.test(item.name)) {
                matches.push(full);
              }
            }
          } catch {}
        }

        if (stat.isDirectory()) {
          walk(targetPath);
        } else if (regex.test(path.basename(targetPath))) {
          matches.push(targetPath);
        }

        return { matches, count: matches.length, pattern, skippedOutOfBounds };
      }

      case 'grep': {
        const pattern = params.pattern || '';
        if (!pattern) throw new Error('MISSING_PATTERN: pattern is required for grep');
        if (pattern.length > GREP_MAX_PATTERN_LENGTH) {
          throw new Error(
            `PATTERN_TOO_LONG: grep pattern exceeds ${GREP_MAX_PATTERN_LENGTH} characters (${pattern.length})`
          );
        }

        const regex = new RegExp(pattern, 'i');
        const matches: Array<{ file: string; line: number; text: string }> = [];
        let skippedOutOfBounds = 0;
        let skippedOversizedFiles = 0;

        function searchFile(filePath: string) {
          try {
            // P2: resource cap — skip oversized files (>2MB)
            try {
              const st = fs.statSync(filePath);
              if (st.size > GREP_MAX_FILE_BYTES) {
                skippedOversizedFiles++;
                return;
              }
            } catch {
              return;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            lines.forEach((lineText, idx) => {
              if (regex.test(lineText)) {
                matches.push({ file: filePath, line: idx + 1, text: lineText.trim() });
              }
            });
          } catch {}
        }

        function walk(dir: string) {
          try {
            const list = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of list) {
              const full = path.join(dir, item.name);
              // P2: per-child workspace fence — skip anything escaping the root.
              const fence = assertChildInWorkspace(full, fenceRoot, fenceMode);
              if (!fence.allowed) {
                skippedOutOfBounds++;
                continue;
              }
              if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                walk(full);
              } else if (item.isFile()) {
                searchFile(full);
              }
            }
          } catch {}
        }

        if (stat.isFile()) {
          searchFile(targetPath);
        } else {
          walk(targetPath);
        }

        return {
          matches,
          count: matches.length,
          pattern,
          skippedOutOfBounds,
          skippedOversizedFiles
        };
      }

      default:
        throw new Error(`UNKNOWN_FS_EXPLORE_ACTION: ${params.action}`);
    }
  }

  /**
   * Mutates the filesystem with automatic pre-mutation snapshot.
   *
   * P2: fail-closed — if the pre-mutation snapshot fails, the mutation is
   * rejected with an error instead of proceeding unprotected. The snapshot also
   * covers the concrete target files (protected copies), so untracked and
   * gitignored targets (e.g. .env) can be rolled back.
   */
  public static mutate(
    params: {
      action: 'write' | 'edit' | 'move' | 'delete';
      path: string;
      content?: string;
      oldText?: string;
      newText?: string;
      destination?: string;
      recursive?: boolean;
    },
    workspaceRoot: string
  ): any {
    const targetPath = params.path;
    const dest = (params as any)._resolvedDestination || params.destination;

    // Pre-snapshot existence guard for edit/move/delete: prevents stale approvals
    // from creating empty checkpoints or executing against paths that were already
    // renamed or removed.
    if (params.action === 'edit' && !fs.existsSync(targetPath)) {
      throw new Error(`FILE_NOT_FOUND: ${targetPath}`);
    }
    if (params.action === 'move') {
      if (!dest) {
        throw new Error('DESTINATION_REQUIRED: destination is required for move action');
      }
      if (!fs.existsSync(targetPath)) {
        throw new Error(`SOURCE_NOT_FOUND: ${targetPath}`);
      }
    }
    if (params.action === 'delete' && !fs.existsSync(targetPath)) {
      throw new Error(`FILE_NOT_FOUND: Target path no longer exists: ${targetPath}`);
    }

    // P2: fail-closed snapshot — no swallowing. The mutation target (and move
    // destination) are passed as protected targets so the pre-mutation content
    // of untracked/gitignored files is captured too.
    let checkpointId = '';
    try {
      const protectedTargets = [targetPath];
      if (params.action === 'move' && dest) {
        protectedTargets.push(dest);
      }
      checkpointId = GitCheckpointManager.create('pre-fs-mutate', workspaceRoot, protectedTargets);
    } catch (err: any) {
      throw new Error(
        `CHECKPOINT_SNAPSHOT_FAILED: Pre-mutation snapshot failed, mutation rejected (${err?.message || err})`
      );
    }

    switch (params.action) {
      case 'write': {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, params.content ?? '', 'utf-8');
        return {
          action: 'write',
          path: targetPath,
          bytesWritten: Buffer.byteLength(params.content ?? '', 'utf-8'),
          checkpointId
        };
      }

      case 'edit': {
        if (!fs.existsSync(targetPath)) {
          throw new Error(`FILE_NOT_FOUND: ${targetPath}`);
        }
        if (typeof params.oldText !== 'string' || typeof params.newText !== 'string') {
          throw new Error('EDIT_PARAMETERS_REQUIRED: oldText and newText are required for edit action');
        }

        const existing = fs.readFileSync(targetPath, 'utf-8');
        if (!existing.includes(params.oldText)) {
          throw new Error(`EDIT_TARGET_NOT_FOUND: oldText not found in ${targetPath}`);
        }

        const updated = existing.replace(params.oldText, params.newText);
        fs.writeFileSync(targetPath, updated, 'utf-8');
        return {
          action: 'edit',
          path: targetPath,
          checkpointId
        };
      }

      case 'move': {
        if (!dest) {
          throw new Error('DESTINATION_REQUIRED: destination is required for move action');
        }
        if (!fs.existsSync(targetPath)) {
          throw new Error(`SOURCE_NOT_FOUND: ${targetPath}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(targetPath, dest);
        return {
          action: 'move',
          from: targetPath,
          to: dest,
          checkpointId
        };
      }

      case 'delete': {
        if (fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { recursive: !!params.recursive, force: true });
        }
        return {
          action: 'delete',
          path: targetPath,
          checkpointId
        };
      }

      default:
        throw new Error(`UNKNOWN_FS_MUTATE_ACTION: ${params.action}`);
    }
  }
}

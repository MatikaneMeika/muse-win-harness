/**
 * `skill_read` — the only supported way for Muse to fetch the full text of an
 * enabled local Skill. Reads `<skillDir>/SKILL.md` only; disabled entries are
 * rejected by the manager before this module runs, and paths outside the recorded
 * directory are never followed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResourceEntry } from './types.js';

export const MAX_SKILL_READ_BYTES = 256 * 1024;

/** `C:\Users\me\.claude\skills\x` -> `~\.claude\skills\x` for human-facing output. */
export function toTildePath(absolutePath: string, homeDir = os.homedir()): string {
  if (!absolutePath) return '';
  const normalized = path.normalize(absolutePath);
  const home = path.normalize(homeDir);
  if (normalized.toLowerCase() === home.toLowerCase()) return '~';
  if (normalized.toLowerCase().startsWith(`${home.toLowerCase()}${path.sep}`)) {
    return `~${normalized.slice(home.length)}`;
  }
  return normalized;
}

export interface SkillReadResult {
  name: string;
  description: string;
  content: string;
  path: string;
  truncated: boolean;
}

export function readSkillContent(entry: ResourceEntry): SkillReadResult {
  if (!entry.skillDir) {
    throw new Error(`SKILL_NOT_READABLE: '${entry.displayName}' has no recorded directory`);
  }
  const skillFile = path.resolve(entry.skillDir, 'SKILL.md');
  const root = path.resolve(entry.skillDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(skillFile);
  } catch {
    throw new Error(`SKILL_NOT_AVAILABLE: '${entry.displayName}' has no readable SKILL.md`);
  }
  if (!stat.isFile()) {
    throw new Error(`SKILL_NOT_AVAILABLE: '${entry.displayName}' SKILL.md is not a file`);
  }
  // A symlinked SKILL.md must not redirect the read outside the recorded directory.
  try {
    const realRoot = fs.realpathSync(root).toLowerCase();
    const realFile = fs.realpathSync(skillFile).toLowerCase();
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`SKILL_NOT_READABLE: '${entry.displayName}' SKILL.md resolves outside its directory`);
    }
  } catch (err: any) {
    if (String(err?.message || err).startsWith('SKILL_NOT_READABLE')) throw err;
    throw new Error(`SKILL_NOT_AVAILABLE: '${entry.displayName}' SKILL.md is not accessible`);
  }
  let content = fs.readFileSync(skillFile, 'utf-8');
  const truncated = content.length > MAX_SKILL_READ_BYTES;
  if (truncated) {
    content = content.slice(0, MAX_SKILL_READ_BYTES);
  }
  return {
    name: entry.displayName,
    description: entry.skillDescription || '',
    content,
    path: toTildePath(root),
    truncated
  };
}

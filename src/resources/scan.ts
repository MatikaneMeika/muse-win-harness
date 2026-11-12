/**
 * Read-only discovery of local MCP servers and Skill directories.
 *
 * Guarantees:
 * - Only READ operations (`existsSync` / `readFileSync` / `readdirSync`); no
 *   external product configuration is ever rewritten.
 * - Every discovered entry starts with `enabled: false`; whether an entry is
 *   exposed to Muse is decided solely by the MWH registry.
 * - Unrecognised / malformed files are skipped with a reason, never fatal.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envSecretRef, headersSecretRef, shortIdFragment, storeResourceSecret } from './registry.js';
import { sanitizeToolNameSegment } from './toolNames.js';
import type { ResourceEntry, ResourceScanOutcome, ResourceScanSkip } from './types.js';

export interface ScanOptions {
  workspaceRoot: string;
  homeDir?: string;
  appDataDir?: string;
}

interface McpConfigSource {
  key: string;
  label: string;
  filePath: string;
  /** JSON key holding the server map; both are probed when not specified. */
  serverKeys?: string[];
}

const SKILL_DESCRIPTION_LIMIT = 240;

function defaultHomeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function defaultAppDataDir(): string {
  return process.env.APPDATA || path.join(defaultHomeDir(), 'AppData', 'Roaming');
}

function mcpConfigSources(opts: Required<ScanOptions>): McpConfigSource[] {
  return [
    {
      key: 'claude-desktop',
      label: 'Claude Desktop',
      filePath: path.join(opts.appDataDir, 'Claude', 'claude_desktop_config.json')
    },
    {
      key: 'cursor',
      label: 'Cursor',
      filePath: path.join(opts.homeDir, '.cursor', 'mcp.json')
    },
    {
      key: 'cursor-workspace',
      label: 'Cursor 工作区',
      filePath: path.join(opts.workspaceRoot, '.cursor', 'mcp.json')
    },
    {
      key: 'claude-code',
      label: 'Claude Code',
      filePath: path.join(opts.homeDir, '.claude.json')
    },
    {
      key: 'vscode',
      label: 'VS Code',
      filePath: path.join(opts.appDataDir, 'Code', 'User', 'mcp.json'),
      serverKeys: ['servers', 'mcpServers']
    },
    {
      key: 'muse',
      label: 'Muse Code',
      filePath: path.join(opts.homeDir, '.muse', 'mcp.json')
    }
  ];
}

function skillRoots(opts: Required<ScanOptions>): Array<{ key: string; label: string; dir: string }> {
  return [
    { key: 'agents', label: 'Agents', dir: path.join(opts.homeDir, '.agents', 'skills') },
    { key: 'claude', label: 'Claude', dir: path.join(opts.homeDir, '.claude', 'skills') },
    { key: 'cursor', label: 'Cursor', dir: path.join(opts.homeDir, '.cursor', 'skills') },
    { key: 'workspace-agents', label: '工作区 Agents', dir: path.join(opts.workspaceRoot, '.agents', 'skills') },
    { key: 'workspace-claude', label: '工作区 Claude', dir: path.join(opts.workspaceRoot, '.claude', 'skills') }
  ];
}

function readJsonFile(filePath: string): { ok: true; value: any } | { ok: false; reason: string } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    return { ok: false, reason: `无法读取：${err?.message || String(err)}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: '不是有效的 JSON，已跳过' };
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Extracts a short human summary from SKILL.md: YAML description or first paragraph. */
export function extractSkillDescription(skillMdPath: string): string {
  let text = '';
  try {
    text = fs.readFileSync(skillMdPath, 'utf-8');
  } catch {
    return '';
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (frontmatter) {
    const descLine = /^description\s*:\s*(.+)$/im.exec(frontmatter[1]);
    if (descLine) {
      const value = descLine[1].trim().replace(/^["']|["']$/g, '');
      if (value) return value.slice(0, SKILL_DESCRIPTION_LIMIT);
    }
  }
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('<!--')) continue;
    return line.replace(/\s+/g, ' ').slice(0, SKILL_DESCRIPTION_LIMIT);
  }
  return '';
}

function scanMcpConfig(
  source: McpConfigSource,
  workspaceRoot: string,
  discovered: ResourceEntry[],
  skipped: ResourceScanSkip[]
): void {
  if (!fs.existsSync(source.filePath)) return;
  const parsed = readJsonFile(source.filePath);
  if (!parsed.ok) {
    skipped.push({ path: source.filePath, reason: parsed.reason });
    return;
  }
  const root = parsed.value;
  if (!root || typeof root !== 'object') {
    skipped.push({ path: source.filePath, reason: '顶层不是对象，已跳过' });
    return;
  }
  const candidateKeys = source.serverKeys || ['mcpServers', 'servers'];
  let serverMap: Record<string, any> | undefined;
  for (const key of candidateKeys) {
    if (root[key] && typeof root[key] === 'object' && !Array.isArray(root[key])) {
      serverMap = root[key];
      break;
    }
  }
  if (!serverMap) return;

  for (const [serverKey, rawConfig] of Object.entries(serverMap)) {
    if (!rawConfig || typeof rawConfig !== 'object') continue;
    const config = rawConfig as Record<string, any>;
    const displayName = String(serverKey).trim();
    if (!displayName) continue;

    const httpUrlRaw =
      typeof config.url === 'string' && config.url.trim()
        ? config.url.trim()
        : typeof config.serverUrl === 'string' && config.serverUrl.trim()
          ? config.serverUrl.trim()
          : '';
    const typeHint = String(config.type || config.transport || '').toLowerCase();
    const urlLooksHttp = /^https?:\/\//i.test(httpUrlRaw);

    const entry: ResourceEntry = {
      id: `scan_${source.key}_${sanitizeToolNameSegment(serverKey, 'server').toLowerCase()}`,
      kind: 'mcp',
      displayName,
      enabled: false,
      source: 'scan',
      sourceLabel: `扫描自 ${source.label}`,
      readonly: false,
      runtimeStatus: 'stopped'
    };

    if (urlLooksHttp || (httpUrlRaw && (typeHint === 'http' || typeHint === 'streamable-http' || typeHint === 'sse'))) {
      entry.transport = 'http';
      entry.httpUrl = httpUrlRaw;
      const rawHeaders =
        config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
          ? config.headers
          : null;
      if (rawHeaders) {
        const headerMap: Record<string, string> = {};
        for (const [name, value] of Object.entries(rawHeaders)) {
          if (typeof value === 'string') headerMap[name] = value;
        }
        if (Object.keys(headerMap).length > 0) {
          const ref = headersSecretRef(entry.id);
          // Values are encrypted into MWH's own secret file — external config is
          // never rewritten and the registry only keeps the reference.
          if (storeResourceSecret(workspaceRoot, ref, JSON.stringify(headerMap))) {
            entry.httpHeaderSecretKey = ref;
          }
        }
      }
    } else if (typeof config.command === 'string' && config.command.trim()) {
      entry.transport = 'stdio';
      entry.command = config.command.trim();
      entry.args = isStringArray(config.args) ? config.args : [];
      if (typeof config.cwd === 'string' && config.cwd.trim()) entry.cwd = config.cwd.trim();
      if (config.env && typeof config.env === 'object' && !Array.isArray(config.env)) {
        const storedKeys: string[] = [];
        for (const [envName, envValue] of Object.entries(config.env as Record<string, unknown>)) {
          if (typeof envValue !== 'string') continue;
          storeResourceSecret(workspaceRoot, envSecretRef(entry.id, envName), envValue);
          storedKeys.push(envName);
        }
        if (storedKeys.length > 0) entry.envSecretKeys = storedKeys;
      }
    } else {
      skipped.push({ path: `${source.filePath}#${serverKey}`, reason: '既没有 command 也没有 HTTP URL，已跳过' });
      continue;
    }

    discovered.push(entry);
  }
}

function scanSkillRoots(
  opts: Required<ScanOptions>,
  discovered: ResourceEntry[],
  skipped: ResourceScanSkip[]
): void {
  for (const root of skillRoots(opts)) {
    if (!fs.existsSync(root.dir)) continue;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch (err: any) {
      skipped.push({ path: root.dir, reason: `无法列出目录：${err?.message || String(err)}` });
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const skillDir = path.join(root.dir, dirent.name);
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      discovered.push({
        id: `skill_${shortIdFragment(skillDir)}`,
        kind: 'skill',
        displayName: dirent.name,
        enabled: false,
        source: 'scan',
        sourceLabel: `扫描自 ${root.label}`,
        readonly: false,
        skillDir,
        skillDescription: extractSkillDescription(skillMd),
        runtimeStatus: 'stopped'
      });
    }
  }
}

/**
 * Scans known local configuration locations. Never mutates anything on disk —
 * the returned entries are merged into the MWH registry by the manager.
 */
export function scanLocalResources(options: ScanOptions): ResourceScanOutcome {
  const opts: Required<ScanOptions> = {
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir || defaultHomeDir(),
    appDataDir: options.appDataDir || defaultAppDataDir()
  };
  const discovered: ResourceEntry[] = [];
  const skipped: ResourceScanSkip[] = [];
  const seen = new Set<string>();

  for (const source of mcpConfigSources(opts)) {
    scanMcpConfig(source, opts.workspaceRoot, discovered, skipped);
  }
  scanSkillRoots(opts, discovered, skipped);

  const unique: ResourceEntry[] = [];
  for (const entry of discovered) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }

  return { discovered: unique, added: [], skipped };
}

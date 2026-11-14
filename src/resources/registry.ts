/**
 * Local resource registry.
 *
 * Enabled MCP servers are projected to `.mwh/mcp.json` in the industry-standard
 * `{ "mcpServers": { name: { command, args, cwd } | { url } } }` shape used by
 * Claude / Cursor / VS Code. Enabled Skills are projected to `.mwh/skills.json`
 * as `{ "skills": { name: { path } } }`. The full catalogue (including disabled
 * entries and MWH metadata) stays in `.mwh/resources.json`. Secrets stay in the
 * DPAPI sidecar `.mwh/resource-secrets.json` and are never written into mcp.json.
 *
 * All of these files are machine-local and git-ignored. Scanning external
 * products is read-only and never writes Claude / Cursor / Muse Code configuration
 * back. Secret VALUES never appear in the catalogue — entries only carry the
 * names of env vars / the header map key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dpapiProtectString, dpapiUnprotectString } from '../security/secretStore.js';
import type { ResourceEntry } from './types.js';

export const RESOURCES_SCHEMA = 'mwh-resources/v1';
export const RESOURCE_SECRETS_SCHEMA = 'mwh-resource-secrets/v1-dpapi';

const PERSISTED_KEYS: Array<keyof ResourceEntry> = [
  'id',
  'kind',
  'displayName',
  'enabled',
  'source',
  'sourceLabel',
  'readonly',
  'transport',
  'command',
  'args',
  'cwd',
  'envSecretKeys',
  'httpUrl',
  'httpHeaderSecretKey',
  'skillDir',
  'skillDescription'
];

export function resolveResourcesFilePath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, '.mwh', 'resources.json');
}

export function resolveMcpJsonPath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, '.mwh', 'mcp.json');
}

export function resolveSkillsJsonPath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, '.mwh', 'skills.json');
}

export function resolveResourceSecretsFilePath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, '.mwh', 'resource-secrets.json');
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(payload, null, 2);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup of the temp file.
    }
    fs.writeFileSync(filePath, text, 'utf-8');
  }
}

/** Strips runtime-only fields (status / fault / exposed names) before saving. */
export function toPersistedEntry(entry: ResourceEntry): ResourceEntry {
  const out: Record<string, unknown> = {};
  for (const key of PERSISTED_KEYS) {
    const value = entry[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out as unknown as ResourceEntry;
}

export function loadResourceEntries(workspaceRoot: string): ResourceEntry[] {
  const filePath = resolveResourcesFilePath(workspaceRoot);
  if (!fs.existsSync(filePath)) return importStandardFiles(workspaceRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const entries: ResourceEntry[] = [];
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.id !== 'string' || !raw.id) continue;
      if (raw.kind !== 'mcp' && raw.kind !== 'skill') continue;
      entries.push({
        ...raw,
        displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : raw.id,
        enabled: raw.enabled === true,
        source: raw.source === 'scan' ? 'scan' : 'manual',
        sourceLabel:
          typeof raw.sourceLabel === 'string' && raw.sourceLabel
            ? raw.sourceLabel
            : raw.source === 'scan'
              ? '扫描发现'
              : '手动添加',
        readonly: raw.readonly === true,
        runtimeStatus: 'stopped'
      });
    }
    return entries;
  } catch {
    return [];
  }
}

export function saveResourceEntries(workspaceRoot: string, entries: ResourceEntry[]): void {
  const persisted = entries.map(toPersistedEntry);
  writeJsonAtomic(resolveResourcesFilePath(workspaceRoot), {
    schema: RESOURCES_SCHEMA,
    updatedAt: new Date().toISOString(),
    entries: persisted
  });
  // Standard projections for Muse / other harnesses. Enabled only; no secrets.
  writeJsonAtomic(resolveMcpJsonPath(workspaceRoot), toStandardMcpJson(persisted));
  writeJsonAtomic(resolveSkillsJsonPath(workspaceRoot), toStandardSkillsJson(persisted));
}

/** Sanitise a display name into a unique mcpServers / skills object key. */
export function standardConfigKey(displayName: string, id: string, used: Set<string>): string {
  const base =
    (displayName || id)
      .replace(/[^A-Za-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || id;
  let key = base;
  let n = 2;
  while (used.has(key.toLowerCase())) {
    key = `${base}-${n++}`;
  }
  used.add(key.toLowerCase());
  return key;
}

/**
 * Industry-standard MCP config: only enabled servers, no env/header secrets.
 * stdio → { command, args?, cwd? }; Streamable HTTP → { url }.
 */
export function toStandardMcpJson(entries: ResourceEntry[]): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const used = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'mcp' || entry.enabled !== true) continue;
    const key = standardConfigKey(entry.displayName, entry.id, used);
    if (entry.transport === 'http') {
      if (typeof entry.httpUrl === 'string' && entry.httpUrl) {
        mcpServers[key] = { url: entry.httpUrl };
      }
      continue;
    }
    if (typeof entry.command === 'string' && entry.command) {
      const server: Record<string, unknown> = { command: entry.command };
      if (Array.isArray(entry.args) && entry.args.length > 0) server.args = entry.args;
      if (typeof entry.cwd === 'string' && entry.cwd) server.cwd = entry.cwd;
      mcpServers[key] = server;
    }
  }
  return { mcpServers };
}

/** Enabled Skill directory pointers, one path each. */
export function toStandardSkillsJson(entries: ResourceEntry[]): { skills: Record<string, { path: string }> } {
  const skills: Record<string, { path: string }> = {};
  const used = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'skill' || entry.enabled !== true) continue;
    if (typeof entry.skillDir !== 'string' || !entry.skillDir) continue;
    const key = standardConfigKey(entry.displayName, entry.id, used);
    skills[key] = { path: entry.skillDir };
  }
  return { skills };
}

/**
 * Bootstrap a catalogue from standard files when `.mwh/resources.json` is absent
 * (for example a user dropped in an mcp.json by hand). Subsequent saves write
 * the full catalogue back to resources.json.
 */
function importStandardFiles(workspaceRoot: string): ResourceEntry[] {
  const entries: ResourceEntry[] = [];
  const mcpPath = resolveMcpJsonPath(workspaceRoot);
  if (fs.existsSync(mcpPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as {
        mcpServers?: Record<string, Record<string, unknown>>;
      };
      const servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
      for (const [name, raw] of Object.entries(servers)) {
        if (!raw || typeof raw !== 'object') continue;
        const url = typeof raw.url === 'string' ? raw.url : undefined;
        const command = typeof raw.command === 'string' ? raw.command : undefined;
        if (!url && !command) continue;
        const args = Array.isArray(raw.args)
          ? raw.args.filter((item): item is string => typeof item === 'string')
          : undefined;
        const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;
        const disabled = raw.disabled === true;
        entries.push({
          id: `mcp_${shortIdFragment(`mcp.json:${name}`)}`,
          kind: 'mcp',
          displayName: name || 'mcp',
          enabled: !disabled,
          source: 'manual',
          sourceLabel: '本机 mcp.json',
          readonly: false,
          transport: url ? 'http' : 'stdio',
          command,
          args,
          cwd,
          httpUrl: url,
          runtimeStatus: 'stopped'
        });
      }
    } catch {
      // Corrupt mcp.json: start with an empty catalogue rather than crash.
    }
  }
  const skillsPath = resolveSkillsJsonPath(workspaceRoot);
  if (fs.existsSync(skillsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(skillsPath, 'utf-8')) as {
        skills?: Record<string, { path?: unknown }>;
      };
      const skills = parsed?.skills && typeof parsed.skills === 'object' ? parsed.skills : {};
      for (const [name, raw] of Object.entries(skills)) {
        const skillDir = raw && typeof raw.path === 'string' ? raw.path : '';
        if (!skillDir) continue;
        entries.push({
          id: `skill_${shortIdFragment(`skills.json:${name}:${skillDir}`)}`,
          kind: 'skill',
          displayName: name || 'skill',
          enabled: true,
          source: 'manual',
          sourceLabel: '本机 skills.json',
          readonly: false,
          skillDir,
          runtimeStatus: 'stopped'
        });
      }
    } catch {
      // Corrupt skills.json is ignored the same way.
    }
  }
  return entries;
}

interface ResourceSecretFile {
  schema?: string;
  items?: Record<string, string>;
}

function readSecretItems(workspaceRoot: string): Record<string, string> {
  const filePath = resolveResourceSecretsFilePath(workspaceRoot);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed: ResourceSecretFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed?.items && typeof parsed.items === 'object' ? parsed.items : {};
  } catch {
    return {};
  }
}

function writeSecretItems(workspaceRoot: string, items: Record<string, string>): void {
  writeJsonAtomic(resolveResourceSecretsFilePath(workspaceRoot), {
    schema: RESOURCE_SECRETS_SCHEMA,
    updatedAt: new Date().toISOString(),
    items
  });
}

/** Stable pseudo-key for an entry's env var so names never leak into the registry. */
export function envSecretRef(entryId: string, envName: string): string {
  return `${entryId}::env::${envName}`;
}

export function headersSecretRef(entryId: string): string {
  return `${entryId}::headers`;
}

/**
 * Stores one secret value (DPAPI encrypted). Returns false when DPAPI is
 * unavailable (non-Windows / reduced environment) — the caller must surface the
 * degradation instead of silently persisting plaintext.
 */
export function storeResourceSecret(workspaceRoot: string, ref: string, value: string): boolean {
  try {
    const items = readSecretItems(workspaceRoot);
    items[ref] = dpapiProtectString(value);
    writeSecretItems(workspaceRoot, items);
    return true;
  } catch {
    return false;
  }
}

export function readResourceSecret(workspaceRoot: string, ref: string): string | null {
  try {
    const items = readSecretItems(workspaceRoot);
    const cipher = items[ref];
    if (!cipher) return null;
    return dpapiUnprotectString(cipher);
  } catch {
    return null;
  }
}

export function deleteResourceSecrets(workspaceRoot: string, entryId: string): void {
  try {
    const items = readSecretItems(workspaceRoot);
    const prefix = `${entryId}::`;
    let changed = false;
    for (const key of Object.keys(items)) {
      if (key.startsWith(prefix)) {
        delete items[key];
        changed = true;
      }
    }
    if (changed) writeSecretItems(workspaceRoot, items);
  } catch {
    // Secret cleanup is best-effort; orphaned DPAPI blobs are unreadable names only.
  }
}

/** Env map for a stdio MCP child: decrypted values for the recorded key names. */
export function loadEntryEnv(workspaceRoot: string, entry: ResourceEntry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of entry.envSecretKeys || []) {
    const value = readResourceSecret(workspaceRoot, envSecretRef(entry.id, name));
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Header map for a Streamable HTTP MCP session (JSON stored encrypted). */
export function loadEntryHeaders(workspaceRoot: string, entry: ResourceEntry): Record<string, string> {
  if (!entry.httpHeaderSecretKey) return {};
  const raw = readResourceSecret(workspaceRoot, entry.httpHeaderSecretKey);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Deterministic, filesystem-safe id fragment. */
export function shortIdFragment(value: string): string {
  return crypto.createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 10);
}

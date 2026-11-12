/**
 * Local resource registry — `.mwh/resources.json` plus the DPAPI-backed secret
 * sidecar `.mwh/resource-secrets.json`.
 *
 * The registry is machine-local state: it is git-ignored and never written back
 * into Claude / Cursor / Muse Code configuration. Secret VALUES never appear in
 * the registry — entries only carry the names of env vars / the header map key,
 * and the values are encrypted with the existing `secretStore` DPAPI helpers.
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
  if (!fs.existsSync(filePath)) return [];
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
  writeJsonAtomic(resolveResourcesFilePath(workspaceRoot), {
    schema: RESOURCES_SCHEMA,
    updatedAt: new Date().toISOString(),
    entries: entries.map(toPersistedEntry)
  });
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
  return crypto.createHash('sha1').update(value.toLowerCase()).digest('hex').slice(0, 10);
}

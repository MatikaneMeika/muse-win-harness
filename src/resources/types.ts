/**
 * Local MCP / Skill resource library — shared types.
 *
 * The registry lives in `.mwh/resources.json` (git-ignored, machine-local).
 * Enabled state only ever exists there: scanning external products is
 * read-only and never writes Claude / Cursor / Muse Code configuration back.
 */

export type ResourceKind = 'mcp' | 'skill';
export type McpTransport = 'stdio' | 'http';
export type ResourceRuntimeStatus = 'stopped' | 'starting' | 'running' | 'fault';

export interface ExposedToolName {
  original: string;
  exposed: string;
}

export interface ResourceEntry {
  /** Stable identity, unique inside the registry (scan merge key). */
  id: string;
  kind: ResourceKind;
  /** User-visible short name; also the base of the exposed tool prefix. */
  displayName: string;
  enabled: boolean;
  source: 'scan' | 'manual';
  /** e.g. 「扫描自 Cursor」「手动添加」— UI only. */
  sourceLabel: string;
  /** Only editable per entry; plan mode passes through when true. */
  readonly: boolean;

  // --- MCP ---
  transport?: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Names of env vars whose values live in the DPAPI secret store, never here. */
  envSecretKeys?: string[];
  httpUrl?: string;
  /** Secret-store key holding the JSON header map, never plaintext. */
  httpHeaderSecretKey?: string;

  // --- Skill ---
  /** Absolute local path; backend only — UI renders the `~` form. */
  skillDir?: string;
  /** First paragraph / YAML frontmatter description of SKILL.md. */
  skillDescription?: string;

  // --- runtime (not persisted) ---
  runtimeStatus?: ResourceRuntimeStatus;
  /** Short Chinese reason shown as an amber badge, e.g. 「启动超时」. */
  faultReason?: string;
  exposedToolNames?: ExposedToolName[];
  toolCount?: number;
}

/** Entry shape handed to the UI: no absolute private path, no secret values. */
export interface PublicResourceEntry extends Omit<ResourceEntry, 'skillDir'> {
  skillDirDisplay?: string;
}

export interface ResourceScanSkip {
  path: string;
  reason: string;
}

export interface ResourceScanOutcome {
  /** Newly discovered entries only; already registered ids are untouched. */
  discovered: ResourceEntry[];
  /** Entries actually added to the registry by this scan. */
  added: string[];
  skipped: ResourceScanSkip[];
}

export interface ResourceStatusSummary {
  enabledCount: number;
  mcp: Array<{
    id: string;
    displayName: string;
    status: ResourceRuntimeStatus;
    faultReason?: string;
    toolCount: number;
    readonly: boolean;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    available: boolean;
  }>;
}

export interface ResourceProbeResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
  faultReason?: string;
}

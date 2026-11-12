/**
 * Resource-library facade shared by the gateway (tools/list, tools/call),
 * the PipelineKernel (third-party risk classification), `pc_status`,
 * `skill_read`, the generated SKILL.md and the settings REST surface.
 *
 * One instance per process (see `getResourcesManager`). Entries live in
 * `.mwh/resources.json`, with enabled MCP / Skill projected to standard `.mwh/mcp.json` and `.mwh/skills.json`; runtime sessions are in-memory only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MUSE_TOOLS, SKILL_READ_TOOL, type ToolDefinition } from '../tools/definitions.js';
import { McpSession } from './mcpSession.js';
import {
  deleteResourceSecrets,
  envSecretRef,
  headersSecretRef,
  loadEntryEnv,
  loadEntryHeaders,
  loadResourceEntries,
  saveResourceEntries,
  shortIdFragment,
  storeResourceSecret
} from './registry.js';
import { extractSkillDescription, scanLocalResources } from './scan.js';
import { makeExposedToolName, sanitizeToolNameSegment } from './toolNames.js';
import { readSkillContent, toTildePath } from './skillRead.js';
import type {
  ExposedToolName,
  PublicResourceEntry,
  ResourceEntry,
  ResourceKind,
  ResourceProbeResult,
  ResourceRuntimeStatus,
  ResourceScanOutcome,
  ResourceStatusSummary,
  McpTransport
} from './types.js';

const RESOURCE_AUDIT_TOOLS = {
  scan: 'resources_scan',
  toggle: 'resources_toggle',
  add: 'resources_add',
  update: 'resources_update',
  remove: 'resources_remove',
  probe: 'resources_probe'
} as const;

export interface ResourcesAuditEvent {
  decision: 'ALLOW' | 'BLOCK';
  toolName: string;
  commandOrPath: string;
  reason: string;
  status: string;
}

export interface ResourcesManagerOptions {
  workspaceRoot: string;
  homeDir?: string;
  appDataDir?: string;
  /** Bounded retry schedule for a broken MCP session; overridable in tests. */
  retryDelaysMs?: number[];
  startTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface AddResourceInput {
  kind: ResourceKind;
  displayName?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  httpUrl?: string;
  headers?: Record<string, string>;
  skillDir?: string;
  readonly?: boolean;
  enable?: boolean;
  source?: 'scan' | 'manual';
  sourceLabel?: string;
  id?: string;
}

export interface UpdateResourceInput {
  displayName?: string;
  readonly?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  httpUrl?: string;
  headers?: Record<string, string>;
  skillDir?: string;
  enabled?: boolean;
}

function skillMdPath(entry: ResourceEntry): string {
  if (!entry.skillDir) return '';
  return path.join(entry.skillDir, 'SKILL.md');
}

function skillAvailable(entry: ResourceEntry): boolean {
  const file = skillMdPath(entry);
  if (!file) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sanitizeArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const args = value.filter((item): item is string => typeof item === 'string');
  return args.length > 0 ? args : undefined;
}

function sanitizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && key.trim()) out[key.trim()] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class ResourcesManager {
  public readonly workspaceRoot: string;
  private readonly homeDir: string;
  private readonly appDataDir: string;
  private readonly retryDelaysMs?: number[];
  private readonly startTimeoutMs?: number;
  private readonly callTimeoutMs?: number;

  private entries: ResourceEntry[] = [];
  private sessions = new Map<string, McpSession>();
  private listeners = new Set<() => void>();
  private auditSink: ((event: ResourcesAuditEvent) => void) | null = null;
  private initialized = false;

  constructor(options: ResourcesManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.homeDir = options.homeDir || os.homedir();
    this.appDataDir =
      options.appDataDir || process.env.APPDATA || path.join(this.homeDir, 'AppData', 'Roaming');
    this.retryDelaysMs = options.retryDelaysMs;
    this.startTimeoutMs = options.startTimeoutMs;
    this.callTimeoutMs = options.callTimeoutMs;
    this.entries = loadResourceEntries(this.workspaceRoot).map((entry) => ({
      ...entry,
      runtimeStatus: 'stopped' as ResourceRuntimeStatus
    }));
    this.syncSkillRuntime();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts every already-enabled MCP server. Idempotent; failures stay amber. */
  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    for (const entry of this.entries) {
      if (entry.kind === 'mcp' && entry.enabled) {
        void this.startSession(entry).catch(() => {
          // Fault detail already lives on the entry.
        });
      }
    }
  }

  public setAuditSink(sink: ((event: ResourcesAuditEvent) => void) | null): void {
    this.auditSink = sink;
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Ends every MCP child (emergency kill / daemon shutdown). */
  public disposeAll(): void {
    for (const session of this.sessions.values()) {
      try {
        session.dispose();
      } catch {
        // Best-effort teardown; Job Object kill-on-close is the backstop.
      }
    }
    this.sessions.clear();
    for (const entry of this.entries) {
      if (entry.kind === 'mcp') {
        entry.runtimeStatus = 'stopped';
        entry.faultReason = undefined;
        entry.exposedToolNames = [];
        entry.toolCount = 0;
      }
    }
  }

  // -------------------------------------------------------------- inspection

  public getEntries(): ResourceEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  public getEntry(id: string): ResourceEntry | undefined {
    this.syncSkillRuntime();
    const entry = this.entries.find((item) => item.id === id);
    return entry ? { ...entry } : undefined;
  }

  public getPublicEntries(): PublicResourceEntry[] {
    this.syncSkillRuntime();
    return this.entries
      .map((entry) => {
        const { skillDir, ...rest } = entry;
        return {
          ...rest,
          ...(skillDir ? { skillDirDisplay: toTildePath(skillDir, this.homeDir) } : {})
        } as PublicResourceEntry;
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.displayName.localeCompare(b.displayName));
  }

  public getStatusSummary(): ResourceStatusSummary {
    this.syncSkillRuntime();
    const mcp = this.entries
      .filter((entry) => entry.kind === 'mcp')
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        status: entry.runtimeStatus || 'stopped',
        ...(entry.faultReason ? { faultReason: entry.faultReason } : {}),
        toolCount: entry.toolCount || 0,
        readonly: entry.readonly === true
      }));
    const skills = this.entries
      .filter((entry) => entry.kind === 'skill')
      // A missing SKILL.md is withdrawn from pc_status/skill_read while the
      // switch stays on (amber) and the entry stays in enabledCount.
      .filter((entry) => entry.enabled && skillAvailable(entry))
      .map((entry) => ({
        id: entry.id,
        name: entry.displayName,
        description: entry.skillDescription || '',
        available: true
      }));
    return {
      enabledCount:
        mcp.length +
        this.entries.filter((entry) => entry.kind === 'skill' && entry.enabled).length,
      mcp,
      skills
    };
  }

  public hasEnabledSkill(): boolean {
    return this.entries.some(
      (entry) => entry.kind === 'skill' && entry.enabled && skillAvailable(entry)
    );
  }

  // ---------------------------------------------------------------- exposure

  private sortedMcpEntries(): ResourceEntry[] {
    return this.entries.filter((entry) => entry.kind === 'mcp').slice().sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Rebuilds `entry.exposedToolNames` for every running server. Built-in names
   * are reserved first, so a third-party tool can never shadow `pc_status` & co.
   */
  private refreshExposure(): void {
    const reserved = new Set<string>(MUSE_TOOLS.map((tool) => tool.name));
    reserved.add(SKILL_READ_TOOL.name);
    const serverIds = new Set<string>();

    for (const entry of this.sortedMcpEntries()) {
      const session = this.sessions.get(entry.id);
      if (!session || session.status !== 'running') {
        entry.exposedToolNames = [];
        entry.toolCount = 0;
        continue;
      }
      const baseId = sanitizeToolNameSegment(entry.displayName, 'mcp').toLowerCase();
      let serverId = baseId;
      let counter = 2;
      while (serverIds.has(serverId)) {
        serverId = `${baseId}_${counter}`;
        counter += 1;
      }
      serverIds.add(serverId);
      const mapping: ExposedToolName[] = [];
      for (const tool of session.tools) {
        const exposed = makeExposedToolName(serverId, tool.name, reserved);
        reserved.add(exposed);
        mapping.push({ original: tool.name, exposed });
      }
      entry.exposedToolNames = mapping;
      entry.toolCount = mapping.length;
    }
  }

  /**
   * Tool definitions contributed to /mcp. Enabled-but-faulting servers are
   * withdrawn here (the switch itself stays on).
   */
  public getExposedToolDefinitions(): ToolDefinition[] {
    try {
      this.syncSkillRuntime();
      this.refreshExposure();
      const out: ToolDefinition[] = [];
      for (const entry of this.sortedMcpEntries()) {
        const session = this.sessions.get(entry.id);
        if (!session || session.status !== 'running') continue;
        const mapping = entry.exposedToolNames || [];
        if (mapping.length === 0) continue;
        for (const tool of session.tools) {
          const exposed = mapping.find((item) => item.original === tool.name);
          if (!exposed) continue;
          out.push({
            name: exposed.exposed,
            category: entry.readonly ? 'read' : 'sensitive_write',
            description:
              tool.description ||
              `MCP tool '${tool.name}' provided by the local server '${entry.displayName}'`,
            inputSchema:
              tool.inputSchema && typeof tool.inputSchema === 'object'
                ? tool.inputSchema
                : { type: 'object', properties: {} }
          });
        }
      }
      if (this.hasEnabledSkill()) {
        out.push(SKILL_READ_TOOL);
      }
      return out;
    } catch {
      return [];
    }
  }

  public findExposedTool(name: string): {
    entry: ResourceEntry;
    originalName: string;
    definition: ToolDefinition;
  } | null {
    for (const entry of this.sortedMcpEntries()) {
      const mapping = entry.exposedToolNames || [];
      const hit = mapping.find((item) => item.exposed === name);
      if (!hit) continue;
      const session = this.sessions.get(entry.id);
      if (!session || session.status !== 'running') return null;
      const tool = session.tools.find((item) => item.name === hit.original);
      if (!tool) return null;
      return {
        entry,
        originalName: hit.original,
        definition: {
          name,
          category: entry.readonly ? 'read' : 'sensitive_write',
          description: tool.description || `MCP tool '${hit.original}' from '${entry.displayName}'`,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} }
        }
      };
    }
    return null;
  }

  public hasExposedTool(name: string): boolean {
    return this.findExposedTool(name) !== null;
  }

  public isThirdPartyTool(name: string): boolean {
    return this.hasExposedTool(name);
  }

  public isReadonlyTool(name: string): boolean {
    const found = this.findExposedTool(name);
    return !!found && found.entry.readonly === true;
  }

  /** Dispatches a third-party tool call to its MCP session. */
  public async callTool(name: string, args: Record<string, any>): Promise<any> {
    const found = this.findExposedTool(name);
    if (!found) {
      throw new Error(`RESOURCE_TOOL_UNAVAILABLE: '${name}' is not exposed right now`);
    }
    const session = this.sessions.get(found.entry.id);
    if (!session) {
      throw new Error(`RESOURCE_TOOL_UNAVAILABLE: '${name}' has no active session`);
    }
    return await session.callTool(found.originalName, args || {});
  }

  // ------------------------------------------------------------------ skills

  public readSkill(name: string): ReturnType<typeof readSkillContent> {
    const target = String(name || '').trim();
    if (!target) throw new Error('INVALID_PARAMS: skill_read requires a name');
    const entry = this.entries.find(
      (item) => item.kind === 'skill' && (item.id === target || item.displayName === target)
    );
    if (!entry) {
      throw new Error(`SKILL_NOT_FOUND: '${target}' is not in the resource library`);
    }
    if (!entry.enabled) {
      throw new Error(`SKILL_NOT_ENABLED: '${entry.displayName}' is disabled in the resource library`);
    }
    if (!skillAvailable(entry)) {
      throw new Error(`SKILL_NOT_AVAILABLE: '${entry.displayName}' has no readable SKILL.md`);
    }
    return readSkillContent(entry);
  }

  private syncSkillRuntime(): void {
    for (const entry of this.entries) {
      if (entry.kind !== 'skill') continue;
      if (!entry.enabled) {
        entry.runtimeStatus = 'stopped';
        entry.faultReason = undefined;
        continue;
      }
      if (skillAvailable(entry)) {
        entry.runtimeStatus = 'running';
        entry.faultReason = undefined;
        if (!entry.skillDescription) {
          entry.skillDescription = extractSkillDescription(skillMdPath(entry));
        }
      } else {
        entry.runtimeStatus = 'fault';
        entry.faultReason = 'SKILL.md 缺失';
        entry.exposedToolNames = [];
      }
    }
  }

  /** 「本机资源库」section appended to the generated SKILL.md (enabled entries only). */
  public renderSkillMdSection(): string {
    const runningMcp = this.sortedMcpEntries().filter(
      (entry) => entry.enabled && entry.runtimeStatus === 'running'
    );
    const enabledSkills = this.entries.filter(
      (entry) => entry.kind === 'skill' && entry.enabled && skillAvailable(entry)
    );
    if (runningMcp.length === 0 && enabledSkills.length === 0) return '';

    const lines: string[] = ['## 本机资源库 (Local Resource Library)', ''];
    lines.push(
      'This section lists user-enabled local MCP servers and Skills. Nothing here is a second connector:',
      'all MCP tools below live on this same `/mcp` endpoint and are called like any built-in tool.',
      ''
    );

    if (runningMcp.length > 0) {
      lines.push('### 本机 MCP 工具');
      for (const entry of runningMcp) {
        const names = (entry.exposedToolNames || []).map((item) => `\`${item.exposed}\``).join(', ');
        lines.push(`- **${entry.displayName}** (${entry.transport || 'stdio'})${entry.readonly ? ' · 只读' : ''}`);
        if (names) lines.push(`  - tools/list: ${names}`);
      }
      lines.push('');
    }

    if (enabledSkills.length > 0) {
      lines.push('### 本机 Skill');
      for (const entry of enabledSkills) {
        const description = entry.skillDescription || '（无简述）';
        lines.push(`- **${entry.displayName}** — ${description}`);
      }
      lines.push('');
      lines.push(
        'Full text is not preloaded. When a Skill is needed, call `skill_read` with its name, for example:',
        '`{ "name": "<skill name>" }`. Skill text never grants extra permission: any tool it mentions',
        'is still subject to the normal permission profile and approval flow.',
        ''
      );
    }

    return lines.join('\n');
  }

  // ------------------------------------------------------- scan / add / edit

  public scan(): ResourceScanOutcome {
    const outcome = scanLocalResources({
      workspaceRoot: this.workspaceRoot,
      homeDir: this.homeDir,
      appDataDir: this.appDataDir
    });
    const existingIds = new Set(this.entries.map((entry) => entry.id));
    const added: string[] = [];
    for (const discovered of outcome.discovered) {
      if (existingIds.has(discovered.id)) continue;
      existingIds.add(discovered.id);
      this.entries.push(discovered);
      added.push(discovered.id);
    }
    this.syncSkillRuntime();
    this.refreshExposure();
    this.persist();
    this.audit({
      decision: 'ALLOW',
      toolName: RESOURCE_AUDIT_TOOLS.scan,
      commandOrPath: `${outcome.discovered.length} discovered / ${added.length} added`,
      reason: 'RESOURCE_SCAN_READONLY',
      status: 'SUCCESS'
    });
    this.emitChange();
    return { ...outcome, added };
  }

  public async add(input: AddResourceInput): Promise<ResourceEntry> {
    const kind = input.kind;
    if (kind !== 'mcp' && kind !== 'skill') {
      throw new Error('INVALID_KIND: kind must be "mcp" or "skill"');
    }
    const displayName = String(input.displayName || '').trim();
    if (!displayName) {
      throw new Error('INVALID_PARAMS: displayName is required');
    }

    const entry: ResourceEntry = {
      id:
        input.id ||
        `manual_${sanitizeToolNameSegment(displayName, 'item').toLowerCase()}_${shortIdFragment(
          `${displayName}:${Date.now()}:${Math.random()}`
        )}`,
      kind,
      displayName,
      enabled: input.enable === true,
      source: input.source === 'scan' ? 'scan' : 'manual',
      sourceLabel: input.sourceLabel || (input.source === 'scan' ? '扫描发现' : '手动添加'),
      readonly: input.readonly === true,
      runtimeStatus: 'stopped'
    };
    if (this.entries.some((item) => item.id === entry.id)) {
      throw new Error(`RESOURCE_ID_CONFLICT: '${entry.id}' already exists`);
    }

    if (kind === 'mcp') {
      const transport: McpTransport = input.transport === 'http' ? 'http' : 'stdio';
      entry.transport = transport;
      if (transport === 'http') {
        if (!input.httpUrl || !/^https?:\/\//i.test(input.httpUrl.trim())) {
          throw new Error('INVALID_PARAMS: http transport requires an http(s) URL');
        }
        entry.httpUrl = input.httpUrl.trim();
        const headers = sanitizeStringMap(input.headers);
        if (headers) {
          const ref = headersSecretRef(entry.id);
          if (!storeResourceSecret(this.workspaceRoot, ref, JSON.stringify(headers))) {
            throw new Error('SECRET_STORE_UNAVAILABLE: cannot encrypt HTTP headers on this host');
          }
          entry.httpHeaderSecretKey = ref;
        }
      } else {
        if (!input.command || !input.command.trim()) {
          throw new Error('INVALID_PARAMS: stdio transport requires a command');
        }
        entry.command = input.command.trim();
        entry.args = sanitizeArgs(input.args);
        if (input.cwd && input.cwd.trim()) entry.cwd = input.cwd.trim();
        const env = sanitizeStringMap(input.env);
        if (env) {
          const stored: string[] = [];
          for (const [key, value] of Object.entries(env)) {
            if (storeResourceSecret(this.workspaceRoot, envSecretRef(entry.id, key), value)) {
              stored.push(key);
            }
          }
          if (stored.length > 0) entry.envSecretKeys = stored;
        }
      }
    } else {
      const dir = String(input.skillDir || '').trim();
      if (!dir) throw new Error('INVALID_PARAMS: skill entries require skillDir');
      const resolved = path.resolve(dir);
      if (!fs.existsSync(path.join(resolved, 'SKILL.md'))) {
        throw new Error('SKILL_MD_MISSING: the selected folder has no SKILL.md');
      }
      entry.skillDir = resolved;
      entry.skillDescription = extractSkillDescription(path.join(resolved, 'SKILL.md'));
    }

    this.entries.push(entry);
    this.syncSkillRuntime();
    this.persist();
    this.audit({
      decision: 'ALLOW',
      toolName: RESOURCE_AUDIT_TOOLS.add,
      commandOrPath: entry.displayName,
      reason: `RESOURCE_ADDED kind=${entry.kind}`,
      status: 'SUCCESS'
    });

    if (entry.enabled && entry.kind === 'mcp') {
      await this.startSession(entry);
    }
    this.emitChange();
    return { ...entry };
  }

  public async update(id: string, patch: UpdateResourceInput): Promise<ResourceEntry> {
    const entry = this.requireEntry(id);
    const needsRestart =
      entry.kind === 'mcp' &&
      entry.enabled &&
      (patch.command !== undefined ||
        patch.args !== undefined ||
        patch.cwd !== undefined ||
        patch.env !== undefined ||
        patch.httpUrl !== undefined ||
        patch.headers !== undefined);

    if (patch.displayName !== undefined) {
      const name = String(patch.displayName).trim();
      if (!name) throw new Error('INVALID_PARAMS: displayName cannot be empty');
      entry.displayName = name;
    }
    if (patch.readonly !== undefined) entry.readonly = patch.readonly === true;

    if (entry.kind === 'mcp') {
      if (patch.command !== undefined) {
        if (!String(patch.command).trim()) throw new Error('INVALID_PARAMS: command cannot be empty');
        entry.command = String(patch.command).trim();
      }
      if (patch.args !== undefined) entry.args = sanitizeArgs(patch.args);
      if (patch.cwd !== undefined) {
        const cwd = String(patch.cwd).trim();
        if (cwd) entry.cwd = cwd;
        else delete entry.cwd;
      }
      if (patch.httpUrl !== undefined) {
        const url = String(patch.httpUrl).trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('INVALID_PARAMS: httpUrl must be http(s)');
        entry.httpUrl = url;
      }
      if (patch.env !== undefined) {
        const env = sanitizeStringMap(patch.env) || {};
        const stored: string[] = [];
        for (const [key, value] of Object.entries(env)) {
          if (storeResourceSecret(this.workspaceRoot, envSecretRef(entry.id, key), value)) {
            stored.push(key);
          }
        }
        entry.envSecretKeys = stored.length > 0 ? stored : undefined;
      }
      if (patch.headers !== undefined) {
        const headers = sanitizeStringMap(patch.headers);
        if (headers) {
          const ref = headersSecretRef(entry.id);
          if (!storeResourceSecret(this.workspaceRoot, ref, JSON.stringify(headers))) {
            throw new Error('SECRET_STORE_UNAVAILABLE: cannot encrypt HTTP headers on this host');
          }
          entry.httpHeaderSecretKey = ref;
        } else {
          delete entry.httpHeaderSecretKey;
        }
      }
    } else {
      if (patch.skillDir !== undefined) {
        const resolved = path.resolve(String(patch.skillDir).trim());
        if (!fs.existsSync(path.join(resolved, 'SKILL.md'))) {
          throw new Error('SKILL_MD_MISSING: the selected folder has no SKILL.md');
        }
        entry.skillDir = resolved;
        entry.skillDescription = extractSkillDescription(path.join(resolved, 'SKILL.md'));
      }
    }

    if (patch.enabled !== undefined) {
      await this.applyEnabledState(entry, patch.enabled === true);
    } else if (needsRestart) {
      this.stopSession(entry);
      if (entry.enabled) await this.startSession(entry);
    }

    this.syncSkillRuntime();
    this.persist();
    this.audit({
      decision: 'ALLOW',
      toolName: RESOURCE_AUDIT_TOOLS.update,
      commandOrPath: entry.displayName,
      reason: 'RESOURCE_UPDATED',
      status: 'SUCCESS'
    });
    this.emitChange();
    return { ...entry };
  }

  public async toggle(id: string, enabled: boolean): Promise<ResourceEntry> {
    const entry = this.requireEntry(id);
    await this.applyEnabledState(entry, enabled);
    this.syncSkillRuntime();
    this.persist();
    this.audit({
      decision: 'ALLOW',
      toolName: RESOURCE_AUDIT_TOOLS.toggle,
      commandOrPath: entry.displayName,
      reason: enabled ? 'RESOURCE_ENABLED' : 'RESOURCE_DISABLED',
      status: 'SUCCESS'
    });
    this.emitChange();
    return { ...entry };
  }

  public async remove(id: string): Promise<void> {
    const entry = this.requireEntry(id);
    this.stopSession(entry);
    this.entries = this.entries.filter((item) => item.id !== id);
    deleteResourceSecrets(this.workspaceRoot, entry.id);
    this.persist();
    this.audit({
      decision: 'ALLOW',
      toolName: RESOURCE_AUDIT_TOOLS.remove,
      commandOrPath: entry.displayName,
      reason: 'RESOURCE_REMOVED',
      status: 'SUCCESS'
    });
    this.emitChange();
  }

  /** Starts a throwaway session to show which tools an entry would expose. */
  public async probe(input: AddResourceInput & { id?: string }): Promise<ResourceProbeResult> {
    if (input.id && !input.command && !input.httpUrl && !input.skillDir) {
      const existing = this.getEntry(input.id);
      if (!existing) {
        return { ok: false, error: 'RESOURCE_NOT_FOUND' };
      }
      input = {
        ...input,
        kind: input.kind || existing.kind,
        displayName: existing.displayName,
        transport: existing.transport,
        command: existing.command,
        args: existing.args,
        cwd: existing.cwd,
        httpUrl: existing.httpUrl,
        skillDir: existing.skillDir
      };
    }

    if (input.kind === 'skill') {
      const dir = String(input.skillDir || '').trim();
      if (!dir || !fs.existsSync(path.join(path.resolve(dir), 'SKILL.md'))) {
        return { ok: false, error: 'SKILL_MD_MISSING' };
      }
      return { ok: true, tools: [] };
    }

    const probeId = `probe_${sanitizeToolNameSegment(input.displayName || 'mcp', 'mcp')}`;
    const entry: ResourceEntry = {
      id: probeId,
      kind: 'mcp',
      displayName: input.displayName || 'probe',
      enabled: false,
      source: 'manual',
      sourceLabel: '探测',
      readonly: input.readonly === true,
      transport: input.transport === 'http' ? 'http' : 'stdio',
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      httpUrl: input.httpUrl,
      runtimeStatus: 'starting'
    };

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitizeStringMap(input.env) || {})) {
      env[key] = value;
    }
    const headers = sanitizeStringMap(input.headers) || {};

    const session = new McpSession({
      entry,
      env,
      headers,
      startTimeoutMs: this.startTimeoutMs,
      callTimeoutMs: this.callTimeoutMs,
      retryDelaysMs: [],
      hooks: {}
    });
    try {
      await session.start();
      return {
        ok: true,
        tools: session.tools.map((tool) => ({ name: tool.name, description: tool.description }))
      };
    } catch (err: any) {
      this.audit({
        decision: 'BLOCK',
        toolName: RESOURCE_AUDIT_TOOLS.probe,
        commandOrPath: entry.displayName,
        reason: `RESOURCE_PROBE_FAILED: ${err?.message || String(err)}`,
        status: 'ERROR'
      });
      return {
        ok: false,
        error: err?.message || String(err),
        faultReason: session.faultReason || '启动失败'
      };
    } finally {
      session.dispose();
    }
  }

  // --------------------------------------------------------------- internals

  private requireEntry(id: string): ResourceEntry {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error(`RESOURCE_NOT_FOUND: '${id}'`);
    return entry;
  }

  private async applyEnabledState(entry: ResourceEntry, enabled: boolean): Promise<void> {
    entry.enabled = enabled;
    if (entry.kind === 'mcp') {
      if (enabled) {
        await this.startSession(entry);
      } else {
        this.stopSession(entry);
      }
    }
  }

  private async startSession(entry: ResourceEntry): Promise<void> {
    if (entry.kind !== 'mcp') return;
    let session = this.sessions.get(entry.id);
    if (!session) {
      session = new McpSession({
        entry,
        env: loadEntryEnv(this.workspaceRoot, entry),
        headers: loadEntryHeaders(this.workspaceRoot, entry),
        startTimeoutMs: this.startTimeoutMs,
        callTimeoutMs: this.callTimeoutMs,
        retryDelaysMs: this.retryDelaysMs,
        hooks: {
          onStatusChange: () => this.handleSessionChange(entry),
          onToolsChanged: () => this.handleSessionChange(entry)
        }
      });
      this.sessions.set(entry.id, session);
    }
    try {
      await session.start();
    } catch {
      // Fault is recorded on the session and mirrored onto the entry below.
    }
    this.handleSessionChange(entry);
  }

  private stopSession(entry: ResourceEntry): void {
    const session = this.sessions.get(entry.id);
    if (!session) {
      entry.runtimeStatus = 'stopped';
      entry.faultReason = undefined;
      entry.exposedToolNames = [];
      entry.toolCount = 0;
      return;
    }
    try {
      session.stop();
    } finally {
      this.sessions.delete(entry.id);
      entry.runtimeStatus = 'stopped';
      entry.faultReason = undefined;
      entry.exposedToolNames = [];
      entry.toolCount = 0;
    }
  }

  private handleSessionChange(entry: ResourceEntry): void {
    const session = this.sessions.get(entry.id);
    if (session) {
      entry.runtimeStatus = session.status;
      entry.faultReason = session.faultReason;
    }
    this.refreshExposure();
    this.emitChange();
  }

  private persist(): void {
    try {
      saveResourceEntries(this.workspaceRoot, this.entries);
    } catch {
      // Registry persistence failure must not crash the daemon; the in-memory
      // state stays authoritative for this process.
    }
  }

  private emitChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Listener failures never break the resource pipeline.
      }
    }
  }

  private audit(event: ResourcesAuditEvent): void {
    try {
      this.auditSink?.(event);
    } catch {
      // Audit failures are surfaced by the sink itself.
    }
  }
}

let sharedManager: ResourcesManager | null = null;

/**
 * Process-wide instance. `workspaceRoot` is only honoured on first creation
 * (the daemon uses `process.cwd()`, same as every other `.mwh` path).
 */
export function getResourcesManager(workspaceRoot?: string): ResourcesManager {
  if (!sharedManager) {
    sharedManager = new ResourcesManager({ workspaceRoot: workspaceRoot || process.cwd() });
  }
  return sharedManager;
}

/** Test-only: replaces the process-wide instance (undefined clears it). */
export function __setResourcesManagerForTests(manager: ResourcesManager | null): void {
  sharedManager = manager;
}

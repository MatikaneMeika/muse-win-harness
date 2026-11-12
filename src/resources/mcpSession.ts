/**
 * MCP session for one registered local server.
 *
 * - stdio: child lives inside a Win32 Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
 *   with `windowsHide: true`; a failed job assignment is fail-closed (the child is
 *   killed instead of running uncontained).
 * - Streamable HTTP: explicit user URLs are used as-is only for loopback hosts;
 *   every other target must clear the existing `outboundGuard` SSRF rules, and
 *   redirects are refused so a public endpoint cannot bounce the session inward.
 *
 * Failure model: the switch stays ON. A broken server moves to `fault`, its tools
 * are withdrawn from /mcp, and a bounded retry schedule brings it back.
 */

import { ChildProcess, spawn } from 'node:child_process';
import os from 'node:os';
import { buildCleanChildEnv } from '../executors/cliAdapters.js';
import { Win32JobObject } from '../pipeline/win32Job.js';
import { validateOutboundUrl } from '../security/outboundGuard.js';
import type { ResourceEntry, ResourceRuntimeStatus } from './types.js';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpSessionHooks {
  onStatusChange?: (status: ResourceRuntimeStatus, faultReason?: string) => void;
  onToolsChanged?: (tools: McpToolInfo[]) => void;
}

export interface McpSessionOptions {
  entry: ResourceEntry;
  /** Decrypted env vars for stdio children (never plaintext in the registry). */
  env?: Record<string, string>;
  /** Decrypted header map for HTTP sessions. */
  headers?: Record<string, string>;
  hooks?: McpSessionHooks;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  retryDelaysMs?: number[];
}

const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_CALL_TIMEOUT_MS = 60000;
const DEFAULT_RETRY_DELAYS_MS = [2000, 8000, 20000];
const MCP_PROTOCOL_VERSION = '2024-11-05';

interface PendingRpc {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function shortFaultReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (/timeout|超时/i.test(message)) return '启动超时';
  if (/ENOENT|not found|cannot find/i.test(message)) return '命令未找到';
  if (/HTTP\s*4\d\d|HTTP\s*5\d\d|fetch failed|ECONNREFUSED|aborted/i.test(message)) return '连接失败';
  if (/OUTBOUND_GUARD_BLOCKED/i.test(message)) return '出站地址被拒绝';
  if (/initialize|protocol/i.test(message)) return '握手失败';
  return '启动失败';
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * User-typed loopback endpoints are legitimate local MCP servers; every other
 * target goes through the shared SSRF guard (protocol, private ranges, DNS).
 */
export async function assertResourceHttpUrlAllowed(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('INVALID_HTTP_URL: resource URL is not a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OUTBOUND_GUARD_BLOCKED: Protocol not allowed: ${parsed.protocol}`);
  }
  if (isLoopbackHost(parsed.hostname)) {
    return parsed;
  }
  return await validateOutboundUrl(parsed.toString());
}

function normalizeTools(rawTools: unknown): McpToolInfo[] {
  if (!Array.isArray(rawTools)) return [];
  const tools: McpToolInfo[] = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, any>;
    if (typeof item.name !== 'string' || !item.name) continue;
    tools.push({
      name: item.name,
      description: typeof item.description === 'string' ? item.description : undefined,
      inputSchema:
        item.inputSchema && typeof item.inputSchema === 'object'
          ? item.inputSchema
          : { type: 'object', properties: {} }
    });
  }
  return tools;
}

/** Pulls the matching JSON-RPC response out of a plain JSON or SSE body. */
function parseRpcPayload(text: string, contentType: string, id: number): any {
  const candidates: any[] = [];
  if (/text\/event-stream/i.test(contentType) || /^\s*event:/m.test(text) || /^\s*data:/m.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const match = /^data:\s*(.+)$/.exec(line);
      if (!match) continue;
      try {
        candidates.push(JSON.parse(match[1]));
      } catch {
        // Ignore malformed SSE frames.
      }
    }
  } else {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) candidates.push(...parsed);
      else candidates.push(parsed);
    } catch {
      throw new Error('RESOURCE_MCP_BAD_RESPONSE: response was not valid JSON');
    }
  }
  const match = candidates.find((item) => item && typeof item === 'object' && item.id === id);
  if (!match) throw new Error('RESOURCE_MCP_BAD_RESPONSE: no JSON-RPC response for the request id');
  if (match.error) {
    const message = typeof match.error.message === 'string' ? match.error.message : 'unknown error';
    throw new Error(`RESOURCE_MCP_ERROR: ${message}`);
  }
  return match.result;
}

export class McpSession {
  public readonly entry: ResourceEntry;
  public status: ResourceRuntimeStatus = 'stopped';
  public faultReason: string | undefined;
  public tools: McpToolInfo[] = [];

  private readonly startTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly hooks: McpSessionHooks;
  private readonly env: Record<string, string>;
  private readonly headers: Record<string, string>;

  private child: ChildProcess | null = null;
  private job: Win32JobObject | null = null;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRpc>();
  private nextId = 1;
  private httpSessionId: string | null = null;
  private retryAttempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stoppedByUser = false;
  private starting = false;
  private disposed = false;

  constructor(options: McpSessionOptions) {
    this.entry = options.entry;
    this.env = options.env || {};
    this.headers = options.headers || {};
    this.hooks = options.hooks || {};
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  public get transport(): 'stdio' | 'http' {
    return this.entry.transport === 'http' ? 'http' : 'stdio';
  }

  private setStatus(status: ResourceRuntimeStatus, faultReason?: string): void {
    this.status = status;
    this.faultReason = faultReason;
    this.hooks.onStatusChange?.(status, faultReason);
  }

  /** Starts (or restarts) the session, performs the MCP handshake and caches tools. */
  public async start(): Promise<void> {
    if (this.disposed || this.starting) return;
    if (this.status === 'running') return;
    this.starting = true;
    this.stoppedByUser = false;
    this.setStatus('starting');
    try {
      if (this.transport === 'stdio') {
        this.spawnStdioChild();
      } else {
        await assertResourceHttpUrlAllowed(this.entry.httpUrl || '');
      }
      await this.rpc(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'muse-win-harness-resources', version: '0.1.0' }
        },
        this.startTimeoutMs
      );
      await this.notify('notifications/initialized');
      const listResult = await this.rpc('tools/list', {}, this.startTimeoutMs);
      this.tools = normalizeTools(listResult?.tools);
      this.retryAttempt = 0;
      this.setStatus('running');
      this.hooks.onToolsChanged?.(this.tools);
    } catch (err: any) {
      this.teardownTransport();
      this.tools = [];
      this.hooks.onToolsChanged?.([]);
      this.setStatus('fault', shortFaultReason(err));
      this.scheduleRetry();
      throw err;
    } finally {
      this.starting = false;
    }
  }

  private spawnStdioChild(): void {
    const command = this.entry.command;
    if (!command) {
      throw new Error('RESOURCE_COMMAND_MISSING: stdio MCP requires a command');
    }
    // Default cwd is the user's home directory: never the MWH repository root,
    // so an MCP server cannot see uncommitted project files by accident.
    const cwd = this.entry.cwd && this.entry.cwd.trim() ? this.entry.cwd.trim() : os.homedir();
    const childEnv = { ...buildCleanChildEnv(cwd, 'workspace-write'), ...this.env };

    const job = new Win32JobObject();
    const child = spawn(command, this.entry.args || [], {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.job = job;
    this.stdoutBuffer = '';

    if (child.pid) {
      const assigned = job.assignPid(child.pid);
      if (!assigned) {
        // Fail-closed: an uncontained MCP child must never keep running.
        try {
          child.kill('SIGKILL');
        } catch {
          // The child may already be gone.
        }
        this.teardownTransport();
        throw new Error('JOB_ASSIGN_FAILED: could not assign the MCP child to a Win32 Job Object');
      }
    }

    child.stdout?.on('data', (chunk: Buffer | string) => this.consumeStdout(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer | string) => {
      // Drain stderr so the pipe never backpressures; content stays out of logs.
      const text = chunk.toString().trim();
      if (text.length > 0) {
        process.stderr.write(`[MWH_RESOURCE_MCP_STDERR] ${this.entry.id}: ${text.slice(0, 400)}\n`);
      }
    });
    child.on('error', (err) => {
      this.failPending(new Error(`RESOURCE_MCP_SPAWN_ERROR: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      this.failPending(
        new Error(`RESOURCE_MCP_EXITED: server exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
      );
      if (this.stoppedByUser || this.disposed) return;
      if (this.status === 'running') {
        this.tools = [];
        this.hooks.onToolsChanged?.([]);
        this.setStatus('fault', '会话已断开，正在重试');
        this.scheduleRetry();
      }
    });
  }

  private consumeStdout(text: string): void {
    this.stdoutBuffer += text;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message || typeof message !== 'object') continue;
      if (typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const detail = typeof message.error.message === 'string' ? message.error.message : 'unknown error';
        pending.reject(new Error(`RESOURCE_MCP_ERROR: ${detail}`));
      } else {
        pending.resolve(message.result);
      }
    }
    // Guard against a runaway single line (no newline ever emitted).
    if (this.stdoutBuffer.length > 8 * 1024 * 1024) {
      this.stdoutBuffer = '';
    }
  }

  private failPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private async rpc(method: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
    return this.transport === 'http'
      ? await this.httpRpc(method, params, timeoutMs)
      : await this.stdioRpc(method, params, timeoutMs);
  }

  private async stdioRpc(method: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error('RESOURCE_SESSION_UNAVAILABLE: MCP stdio process is not running');
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RESOURCE_MCP_TIMEOUT: ${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin!.write(`${payload}\n`);
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`RESOURCE_MCP_WRITE_FAILED: ${err?.message || String(err)}`));
      }
    });
  }

  private httpEndpoint(): URL {
    return new URL(String(this.entry.httpUrl || '').trim());
  }

  private httpHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers
    };
    if (this.httpSessionId) headers['Mcp-Session-Id'] = this.httpSessionId;
    return headers;
  }

  private async httpRpc(method: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(this.httpEndpoint(), {
        method: 'POST',
        headers: this.httpHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
        redirect: 'error'
      });
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.httpSessionId = sessionId;
      if (!response.ok) {
        throw new Error(`RESOURCE_MCP_HTTP_${response.status}: ${response.statusText || 'request failed'}`);
      }
      const text = await response.text();
      return parseRpcPayload(text, response.headers.get('content-type') || '', id);
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(method: string): Promise<void> {
    if (this.transport === 'stdio') {
      const child = this.child;
      if (!child?.stdin || child.stdin.destroyed) return;
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
      } catch {
        // A missing initialized notification surfaces on the next request.
      }
      return;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.startTimeoutMs);
      timer.unref?.();
      try {
        await fetch(this.httpEndpoint(), {
          method: 'POST',
          headers: this.httpHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', method }),
          signal: controller.signal,
          redirect: 'error'
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Notifications are best-effort by protocol design.
    }
  }

  /** Invokes one remote tool. Throws when the session is not running. */
  public async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    if (this.status !== 'running') {
      throw new Error(
        `RESOURCE_SESSION_UNAVAILABLE: '${this.entry.displayName}' is ${this.status}${
          this.faultReason ? ` (${this.faultReason})` : ''
        }`
      );
    }
    try {
      return await this.rpc('tools/call', { name: toolName, arguments: args || {} }, this.callTimeoutMs);
    } catch (err: any) {
      const message = String(err?.message || err);
      if (/RESOURCE_MCP_(EXITED|TIMEOUT)|RESOURCE_MCP_HTTP_(5\d\d)|fetch failed|ECONN/i.test(message)) {
        if (!this.stoppedByUser) {
          this.tools = [];
          this.hooks.onToolsChanged?.([]);
          this.setStatus('fault', '调用失败，正在重试');
          this.scheduleRetry();
        }
      }
      throw err;
    }
  }

  private scheduleRetry(): void {
    if (this.stoppedByUser || this.disposed) return;
    if (this.retryTimer) return;
    if (this.retryAttempt >= this.retryDelaysMs.length) {
      this.faultReason = this.faultReason ? `${this.faultReason}（已停止重试）` : '已停止重试';
      this.hooks.onStatusChange?.(this.status, this.faultReason);
      return;
    }
    const delay = this.retryDelaysMs[this.retryAttempt];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stoppedByUser || this.disposed) return;
      void this.start().catch(() => {
        // Failure is already reflected in status/faultReason and rescheduled.
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  private teardownTransport(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.failPending(new Error('RESOURCE_SESSION_STOPPED: MCP session was stopped'));
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.stdin?.end();
      } catch {
        // Streams may already be closed.
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already be gone.
      }
    }
    const job = this.job;
    this.job = null;
    if (job) {
      try {
        job.terminate(1);
      } catch {
        // Kill-on-close remains the backstop if termination fails.
      }
    }
    this.httpSessionId = null;
  }

  /** Stops the session, withdraws its tools and leaves the switch untouched. */
  public stop(): void {
    this.stoppedByUser = true;
    this.teardownTransport();
    this.tools = [];
    this.hooks.onToolsChanged?.([]);
    this.setStatus('stopped');
  }

  /** Permanent teardown (registry delete / daemon shutdown). */
  public dispose(): void {
    this.disposed = true;
    this.stop();
  }
}

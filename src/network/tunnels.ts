/**
 * Network Channel Drivers & Skill Template Generator
 * Implements 4 network channels (Quick Tunnel, Named Tunnel, Tailscale, Custom Reverse Proxy)
 * with fail-closed public bind security and automatic SKILL.md generation.
 */

import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { joinInsideRoot } from '../pipeline/pathGuard.js';
import { getResourcesManager } from '../resources/manager.js';
import { getExposedMuseTools } from '../tools/definitions.js';

/**
 * Windows leaves cloudflared alive after Node's child.kill(). Kill by the
 * exact pid (and its children), never by image name — other tools run their
 * own cloudflared under the same executable name.
 */
function killOwnedProcess(child: ChildProcess | null): void {
  if (!child || child.killed) return;
  const pid = child.pid;
  try {
    child.kill('SIGKILL');
  } catch {
    // The process may already be gone.
  }
  if (pid && process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      // taskkill exits non-zero when the pid has already exited.
    }
  }
}

/**
 * Validates bind address security.
 * Fail-Closed: If binding non-loopback (e.g. 0.0.0.0), enforces a >=32 character high-entropy token.
 *
 * P3: Tailscale CGNAT addresses (100.64.0.0/10) are only honored when explicitly
 * present in `allowedTailscaleIps` (the list measured live via `tailscale ip -4`).
 * A CGNAT address NOT matching the list is treated as a public address and still
 * requires the high-entropy token (fail-closed).
 */
export function validateServerBindSecurity(
  host: string,
  runtimeToken?: string,
  allowedTailscaleIps?: string[]
): void {
  const normHost = host.trim().toLowerCase();

  // Loopback addresses are always permitted for local development
  if (
    normHost === '127.0.0.1' ||
    normHost === 'localhost' ||
    normHost === '::1'
  ) {
    return;
  }

  // Check Tailscale CGNAT address space (100.64.0.0/10: 100.64.0.0 - 100.127.255.255)
  if (net.isIPv4(normHost)) {
    const parts = normHost.split('.').map(Number);
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
      const allowed = (allowedTailscaleIps || []).some(
        (ip) => String(ip || '').trim().toLowerCase() === normHost
      );
      if (allowed) {
        return;
      }
      // Not in the measured Tailscale IP list: fall through to the public-address
      // token requirement (fail-closed).
    }
  }

  // Public or non-loopback bind requires at least 32-character high-entropy token
  if (!runtimeToken || runtimeToken.length < 32) {
    throw new Error(
      'FAIL_CLOSED_INSECURE_PUBLIC_BIND: Refusing to bind non-loopback address without >=32 char high-entropy TUNNEL_RUNTIME_TOKEN'
    );
  }
}

/**
 * P3: coarse-grained token entropy gate. A runtime token must be at least 32
 * characters long and contain at least 12 distinct characters. Violations throw
 * TOKEN_ENTROPY_TOO_WEAK (e.g. a 32-character run of the same character).
 */
export function assertTokenEntropy(token: string | undefined | null): void {
  const value = token || '';
  if (value.length < 32 || new Set(value).size < 12) {
    throw new Error(
      'TOKEN_ENTROPY_TOO_WEAK: Runtime token must be >=32 characters and contain at least 12 distinct characters'
    );
  }
}

/**
 * P3-R2: normalizes the configured tunnel mode. Missing/empty config defaults
 * to 'quick' (only an explicit 'off' disables tunneling). Legacy config aliases
 * ('quick-tunnel' etc.) are mapped onto the P3 enum; unknown values are passed
 * through lowercased for the caller to warn about honestly.
 */
export function normalizeTunnelMode(
  raw: string | undefined | null
): 'quick' | 'named' | 'tailscale' | 'custom' | 'off' | string {
  const value = String(raw ?? '').trim().toLowerCase();
  switch (value) {
    case '':
    case 'quick':
    case 'quick-tunnel':
      return 'quick';
    case 'named':
    case 'named-tunnel':
      return 'named';
    case 'custom':
    case 'custom-reverse-proxy':
      return 'custom';
    case 'tailscale':
      return 'tailscale';
    case 'off':
      return 'off';
    default:
      return value;
  }
}

export function sanitizeSkillEndpointUrl(rawUrl: string): string {
  const trimmed = String(rawUrl || '').trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`INVALID_SKILL_ENDPOINT_URL: '${rawUrl}' is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`INVALID_SKILL_ENDPOINT_PROTOCOL: '${parsed.protocol}' is not permitted`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('INVALID_SKILL_ENDPOINT_URL: Credentials, query strings, and fragments are forbidden in endpoint URLs');
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Skill Template Generator
 * Synchronizes connectors/muse-skill-template/SKILL.md with active endpoint and tools.
 */
function safeRenderResourcesSection(): string {
  try {
    return getResourcesManager().renderSkillMdSection();
  } catch {
    // A broken registry must never prevent the pairing SKILL.md from refreshing.
    return '';
  }
}

export class SkillTemplateGenerator {
  public static refreshSkillMd(
    endpointUrl: string,
    outputPath = path.resolve(process.cwd(), 'connectors', 'muse-skill-template', 'SKILL.md'),
    desktopHandsEnabled = false,
    /**
     * 「本机资源库」section. Left undefined, it is generated from the local
     * registry's enabled entries; pass '' to omit it explicitly.
     */
    resourcesSection?: string
  ): string {
    const cleanUrl = sanitizeSkillEndpointUrl(endpointUrl);
    const mcpUrl = `${cleanUrl}/mcp`;
    const restUrl = `${cleanUrl}/api/v1`;

    const section =
      resourcesSection === undefined ? safeRenderResourcesSection() : resourcesSection;

    const exposedTools = getExposedMuseTools(desktopHandsEnabled);
    const toolsDocs = exposedTools.map((t) => {
      return `### \`${t.name}\` (${t.category})\n${t.description}\n`;
    }).join('\n');

    const content = `---
name: muse-win-harness
description: Local Windows Agent Runtime and Bridge for Muse
version: 0.1.0
endpoint: ${cleanUrl}
mcpEndpoint: ${mcpUrl}
restEndpoint: ${restUrl}
authHeader: "Authorization: Bearer <TUNNEL_RUNTIME_TOKEN>"
---

# Muse-Win-Harness (MWH) Integration Guide

MWH is an independent open-source local agent runtime and forward bridge for Windows.

## Endpoints
- **Streamable HTTP MCP**: \`${mcpUrl}\`
- **REST Skill API**: \`${restUrl}/*\`
- **Authentication**: Include header \`Authorization: Bearer $TUNNEL_RUNTIME_TOKEN\` on all requests.

## Exposed Tools (${exposedTools.length} Muse Tools)
${toolsDocs}
${section ? `${section}\n` : ''}
## Permission Profiles (4 Unified Tiers)
- **计划模式 (Plan Mode)**: Read-only exploration and whitelisted inspection commands. All file writes and mutations are blocked.
- **变更前确认 (Confirm Before Change)**: Confined to authorized workspace roots; read probes run automatically, file mutations and shell commands require confirmation before execution.
- **自主模式 (Autonomous Mode)**: Confined to authorized workspace roots; routine workspace reads and writes run automatically with pre-mutation Git shadow snapshots; risky operations ask for confirmation.
- **完全访问 (Full Access)**: Cross-directory ordinary reads and writes run without cross-boundary critical escalation; destructive operations (\`rm -rf\`, \`Remove-Item -Recurse\`, \`git push --force\`, \`format\`) and sensitive credential paths still require confirmation.

## Approval & Automatic Receipt Polling Flow (G5)
1. **Confirmation Required**: When \`exec_command\`, \`fs_mutate\`, or \`subagent_dispatch\` returns \`status: "CONFIRMATION_REQUIRED"\` with \`approvalId\`:
   - The user approves on the desktop floating island. **Do NOT wait for the user to type "批了" in chat.**
   - Poll \`job_control\` directly using \`approvalId\`:
     \`{ "action": "poll", "approvalId": "<approvalId>", "page": 1, "pageSize": 8192 }\` (or \`{ "action": "status", "approvalId": "<approvalId>" }\`).
   - Once the user clicks Allow on the floating island, \`approvalStatus\` transitions to \`CONSUMED\` and returns the sanitized execution receipt or 8KB-paginated command output (\`COMPLETED\` / \`FAILED\`).
   - Never re-issue a stale delete or move against an old path that has already been renamed or removed.
2. **Polling Background Job Output**:
   - Call \`job_control\` (\`POST ${restUrl}/tools/job_control\` or MCP tool \`job_control\`) with:
     \`{ "action": "poll", "jobId": "<jobId>", "page": 1, "pageSize": 8192 }\`
   - Each page returns up to 8KB (UTF-8 character boundary aligned) along with \`status\` (\`RUNNING\` | \`RUNNING_ASYNC\` | \`COMPLETED\` | \`FAILED\` | \`TERMINATED\`), \`exitCode\`, \`page\`, and \`totalPages\`.

## Subagent Async Dispatch & Polling
- \`subagent_dispatch\` is dual-track: fast runs return inline, while longer external CLI / ACP runs
  return \`{ "status": "RUNNING_ASYNC", "jobId": "<jobId>", "runId": "<jobId>" }\` after a short
  yield window (default 500ms).
- When a response has \`status: "RUNNING_ASYNC"\`, do **NOT** ask the user for confirmation and do
  **NOT** re-dispatch the task. Loop \`job_control\` directly:
  \`{ "action": "poll", "jobId": "<jobId>", "page": 1, "pageSize": 8192 }\` until \`status\` becomes
  \`COMPLETED\`, \`FAILED\`, or \`TERMINATED\`, incrementing \`page\` to read further output.
- The job log ends with a \`[MWH_SUBAGENT_SUMMARY]\` block, and the same structured object is returned
  as \`subagentSummary\` on every poll (\`status\`, \`summary\`, \`filesModified\`, \`gitDiffStat\`, \`jobId\`).
- Never hand-assemble low-level CLI permission / approval flags inside \`exec_command\`. MWH computes
  and confines child argv internally; those flags are local-only and redacted from every
  cloud-visible echo.

## Windows Command Quoting & \`%\` Format Specifiers (G7)
- \`exec_command\` runs via \`powershell.exe -NoProfile -NonInteractive -EncodedCommand\` (UTF-16LE Base64), bypassing \`cmd.exe\` \`%VAR%\` environment variable expansion and Win32 CLI quote stripping.
- When passing format strings containing spaces (e.g. \`git log\`), always wrap the format value in double quotes: \`git log -1 --format="%H %D %s" --date=short\`.
- If you explicitly invoke \`cmd.exe /c ...\`, escape literal percent signs as \`%%\` (e.g. \`%%D\`) to prevent \`cmd.exe\` from expanding them as environment variables.

## Security Model Notice
> **无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流**  
> High-risk operations require explicit human confirmation with signed one-time HMAC mobile links.
`;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf-8');
    return outputPath;
  }
}

export interface QuickTunnelExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  tunnelUrl: string | null;
  expected: boolean;
}

/**
 * Channel 1: Cloudflare Quick Tunnel Driver
 */
export class QuickTunnelDriver {
  private child: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private outputTail: string[] = [];
  private expectedShutdown = false;
  private exitListeners: Set<(event: QuickTunnelExitEvent) => void> = new Set();

  public onExit(listener: (event: QuickTunnelExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  public isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * Probe order (first hit wins). Explicit sources only — no scan of the user
   * profile. A binary that is not installed in one of these places is reported
   * missing; `npm run doctor -- --fix --cloudflared <dir>` copies it into
   * `<workspace>/.mwh/bin` so the next probe hits step 5.
   *   1. explicit argument (config.yaml `tunnel.cloudflaredPath`)
   *   2. CLOUDFLARED_PATH
   *   3. where.exe on PATH
   *   4. %ProgramFiles%\cloudflared and the WinGet / per-user install dirs
   *   5. `<workspace>/.mwh/bin/cloudflared.exe`
   *   6. MWH_CLOUDFLARED_DIR (the exe itself, or a versions directory)
   */
  public static probeCloudflared(
    explicitPath?: string,
    workspaceRoot?: string
  ): {
    found: boolean;
    path?: string;
    source?: string;
    message?: string;
  } {
    const configured = explicitPath || process.env.CLOUDFLARED_PATH;
    if (configured && fs.existsSync(configured)) {
      return { found: true, path: configured, source: explicitPath ? 'config' : 'env' };
    }

    try {
      const out = execFileSync('where.exe', ['cloudflared'], {
        windowsHide: true,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      const first = out.split('\r\n')[0] || out.split('\n')[0];
      if (first && fs.existsSync(first)) {
        return { found: true, path: first.trim(), source: 'path' };
      }
    } catch {}

    // Well-known installation locations
    const candidates: string[] = [];
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'cloudflared', 'cloudflared.exe'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(
          process.env.LOCALAPPDATA,
          'Microsoft',
          'WinGet',
          'Links',
          'cloudflared.exe'
        )
      );
      candidates.push(
        path.join(process.env.LOCALAPPDATA, 'Programs', 'cloudflared', 'cloudflared.exe')
      );
    }
    // Repo-managed binary: drop cloudflared.exe here once and it wins forever,
    // independent of PATH and of any machine-specific install layout.
    if (workspaceRoot) {
      candidates.push(path.join(workspaceRoot, '.mwh', 'bin', 'cloudflared.exe'));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return {
          found: true,
          path: candidate,
          source: candidate.includes(`${path.sep}.mwh${path.sep}`) ? 'workspace' : 'well-known'
        };
      }
    }

    const customVersionsDir = process.env.MWH_CLOUDFLARED_DIR;
    if (customVersionsDir) {
      if (
        fs.existsSync(customVersionsDir) &&
        fs.statSync(customVersionsDir).isFile() &&
        path.basename(customVersionsDir).toLowerCase() === 'cloudflared.exe'
      ) {
        return { found: true, path: customVersionsDir, source: 'versions-dir' };
      }
      const newest = this.findNewestVersionedCloudflared(customVersionsDir);
      if (newest) {
        return { found: true, path: newest, source: 'versions-dir' };
      }
    }

    return {
      found: false,
      message:
        'CLOUDFLARED_MISSING: cloudflared was not found via tunnel.cloudflaredPath, CLOUDFLARED_PATH, ' +
        'PATH, the standard install directories, <workspace>/.mwh/bin, or MWH_CLOUDFLARED_DIR. ' +
        'Fix it once: winget install Cloudflare.cloudflared, or ' +
        'node scripts/doctor.mjs --fix --cloudflared "<dir-containing-cloudflared.exe>".'
    };
  }

  /**
   * Scans a version-manager layout (semver-ish subdirectories, each
   * expected to contain cloudflared.exe) and returns the absolute path from the
   * newest version. Read-only: never touches running tunnel processes.
   */
  private static findNewestVersionedCloudflared(versionsDir: string): string | null {
    if (!fs.existsSync(versionsDir)) {
      return null;
    }
    let entries: string[];
    try {
      entries = fs
        .readdirSync(versionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^[0-9A-Za-z._-]+$/.test(e.name) && e.name !== '.' && e.name !== '..')
        .map((e) => e.name);
    } catch {
      return null;
    }
    if (entries.length === 0) {
      return null;
    }
    // Newest first: split on '.' and compare numerically segment by segment
    const sorted = entries.sort((a, b) => {
      const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
      const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
      const len = Math.max(pa.length, pb.length);
      for (let i = 0; i < len; i++) {
        const diff = (pb[i] || 0) - (pa[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    for (const version of sorted) {
      try {
        const exePath = joinInsideRoot(versionsDir, version, 'cloudflared.exe');
        if (fs.existsSync(exePath)) {
          return exePath;
        }
      } catch {
        // Reject any invalid or escaping version directory entry
      }
    }
    return null;
  }

  public async start(
    port: number,
    cloudflaredPath?: string,
    workspaceRoot = process.cwd()
  ): Promise<string> {
    const probe = QuickTunnelDriver.probeCloudflared(cloudflaredPath, workspaceRoot);
    if (!probe.found || !probe.path) {
      throw new Error(probe.message || 'CLOUDFLARED_MISSING');
    }

    if (this.child) {
      this.stop();
    }

    this.outputTail = [];
    this.expectedShutdown = false;
    this.tunnelUrl = null;

    const logPath = path.resolve(workspaceRoot, '.mwh', 'logs', 'cloudflared-quick.log');
    const appendQuickLog = (line: string) => {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
      } catch {
        // Logging must never break tunnel stream consumption.
      }
    };

    appendQuickLog(
      `[START] spawning ${probe.path} tunnel --protocol http2 --url http://127.0.0.1:${port} --no-autoupdate`
    );

    return new Promise<string>((resolve, reject) => {
      let resolved = false;

      // G10: Force --protocol http2 (TCP) instead of default QUIC/UDP to prevent
      // silent UDP drops and HTTP 530 origin disconnects.
      const child = spawn(
        probe.path!,
        ['tunnel', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
      this.child = child;

      // G9: Persistent stdout/stderr consumers (never detached) to prevent pipe
      // backpressure and capture full diagnostic logs + tail before exit.
      const consumeStream = (streamName: 'STDOUT' | 'STDERR', data: Buffer | string) => {
        const text = data.toString();
        this.outputTail.push(text);
        while (this.outputTail.join('').length > 4096 && this.outputTail.length > 1) {
          this.outputTail.shift();
        }
        for (const rawLine of text.split(/\r?\n/)) {
          if (rawLine.trim().length > 0) {
            appendQuickLog(`[${streamName}] ${rawLine}`);
          }
        }
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !resolved) {
          resolved = true;
          this.tunnelUrl = match[0];
          appendQuickLog(`[READY] Assigned Quick Tunnel URL: ${this.tunnelUrl}`);
          SkillTemplateGenerator.refreshSkillMd(
            this.tunnelUrl,
            path.resolve(workspaceRoot, 'connectors', 'muse-skill-template', 'SKILL.md')
          );
          resolve(this.tunnelUrl);
        }
      };

      child.stdout?.on('data', (d) => consumeStream('STDOUT', d));
      child.stderr?.on('data', (d) => consumeStream('STDERR', d));

      child.on('error', (err) => {
        appendQuickLog(`[ERROR] spawn error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          reject(new Error(`CLOUDFLARED_SPAWN_ERROR: ${err.message}`));
        }
      });

      child.on('exit', (code, signal) => {
        const lastUrl = this.tunnelUrl;
        const tail = this.outputTail.join('').trim().slice(-1000);
        const expected = this.expectedShutdown;
        appendQuickLog(
          `[EXIT] code=${code} signal=${signal} expected=${expected} lastUrl=${lastUrl || 'none'} tail=${JSON.stringify(tail)}`
        );
        if (this.child === child) {
          this.child = null;
          this.tunnelUrl = null;
        }
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `CLOUDFLARED_EXITED_BEFORE_READY: code=${code} signal=${signal} tail=${tail.slice(-300)}`
            )
          );
        }
        for (const listener of this.exitListeners) {
          try {
            listener({
              code,
              signal,
              stderrTail: tail,
              tunnelUrl: lastUrl,
              expected
            });
          } catch {
            // Listener errors must not break exit cleanup.
          }
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          appendQuickLog('[TIMEOUT] Timed out after 30000ms waiting for trycloudflare.com URL');
          this.stop();
          reject(new Error('QUICK_TUNNEL_TIMEOUT: Timed out waiting for trycloudflare.com URL'));
        }
      }, 30000);
    });
  }

  public getTunnelUrl(): string | null {
    return this.tunnelUrl;
  }

  public stop(): void {
    const child = this.child;
    this.child = null;
    this.tunnelUrl = null;
    this.expectedShutdown = true;
    killOwnedProcess(child);
  }
}

/**
 * Channel 2: Cloudflare Named Tunnel Driver
 *
 * P3: spawn errors and premature exits are no longer swallowed — they are
 * logged to stderr together with the tail of the tunnel process output and
 * stored in lastError (queryable via getLastError()).
 *
 * P3-R2: start() becomes async and returns the boot result
 * ({ started, lastError, stderrTail }) after a short settle window, so callers
 * can report NAMED_TUNNEL_FAILED honestly instead of assuming the tunnel is
 * up. Exits caused by our own stop() are flagged expected and never reported
 * as errors.
 */
export interface NamedTunnelStartResult {
  started: boolean;
  lastError: string | null;
  stderrTail: string;
}

export class NamedTunnelDriver {
  private child: ChildProcess | null = null;
  private stderrTail: string[] = [];
  private lastError: string | null = null;
  private expectedShutdown = false;
  private bootFailResolve: ((msg: string) => void) | null = null;

  public getLastError(): string | null {
    return this.lastError;
  }

  public async start(
    token: string,
    cloudflaredPath?: string,
    bootSettleMs = 3000,
    workspaceRoot = process.cwd()
  ): Promise<NamedTunnelStartResult> {
    const probe = QuickTunnelDriver.probeCloudflared(cloudflaredPath, workspaceRoot);
    if (!probe.found || !probe.path) {
      throw new Error(probe.message || 'CLOUDFLARED_MISSING');
    }

    this.stderrTail = [];
    this.lastError = null;
    this.expectedShutdown = false;

    this.child = spawn(
      probe.path,
      ['tunnel', '--protocol', 'http2', '--no-autoupdate', 'run', '--token', token],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    const pushTail = (data: Buffer | string) => {
      const raw = data.toString();
      const scrubbed = token ? raw.split(token).join('[REDACTED]') : raw;
      this.stderrTail.push(scrubbed);
      // Keep only the most recent output (bounded tail)
      while (this.stderrTail.join('').length > 8192 && this.stderrTail.length > 1) {
        this.stderrTail.shift();
      }
    };

    this.child.stderr?.on('data', pushTail);
    this.child.stdout?.on('data', pushTail);

    this.child.on('error', (err) => {
      this.lastError = `CLOUDFLARED_SPAWN_ERROR: ${err.message}`;
      console.error(
        `[NamedTunnelDriver] ${this.lastError}\n[NamedTunnelDriver] stderr tail: ${this.stderrTail.join('')}`
      );
      this.bootFailResolve?.(this.lastError);
    });

    this.child.on('exit', (code, signal) => {
      if (this.expectedShutdown || (code === 0 && !signal)) {
        return; // clean or expected shutdown is not an error
      }
      this.lastError = `CLOUDFLARED_TUNNEL_EXITED_PREMATURELY: code=${code} signal=${signal}`;
      console.error(
        `[NamedTunnelDriver] ${this.lastError}\n[NamedTunnelDriver] output tail: ${this.stderrTail.join('')}`
      );
      this.bootFailResolve?.(this.lastError);
    });

    // Boot settle window: surface immediate spawn failures / early exits so the
    // caller never reports a dead tunnel as "launched".
    let bootError: string | null = null;
    try {
      bootError = await Promise.race([
        new Promise<string | null>((resolve) => {
          this.bootFailResolve = resolve;
        }),
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), bootSettleMs))
      ]);
    } catch {
      bootError = null;
    }
    this.bootFailResolve = null;

    return {
      started: !bootError,
      lastError: this.lastError,
      stderrTail: this.stderrTail.join('')
    };
  }

  public stop(): void {
    const child = this.child;
    this.child = null;
    this.expectedShutdown = true;
    killOwnedProcess(child);
  }
}

/**
 * Channel 3: Tailscale Driver
 */
export class TailscaleDriver {
  public static probe(): { available: boolean; ip?: string; path?: string } {
    let tsPath = '';
    const envPath = process.env.MWH_TAILSCALE_EXE;
    if (envPath && fs.existsSync(envPath)) {
      tsPath = envPath;
    } else {
      try {
        const out = execFileSync('where.exe', ['tailscale'], {
          windowsHide: true,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        tsPath = out.split('\r\n')[0] || out.split('\n')[0];
      } catch {}
      if ((!tsPath || !fs.existsSync(tsPath)) && process.env.ProgramFiles) {
        const candidate = path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe');
        if (fs.existsSync(candidate)) {
          tsPath = candidate;
        }
      }
    }

    if (!tsPath || !fs.existsSync(tsPath)) {
      return { available: false };
    }

    try {
      const ip = execFileSync(tsPath, ['ip', '-4'], {
        windowsHide: true,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return { available: true, ip, path: tsPath };
    } catch {
      return { available: true, path: tsPath };
    }
  }
}

/**
 * Muse-Win-Harness Daemon Entrypoint
 * Starts the dual-protocol server, wires the network channel (quick/named/
 * tailscale/custom) with honest degradation, connects the JobManager
 * confinement-mode provider to the live kernel context, and handles
 * process termination signals.
 *
 * P3 fail-closed rules:
 * - Non-loopback bind without a configured TUNNEL_RUNTIME_TOKEN refuses to
 *   start (no random token is ever auto-generated for an exposed bind).
 * - Non-loopback tokens must pass the coarse entropy gate (TOKEN_ENTROPY_TOO_WEAK).
 * - If the default quick tunnel cannot find cloudflared, the daemon degrades
 *   HONESTLY to local-only listening with a stderr warning — it never pretends
 *   a tunnel is online.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { JobManager } from './executors/jobManager.js';
import { MwhServer } from './network/server.js';
import {
  NamedTunnelDriver,
  QuickTunnelDriver,
  SkillTemplateGenerator,
  TailscaleDriver,
  assertTokenEntropy,
  normalizeTunnelMode
} from './network/tunnels.js';
import { setUiSessionSecret } from './network/uiStatic.js';
import { PipelineKernel } from './pipeline/pipeline.js';
import { getResourcesManager } from './resources/manager.js';
import {
  loadPersistedSecrets,
  resolveConfiguredTokenTtlMs,
  savePersistedSecrets
} from './security/secretStore.js';
import { SubagentDispatcher } from './subagents/dispatcher.js';
import {
  VALID_PERMISSION_PROFILES,
  profileToConfinementAndPolicy,
  resolvePermissionProfile,
  type ApprovalPolicy,
  type ConfinementMode,
  type MwhConfig,
  type PermissionProfileId
} from './types.js';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.trim().toLowerCase());
}

async function main() {
  const workspaceRoot = process.cwd();

  // Load config.yaml or config.example.yaml
  let config: Partial<MwhConfig> = {};
  const configPath = fs.existsSync(path.join(workspaceRoot, 'config.yaml'))
    ? path.join(workspaceRoot, 'config.yaml')
    : path.join(workspaceRoot, 'config.example.yaml');

  if (fs.existsSync(configPath)) {
    try {
      const rawYaml = fs.readFileSync(configPath, 'utf-8');
      config = yaml.parse(rawYaml) || {};
    } catch (err: any) {
      console.warn(`[WARN] Failed to parse config file at ${configPath}: ${err.message}`);
    }
  }

  const host = process.env.MWH_HOST || config.server?.host || '127.0.0.1';
  const port = Number(process.env.MWH_PORT || config.server?.port || 19820);
  const loopbackBind = isLoopbackHost(host);

  // ------------------------------------------------------------------
  // P3: Runtime token fail-closed handling + DPAPI secret store.
  // Non-loopback binds REQUIRE an explicitly configured token — no random
  // fallback generation. Non-loopback tokens must pass the entropy gate.
  // Ephemeral env-injected tokens never overwrite an existing different
  // persisted token in `.mwh/secrets.json`.
  // ------------------------------------------------------------------
  const runtimeTokenEnvName = config.tunnel?.runtimeTokenEnv || 'TUNNEL_RUNTIME_TOKEN';
  const envToken: string | undefined =
    process.env.TUNNEL_RUNTIME_TOKEN ||
    (config.tunnel?.runtimeTokenEnv ? process.env[config.tunnel.runtimeTokenEnv] : undefined);
  let runtimeToken: string | undefined = envToken;
  let tokenExpiresAt: number | undefined;
  let shouldPersistSecrets = false;

  const persisted = loadPersistedSecrets(workspaceRoot);
  if (!runtimeToken && persisted) {
    if (typeof persisted.token === 'string' && persisted.token.length >= 32) {
      if (
        loopbackBind &&
        typeof persisted.tokenExpiresAt === 'number' &&
        Date.now() > persisted.tokenExpiresAt
      ) {
        runtimeToken = 'mwh_rt_' + crypto.randomBytes(24).toString('hex');
        tokenExpiresAt = Date.now() + resolveConfiguredTokenTtlMs();
        shouldPersistSecrets = true;
      } else {
        runtimeToken = persisted.token;
        tokenExpiresAt = persisted.tokenExpiresAt;
        if (persisted.legacyPlaintext) {
          shouldPersistSecrets = true;
        }
      }
    }
  }
  if (
    !process.env.MWH_HMAC_SECRET &&
    persisted &&
    typeof persisted.signingKey === 'string' &&
    persisted.signingKey.length >= 32
  ) {
    process.env.MWH_HMAC_SECRET = persisted.signingKey;
    if (persisted.legacyPlaintext) {
      shouldPersistSecrets = true;
    }
  }

  if (!runtimeToken) {
    if (!loopbackBind) {
      console.error(
        `[FATAL] FAIL_CLOSED_RUNTIME_TOKEN_REQUIRED: Refusing to bind non-loopback address '${host}' without an explicitly configured TUNNEL_RUNTIME_TOKEN (${runtimeTokenEnvName}). ` +
          'Generate a high-entropy token (>=32 chars, >=12 distinct characters) and expose it via the environment.'
      );
      process.exit(1);
    }
    runtimeToken = 'mwh_rt_' + crypto.randomBytes(24).toString('hex');
    tokenExpiresAt = Date.now() + resolveConfiguredTokenTtlMs();
    shouldPersistSecrets = true;
  } else {
    if (!loopbackBind) {
      try {
        assertTokenEntropy(runtimeToken);
      } catch (err: any) {
        console.error(`[FATAL] ${err.message}`);
        process.exit(1);
      }
    }
    if (envToken) {
      if (!persisted || !persisted.token) {
        tokenExpiresAt = Date.now() + resolveConfiguredTokenTtlMs();
        shouldPersistSecrets = true;
      } else if (persisted.token === envToken) {
        tokenExpiresAt = persisted.tokenExpiresAt;
        if (persisted.legacyPlaintext) {
          shouldPersistSecrets = true;
        }
      } else {
        // Ephemeral env override (e.g. test suite or manual CLI env override):
        // honor in memory for this process, do NOT overwrite persisted secrets.json.
        tokenExpiresAt = Date.now() + resolveConfiguredTokenTtlMs();
        shouldPersistSecrets = false;
      }
    }
  }

  // For local loopback cold starts (`node dist/cli.js`), mint a per-process
  // CSPRNG HMAC secret if none was explicitly provided in the environment so
  // local desktop UI critical approvals work out of the box. Non-loopback binds
  // keep fail-closed behavior if MWH_HMAC_SECRET is absent.
  if (!process.env.MWH_HMAC_SECRET && loopbackBind) {
    process.env.MWH_HMAC_SECRET = crypto.randomBytes(32).toString('hex');
    if (!envToken || !persisted?.signingKey) {
      shouldPersistSecrets = true;
    }
  }

  const cookieSecret = persisted?.cookieSecret || crypto.randomBytes(32).toString('hex');
  setUiSessionSecret(cookieSecret);

  if (shouldPersistSecrets) {
    try {
      savePersistedSecrets(workspaceRoot, {
        token: runtimeToken,
        signingKey: process.env.MWH_HMAC_SECRET || '',
        cookieSecret,
        tokenExpiresAt
      });
    } catch {}
  }

  const rawProfile =
    (process.env.MWH_PERMISSION_PROFILE as PermissionProfileId | undefined) ||
    ((config.confinement as any)?.profile as PermissionProfileId | undefined);
  const profileDefaults =
    rawProfile && VALID_PERMISSION_PROFILES.includes(rawProfile)
      ? profileToConfinementAndPolicy(rawProfile)
      : null;

  const confinementMode: ConfinementMode =
    (process.env.MWH_CONFINEMENT_MODE as ConfinementMode) ||
    profileDefaults?.confinementMode ||
    config.confinement?.mode ||
    'workspace-write';

  const approvalPolicy: ApprovalPolicy =
    (process.env.MWH_APPROVAL_POLICY as ApprovalPolicy) ||
    profileDefaults?.approvalPolicy ||
    config.confinement?.approvalPolicy ||
    (confinementMode === 'danger-full-access' ? 'unattended-yolo' : 'smart-risk');

  const desktopHandsEnabled = !!config.desktopHands?.enabled;

  // ------------------------------------------------------------------
  // Subagent defaults from config.yaml (subagents.*) — previously dead
  // config. They now feed both the kernel context and the dispatcher.
  // ------------------------------------------------------------------
  const subagentTimeoutMs =
    typeof config.subagents?.timeoutMs === 'number' && config.subagents.timeoutMs > 0
      ? config.subagents.timeoutMs
      : undefined;
  const subagentMaxSteps =
    typeof config.subagents?.maxSteps === 'number' && config.subagents.maxSteps > 0
      ? config.subagents.maxSteps
      : undefined;

  SubagentDispatcher.configureDefaults({
    timeoutMs: subagentTimeoutMs,
    maxSteps: subagentMaxSteps
  });

  const kernel = new PipelineKernel({
    confinementMode,
    approvalPolicy,
    workspaceRoot,
    desktopHandsEnabled,
    subagentTimeoutMs,
    subagentMaxSteps
  });

  // ------------------------------------------------------------------
  // P3: Wire the async JobManager to the LIVE kernel confinement mode, so
  // exec_command cwd fencing follows switch_mode in real time.
  // ------------------------------------------------------------------
  JobManager.getInstance().setConfinementModeProvider(() => kernel.getContext().confinementMode);

  // ------------------------------------------------------------------
  // P3-R2: probe Tailscale once at startup and feed the measured `tailscale
  // ip -4` address into the bind-security validation (the allowlist is no
  // longer dead code: a CGNAT bind matching the measured IP is honored).
  // ------------------------------------------------------------------
  const tsProbe = TailscaleDriver.probe();
  const allowedTailscaleIps = tsProbe.available && tsProbe.ip ? [tsProbe.ip.trim()] : undefined;

  const server = new MwhServer({
    host,
    port,
    runtimeToken,
    tokenExpiresAt,
    kernel,
    // The control plane must use the same explicit binary path as the boot
    // probe; otherwise a UI-triggered tunnel start silently loses it.
    cloudflaredPath: config.tunnel?.cloudflaredPath || undefined
  });

  let quickDriver: QuickTunnelDriver | null = null;
  let namedDriver: NamedTunnelDriver | null = null;

  let exitReasonLogged = false;
  let pendingExitReason = 'normal_exit';
  let pendingExitTrigger = 'process.exit';

  const recordDaemonExitReason = (reason: string, trigger: string, detail?: string) => {
    if (exitReasonLogged) return;
    exitReasonLogged = true;
    try {
      const logDir = path.join(workspaceRoot, '.mwh', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        process: 'daemon',
        pid: process.pid,
        reason,
        trigger,
        ...(detail ? { detail } : {})
      };
      fs.appendFileSync(path.join(logDir, 'exit-reason.log'), JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Never block shutdown on log I/O failure
    }
  };

  const recordDaemonNonFatal = (reason: string, trigger: string, detail?: string) => {
    try {
      const logDir = path.join(workspaceRoot, '.mwh', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        process: 'daemon',
        pid: process.pid,
        reason,
        trigger,
        terminal: false,
        ...(detail ? { detail } : {})
      };
      fs.appendFileSync(path.join(logDir, 'exit-reason.log'), JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Never block on log I/O failure
    }
  };

  const daemonPidFile = path.join(workspaceRoot, '.mwh', 'daemon.json');
  const writeDaemonPidFile = () => {
    try {
      fs.mkdirSync(path.dirname(daemonPidFile), { recursive: true });
      fs.writeFileSync(
        daemonPidFile,
        JSON.stringify(
          {
            pid: process.pid,
            port,
            host,
            workspaceRoot,
            startedAt: new Date().toISOString()
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch {
      // Never block daemon startup on metadata write failure
    }
  };
  const removeDaemonPidFile = () => {
    try {
      if (!fs.existsSync(daemonPidFile)) return;
      const raw = JSON.parse(fs.readFileSync(daemonPidFile, 'utf-8'));
      if (!raw || raw.pid === process.pid) {
        fs.unlinkSync(daemonPidFile);
      }
    } catch {
      // Ignore cleanup errors on exit
    }
  };

  let shuttingDown = false;
  const shutdown = async (reason = 'signal_shutdown', trigger = 'signal', detail?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    pendingExitReason = reason;
    pendingExitTrigger = trigger;
    recordDaemonExitReason(reason, trigger, detail);
    removeDaemonPidFile();
    console.log(`\n[MWH] Shutting down daemon gracefully (reason=${reason}, trigger=${trigger})...`);
    try {
      quickDriver?.stop();
    } catch {}
    try {
      namedDriver?.stop();
    } catch {}
    try {
      await server.stop();
    } catch {}
    console.log('[MWH] Server stopped cleanly. Goodbye.');
    process.exit(0);
  };

  // Allow parent Electron shell to notify exact exit reason (e.g. tray_quit) via stdin pipe before termination
  if (process.stdin && !process.stdin.destroyed) {
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      const match = text.match(/__MWH_SHUTDOWN__:([^:\r\n]+)(?::([^\r\n]*))?/);
      if (match) {
        const reason = match[1]?.trim() || 'shell_quit';
        const trigger = match[2]?.trim() || 'shell_stdin_ipc';
        void shutdown(reason, trigger, 'Received shutdown command from parent shell');
      }
    });
    process.stdin.on('error', () => {});
  }

  process.on('SIGINT', () => {
    void shutdown('sigint', 'process.on(SIGINT)');
  });
  process.on('SIGTERM', () => {
    void shutdown('sigterm', 'process.on(SIGTERM)');
  });
  process.on('SIGHUP', () => {
    void shutdown('sighup', 'process.on(SIGHUP)');
  });
  process.on('SIGBREAK', () => {
    void shutdown('sigbreak', 'process.on(SIGBREAK)');
  });
  process.on('uncaughtException', (err) => {
    recordDaemonExitReason('uncaught_exception', 'process.on(uncaughtException)', err?.stack || String(err));
    console.error('[FATAL] Uncaught exception in daemon:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    recordDaemonNonFatal('unhandled_rejection', 'process.on(unhandledRejection)', String(reason));
    console.error('[WARN] Unhandled rejection in daemon:', reason);
  });
  process.on('exit', (code) => {
    removeDaemonPidFile();
    recordDaemonExitReason(pendingExitReason, pendingExitTrigger, `exitCode=${code}`);
  });

  // HTTP shutdown is Bearer-protected (same trust level as emergency-kill).
  server.setShutdownHandler(() => {
    void shutdown('http_shutdown', 'http_api');
  });

  const { url } = await server.start(allowedTailscaleIps);
  writeDaemonPidFile();

  // ------------------------------------------------------------------
  // P3: Network channel wiring (quick | named | tailscale | custom | off).
  // Missing/empty config defaults to 'quick' (only explicit 'off' disables).
  // ------------------------------------------------------------------
  const tunnelMode = normalizeTunnelMode(config.tunnel?.mode);
  const configuredCloudflaredPath = config.tunnel?.cloudflaredPath || undefined;

  let endpointUrl = url;
  let tunnelStatus = 'LOCAL-ONLY (no tunnel active)';

  switch (tunnelMode) {
    case 'quick': {
      // start() is the only probe call site. A second probe here used to omit
      // workspaceRoot, so <workspace>/.mwh/bin was visible to the UI and invisible at boot.
      quickDriver = new QuickTunnelDriver();
      try {
        const tunnelUrl = await quickDriver.start(port, configuredCloudflaredPath, workspaceRoot);
        endpointUrl = tunnelUrl;
        tunnelStatus = `QUICK TUNNEL ACTIVE: ${tunnelUrl}`;
      } catch (err: any) {
        quickDriver.stop();
        quickDriver = null;
        console.error(
          `[WARN] TUNNEL_DEGRADED_LOCAL_ONLY: quick tunnel failed to start (${err.message}). ` +
            `The daemon is honestly degrading to LOCAL-ONLY listening on ${url} — no tunnel is active.`
        );
      }
      break;
    }
    case 'named': {
      const tokenEnvName = config.tunnel?.namedTunnelTokenEnv || 'MWH_CF_TUNNEL_TOKEN';
      const namedToken = process.env[tokenEnvName];
      if (!namedToken) {
        console.error(
          `[FATAL] FAIL_CLOSED_NAMED_TUNNEL_TOKEN_REQUIRED: tunnel.mode='named' requires the Cloudflare named-tunnel token in env '${tokenEnvName}'.`
        );
        await server.stop();
        process.exit(1);
      }
      namedDriver = new NamedTunnelDriver();
      const namedResult = await namedDriver.start(namedToken, configuredCloudflaredPath, 3000, workspaceRoot);
      if (namedResult.started) {
        tunnelStatus = `NAMED TUNNEL RUNNING (cloudflared runs in background; endpoint managed by Cloudflare dashboard; later failures surface via stderr / getLastError())`;
      } else {
        console.error(
          `[WARN] NAMED_TUNNEL_FAILED: ${namedResult.lastError || 'cloudflared exited during boot window'}\n` +
            `[WARN] Named tunnel output tail: ${namedResult.stderrTail || '(empty)'}\n` +
            `[WARN] The daemon is honestly degrading to LOCAL-ONLY listening on ${url} — no tunnel is active.`
        );
        tunnelStatus = 'NAMED TUNNEL FAILED (see stderr for output tail) — LOCAL-ONLY';
      }
      break;
    }
    case 'tailscale': {
      if (tsProbe.available && tsProbe.ip) {
        tunnelStatus = `TAILSCALE BIND AVAILABLE: tailscale IP ${tsProbe.ip} (binary: ${tsProbe.path}). ` +
          `The measured address is allow-listed for bind validation; to bind, set MWH_HOST=${tsProbe.ip} ` +
          `(a runtime token is still required for public/custom binds); ` +
          `'tailscale funnel' is NOT implemented in-process — expose via Tailscale manually.`;
      } else if (tsProbe.available) {
        tunnelStatus = `TAILSCALE CLI FOUND (${tsProbe.path}) but no IPv4 address could be read ('tailscale ip -4' failed) — staying LOCAL-ONLY.`;
      } else {
        tunnelStatus = 'TAILSCALE NOT AVAILABLE (tailscale binary not found) — staying LOCAL-ONLY.';
      }
      console.log(`[INFO] Tailscale channel: ${tunnelStatus}`);
      break;
    }
    case 'custom': {
      console.log(
        '[INFO] CUSTOM REVERSE-PROXY CHANNEL (Fail-Closed requirements):\n' +
          '  - The reverse proxy (FRP / Caddy / nginx ...) is NOT implemented or managed by this process.\n' +
          '  - You operate it entirely at your own responsibility (BYO proxy).\n' +
          '  - This process ONLY validates its bind address: non-loopback binds REQUIRE a\n' +
          '    >=32-char high-entropy TUNNEL_RUNTIME_TOKEN, otherwise startup is refused.'
      );
      tunnelStatus = 'CUSTOM (external reverse proxy; user-managed; bind address fail-closed validated)';
      break;
    }
    case 'off':
      tunnelStatus = 'OFF (tunnel disabled by config)';
      break;
    default:
      console.error(
        `[WARN] TUNNEL_MODE_UNKNOWN: config tunnel.mode='${tunnelMode}' is not one of quick|named|tailscale|custom|off — staying LOCAL-ONLY.`
      );
      tunnelStatus = 'LOCAL-ONLY (unknown tunnel.mode)';
      break;
  }

  server.attachOwnedTunnels({ quick: quickDriver, named: namedDriver });

  // Start already-enabled local MCP servers from the resource library. A broken
  // server stays enabled with an amber fault reason and never blocks boot.
  try {
    await getResourcesManager(workspaceRoot).initialize();
  } catch (err: any) {
    console.warn(
      `[WARN] RESOURCE_LIBRARY_INIT_FAILED: ${err?.message || String(err)} — continuing without local MCP resources.`
    );
  }

  // Refresh skill template with the honest, actually-serving endpoint
  const skillPath = SkillTemplateGenerator.refreshSkillMd(
    endpointUrl,
    path.resolve(workspaceRoot, 'connectors', 'muse-skill-template', 'SKILL.md'),
    desktopHandsEnabled
  );

  console.log('===============================================================');
  console.log('  MUSE-WIN-HARNESS (MWH) LOCAL AGENT DAEMON');
  console.log(`  Endpoint URL:      ${endpointUrl}`);
  console.log(`  Streamable MCP:    ${endpointUrl}/mcp`);
  console.log(`  REST API:          ${endpointUrl}/api/v1`);
  console.log(`  Tunnel Status:     ${tunnelStatus}`);
  console.log(`  Permission Mode:   ${resolvePermissionProfile(confinementMode, approvalPolicy)} (${confinementMode} / ${approvalPolicy})`);
  console.log(`  Confinement Mode:  ${confinementMode}`);
  console.log(`  Approval Policy:   ${approvalPolicy}`);
  console.log(`  Security Boundary: 无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流`);
  console.log(`  Skill Template:    ${skillPath}`);
  console.log(`  Runtime Token:     ${runtimeToken.slice(0, 8)}...[TRUNCATED]`);
  console.log('===============================================================\n');
  console.log('Daemon running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('[FATAL] Failed to start Muse-Win-Harness daemon:', err);
  process.exit(1);
});

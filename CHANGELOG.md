# Changelog

All notable changes to **Muse-Win-Harness (MWH)** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-12 (Early Preview)

First public early-preview release. The harness is functional end-to-end on Windows 10/11
x64 but the surface area (tool schemas, config keys, UI contract) may still change before 1.0.

### Added

- **Local Resource Library (MCP/Skill registry)** — a new **Resource Library** tab in the Advanced Configuration Center: scan the machine for local MCP servers and Skills, enable them with an iOS-style switch, and their tools are exposed on the existing `/mcp` endpoint (no second connector). Entries are off by default; enabled MCPs run with your Windows user privileges and no extra OS sandbox. Enabled servers are projected to the standard `.mwh/mcp.json` (`mcpServers` shape) and enabled Skills to `.mwh/skills.json`; the full catalogue lives in `.mwh/resources.json`. Resource mutations (add/toggle/probe) are Bearer-authenticated control-plane calls and do not go through the desktop approval island (see `docs/SECURITY_DISCLOSURE.md` §4.8). Covered by a dedicated `test:resources` suite (`node scripts/test_resources.mjs`).
- **Four-tab Advanced Configuration Center & iOS-style switches** — the settings subpanel is now four tabs (`Connectors & Permissions` / `Workspaces & Subagents` / `Resource Library` / `Audit Log`) with a parameter-level visual spec in `docs/DESIGN.md`; toggles are iOS-style switches with in-place animation. Resource requests from the panel go through the main-process `mwh:daemon-http` IPC bridge (the panel can no longer fetch `127.0.0.1` directly from the `muse.ai` page origin).
- **Bearer Token & Secret Defense Line Hardening (6 Security Closures)** —
  1. **Win32 DPAPI Encrypted Secret Store (`src/security/secretStore.ts`)**: `.mwh/secrets.json` now encrypts `token`, `signingKey`, `cookieSecret`, and `tokenExpiresAt` at rest using `crypt32.dll` `CryptProtectData` / `CryptUnprotectData` (`schema: "mwh-secrets/v2-dpapi"`, bound to the current Windows user SID via `koffi`, zero new npm dependencies) with atomic temp-file writes, automatic one-version plaintext migration, and non-overwrite protection when ephemeral env tokens are used.
  2. **Token TTL & Persistent Rotation**: `BearerAuthGuard` enforces `tokenExpiresAt` (default 30 days, configurable via `MWH_TOKEN_TTL_DAYS` / `MWH_TOKEN_TTL_MS`, returning `401 TOKEN_EXPIRED`), and `POST /api/v1/tunnel/rotate-token` now persists rotated tokens and rotated UI cookie secrets to `.mwh/secrets.json` via DPAPI while immediately revoking the previous token and active `/ui` session cookies.
  3. **Loopback Token Endpoint Origin/CORS Lockdown**: `GET /api/v1/tunnel/token` now requires a direct physical loopback socket with zero proxy headers, validates `Sec-Fetch-Site` (`same-origin` / `none`) and loopback `Origin`, sets `Cache-Control: no-store`, and omits wildcard `Access-Control-Allow-Origin` across `/api/v1/tunnel/token`, `/ui/*`, and `/approve/*`.
  4. **REST Critical Approval Anti-Bypass & `sessionStorage` Migration**: `resolveRequestActor` rejects `body.source = "ui_island"` spoofing from `Mcp-Session-Id`, non-loopback sockets, tunnel headers, or cross-origin requests; `POST /api/v1/tasks/:id/approve` enforces `403 LOOPBACK_SELF_APPROVAL_FORBIDDEN` for critical (`requiresMobileHmac`) tasks on non-loopback binds or when `MWH_BLOCK_LOOPBACK_CRITICAL_APPROVAL=1`; `/ui` migrated `mwh_bearer_token` from persistent `localStorage` to tab-scoped `sessionStorage` and purges legacy `localStorage['mwh_bearer_token']`.
  5. **Ban-Bucket Anti-Spoofing (`CF-Connecting-IP`)**: loopback requests only honor `CF-Connecting-IP` when a Cloudflare tunnel is actively running in `MwhControlPlane` and a valid `CF-Ray` + IP literal are present, preventing local brute-force processes from rotating fake IPs to evade the 5-failure / 15-minute ban.
  6. **CSPRNG `mwh_ui_session` Cookie Secret & `Max-Age`**: replaced hardcoded `'mwh_ui_session_v1'` with a persisted 256-bit CSPRNG secret (`uiStatic.ts`) and added `Max-Age=86400; HttpOnly; SameSite=Strict; Path=/ui`. Covered by `scripts/negative_test_p3.mjs` C16.
- **Graceful Remote Shutdown Endpoint & Full-Exit Tray Quit** — `POST /api/v1/daemon/shutdown` is
  Bearer-protected (same trust level as emergency-kill). Unwired handlers return
  `503 SHUTDOWN_HANDLER_NOT_WIRED`; once assembled the route replies `200` and then triggers
  graceful teardown asynchronously (stop quick/named tunnels, stop HTTP, flush audit). Tray
  **Quit (stop daemon & tunnel)** best-effort HTTP-shuts an adopted daemon with a 3-second
  timeout (owned daemons still use the stdin channel). A new tray item
  **Close Window (keep daemon running)** hides the window without stopping the daemon.
  Gate5 G5C covers the contract.
- **Smart Domain-Routed Verification (`npm run verify` / `scripts/verify.mjs`), Single-Instance Shell Lock & Static-Analysis Closure** —
  `scripts/verify.mjs` auto-detects stale `dist/` artifacts (running local `tsc` before any `dist/`-based
  gate) and routes `git status` touched files to the minimal sufficient verification suites.
  Interactive desktop shells now enforce `app.requestSingleInstanceLock()` and record `.mwh/daemon.json`
  for `doctor.mjs` observability. All 7 previously reported static-analysis findings are closed (`cliAdapters.ts` fixed
  `'cmd.exe'`, `tunnels.ts`/`doctor.mjs` exact `cloudflared.exe` + `joinInsideRoot` fencing,
  `authGuard.ts` regex-free IP normalization, `postWorkspaceAdd` pre-stat `resolveNativePath`,
  `DesktopHands` coordinate & path validation, covered by `negative_test_p3.mjs` C15).
- **3-Layer Global Emergency Kill (`/api/v1/daemon/emergency-kill`)** — in addition to terminating all
  active Win32 Job Object process trees (`JobManager.abortAll()`), emergency kill now atomically
  rejects all `PENDING` approvals (`ApprovalEngine.rejectAllPending('EMERGENCY_KILL')`) so stale
  approvals can never be approved afterwards, and increments `SubagentDispatcher.emergencyEpoch` to
  abort in-flight builtin ReAct loops immediately.
- **Verified 4-Profile Permission Matrix & Cross-Scenario Gates** — added reproducible matrix
  verification (`plan` / `confirm` / `autonomous` / `full-access` × 6 action classes in
  `negative_test_p3.mjs` C13/C14), Emergency-Kill + Immediate Rollback cross-verification in `gate1`
  (5G), and 3-layer emergency-kill E2E verification in `gate5` (G5B).
- **Multi-language READMEs & Synthetic Vector Brand Assets** — added English primary `README.md`,
  `docs/readme/README_zh.md`, `README_zh-TC.md`, `README_ja.md`, `docs/README.md` index,
  and hand-crafted SVG mockups under `assets/brand/` (`mwh-logo.svg`,
  `mwh-cover.svg`, `mwh-ui-mockup.svg`).
- **`docs/PAIRING.md`** — the operator-facing pairing and recovery guide: first pairing, quick-tunnel
  hostname rotation (URL changes, token does not), `401`/`403` root causes, the connector-delete →
  new side chat → rebuild recovery path, and why the "re-register" loop is not a deadlock.
- **`mwh:daemon-status` IPC channel** and `getDaemonStatus()` on `window.mwhChrome`, so the chrome
  shell can render a honest "daemon not connected" strip instead of an empty window.
- **Dual-Protocol Gateway** — a single loopback daemon exposes the same tool surface over
  Streamable HTTP MCP at `/mcp` and a REST API at `/api/v1`, both guarded by a bearer
  runtime token.
- **Single-Pipeline Kernel** — one execution pipeline serves every channel (MCP, REST,
  desktop overlay, subagents) with four unified permission profiles: `plan`, `confirm`,
  `autonomous`, and `full-access`.
- **Seven default orthogonal tools** — `pc_status`, `fs_explore`, `fs_mutate`,
  `exec_command`, `job_control`, `subagent_dispatch`, and `git_checkpoint`.
- **Optional conditional `desktop_hands` tool** — an eighth desktop-automation tool that is
  exposed only when `desktopHands.enabled: true`.
- **ACP stdio and custom-profile subagent dispatch** with optional Git worktree isolation,
  incremental event ring streaming, live mid-run steering, and cooperative teardown.
- **Pre-mutation Git shadow snapshots** with single-item rollback for file mutations and
  checkpoint-based restore.
- **Electron frameless desktop shell** — a frameless `chrome.html` host with `BrowserView`
  preload injection for the floating capsule, approval island, and settings panel.
- **Verification alignment** — the kernel gates and the desktop E2E contract are aligned on
  the G10 / Gate-A2 expectations, including the generated skill template that mirrors the
  live tool surface.

### Fixed

- **`cloudflared` discovery no longer depends on a machine-specific path.** The probe chain is now
  `config.tunnel.cloudflaredPath → CLOUDFLARED_PATH → PATH → well-known dirs → <workspace>/.mwh/bin →
  MWH_CLOUDFLARED_DIR → version-manager layouts`; the v0.1.0 de-hardcoding had silently removed the
  only source that used to match, so Quick Tunnel could never start on an existing install.
- **Tunnel start failures are no longer reported as success.** `POST /api/v1/tunnel/driver` now returns
  `502 QUICK_TUNNEL_START_FAILED` with the real reason instead of `200 { ok: true }`; an explicit
  `stopQuick` request returns `500 TUNNEL_STOP_FAILED` when the child survives.
- **`cloudflared` teardown actually kills the process tree** (PID-scoped force kill as a fallback),
  so a stopped tunnel cannot leave an orphan holding the old hostname.
- **`npm run doctor`** — a one-shot environment self-check (build, daemon, token, `cloudflared`,
  leftover processes) with `--fix` to vendor a discovered binary into `.mwh/bin`.
- **`MWH启动.cmd` preflight no longer blocks the window.** The launcher still runs
  `electron.exe . --ensure-daemon-only` first (start, wait up to 20s, verify `/api/v1/state`), but a
  preflight failure now opens the shell anyway and the chrome banner shows the real host status
  (including the listener PID/image when port 19820 is held by another process). The global
  `taskkill` by image name is gone.
- **`ensureDaemon()` reports structured results** (`adopted` / `spawned` /
  `PORT_OCCUPIED_UNAUTHORIZED` / `DAEMON_START_TIMEOUT` / `SPAWN_FAILED`) and falls back to
  `ELECTRON_RUN_AS_NODE=1` via Electron when no system `node` is found.
- **The pairing prompt no longer claims "已接通".** It is now labelled as a template, and it tells
  the model to verify with `pc_status` before treating the connector as live.
- **Copying pairing artifacts while the host is down now fails loudly** instead of emitting
  instructions built from placeholder state.

### Changed

- Renamed the user-facing term 「子代理」 to 「代理（ACP Agent）」 across the settings drawer, the
  injected UI, and the docs. Tool names, identifiers, and code comments are unchanged; the UI
  contract gate now asserts the «代理» tab title.

[0.1.0]: https://github.com/MatikaneMeika/muse-win-harness/releases/tag/v0.1.0

# Muse-Win-Harness (MWH) — Agent Engineering & Lifecycle Rules

All AI coding agents working in this repository must follow these mandatory rules:

1. **Never Ship Unbuilt or Stale Artifacts**:
   - After modifying `src/`, `frontend/`, `shell/`, or `MWH启动.cmd`, always run `node scripts/verify.mjs` before handoff.
   - `scripts/verify.mjs` automatically compiles stale backend (`dist/cli.js`) and frontend (`frontend/dist/index.html`) artifacts and routes domain tests.
   - Use `node scripts/ensure-ready.mjs` (or `npm run build:all`) to self-heal all three packages (`root`, `shell`, `frontend`), vendor `cloudflared.exe` into `.mwh/bin/`, and clean up stale MWH processes.

2. **Process & Port Lifecycle Hygiene (`127.0.0.1:19820`)**:
   - **Never** run `taskkill /IM` by image name (`node.exe`, `electron.exe`, `cloudflared.exe`) — adjacent tools (such as MWHLite or AgentDock) share these executable names.
   - **Never** leave background `node dist/cli.js` or `electron.exe` test processes running after verification.
   - Whenever code or build artifacts change while an old MWH daemon or tray shell is running, restart via `MWH启动.cmd` / `scripts/ensure-ready.mjs` so the shell never adopts a stale daemon or stale preload script.

3. **Cloudflared Binary Hygiene**:
   - `QuickTunnelDriver` expects `cloudflared.exe` on `PATH`, in standard install dirs, in `<workspace>/.mwh/bin/cloudflared.exe`, or via `MWH_CLOUDFLARED_DIR`.
   - Run `node scripts/doctor.mjs` whenever touching launcher, daemon, shell, or tunnel code.

4. **Repository Hygiene & Security Contracts**:
   - **Never** commit or leave `docs/plans/` or `docs/archive/` in the repository tree (enforced by `scripts/test_ui_contract.mjs` Gate 14).
   - **Never** hardcode machine-specific local paths (`D:\gongju`, `E:\gongju`, `C:\Users\<name>`) in committed scripts or source files.
   - Keep `MWH启动.cmd` aligned with Gate 13 (`--ensure-daemon-only`, `Opening the shell anyway`, `ensure-ready.mjs`, zero `taskkill`).

<p align="center">
  <img src="./assets/brand/mwh-cover.svg" alt="Muse-Win-Harness: Local Agent Execution Engine & Desktop Companion Shell for Windows 10/11" width="100%">
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> |
  <a href="./docs/readme/README_zh.md">简体中文</a> |
  <a href="./docs/readme/README_zh-TW.md">繁體中文</a> |
  <a href="./docs/readme/README_ja.md">日本語</a> |
  <a href="./docs/README.md">Docs Map</a>
</p>

<p align="center">
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.1.0_early_preview-2B7FFF.svg" alt="Version 0.1.0"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-1B6FEF.svg" alt="Apache-2.0 License"></a>
  <img src="https://img.shields.io/badge/platform-Windows_10_%2F_11_x64-0078D6.svg" alt="Windows 10/11 x64">
  <img src="https://img.shields.io/badge/node-%3E%3D22.0.0-339933.svg" alt="Node.js >= 22">
  <a href="./docs/SECURITY_DISCLOSURE.md"><img src="https://img.shields.io/badge/security-Fail--Closed_Fenced-10B981.svg" alt="Security Disclosure"></a>
</p>

**Muse-Win-Harness (MWH) gives a cloud AI agent a pair of hands on your Windows PC — without giving away the keys to the house.** It connects [Muse](https://muse.ai) (or any standard MCP / REST client) to a native Windows 10/11 workstation with zero WSL2, zero Hyper-V, and zero Docker overhead: every path is canonicalized against NTFS junctions, every child process lives inside a Win32 Job Object (`KILL_ON_JOB_CLOSE`), every file edit creates a pre-write Git Shadow snapshot for one-click rollback, and destructive commands pause at a desktop floating island until you click approve.

> [!IMPORTANT]
> **Early Preview (`v0.1.0`) & Honest Security Boundary (No Security Washing)**
>
> **无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流** *(No OS-kernel sandbox; relies on application-layer path confinement, Win32 Job Object process tree control, pre-write Git Shadow snapshots, and human-in-the-loop approval workflows).* Read the full [Security Disclosure & Verified Permission Matrix](./docs/SECURITY_DISCLOSURE.md) and [Known Limitations](#known-limitations) before use.

## Table of Contents

- [Why Muse-Win-Harness](#why-muse-win-harness)
- [UI Preview (Synthetic Vector Mockup)](#ui-preview-synthetic-vector-mockup)
- [Exposed Tools Matrix (7 Default + 1 Conditional)](#exposed-tools-matrix-7-default--1-conditional)
- [Quick Start & Pairing](#quick-start--pairing)
- [Security Boundary & Verified Matrix](#security-boundary--verified-matrix)
- [Known Limitations](#known-limitations)
- [Documentation Map](#documentation-map)
- [Contributing & License](#contributing--license)

## Why Muse-Win-Harness

<table>
  <tr>
    <td width="50%" valign="top">
      <b>Asks before it touches.</b><br>
      Four unified permission profiles — <code>plan</code> (read-only), <code>confirm</code> (ask before write, default), <code>autonomous</code> (auto-approve inside workspace), and <code>full-access</code> (2-hour auto-downgrade timer). Destructive commands (<code>rm -rf</code>, <code>Remove-Item -Recurse</code>, <code>git push --force</code>, <code>format</code>) and sensitive paths (<code>.env*</code>, <code>~/.ssh</code>, <code>~/.aws</code>) always require cryptographic HMAC human confirmation.
    </td>
    <td width="50%" valign="top">
      <b>Instant approval receipts.</b><br>
      Click <i>Approve Once</i> on the bottom desktop floating island and the daemon executes the task and writes a sanitized <code>CONSUMED</code> receipt immediately. The cloud model polls <code>job_control(action="poll", approvalId="appr_...")</code> directly — no need to type "approved" in chat. Stale approvals targeting deleted/renamed files fail closed automatically.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>Kills the whole tree, not just the parent.</b><br>
      Every shell command and ACP agent runs with <code>CREATE_NO_WINDOW</code> (zero console popups) inside a Win32 Job Object via Koffi FFI. Floating-island <i>Kill</i> terminates a single job tree; <i>Global Emergency Kill</i> atomically kills all active job trees, aborts in-flight builtin ReAct loops, and rejects all pending approvals.
    </td>
    <td width="50%" valign="top">
      <b>Undo in one click.</b><br>
      Before any file write or approved task, MWH captures tracked, untracked, and CJK-named files into a deterministic Git Shadow checkpoint under <code>.mwh/checkpoints/</code>. The <i>Audit</i> tab groups snapshots by workspace path for single-item 1-click rollback with pre-restore integrity verification.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>Bring your own local ACP agents.</b><br>
      Register any Agent Client Protocol (JSON-RPC 2.0 over stdio) binary in <code>%USERPROFILE%\.mwh\acp-profiles.json</code>. Every dispatched agent obeys <b>Iron Law 1</b> (<code>ChildMode &lt;= ParentMode</code> privilege ceiling) and <b>Iron Law 2</b> (optional <code>git worktree</code> isolation).
    </td>
    <td width="50%" valign="top">
      <b>Preflight-verified desktop shell.</b><br>
      <code>MWH启动.cmd</code> runs <code>electron.exe . --ensure-daemon-only</code> first to verify <code>127.0.0.1:19820</code> and Bearer auth before opening the frameless window. If the daemon is unreachable, the top bar renders an honest status banner instead of a fake ready state.
    </td>
  </tr>
</table>

## UI Preview (Synthetic Vector Mockup)

<p align="center">
  <img src="./assets/brand/mwh-ui-mockup.svg" alt="Synthetic vector mockup of the MWH frameless desktop shell, 20px settings drawer, 24px 5-tab advanced configuration center, and bottom approval floating island" width="96%">
</p>

<p align="center">
  <sub><i>Synthetic vector diagram (zero real screenshots, zero private endpoints/paths). Left: 320px/20px settings drawer. Right: 5-column equal-width advanced configuration center (Connect / Permissions / Workspaces / Agents / Audit). Bottom: real-time approval floating island.</i></sub>
</p>

## Exposed Tools Matrix (7 Default + 1 Conditional)

MWH exposes **7 orthogonal tools by default** over `/mcp` (Streamable HTTP JSON-RPC 2.0) and `/api/v1/tools/:name`. The 8th tool (`desktop_hands`) is hidden unless explicitly enabled in `config.yaml`.

| Tool Name | Category | Default | Supported `action` Values & Capabilities |
| :--- | :--- | :---: | :--- |
| `pc_status` | `read` | Yes | Host OS/CPU/RAM telemetry, active permission `profile`, tunnel state, `lastApprovalReceipt`, and probed ACP agent profiles. |
| `fs_explore` | `read` | Yes | Path-fenced file operations: `read` (line-sliced), `list` (directory entries), `glob` (pattern match), and `grep` (bounded regex search). |
| `fs_mutate` | `write` | Yes | Pre-write Git Shadow snapshot followed by atomic `write`, exact snippet `edit`, `move`, or `delete`. |
| `exec_command` | `sensitive_write` | Yes | PowerShell execution (`-EncodedCommand` UTF-16LE Base64) under `windowsHide: true` and Win32 Job Object containment; 8000ms fast/slow dual-track yield. |
| `job_control` | `write` | Yes | Background job & approval lifecycle: 8KB UTF-8 aligned `poll`, incremental `events`, live `steer`, `stdin`, process-tree `abort`, `approve`/`reject`, and `status`. |
| `subagent_dispatch` | `sensitive_write` | Yes | Dispatches and controls ACP stdio agents or the builtin ReAct loop under `ChildMode <= ParentMode` ceiling (`run`, `resume`, `events`, `wait`, `steer`, `interrupt`, `list`, `profiles`). |
| `git_checkpoint` | `write` | Yes | Deterministic workspace snapshot management: `create`, `status`, `diff`, and pre-verified single-point `rollback`. |
| `desktop_hands` | `sensitive_write` | Conditional `[Experimental]` | DPI-aware Win32 desktop automation (`screenshot`, `mouse_move`, `mouse_click`, `keyboard_type`). **Disabled and hidden by default**; registered only when `desktopHands.enabled: true`. |

## Quick Start & Pairing

### 1. Requirements & Build

- **OS**: Windows 10 / Windows 11 x64
- **Runtime**: Node.js `>= 22.0.0` (pinned in [`.nvmrc`](./.nvmrc)) and Git in `PATH`

```powershell
# 1. Enable repository pre-commit hook (blocks accidental commits of runtime SKILL.md)
git config core.hooksPath .githooks

# 2. Install dependencies across root, frontend, and Electron shell
npm ci
npm --prefix frontend ci
npm --prefix shell ci

# 3. Build frontend assets and TypeScript kernel
npm run build:ui
npm run build
```

### 2. Launch the Daemon & Desktop Shell

Double-click [`MWH启动.cmd`](./MWH启动.cmd) (runs preflight `--ensure-daemon-only` first, then opens the detached frameless shell), or start from PowerShell with explicit environment secrets (use your own high-entropy values, never commit real secrets):

```powershell
$env:TUNNEL_RUNTIME_TOKEN = "<YOUR_RANDOM_32_PLUS_CHAR_RUNTIME_TOKEN>"
$env:MWH_HMAC_SECRET      = "<YOUR_RANDOM_64_HEX_HMAC_SECRET>"

# Start daemon on 127.0.0.1:19820
npm start

# In a second terminal, launch the Electron companion shell
npm --prefix shell start
```

### 3. Pair with Muse (3 Steps — Full Recovery Guide in [`docs/PAIRING.md`](./docs/PAIRING.md))

1. Open the MWH drawer (left rail icon) -> **Connectors & Tunnels**, start `Cloudflare Quick Tunnel`, and copy the **MCP Endpoint** and **Bearer Token**.
2. Create a custom MCP connector in Muse with those two values (never paste your Bearer Token into chat), then click **Copy Pairing Prompt** and paste the key-free prompt template into a **new** chat.
3. Ask Muse to call `pc_status` — pairing is live only when `pc_status` returns your active permission profile, workspace root, and tunnel status. If a quick tunnel rotates its `*.trycloudflare.com` hostname after a restart, update the connector URL (your token stays unchanged). See [`docs/PAIRING.md`](./docs/PAIRING.md) for `401`/`403` recovery.

### 4. Run Verification Gates

Before filing an issue about "the tunnel will not start", run the environment doctor — it checks the
build, the daemon, the token, the `cloudflared` probe chain and leftover processes in one shot:

```powershell
npm run doctor
node scripts/doctor.mjs --fix --cloudflared "<path-to-cloudflared-or-versions-dir>"  # vendor once into .mwh/bin
```

```powershell
npm run build
npm --prefix frontend run lint
npm --prefix frontend run build
npm run test:ui-contract
npm run test:kernel-safety   # gate1 + gate2 + gate3 + gate4 + gate:acp
npm run gate5                # Full control-plane & CDP desktop shell E2E
node scripts/negative_test_p1.mjs
node scripts/negative_test_p2.mjs
node scripts/negative_test_p3.mjs
```

## Security Boundary & Verified Matrix

Every permission profile and kill switch is continuously verified by automated gates (`gate1`~`gate5`, `gate:acp`, and `negative_test_p1`~`p3`). See [`docs/SECURITY_DISCLOSURE.md`](./docs/SECURITY_DISCLOSURE.md) for the complete 4-profile × 8-action matrix.

| Profile (`profile`) | Underlying Mapping | In-Workspace Read | In-Workspace Write / Exec | Out-of-Workspace Path | `.env*` / `~/.ssh` / Destructive (`rm -rf`, `push -f`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`plan`** | `read-only` × `smart-risk` | `SUCCESS` | `DENIED` (`READ_ONLY_MODE_*_DENIED`) | `DENIED` | `DENIED` |
| **`confirm`** *(default)* | `workspace-write` × `smart-risk` | `SUCCESS` | `CONFIRMATION_REQUIRED` (Floating Island) | `DENIED` (`PATH_CONFINEMENT_VIOLATION`) | `.env*` `DENIED`; destructive `CONFIRMATION_REQUIRED` (`critical` + HMAC `once`) |
| **`autonomous`** | `workspace-write` × `auto-workspace` | `SUCCESS` | `SUCCESS` (auto Git Shadow snapshot) | `DENIED` (`PATH_CONFINEMENT_VIOLATION`) | `.env*` `DENIED`; destructive `CONFIRMATION_REQUIRED` (`critical` + HMAC `once`) |
| **`full-access`** | `danger-full-access` × `unattended-yolo` | `SUCCESS` | `SUCCESS` (2h auto-downgrade timer) | `SUCCESS` (ordinary read/write allowed) | `CONFIRMATION_REQUIRED` (`critical` + HMAC `once`, never bypassed) |

## Known Limitations

1. **No OS-Kernel Sandbox**: MWH runs under the current Windows user account without Hyper-V, WSL2, or AppContainer virtualization. Defense relies on `realpathSync.native` path fencing, NTFS junction blocking, sensitive path blacklisting, Win32 Job Objects, pre-write Git Shadow snapshots, and human approval gates ([`docs/SECURITY_DISCLOSURE.md`](./docs/SECURITY_DISCLOSURE.md)).
2. **`workspace-acl-experimental` Not Implemented (Fail-Closed)**: Reserved for future Windows restricted-token / dynamic NTFS ACL isolation. Requesting it fails closed with `MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED` and leaves the active mode unchanged.
3. **External BYOK CLI Agent Boundary**: Third-party CLI binaries spawned via `subagent_dispatch` run as external child processes. MWH enforces `ChildMode <= ParentMode`, optional Git Worktree isolation, environment secret scrubbing, and Win32 Job Object tree termination, but cannot hook native syscalls inside third-party binaries.
4. **`desktop_hands` Conditional & UIPI Bounded `[Experimental]`**: Disabled and omitted from tool schemas by default. When enabled (`desktopHands.enabled: true`), Windows User Interface Privilege Isolation (UIPI) prevents non-elevated MWH processes from injecting input into elevated (Administrator) windows.
5. **Public Tunnel External Dependencies `[Experimental]`**: `Cloudflare Quick Tunnel` requires `cloudflared.exe` and rotates its random `*.trycloudflare.com` subdomain on restart; `Named Tunnel`, `Tailscale Funnel`, and `Custom TLS Proxy` require user-provisioned domains/certificates.
6. **Gate-A2 Sliding-Window Sensitivity Under Heavy Disk I/O**: `npm run gate:acp` (Gate-A2) tests sub-second sliding-window activity extension via workspace signature scans; extreme host disk I/O contention can occasionally introduce timing jitter.

## Documentation Map

| Document | Description |
| :--- | :--- |
| [`docs/README.md`](./docs/README.md) | Full documentation index |
| [`docs/readme/README_zh.md`](./docs/readme/README_zh.md) | Simplified Chinese full documentation (简体中文完整说明) |
| [`docs/readme/README_zh-TW.md`](./docs/readme/README_zh-TW.md) | Traditional Chinese overview (繁體中文說明) |
| [`docs/readme/README_ja.md`](./docs/readme/README_ja.md) | Japanese overview (日本語ドキュメント) |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Preflight chain, dual-protocol gateway, single-pipeline kernel, and ACP dispatcher |
| [`docs/PAIRING.md`](./docs/PAIRING.md) | Step-by-step Muse pairing, quick-tunnel URL rotation, and 401/403 recovery |
| [`docs/SECURITY_DISCLOSURE.md`](./docs/SECURITY_DISCLOSURE.md) | Verified 4-profile permission matrix, 3-layer emergency kill, SSRF guard, and residual risks |
| [`docs/UI.md`](./docs/UI.md) | Frameless Electron shell, preload injection contract, and manual UI inspection guide |
| [`docs/ADR.md`](./docs/ADR.md) | Architecture Decision Records (ADR-001 through ADR-012) |
| [`docs/WORKFLOW_BRANCH_TESTING.md`](./docs/WORKFLOW_BRANCH_TESTING.md) | Branch isolation, Git worktree testing, and titlebar branch badge workflow |

## Contributing & License

Contributions, bug reports, and security reviews are welcome. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the build and gate checklist, [`SECURITY.md`](./SECURITY.md) for vulnerability reporting, and [`DISCLAIMER.md`](./DISCLAIMER.md) for the independent interoperability statement.

Licensed under the [Apache License, Version 2.0](./LICENSE). Muse-Win-Harness is an independent community project and is not affiliated with or endorsed by `muse.ai` or Meta Platforms, Inc.

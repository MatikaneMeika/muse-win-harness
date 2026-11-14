---
name: muse-win-harness
description: Local Windows Agent Runtime and Bridge for Muse
version: 0.1.0
endpoint: <YOUR_TUNNEL_OR_LOCAL_URL>
mcpEndpoint: <YOUR_TUNNEL_OR_LOCAL_URL>/mcp
restEndpoint: <YOUR_TUNNEL_OR_LOCAL_URL>/api/v1
authHeader: "Authorization: Bearer <TUNNEL_RUNTIME_TOKEN>"
---

# Muse-Win-Harness (MWH) Integration Guide

MWH is an independent open-source local agent runtime and forward bridge for Windows.

> This file is a checked-in example of what the daemon generates at runtime into
> `connectors/muse-skill-template/SKILL.md` (via `SkillTemplateGenerator.refreshSkillMd(<endpoint>)`).
> Replace `<YOUR_TUNNEL_OR_LOCAL_URL>` with your active endpoint (for example
> `http://127.0.0.1:19820`). The generated `SKILL.md` is git-ignored and must never be committed.

## Endpoints
- **Streamable HTTP MCP**: `<YOUR_TUNNEL_OR_LOCAL_URL>/mcp`
- **REST Skill API**: `<YOUR_TUNNEL_OR_LOCAL_URL>/api/v1/*`
- **Authentication**: Include header `Authorization: Bearer $TUNNEL_RUNTIME_TOKEN` on all requests.

## Exposed Tools (7 Muse Tools)
### `pc_status` (read)
Retrieves host machine telemetry, confinement mode, approval policy, security boundary, and available local CLIs.

### `fs_explore` (read)
Safely explores the filesystem with boundary enforcement (read, list, glob, grep).

### `fs_mutate` (write)
Safely mutates filesystem files (write, edit, move, delete) with automatic pre-mutation git snapshot.

### `exec_command` (sensitive_write)
Executes a shell command with Win32 Job Object containment and fast/slow dual-track execution.

### `job_control` (write)
Controls background jobs (poll, events, steer, stdin, abort, status) and resolves conversational confirmation approvals (approve, reject).

### `subagent_dispatch` (sensitive_write)
Invokes and controls a profile-addressed local subagent (ACP stdio agent, custom profile ID, or builtin kernel) with privilege ceiling enforcement, git worktree isolation, incremental event ring streaming (action="events"/"wait"), live mid-run steering (action="steer"), and cooperative gradient teardown (action="interrupt"). Any profile ID is directly addressable via agent or profile (no fixed enum). Default timeoutMs is 600000 (10 minutes).

### `git_checkpoint` (write)
Creates deterministic snapshots of tracked and untracked files and provides 1-click rollback.

> **Optional 8th tool**: `desktop_hands` (sensitive_write) — native Windows desktop automation
> (`windows`, `inspect` UIA tree, multimodal `screenshot` with redaction, background-first `act`,
> and emergency-stoppable `batch`). For native desktop apps only—use Resource Library MCP tools
> for web/browser tasks. It is only exposed when `desktopHands.enabled: true` in config or enabled
> in settings, in which case the generated `SKILL.md` lists 8 Muse Tools and includes the entry below.
>
> ### `desktop_hands` (sensitive_write)
> Native Windows desktop automation (windows, inspect UIA tree with elementToken and head+tail value preservation, screenshot with multimodal image output [unified full virtual-screen capture in Per-Monitor Aware V2 physical pixels, 1:1 source-space redaction of sensitive windows first, then proportional downsampling to <=3840x2160 with scaleFactor], background-first act [background type_text resolves child Edit/RichEditD2DPT/UIA text surfaces and enforces read-back tail verification returning verified/tailMatched/readBackLength/targetHwnd or failing with BACKGROUND_TYPE_TEXT_UNVERIFIED], and emergency-stoppable batch [aborted batches return outer status SUCCESS with [ABORTED] summary to carry step results while approval receipts record executionStatus ERROR / terminalStatus TERMINATED to prevent false-positive completion]). For native desktop apps only—use Resource Library MCP tools for web/browser tasks. Disabled by default.

## 本机资源库 (Local Resource Library)

This section is generated at runtime from the local MCP / Skill registry.
Enabled MCP servers are stored in `.mwh/mcp.json` (standard `mcpServers` shape)
and enabled Skills in `.mwh/skills.json`; the full catalogue, including disabled
entries, is `.mwh/resources.json`. It is not a second connector: every MCP tool
below lives on this same `/mcp` endpoint, so Muse can say "use X to do Y"
the same way it would in a local harness.

Example shape of the generated section (a real one lists only enabled entries):

### 本机 MCP 工具
- **filesystem** (stdio) · 只读
  - tools/list: `filesystem_read_file`, `filesystem_list_directory`

### 本机 Skill
- **code-review** — Reviews the current diff and lists concrete defects.

Full text is not preloaded. When a Skill is needed, call `skill_read` with its
name, for example: `{ "name": "code-review" }`. Skill text never grants extra
permission: any tool it mentions is still subject to the normal permission
profile and approval flow. A server with a fault (start timeout, lost session)
stays switched on but its tools are temporarily withdrawn until it recovers.

## Permission Profiles (4 Unified Tiers)
- **计划模式 (Plan Mode)**: Read-only exploration and whitelisted inspection commands. All file writes and mutations are blocked.
- **变更前确认 (Confirm Before Change)**: Confined to authorized workspace roots; read probes run automatically, file mutations and shell commands require confirmation before execution.
- **自主模式 (Autonomous Mode)**: Confined to authorized workspace roots; routine workspace reads and writes run automatically with pre-mutation Git shadow snapshots; risky operations ask for confirmation.
- **完全访问 (Full Access)**: Cross-directory ordinary reads and writes run without cross-boundary critical escalation; destructive operations (`rm -rf`, `Remove-Item -Recurse`, `git push --force`, `format`) and sensitive credential paths still require confirmation.

## Approval & Automatic Receipt Polling Flow (G5)
1. **Confirmation Required**: When `exec_command`, `fs_mutate`, or `subagent_dispatch` returns `status: "CONFIRMATION_REQUIRED"` with `approvalId`:
   - The user approves on the desktop floating island. **Do NOT wait for the user to type "批了" in chat.**
   - Poll `job_control` directly using `approvalId`:
     `{ "action": "poll", "approvalId": "<approvalId>", "page": 1, "pageSize": 8192 }` (or `{ "action": "status", "approvalId": "<approvalId>" }`).
   - Once the user clicks Allow on the floating island, `approvalStatus` transitions to `CONSUMED` and returns the sanitized execution receipt or 8KB-paginated command output (`COMPLETED` / `FAILED`).
   - Never re-issue a stale delete or move against an old path that has already been renamed or removed.
2. **Polling Background Job Output**:
   - Call `job_control` (`POST <YOUR_TUNNEL_OR_LOCAL_URL>/api/v1/tools/job_control` or MCP tool `job_control`) with:
     `{ "action": "poll", "jobId": "<jobId>", "page": 1, "pageSize": 8192 }`
   - Each page returns up to 8KB (UTF-8 character boundary aligned) along with `status` (`RUNNING` | `RUNNING_ASYNC` | `COMPLETED` | `FAILED` | `TERMINATED`), `exitCode`, `page`, and `totalPages`.

## Subagent Async Dispatch & Polling
- `subagent_dispatch` is dual-track: fast runs return inline, while longer external CLI / ACP runs
  return `{ "status": "RUNNING_ASYNC", "jobId": "<jobId>", "runId": "<jobId>" }` after a short
  yield window (default 500ms).
- When a response has `status: "RUNNING_ASYNC"`, do **NOT** ask the user for confirmation and do
  **NOT** re-dispatch the task. Loop `job_control` directly:
  `{ "action": "poll", "jobId": "<jobId>", "page": 1, "pageSize": 8192 }` until `status` becomes
  `COMPLETED`, `FAILED`, or `TERMINATED`, incrementing `page` to read further output.
- The job log ends with a `[MWH_SUBAGENT_SUMMARY]` block, and the same structured object is returned
  as `subagentSummary` on every poll (`status`, `summary`, `filesModified`, `gitDiffStat`, `jobId`).
- Never hand-assemble low-level CLI permission / approval flags inside `exec_command`. MWH computes
  and confines child argv internally; those flags are local-only and redacted from every
  cloud-visible echo.

## Windows Command Quoting & `%` Format Specifiers (G7)
- `exec_command` runs via `powershell.exe -NoProfile -NonInteractive -EncodedCommand` (UTF-16LE Base64), bypassing `cmd.exe` `%VAR%` environment variable expansion and Win32 CLI quote stripping.
- When passing format strings containing spaces (e.g. `git log`), always wrap the format value in double quotes: `git log -1 --format="%H %D %s" --date=short`.
- If you explicitly invoke `cmd.exe /c ...`, escape literal percent signs as `%%` (e.g. `%%D`) to prevent `cmd.exe` from expanding them as environment variables.

## Security Model Notice
> **无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流**  
> High-risk operations require explicit human confirmation with signed one-time HMAC mobile links.

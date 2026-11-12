# Muse-Win-Harness (MWH) 架构设计说明书

## 1. 系统愿景与定位
Muse-Win-Harness（简称 **MWH**，当前版本 `v0.1.0`）是专为 Windows 10/11 原生环境打造的轻量级 Agent 运行时与双协议桥接底座。它为上游云端模型（如 `muse.ai`）及本地自治代理提供安全可控的系统接入能力，在无需 WSL2、Hyper-V 虚拟化或 Docker 守护进程的前提下，实现应用层路径围栏隔离、Win32 进程树深度受控、写前 Git Shadow 快照与桌面浮岛人机协同审批闭环。

```text
┌──────────────────────────────────────────────────────────────────┐
│               Upstream AI Agent (e.g. Muse.ai)                   │
└─────────────────────────────────┬────────────────────────────────┘
                                  │ (Forward MCP / REST API)
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│               Dual-Protocol Gateway (Port 19820)                 │
│  - Streamable HTTP MCP (/mcp)       - REST Skill API (/api/v1/*) │
│  - BearerAuthGuard (5-Strike/15m)   - Mobile HMAC Approval (/appr)│
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Single-Pipeline Execution Kernel               │
│               preExecute -> execute -> postExecute               │
│                                                                  │
│  [Unified 4-Tier Permission Profile] -> (Confinement × Approval) │
│   1. plan        -> read-only          × always-ask              │
│   2. confirm     -> workspace-write    × always-ask (Default)    │
│   3. autonomous  -> workspace-write    × smart-risk              │
│   4. full-access -> danger-full-access × unattended-yolo         │
│   (Note: workspace-acl-experimental is reserved Fail-Closed)     │
└──────────────────┬───────────────────────────────┬───────────────┘
                   │                               │
                   ▼                               ▼
┌──────────────────────────────────────┐ ┌─────────────────────────┐
│    7 Default + 1 Conditional Tools   │ │  Subagent Dispatcher    │
│ 1. pc_status      5. job_control     │ │ - Iron Law 1 (Ceiling)  │
│ 2. fs_explore     6. subagent_disp   │ │ - Iron Law 2 (Worktree) │
│ 3. fs_mutate      7. git_checkpoint  │ │ - Builtin ReAct Kernel  │
│ 4. exec_command   8. [desktop_hands] │ │ - Dynamic ACP Registry  │
└──────────────────┬───────────────────┘ └────────────┬────────────┘
                   │                                  │
                   ▼                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│               Async Job Engine & Win32 Containment               │
│  - Fast/Slow Dual-Track (8000ms threshold)                       │
│  - Win32 Job Object (koffi FFI: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)│
│  - Continuous Disk Stream (.mwh/logs/<id>.log) + 8KB Pagination  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心架构层次

### 2.0 启动与预检链路（Launch → Preflight → Shell）

双击 `MWH启动.cmd` 时，宿主先于窗口就绪，避免"空壳看起来像已启动"：

1. 启动器校验 `shell\node_modules\electron\dist\electron.exe` 与 `dist\cli.js`（缺失则先构建）。
2. 以前台方式执行 `electron.exe . --ensure-daemon-only`：`shell/main.cjs` 进入纯预检分支——只调用 `ensureDaemon()`，不建窗、不建托盘、不注册 IPC；结果以 `{ ok, adopted, reason }` 结构化输出并以退出码 `0` / `2` 返回。
3. `ensureDaemon()` 的判定语义：端口已开且 `GET /api/v1/state` 通过鉴权 → 接管现有宿主（`adopted`）；端口被占但鉴权失败 → `PORT_OCCUPIED_UNAUTHORIZED`；自拉起后 20 秒内仍不可用 → `DAEMON_START_TIMEOUT`；`spawn` 报 `ENOENT` 时回退到 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`。
4. 预检失败时启动器打印原因并停住，**不打开窗口**；成功后才 `start` 壳进程，且不把 `ELECTRON_RUN_AS_NODE` 继承给壳。
5. 壳内再次 `ensureDaemon()`：成功则正常建窗；失败时 `chrome.html` 顶部显示「宿主未连接（原因）」提示条，并由 `mwh:daemon-status` 通道上报状态，界面不再伪报「宿主守护就绪」。

### 2.1 双协议网关（Dual-Protocol Gateway）
- **Streamable HTTP MCP (`/mcp`)**：遵循 JSON-RPC 2.0 规范，完整实现 `initialize`（`serverInfo.version = "0.1.0"`）、`tools/list`、`tools/call`、`ping` 等指令，并支持基于 Server-Sent Events（SSE）的流式通知与会话绑定（`Mcp-Session-Id`）。
- **REST Skill API (`/api/v1/*`)**：为标准 HTTP 客户端与桌面伴随壳提供控制面与工具调用端点（`/api/v1/state`、`/api/v1/events`、`/api/v1/tools`、`/api/v1/tools/:toolName`）。
- **高安全认证守卫（`BearerAuthGuard`）**：
  - 同时兼容 `Authorization: Bearer <TOKEN>` 与 `X-API-Key: <TOKEN>`，基于 `crypto.timingSafeEqual` 防范时序侧信道攻击。
  - 单 IP 连续 5 次认证失败直接封禁 15 分钟（HTTP 429）。

### 2.2 单流水线内核与统一四档权限模型（Single-Pipeline Kernel）
面向用户与上游模型暴露统一的**四档权限模式（`PermissionProfile`）**，并在内核底层正交映射为 `ConfinementMode × ApprovalPolicy`：

| 统一权限档位 (`profile`) | 底层 `ConfinementMode` | 底层 `ApprovalPolicy` | 核心行为契约 |
| :--- | :--- | :--- | :--- |
| **`plan`（计划模式）** | `read-only` | `always-ask` | 仅允许只读文件探查与白名单只读探针命令，拒绝一切写操作。 |
| **`confirm`（变更前确认，默认）** | `workspace-write` | `always-ask` | 工作区内读操作静默放行；写文件、执行脚本或派发代理需经桌面浮岛或移动端 HMAC 审批，执行前自动创建 Git Shadow 快照。 |
| **`autonomous`（自主模式）** | `workspace-write` | `smart-risk` | 授权工作区白名单内的常规读写自动快照并放行；越界或高风险命令弹窗询问。 |
| **`full-access`（完全访问）** | `danger-full-access` | `unattended-yolo` | 跨工作区目录的普通读写不再因目录边界单独触发拦截；但高危破坏性命令（`rm -rf`、`git push --force`、`format` 等）与敏感凭据路径（`.ssh`、`.aws`、`.env*`）仍强制拦截并要求人工审批。支持 2 小时自动降级保护。 |

> **注**：底层枚举中的 `workspace-acl-experimental` 为未实装预留项，调用时严格按 Fail-Closed 拒绝执行。

所有工具调用严格执行三阶段生命周期：
1. **`preExecute`**：
   - 目标路径围栏校验（`pathGuard` 解析 `fs.realpathSync.native`，阻断跨目录逃逸与 NTFS Junction 欺骗）。
   - 敏感路径黑名单拦截（阻断访问 `~/.ssh`、`~/.aws`、`%APPDATA%`、浏览器密钥、`.env*`）。
   - 风险等级动态评估（`low` / `medium` / `high` / `critical`）与审批挂起（`CONFIRMATION_REQUIRED`）。
2. **`execute`**：
   - 工具原子分发与执行（内部支持受控的 `switch_mode` 档位切换动作）。
   - 文件写操作前自动触发 `GitCheckpointManager.create` 建立工作区安全快照。
3. **`postExecute`**：
   - 结构化审计日志落盘至 `.mwh/logs/audit.jsonl`，强制附带安全边界披露声明 `"无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流"`。
   - 在 `full-access` 模式下自动附加 `[FULL-ACCESS-ACTIVE]` 警示标头。

### 2.3 异步作业引擎（Async Job Engine & Fast/Slow Dual-Track）
- **8000ms 快慢双轨调度**：
  - 前台执行阈值默认 `fastTrackMs = 8000ms`。
  - 若子进程在阈值内完成，直接内联返回完整输出（`completedInline: true`）。
  - 若超时仍在运行，平滑转入后台作业（`status: 'RUNNING_ASYNC'`），立即返回 `jobId` 与日志路径。
- **分页轮询与审批回执自动消费**：通过 `job_control(action="poll", jobId | approvalId, page)` 每次拉取至多 `8192` 字节（8KB，UTF-8 字符边界对齐）的输出分块；用户在桌面浮岛点击批准后，Agent 直接轮询 `approvalId` 即可获取 `CONSUMED` 执行回执。
- **Win32 Job Object 进程树管控**：
  - 通过 `koffi` 动态加载 `kernel32.dll`，为每个作业分配原生 Windows Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000`）。
  - 在超时、用户主动中止（`abort`）或守护进程退出时，一键销毁整个孙代进程树（0 孤儿进程残留）。

### 2.4 子智能体调度器与动态 ACP 注册表（Subagent Dispatcher）
- **动态 ACP Profile 注册表（零硬编码静态 CLI 枚举）**：
  - 彻底废除早期静态 CLI 枚举，改由 `.mwh/acp-profiles.json` 与运行时设置面板动态管理任意兼容 ACP（Agent Client Protocol，JSON-RPC 2.0 over stdio）或自定义命令模板的本地代理 Profile（另内置 `builtin` ReAct 内核）。
  - 支持增量事件流缓冲环（`action="events"` / `action="wait"`）、运行中实时引导（`action="steer"`）与协作式梯度中断（`action="interrupt"`）。
- **铁律一：权限天花板（Privilege Ceiling）**
  - `MODE_RANK[childMode] <= MODE_RANK[parentMode]`。严禁代理获得高于父会话的隔离权限，越级请求直接抛出 `PRIVILEGE_ESCALATION_DENIED`。
- **铁律二：Git Worktree 工作区物理隔离（Worktree Isolation）**
  - 当启用 `isolateWorktree: true` 时，自动通过 `git worktree add --detach <path> HEAD` 创建专属平行工作树，任务结束后支持在 UI 审阅合并或一键卸载。

### 2.5 四大网络通道矩阵（Network Channels）
1. **Quick Tunnel（默认实测通道）**：自动检测环境变量 `MWH_CLOUDFLARED_EXE` / `MWH_CLOUDFLARED_DIR` 或系统 `PATH` 中的 `cloudflared`，以 `--protocol http2` 启动受控子进程隧道，输出 `*.trycloudflare.com` 公网 HTTPS 地址，并动态生成 `connectors/muse-skill-template/SKILL.md`（入库参考模板为 `SKILL.example.md`）。
2. **Named Tunnel `[Experimental]`**：支持通过环境变量 `MWH_CF_TUNNEL_TOKEN` 注入自定义域名 Cloudflare Named Tunnel 凭证。
3. **Tailscale Funnel `[Experimental]`**：自动探测环境变量 `MWH_TAILSCALE_EXE`、`PATH` 或 `%ProgramFiles%\Tailscale\tailscale.exe`，读取安全 CGNAT IPv4（`100.64.0.0/10`）。
4. **Custom Reverse Proxy `[Experimental]`**：Fail-Closed 校验，非 Loopback 绑定若未提供 `>=32` 位高熵 Token 与 `MWH_HMAC_SECRET` 则拒绝启动。

---

## 3. Muse 工具定义矩阵（7 默认暴露 + 1 条件注册）

`src/tools/definitions.ts` 中的 `getExposedMuseTools(desktopHandsEnabled)` 根据 `config.yaml` 的 `desktopHands.enabled` 动态决定暴露集合：

| 工具名称 | 元分类 | 默认暴露 | 核心能力与动作枚举 (`action`) |
| :--- | :--- | :---: | :--- |
| `pc_status` | `read` | ✅ 是 | 采集系统负载、内存用量、当前权限档位 (`profile`)、隧道状态、最近审批回执 (`lastApprovalReceipt`) 及已配置 ACP 代理列表。 |
| `fs_explore` | `read` | ✅ 是 | 安全文件探查：`read`（读内容）、`list`（目录列举）、`glob`（模式匹配）、`grep`（全文正则搜索）。 |
| `fs_mutate` | `write` | ✅ 是 | 文件原子变更：`write`（覆写/新建）、`edit`（精确片段替换）、`move`（移动/重命名）、`delete`（删除），变更前自动创建 Git Shadow 快照。 |
| `exec_command`| `sensitive_write` | ✅ 是 | 8000ms 快慢双轨 PowerShell 指令执行（`-EncodedCommand` Base64 UTF-16LE），Win32 Job Object 进程树包裹。 |
| `job_control` | `write` | ✅ 是 | 异步作业与审批控制：`poll`（8KB 分页日志/审批回执）、`events`（增量事件）、`steer`（运行中引导）、`stdin`（输入流推入）、`abort`（树级终结）、`approve`/`reject`（审批决策）、`status`（状态查询）。 |
| `subagent_dispatch`| `sensitive_write` | ✅ 是 | 派生与控制动态 ACP Profile 或 `builtin` 代理：`run`、`events`、`wait`、`steer`、`interrupt`、`list_profiles`。 |
| `git_checkpoint` | `write` | ✅ 是 | 跟踪与未跟踪工作区全状态确定性快照：`create`（创建快照）、`list`（列举历史）、`rollback`（单点回滚还原）。 |
| `desktop_hands` | `sensitive_write` | ⚙️ 条件注册 | Win32 DPI 自适应桌面自动化：`screenshot`、`mouse_move`、`mouse_click`、`keyboard_type`。**默认关闭且从工具列表中隐藏**，仅当 `desktopHands.enabled === true` 时注册暴露。 |

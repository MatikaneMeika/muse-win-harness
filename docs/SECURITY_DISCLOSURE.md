# Muse-Win-Harness (MWH) 安全边界如实披露表

> **严正声明（No-Security-Washing）**  
> **无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流**  
> *(No OS-level kernel sandbox; relies on application-layer path confinement, Win32 Job Object process tree control, and approval workflows.)*

本披露表旨在向用户如实阐述 MWH 在 Windows 平台上的实际防御能力与安全边界，杜绝任何概念夸大或安全粉饰。

---

## 1. 统一四档权限模式 (`PermissionProfile`) 与底层围栏边界对比

对外设置与配对说明已统一收敛为四档权限模式，映射到底层 `ConfinementMode` 与 `ApprovalPolicy`：

| 统一权限档位 | 底层映射 (`ConfinementMode` × `ApprovalPolicy`) | 应用层 / Win32 防护机制 | **真实非内核边界说明（无法阻止的事项）** |
| :--- | :--- | :--- | :--- |
| **`plan`（计划模式）** | `read-only` × `smart-risk` | 1. 拦截所有 `fs_mutate` 写调用。<br/>2. 阻断重定向（`>`、`>>`）与管道写。<br/>3. Shell 仅允许白名单只读命令（`git status`、`rg`、`whoami` 等）。 | 无法防御绕过白名单的恶意内联脚本解析，或具有副效应的隐蔽只读指令。 |
| **`confirm`（变更前确认）** | `workspace-write` × `smart-risk` | 1. 强制 `fs.realpathSync.native` 真实路径解析，拦截 `..` 与 NTFS Junction 软链接逃逸。<br/>2. 硬编码拦截敏感凭据路径（`~/.ssh`、`~/.aws`、`%APPDATA%`、`.env*`）。<br/>3. 所有写文件与写命令执行前均在桌面浮岛挂起询问。 | **非操作系统级沙盒**。一旦用户点击允许，子进程继承当前 Windows 登录用户的全部特权。 |
| **`autonomous`（自主模式）** | `workspace-write` × `auto-workspace` | 1. 授权工作区内常规读写自动创建 Git Shadow 快照并静默放行。<br/>2. 越界访问、敏感路径与高危命令强制拦截或挂起审批。 | 工作区内被放行的脚本仍以当前登录用户身份运行，可发起网络请求或读取全局可读目录。 |
| **`full-access`（完全访问）** | `danger-full-access` × `unattended-yolo` | 1. 允许跨工作区普通读写（不再因“工作区外路径”单独升为 `critical`）。<br/>2. **破坏性操作与敏感黑名单路径仍强制 `critical` 审批**：递归强制删除（`rm -rf`、`Remove-Item -Recurse`、`del /s`）、强制推送（`git push --force`）、磁盘格式化（`format`、`diskpart`）、系统管理命令（`reg`、`sc`、`schtasks`、`bcdedit`）及敏感凭据目录。<br/>3. 全程附加 `[FULL-ACCESS-ACTIVE]` 审计与 2 小时自动降级保护。 | **完全开放当前登录用户级特权**。普通跨目录读写无需逐次确认，执行后由当前用户承担系统修改风险。 |

> **附：底层 `workspace-acl-experimental` (Rank 3) 说明**  
> 受限令牌进程管线未实现，沙箱能力自检不通过时切换请求直接以 `MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED` 拒绝，绝不静默降级；对外 UI 已收敛为上述四档模式。

### 1.1 四档权限 × 核心动作可复现实测矩阵（Verified Matrix）

以下矩阵由 `scripts/negative_test_p3.mjs`（C13/C14）、`src/gates/gate1.ts` 与 `scripts/gate5_ui_e2e.mjs`（G4/G5/G5B/G6/G7）每次构建自动验证：

| 动作类别 / 工具入口 | `plan` (`read-only` + `smart-risk`) | `confirm` (`workspace-write` + `smart-risk`) | `autonomous` (`workspace-write` + `auto-workspace`) | `full-access` (`danger-full-access` + `unattended-yolo`) |
| :--- | :--- | :--- | :--- | :--- |
| **工作区内普通读取** (`fs_explore` / 白名单 `whoami`,`git status`) | `SUCCESS`（静默放行，不建快照） | `SUCCESS`（静默放行，不建快照） | `SUCCESS`（静默放行，不建快照） | `SUCCESS`（静默放行，附加 `[FULL-ACCESS-ACTIVE]`） |
| **工作区内文件变更** (`fs_mutate` write/edit/move/delete) | `DENIED` (`READ_ONLY_MODE_WRITE_DENIED`) | `CONFIRMATION_REQUIRED` (`medium`，浮岛挂起) | `SUCCESS`（自动写前快照后静默放行） | `SUCCESS`（自动写前快照后静默放行） |
| **工作区内普通命令** (`exec_command` 非白名单) | `DENIED` (`READ_ONLY_MODE_COMMAND_DENIED`) | `CONFIRMATION_REQUIRED` (`medium`，浮岛挂起) | `SUCCESS`（Job Object 包裹下自动执行） | `SUCCESS` (`high`，YOLO 期内自动放行) |
| **跨工作区普通读写** (`path` / `cwd` 在授权目录外) | `DENIED` (`PATH_CONFINEMENT_VIOLATION`) | `DENIED` (`PATH_CONFINEMENT_VIOLATION`) | `DENIED` (`PATH_CONFINEMENT_VIOLATION` / `EXEC_CWD_OUT_OF_WORKSPACE`) | `SUCCESS`（允许跨目录普通读写与 `cwd`） |
| **敏感凭据路径读写** (`.env*`, `~/.ssh`, `~/.aws`, `%APPDATA%`) | `DENIED` (`SENSITIVE_BLACKLIST`) | `DENIED` (`SENSITIVE_BLACKLIST`) | `DENIED` (`SENSITIVE_BLACKLIST`) | 写操作升为 `CONFIRMATION_REQUIRED` (`critical` + `requiresMobileHmac=true` + 强制 `once`)；读操作升为 `high` |
| **破坏性高危指令** (`rm -rf`, `Remove-Item -Recurse`, `git push -f`, `format d:`, `fs_mutate` 递归删) | `DENIED` (`READ_ONLY_MODE_*_DENIED`) | `CONFIRMATION_REQUIRED` (`critical` + `requiresMobileHmac=true` + 强制 `once`) | `CONFIRMATION_REQUIRED` (`critical` + `requiresMobileHmac=true` + 强制 `once`) | `CONFIRMATION_REQUIRED` (`critical` + `requiresMobileHmac=true` + 强制 `once`) |
| **派发代理与权限天花板** (`subagent_dispatch`) | 写意图直接 `DENIED`；请求更高 `childMode` 抛 `PRIVILEGE_ESCALATION_DENIED` | `CONFIRMATION_REQUIRED` (`high`)；子策略不松于父策略；越级返回 `403 PRIVILEGE_ESCALATION_DENIED` | 先挂起 `CONFIRMATION_REQUIRED` (`high`)；即使人工批准后若 `childMode > parentMode` 仍拒绝 (`PRIVILEGE_ESCALATION_DENIED`) | 允许 `childMode <= danger-full-access` 自动派发；内部 Critical 动作仍强制 HMAC 审批 |
| **快照创建与一键回滚** (`git_checkpoint` create/rollback) | `create`/`rollback` 均 `DENIED` (`READ_ONLY_MODE_WRITE_DENIED`)；`status`/`diff` 放行 | REST `/api/v1/snapshots/:id/rollback` 本机 UI 直接还原；MCP 工具调用走 `CONFIRMATION_REQUIRED` | `SUCCESS`（校验 `metadata.json` 与备份完整性，损坏则 `CHECKPOINT_RESTORE_FAILED` 中止） | `SUCCESS`（同左，受 realpath 围栏保护，禁止逃逸工作区） |

> **附：「多端审批」开关（默认关闭）**  
> 关闭时，上表 `confirm` 列完全按原行为（写文件与普通命令在浮岛挂起）。开启后，`confirm`（以及底层 `always-ask` / `smart-risk`）下的工作区文件变更、普通命令、以及非 HMAC 的高危动作（如 `subagent_dispatch`）不再二次挂起 Windows 浮岛，改由 Muse 官方 HITL 卡片在 `tools/call` 发出前于各端（Mac、手机、网页）确认。若用户在 Muse 中对该工具选择了「始终允许」，官方卡片也会跳过。破坏性操作（`rm -rf`、`git push -f`、`Remove-Item -Recurse` 等，`critical` + HMAC）无论开关是否开启，均仍在本机按命令检查——Muse 的「始终允许」以整个工具为单位，不会检查这条命令本身。本机 HMAC 审批页绑定在守护进程地址上，不在电脑跟前时无法代替官方卡片完成破坏性审批。

### 1.2 浮窗停止 (`task-kill`) 与全局急停 (`emergency-kill`) 杀伤边界

- **浮窗停止 (`POST /api/v1/tasks/:id/kill`)**：校验 `id` 属于当前活跃作业后，调用 `JobManager.abort(id)` —— 对外部 ACP 代理先执行协作式梯度中断（`session/cancel → stdin EOF → SIGTERM`），再调用 Win32 Job Object `TerminateJobObject` + `taskkill /F /T` 兜底并同步轮询确认父进程与派生孙进程 PID 全部消亡（`parentAlive=false, childAlive=false`）。
- **全局急停 (`POST /api/v1/daemon/emergency-kill`)**：一次性执行三层闭环清理：
  1. **全量作业进程树强杀**：`JobManager.getInstance().abortAll()` 终止所有 `RUNNING` / `RUNNING_ASYNC` 作业及其子孙进程树；
  2. **内置 ReAct 循环即时熔断**：`SubagentDispatcher.triggerEmergencyStop()` 递增全局急停代数（`emergencyEpoch`），打断所有在途内置多步循环（返回 `EMERGENCY_KILL_ABORTED`）；
  3. **挂起审批单全量作废**：`ApprovalEngine.rejectAllPending('EMERGENCY_KILL')` 将所有 `PENDING` 审批单原子置为 `REJECTED`（`executionStatus='DENIED'`），清空 `pendingTask`，杜绝急停后旧审批单被二次点击放行。

### 1.3 退出生命周期与隧道关闭边界（Exit Lifecycle & Tunnel Teardown）

托盘退出、窗口关闭与全局急停是三条**互不等价**的路径，隧道是否被拆除以本小节为准：

1. **托盘 Quit（彻底退出）**：菜单文案为 `Quit (stop daemon & tunnel)`。壳自拉起的 owned daemon 走 stdin 关停通道；领养态（adopted）daemon 走 `POST /api/v1/daemon/shutdown`（3 秒超时 best-effort）。两条路径都会触发 daemon **优雅停机**：停止 quick / named 隧道 + 停止 HTTP 服务 + 审计落盘；壳随后退出。
2. **点窗口 X / 托盘 `Close Window (keep daemon running)`**：仅隐藏窗口，daemon 与隧道保持运行（托盘常驻，与历史行为一致）。
3. **全局急停 `POST /api/v1/daemon/emergency-kill`**：执行第 1.2 节三层闭环（杀进程树 + 拒绝挂起审批 + 熔断 ReAct 循环），**不停隧道**。这是有意保留控制通道，以便急停后仍可重连 / 重配对——此边界如实披露，切勿将急停理解为「全量拆除」。
4. **shutdown 端点信任级**：与 `emergency-kill` 同级。持有效 Bearer token 者即可调用；这不是提权接口，token 即全部权限。handler 未装配时返回 `503 SHUTDOWN_HANDLER_NOT_WIRED`；装配后先 `200` 再异步触发停机。
5. **桌面壳单实例锁与宿主可观测性**：正常桌面壳模式启用 `app.requestSingleInstanceLock()`，重复启动 `MWH启动.cmd` 会自动唤醒并聚焦既有主窗口并退出副本进程（记入 `second_instance_redirected`），防止多壳共存时任一壳 Quit 误停共享 daemon；同时 daemon 启动时写入 `.mwh/daemon.json`（含 `pid`、`port`、`startedAt`）并在退出时清理，配合 `npm run doctor` 可即时核查宿主 PID 存活与最近退出原因。

---

## 2. 服务端 SSRF 与隧道 URL 防劫持规则 (`outboundGuard`)

MWH 服务端对配置的公网隧道地址（`customPublicUrl`、`cfNamedDomain`、`cfQuickUrl`、`tailscaleMagicDns`）及任何外部 HTTP/HTTPS 目标执行严格校验：
- **协议与格式约束**：仅允许 `http:` 与 `https:` 协议；严禁内嵌 `username:password@` 凭据、查询参数（`?`）或锚点（`#`）。
- **IPv4 禁止网段（BlockList 全量清单）**：
  - 未指定/当前网络：`0.0.0.0/8`
  - 本地回环：`127.0.0.0/8`
  - 私有局域网：`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
  - 链路本地：`169.254.0.0/16`
  - 运营商级 NAT（CGNAT/Tailscale）：`100.64.0.0/10`（注：仅 `tailscale-funnel` 模式下的 `tailscaleIp` 允许 CGNAT 段，不可伪装为公网 HTTPS 隧道）
  - 组播与保留：`224.0.0.0/4`, `240.0.0.0/4`
  - 文档专用（TEST-NET）：`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`
  - 基准测试：`198.18.0.0/15`
- **IPv6 禁止网段**：
  - 未指定与回环：`::/128`, `::1/128`
  - IPv4-mapped：`::ffff:0:0/96`（统一解码回 32 位 IPv4 后查 IPv4 表；非法变体一律 fail-closed 拒绝）
  - NAT64：`64:ff9b::/96`；唯一本地：`fc00::/7`；链路本地：`fe80::/10`；组播：`ff00::/8`；文档专用：`2001:db8::/32`

---

## 3. 认证安全、远程自批阻断与凭据防泄漏

- **Win32 DPAPI 静态加密存储 (`src/security/secretStore.ts`)**：
  - `.mwh/secrets.json` 采用 `mwh-secrets/v2-dpapi` 格式，通过仓内 `koffi` 直调 Win32 `crypt32.dll` `CryptProtectData` / `CryptUnprotectData`（`CRYPTPROTECT_UI_FORBIDDEN = 0x1`，按当前 Windows 登录用户 SID 加密绑定）将 `token`、`signingKey`、`cookieSecret` 与过期时间戳 `tokenExpiresAt` 加密落盘，并以临时文件原子重命名写入。
  - 兼容读取单版本旧明文 `secrets.json` 并在首次写入时原地升级为 DPAPI 密文；当启动时通过临时环境变量注入不同于磁盘的 `TUNNEL_RUNTIME_TOKEN`（如单测或一次性 CLI 调试）时，仅在当次进程内存中生效，绝不覆写污染 `.mwh/secrets.json`。
- **恒定时间比对、TTL 过期与防伪造封禁 (`BearerAuthGuard` & `MwhServer`)**：
  - 使用 SHA-256 定长摘要 + `crypto.timingSafeEqual` 比对 `Authorization: Bearer <token>`，支持可配置 TTL（默认 30 天，`MWH_TOKEN_TTL_DAYS` / `MWH_TOKEN_TTL_MS`），过期后立即返回 HTTP 401 `TOKEN_EXPIRED`。
  - 手动触发 `POST /api/v1/tunnel/rotate-token` 时：**旧 Token 0 秒宽限期立即硬撤销**，同步轮换 `uiSessionSecret` 使旧 `/ui` 会话 Cookie 立即失效，并将新 Token 与新 Cookie 密钥经 DPAPI 写回 `.mwh/secrets.json`。
  - 同一客户端 IP 在 15 分钟滑动窗口内连续 5 次鉴权失败立即封禁 15 分钟（HTTP 429 `IP_BANNED_TOO_MANY_FAILURES`）。回环连接仅在控制面存在实际运行的 Cloudflare 隧道（`isCloudflareTunnelActive() === true`）且同时携带合法 `CF-Ray` 与 IP 字面量时才采信 `CF-Connecting-IP`，彻底阻断本地进程伪造 `CF-Connecting-IP` 绕过封禁配额。
- **回环 Token 发现端点同源与反代理门禁 (`GET /api/v1/tunnel/token`)**：
  - 仅限物理回环 socket 且零代理转发头（严禁携带 `CF-Connecting-IP`、`CF-Ray`、`X-Forwarded-For`、`X-Real-IP`），强制 `Cache-Control: no-store` 且严禁下发 `Access-Control-Allow-Origin: *`；
  - 严格校验 `Sec-Fetch-Site`（仅允许 `same-origin` 或 `none`）与 `Origin`（仅允许匹配本机监听端口的 `127.0.0.1` / `localhost` / `[::1]`），阻断恶意网页通过浏览器跨站 `fetch` 窃取本机 Bearer Token（返回 HTTP 403 `CROSS_ORIGIN_TOKEN_DISCOVERY_FORBIDDEN`）。
- **CSPRNG `/ui` 会话 Cookie 与前端 `sessionStorage` 隔离**：
  - `mwh_ui_session` Cookie 由 256-bit CSPRNG 密钥 `cookieSecret`（非源码常量）进行 HMAC-SHA256 签发，附带 `Max-Age=86400; HttpOnly; SameSite=Strict; Path=/ui`，仅持有 `runtimeToken` 者无法离线伪造 `/ui` Cookie；
  - `/ui` 调试前端将 Token 仅缓存在标签页生命周期的 `sessionStorage['mwh_bearer_token']`，并在初始化时自动清除历史 `localStorage['mwh_bearer_token']` 残留。
- **禁止远程连接器或伪造请求源调用本地浮岛审批端点**：
  - `resolveRequestActor` 优先强制判定 `Mcp-Session-Id`、非回环 socket、隧道转发头、`Sec-Fetch-Site: cross-site/same-site` 及异源 `Origin`，严禁上述来源通过请求体自报 `body.source = 'ui_island'` 提权；
  - `POST /api/v1/tasks/:id/approve` 与 `/approve/:id` 统一实施 `LOOPBACK_SELF_APPROVAL_FORBIDDEN` 门禁：当服务绑定非回环地址或开启 `MWH_BLOCK_LOOPBACK_CRITICAL_APPROVAL=1` 时，严禁从回环接口批准 `requiresMobileHmac`（`critical`）任务。
- **配对说明与回执零密钥泄漏**：
  - `SKILL.md` 与前端「一键复制配对口令」仅输出端点形态与非敏感工具说明（引导 Muse 使用 `pc_status` 与 `job_control(action="poll")`），绝不写入真实 Bearer Token 或 HMAC 签名；
  - 浮岛批准完成后写入脱敏回执（`ApprovalStatusReceipt`），并在执行 `fs_mutate(edit/move/delete)` 前二次校验目标路径是否仍存在，防止过期审批误删或误改已改名文件；
  - `audit.jsonl`、服务端状态快照与 `NamedTunnelDriver` 错误尾部均经过 `scrubSecretText` 过滤，防止 `TUNNEL_RUNTIME_TOKEN`、`MWH_HMAC_SECRET`、`MWH_CF_TUNNEL_TOKEN` 落盘或回传。

---

## 4. 残余风险如实披露（No Security Washing）

1. **审批链接残差**：持有完整移动端审批 URL（含 HMAC `sig`）即等价于拥有单次批准能力。系统通过一次性消费、参数哈希绑定（`paramsHash`）、15 分钟有效期、回环自审批拒绝与全量审计抬高滥用成本，但彻底防护仍依赖带外（out-of-band）通道保管签名链接。
2. **仅回环绑定时回环拦截不生效**：当服务仅绑定 `127.0.0.1` 时，HTTP `/approve/:id?sig=...` 链接仅本机可达，网络层无法区分人类浏览器与本机进程，故回环拦截仅在非回环绑定或显式开启 `MWH_BLOCK_LOOPBACK_CRITICAL_APPROVAL=1` 时启用。
3. **外部 CLI 代理无 OS 级围栏**：通过 `subagent_dispatch` 派发的外部 CLI 运行在 MWH 进程之外，其权限即当前 Windows 用户赋予该 CLI 的本机权限。MWH 仅做派发前权限封顶校验（`ChildMode <= ParentMode`、`cwd` 围栏）与审计。
4. **`grep` ReDoS 残差**：`fs_explore(grep)` 使用 Node 内置正则引擎，无抢占式超时；当前通过限制 pattern 长度 `<=256` 与单文件 `<=2MB` 缓解。
5. **`lstat`–使用间隙 TOCTOU 窗口**：路径围栏在 `lstat` 判定 reparse point 后、实际读写前存在极窄竞态窗口。
6. **`Atomics.wait` 事件循环阻塞**：进程终止验证使用同步等待，单次强杀验证路径最长约 4 秒阻塞事件循环（有界，非无限）。
7. **PID 复用误判窗口**：进程树终止验证基于 PID 存活探测，极端高负载下存在操作系统复用 PID 的窄窗口。
8. **第三方 MCP 与本机 Skill 无额外 OS 内核沙箱**：
   - **无额外操作系统内核沙箱**：通过「资源库」启用的第三方本机 MCP（stdio / Streamable HTTP）子进程在当前 Windows 用户权限下运行，没有额外沙箱（无 Hyper-V / AppContainer 等 OS 级隔离）。其权限等同于该用户可执行的全部行为，这与「外部 CLI 代理无 OS 级围栏」同类。
   - **stdio 进程树管控**：stdio 类型的 MCP 子进程进入 Windows 原生 Win32 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），并在 `windowsHide: true` 下运行。在 MWH 正常退出、用户停用资源、或者触发浮窗停止 / 全局急停时，会一并强杀整个子进程树，不留孤儿进程。
   - **Streamable HTTP 出站守卫**：HTTP MCP 连接遵循现有 `outboundGuard` 规则，禁止探测私有局域网/保留网段等未授权地址以防范 SSRF，默认仅允许回环与用户明确指定的主机。
   - **统一内核流转与权限映射**：所有由 Muse 或上游模型发起的第三方 MCP 工具与 `skill_read` 调用必须经由唯一的 `PipelineKernel`：
     - 在计划模式（`plan`）下，未在编辑表单显式勾选「只读」的第三方工具一律默认拦截；若勾选「只读」则按 `read` 放行并记入审计。
     - 在变更前确认（`confirm`）下，调用挂起至桌面浮岛供人工审批。
     - 在自主模式（`autonomous`）与完全访问（`full-access`）下，常规调用放行但高危破坏性指令仍强制审批。
     - 调用全程结构化记录于 `.mwh/logs/audit.jsonl`，密钥与凭据自动脱敏。
   - **只读扫描（仅对外）**：本机 MCP 与 Skill 扫描过程不修改任何外部产品配置文件，条目默认全部关闭，不把外部产品的密钥抄入展示或审计日志；但扫描会向 MWH 自己的注册表与密钥库写盘（见下），“只读”仅指对外。
   - **资源库控制面不走浮岛审批**：资源库的增/开/改/删/探针（`POST /api/v1/resources*`）只认 Bearer Token，不经过桌面浮岛或移动端 HMAC 审批。持 Token 者可直接注册任意命令的 MCP 服务器并启用，启用的服务器在 daemon 启动时自动拉起；`probe` 会直接执行请求体里的命令，且成功时不写审计。Token 保管即全部权限，见 §1.3.4。
   - **扫描会复制密钥（加密形态）**：扫描外部产品配置时，其环境变量与 HTTP 头会被以 DPAPI 密文抄进 MWH 自己的 `.mwh/resource-secrets.json`（不进展示与审计日志）；“默认全部关闭”仅指扫描发现的条目，手工放入的 `.mwh/mcp.json` / `.mwh/skills.json` 按文件内 `disabled` 字段决定是否启用。

# Muse-Win-Harness (MWH) 架构决策记录 (ADR)

本文档记录 MWH 项目在架构演进过程中的核心技术选型决策。ADR-001 至 ADR-005 为内核基线，ADR-006 起为桌面壳与前端托管增量。

---

## ADR-001: 采用 Windows 原生 Node 22 + TypeScript + `koffi` FFI 替代 WSL2/Docker/node-gyp

### 背景
传统本地 Agent 运行时往往依赖 WSL2、Hyper-V 虚拟机或 Docker 容器来实现隔离，但这在广大 Windows 开发者和最终用户机器上面临严重问题：
1. **安装门槛极高**：WSL2 和 Hyper-V 需要管理员权限、硬件虚拟化 BIOS 支持以及复杂的网络端口映射配置。
2. **性能与内存开销巨大**：启动一个精简微虚拟机至少消耗 1GB~2GB 内存，启动延迟数秒以上。
3. **原生工具链断层**：在 Linux 虚拟机内无法直接控制宿主机的 Windows 桌面、原生工具链及特定本地 CLI。
4. **C++ 原生编译地狱**：传统的 `node-gyp` 和 Node-API 往往需要用户预装 Visual Studio C++ 生成工具，环境极其脆弱。

### 决策
选择 **Node.js 22 LTS + 原生 ESM + TypeScript** 作为运行时，利用现代高性能 C-FFI 库 **`koffi`** 直接加载 Windows 原生动态链接库（`kernel32.dll`、`advapi32.dll`、`user32.dll`）。

### 效果
- **开箱即用**：无需任何 C++ 编译器或虚拟化软件，下载依赖即刻启动。
- **超轻量内存脚印**：空载常驻内存仅数十 MB，响应耗时微秒级。
- **直接控制宿主机**：无缝调用原生 Win32 Job Object、NTFS 重解析点解析与控制台句柄。

---

## ADR-002: 单流水线内核与双状态机架构（Confinement × Approval）

### 背景
Agent 调度系统的安全隐患往往源于“多入口、散装校验”，当系统支持 REST、MCP、Subagent 等多端调用时，如果各工具各自定义校验逻辑，极易导致安全漏网。

### 决策
实现唯一的 **`PipelineKernel`**，统合所有工具调用的生命周期：
$$\text{Invocation} \longrightarrow \text{preExecute} \longrightarrow \text{execute} \longrightarrow \text{postExecute}$$

状态空间正交解耦为两个核心状态机：
1. **`ConfinementMode`（隔离模式）**：
   - `read-only` (Rank 1)
   - `workspace-write` (Rank 2)
   - `workspace-acl-experimental` (Rank 3)
   - `danger-full-access` (Rank 4)
2. **`ApprovalPolicy`（审批策略）**：
   - `always-ask`
   - `smart-risk`
   - `auto-workspace`
   - `unattended-yolo`

### 效果
- 保证任意渠道发起的请求必须穿透统一的边界检查与风险审计。
- 风险评级自动映射，阻断未经用户授权的危险操作。

---

## ADR-003: 基于 Win32 Job Object 与 `windowsHide: true` 的进程树受控机制

### 背景
Node.js 原生的 `child_process.kill()` 仅向目标父进程发送信号。在 Windows 环境下，当父进程（如 `powershell.exe`）派生了子进程（如 `ping.exe`、`node.exe`、编译命令），父进程被杀后子进程会脱钩成为**孤儿进程**（Zombie Processes），长期霸占 CPU、内存并锁死文件句柄。

### 决策
1. 利用 `koffi` 绑定 Windows `kernel32.dll` 的 Job Object 原语：
   - `CreateJobObjectW`
   - `SetInformationJobObject` 配置 `JobObjectExtendedLimitInformation`（LimitFlags = `0x00002000` 即 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）
   - `AssignProcessToJobObject` 绑定 PID
   - `TerminateJobObject` 彻底终结作业
2. 所有子进程创建必须配置 `windowsHide: true` 与 `stdio: ['pipe', 'pipe', 'pipe']`，彻底压制黑色弹窗并捕获完整输出。

### 效果
- 当超时发生或用户发出 `abort` 指令时，Windows 内核自动强行清除整个作业对象内所有子进程及后代进程，**0 进程残留**。

---

## ADR-004: 8000ms 快慢双轨异步作业引擎与 Git Worktree 平行隔离

### 背景
LLM 会话普遍存在超时限制（通常 30~60 秒）。若执行长时间任务（如 `npm install`、项目编译、测试套件），同步挂起会导致上游超时重试；同时，如果在主工作区直接修改代码，会与上游正在进行的文件操作发生严重写冲突。

### 决策
1. **Fast/Slow 双轨模型**：
   - 前台等待阈值设为 `8000ms`。
   - `<= 8000ms` 任务内联同步返回。
   - `> 8000ms` 任务平滑转为后台作业（`status: 'RUNNING_ASYNC'`），持续向 `.mwh/logs/<jobId>.log` 落盘，提供基于 8KB 分页的 `job_control(action="poll")` 接口。
2. **Git Worktree 隔离**：
   - 当派生子 Agent 时，若声明 `isolateWorktree: true`，在 `.mwh/worktrees/sub-<id>` 中挂载独立工作区。

### 效果
- 保证前端会话响应绝不超时；
- 允许多个子 Agent 并行修改同一代码仓，互不干扰、零代码污染。

---

## ADR-005: 正向 MCP/REST 互操作性与移动端单次 HMAC 审批流

### 背景
部分社区工具尝试通过逆向私有 API、盗取浏览器 Cookie 等手段来对接 `muse.ai`，不仅破坏上游服务条款，且存在巨大的凭据泄露风险。

### 决策
1. **严格正向接入**：MWH 仅暴露标准开放协议——Streamable HTTP MCP (`/mcp`) 与 REST API (`/api/v1/*`)；
2. **坚决不触碰隐私**：不读取、不嗅探任何浏览器 Cookie、Session Token 或私有数据；
3. **移动端 HMAC 离线审批**：
   - 敏感高危操作（如递归删除、全局模式跨目录写、系统提权）触发 `CONFIRMATION_REQUIRED`。
   - 生成带有时效性和 HMAC-SHA256 签名的独占 URL（`https://<tunnel>/approve/<id>?sig=<hash>`）。
   - 用户使用手机扫码或点击链接即可完成离线确认；**严禁 AI 在无签名情况下自审批**。

### 效果
- 完全符合开源合规与上游服务协议；
- 形成坚实的人在回路（Human-in-the-Loop）安全防线。

---

## ADR-006: 独立 `frontend/` 构建与 `/ui` 鉴权静态托管

> **状态说明**：本条中关于「`!frontend/dist/` 允许构建产物入库」的决定已被 **ADR-012** 取代（`frontend/dist/` 现已从 Git 退库并列入 `.gitignore`，未构建时由 `src/network/uiStatic.ts` 提供自闭环回退页）；其余 `/ui` Bearer 换发 `HttpOnly` Cookie 的静态托管安全边界保持有效。

### 背景
根工程是 Node.js ESM 守护进程，运行时只有 `koffi` 与 `yaml`。桌面控制台是 React 19 + Vite + Tailwind 4，不能塞进根 `package.json`，否则冷启动 `node dist/cli.js` 会被前端工具链拖住。浏览器打开 `/ui` 时又不能把 Bearer Token 放进 URL。

### 决策
1. 前端独立放在 `frontend/`，`vite build` 的 `base` 为 `/ui/`，产物输出到 `frontend/dist/`。根 `.gitignore` 忽略 `/dist/`，并用 `!frontend/dist/` 允许该目录入库，保证守护进程开箱托管静态文件。
2. `GET /ui` 与 `/ui/*` 只接受 `Authorization: Bearer`。首次带有效 Bearer 访问时，服务端使用 256-bit CSPRNG `cookieSecret`（随 `.mwh/secrets.json` DPAPI 加密持久化并在 Token 轮换时同步重置）下发 `Max-Age=86400; HttpOnly; SameSite=Strict; Path=/ui` 的会话 Cookie，供后续脚本和样式请求使用。`/api/v1/*` 不认这枚 Cookie，也不认 `?token=`。
3. 浏览器尚未持有 Token 时，页面展示认证输入条。用户提交后写入 `sessionStorage` 键 `mwh_bearer_token`（并清除历史 `localStorage['mwh_bearer_token']`），立刻用 Bearer 请求 `/ui` 换 Cookie，并重新拉取 `/api/v1/state`、重建 SSE。

### 效果
- 守护进程冷启动不需要现场编译前端。
- 静态资源与控制面接口的鉴权边界分开，Token 不进入访问日志的查询串。

---

## ADR-007: Fetch ReadableStream SSE 替代 URL Query EventSource

### 背景
浏览器原生 `EventSource` 不能设置 `Authorization` 请求头。若退回 `GET /api/v1/events?token=`，Token 会落在代理日志、历史记录和 Referer 中，直接破坏零信任红线。

### 决策
`MwhDaemonService` 使用 `fetch('/api/v1/events', { headers: { Authorization, Accept: 'text/event-stream' }, signal })`，用 `response.body.getReader()` 按 `\n\n` 切帧，只解析 `data:` JSON，忽略 `: heartbeat`。断线后固定 1.5 秒重连，并用 `AbortController` 在 Token 轮换时拆掉旧流。

Token 读取顺序固定为：`window.mwhWindow.getRuntimeToken()`（preload 桥），然后 `localStorage['mwh_bearer_token']`。轮换成功后的新 Token 钉在内存里，避免旧的桌面环境变量盖住新值。

服务端状态合并时保留本地 UI 字段 `settingsModalOpen`、`activeSettingsTab`（原与 `muse.ai` 原生设置重复的 `themeMode`、`accentColor` 已在 H3 中移除），并把 `isDesktopRuntime` 固定为 `Boolean(window.mwhWindow?.isDesktop)`。

### 效果
- SSE 与 REST 使用同一套 Bearer 头，没有查询串旁路。
- 设置弹窗状态不会被全量状态推送冲掉。

---

## ADR-008: UI 浮岛审批通道 `ui_island` 与既有 ApprovalEngine 零信任闭环对接

### 背景
底部任务浮岛的「允许一次 / 本工作区始终允许 / 拒绝 / 强杀」必须进入既有 `ApprovalEngine`，而不能在前端本地把任务标记成已批准。Critical 操作仍要满足单次消费、`paramsHash` 绑定，以及 AI 工具通道不能自批。

### 决策
前端不复制审批状态机，只把浮岛动作映射到已鉴权的 REST：
- `approveLiveTaskOnce` → `POST /api/v1/tasks/:id/approve` `{ scope: 'once' }`
- `approveLiveTaskWorkspaceAlways` → 同路径 `{ scope: 'workspace', root: liveTask.targetPath }`
- `rejectLiveTask` → `POST /api/v1/tasks/:id/reject`
- `killRunningLiveTask` → `POST /api/v1/tasks/:id/kill`

服务端将这些调用标成 `ui_island`，与 AI 使用的 `job_control` 分开。`job_control` 仍然不能批准 `requiresMobileHmac` / Critical。浮岛只在 `WAITING_APPROVAL` 时发出批准请求。任务生命周期以 SSE 推送的 `liveTask` 为准。

### 效果
- 人在回路的点击与模型自批在通道上物理隔离。
- 前端浮岛不持有第二套放行逻辑，回放和审计仍落在 `.mwh/logs/audit.jsonl`。

---

## ADR-009: Electron 无边框壳与 `persist:muse` 零侵入边界

> **状态：SUPERSEDED by ADR-012**（保留历史架构演进上下文；当前实现已演进为单主窗 `chrome.html` + `BrowserView` + `muse-settings-preload.cjs` 注入架构，见 ADR-012）

### 背景
桌面体验要求无边框窗口、右上角胶囊控制最小化 / 最大化 / 隐藏到托盘，底层展示真实的 `https://muse.ai`。同时 ADR-005 禁止读取或改写 muse.ai 的登录态。

### 决策
1. `shell/` 是独立 Electron 35 工程。`BrowserWindow` 使用 `frame: false`、`titleBarStyle: 'hidden'`、`webviewTag: true`、`contextIsolation: true`、`nodeIntegration: false`。
2. `preload.cjs` 只暴露 `window.mwhWindow`：`isDesktop`、`minimize`、`maximize`、`hideToTray`、`getRuntimeToken`。不暴露 `session`、`cookies` 或 Node API。
3. `<webview id="muse-webview" partition="persist:muse">` 的登录态由 Chromium 分区自己持久化。壳代码不调用 `cookies.get`、不注入脚本、不导出 localStorage。
4. 若 `127.0.0.1:19820` 尚未监听，壳用 `ELECTRON_RUN_AS_NODE=1` 拉起 `dist/cli.js`，退出时只结束自己拉起的子进程。`session.defaultSession.webRequest.onBeforeSendHeaders` 只给 `127.0.0.1:19820` 与 `localhost:19820` 补 `Authorization`，过滤器不覆盖 `muse.ai`。
5. `--smoke-test` 在页面 `did-finish-load` 后打印 `[MWH-SHELL] READY pid=<pid> rssMb=<mb>`，2 秒后退出，供 G9 读取工作集。

### 效果
- 无边框壳与 muse.ai 登录分区彼此隔离。
- 本地守护进程请求能带上 Bearer，且不会误伤其他站点的 Cookie。

---

## ADR-010: 双窗口桌面壳——主窗直载真 muse.ai + 透明浮层子窗

> **状态：SUPERSEDED by ADR-012**（保留历史架构演进上下文；独立透明浮层子窗方案已退役，由单主窗 `chrome.html` + `BrowserView` + `muse-settings-preload.cjs` 取代，见 ADR-012）

### 背景
桌面壳要求底层展示真实的 `https://muse.ai`，胶囊浮岛悬浮其上且非胶囊区域鼠标穿透。有三个实证事实封死了单窗口方案：

1. **Electron 35 的 `<webview>` 客体表面无视 z-index**：guest surface 永远压在宿主页面之上，宿主 DOM 内容到不了屏幕（已用 CDP 实证）。因此「主窗加载 /ui + webview 嵌 muse.ai + overlay 悬浮」在 E35 下不可能成立。
2. **`setIgnoreMouseEvents` 只存在于 `BrowserWindow`**：`webContents` 上没有该 API（`electron.d.ts` 已确认），`options.forward` 也只在窗口级生效。用 `WebContentsView`/`addChildView` 做浮层时无法对浮层单独开穿透，只有独立子窗口才能精确控制。
3. **muse.ai 返回 `X-Frame-Options: SAMEORIGIN`**：iframe 方案被服务端头直接封死。

### 决策
改为双窗口结构：

1. **主窗口**（`frame:false`）直接 `loadURL('https://muse.ai')`，`webPreferences` 只有 `contextIsolation + nodeIntegration:false + sandbox:true`，**不挂 preload、不开 webviewTag**。对 muse.ai 唯一的动作是：UA 剥离（剥掉 ` Electron/…` 与 ` mwh-desktop-shell/…` token，保留真实 Chromium 版本号）、`setWindowOpenHandler` 弹窗白名单（muse/meta/facebook/instagram/stripe 域内 allow，其余 http(s) deny + `shell.openExternal`，非 http(s) deny）、`setPermissionRequestHandler` 权限白名单（media/mediaKeySystem/fullscreen/notifications/pointerLock/clipboard-sanitized-write）。不注入脚本、不读写其 Cookie/localStorage。
2. **透明浮层子窗**（`transparent + frameless + skipTaskbar + hasShadow:false`，`parent` 指向主窗）加载 `http://127.0.0.1:19820/ui?surface=overlay`，挂 `preload.cjs`。初始 `setIgnoreMouseEvents(true, {forward:true})`；页面在 `mousemove` 里用 `elementFromPoint` + `.pointer-events-auto` 判定光标是否在胶囊/浮岛上，经 IPC `mwh:set-ignore-mouse` 动态开关穿透。
3. **窗口同步**：主窗 `move/resize/show/hide/focus` → 浮层 `setBounds(getContentBounds())` 并跟随显隐；主窗 `close` 先 `destroy()` 浮层。拖拽不走 `-webkit-app-region` 单一方案，另备 `mwh:drag-start/drag-end` IPC：主进程 16ms 轮询 `screen.getCursorScreenPoint()` 差值 `setPosition` 主窗，浮层随父子同步跟随。
4. 前端按 `surface=overlay` 查询参数切表面：overlay 模式只渲染拖拽带 + `<MwhOverlayRoot />` + 认证条，并把 html/body 背景置透明；浏览器模式只渲染居中占位说明卡 + `<MwhOverlayRoot />`。`MuseWebSurfaceSimulator` 假底板与 `MuseVisualReferenceBackdrop` 死文件彻底删除。

### 效果
- 主窗显示真 muse.ai，UA 无 Electron 字样，OAuth 弹窗按白名单正常弹出。
- 浮层胶囊真正悬浮在 muse 页面上，穿透由窗口级 API 精确控制，不存在层级压制问题。
- muse.ai 零注入边界不变：应用代码对 muse 页面 DOM、Cookie、localStorage、私有 API 的读写量为零。

---

## ADR-011: H1 双窗无边框 DWM 顶边消除与 Win32 物理客户区逐像素同步 + H5 双进程退出审计

> **状态：PARTIALLY SUPERSEDED by ADR-012**（其中 Win32 `hardenFramelessHwnd` / DWM 边框消除与 `.mwh/logs/exit-reason.log` 双进程退出审计完整保留；跨双窗 `overlayWin` 同步被 ADR-012 单主窗内部 `BrowserView.setBounds` 取代）

### 背景
1. **H1 顶部幽灵条第二层根因**：批次 3 为 `overlayWin` 设置 `title: ''` + `thickFrame: false` 后，真机 150% DPI (`dpi=120`) 下顶部仍残留一条 1px 灰蓝色顶带 (`#68768a`，`rgb(104,118,138)`)。经 Win32 `GetWindowRect` / `GetClientRect` / `ClientToScreen` / `DwmGetWindowAttribute` / `GetWindowLongW` / `GetPixel` 逐像素测量取证，定位出三层叠加根因：
   - **根因 A (`mainWindow` 残留 `WS_CAPTION` + Windows 11 DWM 顶边绘制)**：`mainWindow` (`frame: false`，默认 `thickFrame: true`) 的 `GWL_STYLE` 为 `0x14c70000`，仍包含 `WS_CAPTION (0x00C00000)`，导致 Windows 11 DWM 在窗口物理首行 (`y = top`) 强制绘制 1px `#68768a` 亮色顶边。
   - **根因 B (`thickFrame: true` 与 `thickFrame: false` 的 DIP→物理像素换算漂移)**：在 150% DPI 下，`mainWindow` (`thickFrame: true`) 物理窗口尺寸为 `2161×1381` (`left=199, top=157, right=2360, bottom=1538`)，而 `overlayWin.setBounds(mainWindow.getBounds())` (`thickFrame: false`) 经 Chromium DIP 换算后物理窗口尺寸变为 `2163×1383` (`left=198, top=156, right=2361, bottom=1539`)，产生 `dLeft=-1, dTop=-1, dRight=+1, dBottom=+1, dWidth=+2, dHeight=+2` 的跨窗物理像素漂移。
   - **根因 C (`frontend/index.html` 非空 `<title>`)**：浮层 HTML `<title>` 非空时，若 DWM 触发非客户区合成会直接渲染该标题文本。
2. **H5 壳静默退出归因**：Windows 事件日志无崩溃记录 (`Id=1000` 零命中)，且原 `mainWindow.on('close')` 在非退出态直接销毁窗口而未写审计记录，需对 `shell` 与 `daemon` 的全部退出路径落盘审计。

### 决策
1. **Win32 样式剥离 + DWM 边框关闭 (`hardenFramelessHwnd`)**：在 `shell/main.cjs` 中通过 `koffi` 调用 `GetWindowLongW` / `SetWindowLongW` 剥离两窗的 `WS_CAPTION | WS_SYSMENU`（浮层额外剥离 `WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX`）并触发 `SWP_FRAMECHANGED`，同时调用 `DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR=34, [DWMWA_COLOR_NONE=0xFFFFFFFE], 4)` 关闭 Windows 11 DWM 顶边高亮，实测首行像素由 `#68768a` 恢复为 `#121315`。
2. **Win32 物理客户区 1:1 同步 (`syncOverlay`)**：摒弃存在跨 `thickFrame` DIP 换算误差的 `overlayWin.setBounds(mainWindow.getBounds())`，改由 `GetClientRect(mainHwnd)` + `ClientToScreen(mainHwnd)` 获取主窗客户区真实屏幕物理坐标，并通过 `SetWindowPos(overlayHwnd, ...)` 直接按物理像素对齐，使 `dLeft / dTop / dRight / dBottom / dWidth / dHeight` 全部收敛为 `0px`。
3. **双进程退出审计 (`.mwh/logs/exit-reason.log`)**：在 `shell/main.cjs` 与 `src/cli.ts` 中落地结构化 JSON Lines 退出原因日志，覆盖托盘 Quit (`reason="tray_quit"`)、信号退出、`uncaughtException`、`unhandledRejection`、`window-all-closed` 与渲染进程异常退出。

---

## ADR-012: 单主窗 `chrome.html` + `BrowserView` (`muse-settings-preload.cjs`) 注入式伴随浮岛与 `frontend/dist` 退库

### 背景
1. **双窗口透明浮层（ADR-010/011）的工程摩擦**：独立透明浮层子窗（`overlayWin`）虽然解决了 `<webview>` 层级压制问题，但在窗口最小化/恢复、多显示器 DPI 缩放、焦点争抢以及与 `muse.ai` 原生侧边栏融合时，跨窗口鼠标穿透轮询与双窗口合成仍带来感知割裂。
2. **开源仓库体积与构建产物污染**：ADR-006 早期通过 `!frontend/dist/` 将打包后的 JS/CSS 产物强制提交进 Git 仓库，导致每次前端源码微调都会产生大段压缩代码 diff，不符合开源工程规范。

### 决策
1. **单主窗 + 内嵌 `BrowserView` 架构（取代 ADR-009/010）**：
   - 主窗口 `BrowserWindow`（`frame: false`）加载本地 `shell/chrome.html`（配 `shell/chrome-preload.cjs`），在顶部渲染 38px 自绘标题栏（含应用名、分支/版本徽章 `#version-badge` 与最小化/最大化/隐藏托盘/关闭按钮）。
   - 主窗口下部客户区（`y = 38 .. height`）挂载 `BrowserView`（`museView`），直接加载 `https://muse.ai`，并通过 `museView.setBounds` 随主窗客户区同步缩放。
2. **受控 Preload UI 注入与主题同步（`shell/muse-settings-preload.cjs`）**：
   - `museView` 挂载 `shell/muse-settings-preload.cjs`（启用 `contextIsolation: true`，不暴露 Node 原语、不读取或外传 `muse.ai` 登录 Cookie/Token）。
   - 在 `muse.ai` DOM 中以独立命名空间（`#mwh-drawer-backdrop`、`#mwh-drawer`、`#mwh-subpanel`、`#mwh-approval-island`、`.mwh-activity-slot`）挂载左侧活动栏图标、20px 圆角抽屉、24px 圆角五栏高级配置面板（连接 / 权限 / 工作区 / 代理 / 审计）与底部实时审批灵动岛。
   - 通过 `MutationObserver` 与透明感知色彩采样（`parseOpaqueRgb`）实时检测 `muse.ai` 明暗主题，并经 `mwh:theme-sync` IPC 同步更新主窗 `chrome.html` 顶栏背景色及 Windows 11 DWM 标题栏/边框属性（`applyDwmTheme`）。
3. **`frontend/dist` 产物退库与 `uiStatic.ts` 自闭环回退（更新 ADR-006）**：
   - `.gitignore` 将 `!frontend/dist/` 改为 `frontend/dist/`，从 Git 索引中移除构建产物。
   - 当用户尚未运行 `npm run build:ui` 而直接在浏览器访问 `http://127.0.0.1:19820/ui` 时，`src/network/uiStatic.ts` 返回内置的引导 HTML（保留 `#root` 挂载点契约并提示执行 `npm run build:ui` 或使用桌面壳）。

### 效果
- 彻底消除双窗口焦点切换与透明窗口合成黑屏隐患，伴随抽屉、五栏配置中心与底部审批浮岛同 `muse.ai` 界面浑然一体。
- `npm run gate5`（G10）通过 CDP 同时校验 `chrome.html` 顶栏目标与 `muse.ai` `BrowserView` 注入目标（纯净 UA + `#mwh-drawer` + `#mwh-approval-island` + 真实渲染截图 `>5000 bytes`），形成端到端回归闭环。


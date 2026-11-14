# MWH 桌面界面：构建、打开与排障

本文说明 `shell/` Electron 桌面伴随壳与 `frontend/` 浏览器调试面的架构、构建方法及验证路径。守护进程与桌面壳均严格遵守正向接入边界——不劫持 `muse.ai` 的私有 API、不导出或篡改其登录 Cookie。

## 架构概览

当前桌面壳采用 **单主窗（`shell/chrome.html` 自绘顶栏）+ 内嵌 `BrowserView`（加载 `https://muse.ai` 并经受控 `muse-settings-preload.cjs` 注入伴随抽屉与底部审批浮岛）** 架构（详见 `docs/ADR.md` 之 **ADR-012**）：

```text
shell/main.cjs
  ├─ 主窗口 BrowserWindow (frame: false, DWM 边框/标题栏色同步)
  │    └─ 加载 shell/chrome.html + shell/chrome-preload.cjs
  │         └─ 顶部 32px 自绘标题栏 (#version-badge 显示 v0.1.0、最小化/最大化/隐藏到托盘/关闭)
  │
  ├─ 客户区 BrowserView (museView, 位于顶栏下方 y=32..height)
  │    ├─ 加载 https://muse.ai (剥离 Electron/mwh-desktop-shell UA 标记，保留纯净 Chromium UA)
  │    ├─ setWindowOpenHandler: OAuth 弹窗白名单 (muse/meta/facebook/instagram/stripe)
  │    └─ 挂载 shell/muse-settings-preload.cjs (contextIsolation: true, sandbox: false)
  │         ├─ 左侧活动栏 MWH 入口图标 (.mwh-activity-slot)
  │         ├─ 侧边设置抽屉 (#mwh-drawer, 20px 圆角) + 全屏遮罩 (.mwh-drawer-backdrop)
  │         ├─ 四栏高级配置中心 (#mwh-subpanel: 连接与权限 / 工作区与代理 / 资源库 / 审计日志)
  │         ├─ 底部实时审批灵动岛 (#mwh-approval-island)
  │         ├─ MutationObserver 探测 muse.ai 明暗主题 -> ipcMain 'mwh:theme-sync' 同步顶栏与 DWM
  │         └─ 合规 DOM 语言嗅探 -> ipcMain 'mwh:language-sync' 同步托盘/顶栏/前端四语 (zh-CN/zh-TW/ja/en)
  │
  └─ 本地守护进程连接 (127.0.0.1:19820, dist/cli.js)
       ├─ 主进程 SSE 桥接 (/api/v1/events) -> 实时广播 'mwh:daemon-state' 至 BrowserView
       ├─ 主进程 REST 代理 (daemonFetch -> /api/v1/*, 自动携带 Bearer Token)
       └─ GET /ui , /ui/* -> 托管 frontend/dist 浏览器调试预览面（若未构建则返回内置引导页）
```

- **为什么采用 `BrowserWindow (chrome.html) + BrowserView + preload 注入`**：早期独立透明浮层子窗（ADR-010/011）在多显示器 DPI 切换与窗口焦点切换时存在跨窗口合成开销；现行架构将 32px 窗口控制顶栏放在宿主 `chrome.html`，将 `https://muse.ai` 承载于下部 `BrowserView`，并通过开启 `contextIsolation: true` 的 `muse-settings-preload.cjs` 在页面内挂载独立的 `#mwh-*` 伴随浮层 DOM（仅通过 IPC 与主进程通信，绝不读取或外传 `muse.ai` 的登录凭据）。
- **`frontend/` 的定位**：`frontend/`（编译至 `frontend/dist`，已从 Git 退库）提供浏览器直连 `http://127.0.0.1:19820/ui` 时的独立 React 调试预览面与组件契约验证。

## 构建

确保 Node.js（`>= 22.0.0`）已在系统 `PATH` 中（若本机使用多版本 Node，可通过环境变量 `MWH_NODE_EXE` 指定 `node.exe` 绝对路径）：

前端调试面构建：

```powershell
npm --prefix frontend install
npm --prefix frontend run lint
npm --prefix frontend run build
```

`npm --prefix frontend run lint` 执行 `tsc --noEmit`；`npm --prefix frontend run build`（或根目录 `npm run build:ui`）生成 `frontend/dist/index.html`（该目录已在 `.gitignore` 中忽略，不纳入 Git 提交）。

后端与桌面壳安装构建：

```powershell
npm install
npm --prefix shell install
npm run build
```

## 打开验证

### 路径 A：Electron 桌面伴随壳（推荐主路径）

在仓库根目录直接双击 `MWH启动.cmd`，或在终端执行：

```powershell
npm --prefix shell start
```

桌面壳启动行为：

- **自动拉起守护进程**：若 `127.0.0.1:19820` 尚未监听，桌面壳会优先定位系统 Node（`MWH_NODE_EXE`、`PATH` 或 `%ProgramFiles%\nodejs\node.exe`，回退为 `ELECTRON_RUN_AS_NODE=1`）自动后台启动 `dist/cli.js`；退出壳时自动优雅停止其拉起的守护进程，并将退出原因写入 `.mwh/logs/exit-reason.log`。
- **顶栏与版本标识**：主窗口顶部 32px 渲染 `shell/chrome.html`，显示 `Muse-Win-Harness` 与版本徽章 `v0.1.0`（非 `main` 分支时显示 `v0.1.0 · <branch>`）。
- **纯净 UA 与 OAuth 白名单**：启动时自动剥离默认 User-Agent 中的 `Electron/...` 与 `mwh-desktop-shell/...` 标识；`muse.ai`、`meta.com`、`facebook.com`、`instagram.com`、`stripe.com` 域内 OAuth 登录弹窗正常放行，其余外部 `http(s)` 链接转交系统默认浏览器打开。
- **自适应明暗主题同步**：`muse-settings-preload.cjs` 内置透明感知色彩探针（`parseOpaqueRgb` + `MutationObserver`），实时跟随 `muse.ai` 页面深浅色切换，并通过 `mwh:theme-sync` 同步更新主窗顶栏与 Windows 11 DWM 标题栏颜色。
- **宿主语言实时联动（四语 i18n）**：`muse-settings-preload.cjs` 仅通过无害公开 DOM 特征（`html.lang`、`data-lang`/`data-locale`、`<meta>` 及显式设置控件当前激活标签，严禁读取 Cookies/凭据/聊天内容或拦截网络）嗅探 `muse.ai` 语言并经 `mwh:language-sync` 广播至主进程托盘、`chrome.html` 顶栏与 React 前端；支持简体中文（`zh-CN`）、繁体中文（`zh-TW`）、日语（`ja`），其余语言统一回退至英语（`en`），独立预览环境下自动回退 `navigator.language`。

内存与启动烟测（G9）：

```powershell
cd shell
npx electron . --smoke-test
```

烟测在主窗口加载就绪后打印：

```text
[MWH-SHELL] READY pid=<pid> rssMb=<mb>
```

并在约 2 秒后自动退出。

### 路径 B：浏览器 `/ui` 调试预览面

1. 在仓库根目录执行 `npm run build && npm run build:ui`，并启动守护进程 `npm start`（监听 `127.0.0.1:19820`）。
2. 浏览器访问 `http://127.0.0.1:19820/ui`（若未执行 `npm run build:ui`，服务端仍会返回包含构建指引的自闭环 안내 HTML，不会报错崩溃）。
3. 首次访问在顶部输入条填入 `TUNNEL_RUNTIME_TOKEN` 点击「认证」，前端将 Token 存入当前标签页会话 `sessionStorage['mwh_bearer_token']`（自动清理历史 `localStorage['mwh_bearer_token']`），通过 `Authorization: Bearer` 换取由 256-bit CSPRNG 密钥签发的 `mwh_ui_session`（`Max-Age=86400; HttpOnly; SameSite=Strict; Path=/ui`）静态资源会话 Cookie，并建立 `/api/v1/events` 流。

### 任务浮岛交互（桌面壳与浏览器端一致）

注入进 `BrowserView` 的浮岛（`shell/muse-settings-preload.cjs`）与 React 调试浮岛（`frontend/src/overlay/LiveTaskFloatingIsland.tsx`）遵循统一交互契约：

- **三态切换**：收起胶囊（108×42，「待授权」）→ 展开详情面板（默认 624×384，范围 432×240 ~ 864×624）→ 空闲隐藏（`IDLE` 时不遮挡页面）。
- **拖拽与边缘吸附**：单击标题栏切换展开/收起；按住 90ms 进入拖拽，松手吸附并写入 `localStorage['mwh_island_layout_v2']`，同时经 `mwh:island-layout-save` 镜像落盘至 `userData/island-layout.json`。
- **待审批自动展开一次**：收到新的 `WAITING_APPROVAL` 任务时自动展开一次，展示风险等级、目标路径/命令与「允许一次 / 本工作区始终允许 / 拒绝」按钮。

### 抽屉与四栏高级配置中心

- 点击 Muse 左侧活动栏中的 **MWH** 图标展开设置抽屉（`#mwh-drawer`，宽 `min(clamp(280px, 25vw, 420px), 剩余视口)`，圆角 `20px`），内含快捷配对复制与四档权限模式切换；抽屉底部只保留宿主守护状态与 Muse 连通状态两行摘要。**抽屉不再承载资源库入口**——资源库只存在于「高级配置中心 → 资源库」Tab，抽屉仅保留「打开高级配置中心」总入口。
- 点击抽屉底部「高级配置中心」展开右侧子面板（`#mwh-subpanel`，圆角 `24px`），顶部为等宽四栏 Tab（**`connectors`「连接与权限」 / `daemon`「工作区与代理」 / `resources`「资源库」 / `snapshots-audit`「审计日志」**）：
  - **连接与权限**：包含「连接器」（公网隧道与端点连接参数）与「权限」（四档权限模式切换）两个纵向小节。
  - **工作区与代理**：包含「工作区」（授权根目录与白名单管理）与「代理」（动态 ACP 代理列表、探测及页内添加）两个纵向小节。
  - **资源库**：本机 MCP 与 Skill 统一管理面。
    - 页眉标明：「打开即对 Muse 生效，默认全部关闭。」以及「MCP 在你的 Windows 用户权限下运行，没有额外沙箱。」
    - 打开开关后，启用的 MCP 写入本机标准 `.mwh/mcp.json`（Claude / Cursor 的 `mcpServers` 形状，不含密钥），启用的 Skill 写入 `.mwh/skills.json`；完整目录（含未启用项）在 `.mwh/resources.json`。MWH 把已启用工具挂到现有 `/mcp`，不是第二条连接，也不是云端连接器。
    - 呈现「本机 MCP」与「Skill」两张卡片，支持「扫描本机」与页内「添加」表单（支持 stdio / Streamable HTTP 协议与 Skill 目录选择，「立即启用」默认关闭）。
    - 条目启用状态一律用右侧 **iOS 式开关**（`role="switch"` + `aria-checked`，轨道 46×28、圆点纯白、开启态任务栏同款紫蓝渐变 `#8B5CF6 → #6366F1 → #3B82F6`、关闭态中性灰、无描边）表达，不再使用文字按钮或勾选框；添加表单的「立即启用」、编辑表单的「标记为只读」与「工作区与代理 → 代理」的「立即启用此代理」同款。多选类勾选框（审计日志快照批量选择）保持勾选框形态。
    - 支持条目原位展开查看 `tools/list` 对外名称预览（`{serverId}_{原名}`）与 Skill 描述/相对路径（`~` 形式展示，绝不泄漏绝对私有目录）；支持琥珀色故障态展示（开关如实反映启用状态，故障由琥珀徽章说明原因，禁止把故障条目显示成绿色「已就绪」）；编辑表单支持标记「只读」并显示低调徽章；勾选「只读」即声明该服务器的全部工具都只读，误标会在计划模式下放行写操作。
    - 开关的状态切换一律**原地绘制**：只改当前节点的 `is-on` 与 `aria-checked`，180ms 过渡在同一个节点上播放；表单里的布尔项完全不触发重绘。需要服务端确认的开关（资源启停 / ACP 启停 / 2 小时自动降级）先按目标态上色，请求返回后补足动画时间再刷新，失败则反向播放回滚，动画期间忽略重复点击。
  - **端点与凭据防窥加固**：公网隧道端点（MCP / REST URL）与 `Bearer Token` 默认均做防窥脱敏展示（回环地址 `127.0.0.1` 除外），支持点击眼睛按钮临时揭示完整明文，并在 **15 秒后或关闭抽屉时自动恢复脱敏**；点击复制按钮始终直接写入完整真实值。
  - **聚光灯分步引导（Spotlight Tour）**：抽屉顶栏右侧常驻 `?` 按钮（`data-action="open-tour"`），点击进入 6 步全屏聚光灯遮罩引导（左栏入口与健康圆点 → 四档权限模式 → 端点与凭据防窥配对 → 四栏高级配置中心 → 底部实时审批灵动岛 → 原生桌面操控与防抢占护栏），并由 `scripts/test_ui_contract.mjs` Gate 15 强制校验双端步骤与锚点同步。
  - 全部视觉与动效参数（色阶、圆角、字号、开关与设置行规格、抗缩放溢出规范、时长与缓动令牌、分组件动效表、状态矩阵、禁止清单）以 [`DESIGN.md`](./DESIGN.md) 为唯一真源（动效见 3.4 与 4.8）。
  - **主进程 IPC 桥 `mwh:daemon-http`**：资源库的请求经主进程转发到 daemon（`shell/main.cjs` 的 `mwh:daemon-http` 通道），绕过浏览器页面的混合内容 / 私有网络限制；此前面板直连 `127.0.0.1:19820` 会被 Chromium 拦下，只显示 `Failed to fetch`。
  - **审计日志**：审计与 Git Shadow 快照折叠树，按规范化后的工作区路径（`normalizeWinPath`）树状折叠展示快照，支持单条一键回滚、多选删除与历史裁剪。

### 设置界面内容准入规则（UI Content Admission Rules）

设置面板（`shell/muse-settings-preload.cjs` 与 `frontend/src/overlay/MwhSettingsModal.tsx`）受 `npm run test:ui-contract`（`scripts/test_ui_contract.mjs`）静态门禁强制守护：

1. **受众边界（Human Audience Only）**：设置界面的一切卡片与文案必须面向**人类用户**，严禁混入写给 AI Agent 的提示词说教卡片。
2. **可操作性原则（Operable Controls Required）**：设置页卡片必须承载用户可交互的配置、开关、探测或审阅控件。
3. **单一真源（Single Source of Truth）**：面向 Agent 的工具协议真源位于 `src/network/tunnels.ts`（运行时生成的 `SKILL.md`）与 `connectors/muse-skill-template/SKILL.example.md`。
4. **术语一致性（Zero Retired Concepts）**：严禁残留已退役概念（如 `agentask`、已废弃的静态 CLI 枚举 `dsh`/`codex`/`opencode`/`grok`、或本机私有绝对路径）。

## Token 与 HMAC 从哪里来

| 名称 | 作用 | 来源 |
| :--- | :--- | :--- |
| `TUNNEL_RUNTIME_TOKEN` | `/mcp`、`/ui`、`/api/v1/*`、SSE 的 Bearer 令牌 | 环境变量或 `.mwh/secrets.json`（Win32 DPAPI `mwh-secrets/v2-dpapi` 加密持久化，默认 TTL 30 天）。回环地址冷启动未设置时由守护进程自动生成高熵随机值。 |
| `MWH_HMAC_SECRET` | 移动端审批链接 HMAC-SHA256 签名密钥 | 环境变量或 `.mwh/secrets.json`（Win32 DPAPI 加密）。非回环绑定缺少该值时按 Fail-Closed 策略拒绝启动。 |
| `mwh_bearer_token` | 浏览器 `/ui` 调试面缓存的运行时 Token | 仅当前标签页 `sessionStorage`（初始化自动清理旧版 `localStorage`）。轮换 Token（`POST /api/v1/tunnel/rotate-token`）后同步更新并重连 SSE。 |
| `mwh_ui_session` | `/ui/*` 静态资源会话 Cookie | 服务端用 Bearer + 256-bit CSPRNG `cookieSecret` 换发，`Max-Age=86400; HttpOnly; SameSite=Strict; Path=/ui`。控制面 `/api/v1/*` 与 `/mcp` 绝不接受 Cookie 鉴权。 |

## MUSE 连接器配对

Muse 云端自定义连接器要求 **HTTPS（443 端口）、禁止 URL 携带 `?query` 参数、使用 `API Key` 或 `OAuth 2.0` + `远程 Streamable HTTP`**：

1. **确认公网 HTTPS 隧道就绪**：在「高级配置中心 → 连接」确认 `Cloudflare Quick Tunnel` 已分配 `https://<subdomain>.trycloudflare.com`（或配置自有 Named Tunnel）。
2. **在 Muse 填写连接器参数**：
   - **认证类型**：`API Key`
   - **传输协议**：`远程 Streamable HTTP`
   - **服务器 URL**：`https://<公网域名>/mcp`（严禁附带 `?token=`）
   - **API Key 值**：粘贴 `Bearer Token`（网关同时兼容 `Authorization: Bearer <TOKEN>` 与 `X-API-Key: <TOKEN>`）。
3. **鉴权排障**：若返回 `401`/`403`，查看 `.mwh/logs/auth-probe.log` 中的脱敏诊断记录（仅记录请求头名与前 8 位掩码 `valuePrefix8`）。

## 功能巡检（分节独立执行指南）

日常点检桌面壳与控制面功能可按以下四节独立执行：

### 第一节：顶栏版本徽章与侧栏抽屉交互巡检
- 查看桌面壳顶部 32px 标题栏，确认 `#version-badge` 显示 `v0.1.0`（或 `v0.1.0 · <分支名>`），最小化、最大化、隐藏到托盘按钮响应正常。
- 点击 Muse 左侧活动栏中的 **MWH** 图标，确认设置抽屉（`#mwh-drawer`）平滑滑出，点击全屏遮罩（`.mwh-drawer-backdrop`）可正常收起。

### 第二节：统一四档权限模式即时切换巡检
- 在设置抽屉或「高级配置中心 → 权限」Tab 中依次切换四档权限模式：**计划模式 (`plan`)** / **变更前确认 (`confirm`)** / **自主模式 (`autonomous`)** / **完全访问 (`full-access`)**。
- 确认切换后 `GET /api/v1/state` 与抽屉状态即时同步更新，且 `.mwh/logs/audit.jsonl` 记录模式变更事件。

### 第三节：四栏高级配置中心与真实环境探针巡检
- 打开「高级配置中心」，依次切换 **连接与权限 / 工作区与代理 / 资源库 / 审计日志** 四个等宽 Tab。
- 在「工作区与代理」Tab 中核对工作区白名单路径及 ACP 代理探测（`acp-probe`）状态；在「资源库」Tab 中核对本机 MCP 与 Skill 列表、条目探测与原位展开工具清单，确认与本机实际环境一致。

### 第四节：只读探查、审批浮岛与快照回滚巡检
- 触发一条文件读取或写操作，观察底部实时审批浮岛（`#mwh-approval-island`）是否自动展开并在批准后更新为完成状态，同时在「审计日志」Tab 核对生成的 Git Shadow 快照与 `.mwh/logs/audit.jsonl` 记录。

> **本地自动化门禁职责说明**：越界路径拦截、敏感凭据阻断、未授权请求拒绝、进程树强杀与 CDP 双页面目标渲染校验等对抗性或回归类用例，统一由本地门禁（`npm run test:ui-contract`、`npm run test:kernel-safety`、`npm run gate:acp`、`npm run gate5` 及 `scripts/negative_test_p1..p3.mjs`）自动执行。

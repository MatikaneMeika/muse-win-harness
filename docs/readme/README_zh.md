<p align="center">
  <img src="../../assets/brand/mwh-cover.svg" alt="Muse-Win-Harness：面向 Windows 10/11 的本地 Agent 受控执行底座与桌面伴随壳" width="100%">
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="./README_zh.md"><b>简体中文</b></a> |
  <a href="./README_zh-TW.md">繁體中文</a> |
  <a href="./README_ja.md">日本語</a> |
  <a href="../README.md">文档地图</a>
</p>

<p align="center">
  <a href="../../CHANGELOG.md"><img src="https://img.shields.io/badge/版本-0.1.0_Early_Preview-2B7FFF.svg" alt="Version 0.1.0"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/许可证-Apache_2.0-1B6FEF.svg" alt="Apache-2.0 License"></a>
  <img src="https://img.shields.io/badge/平台-Windows_10_%2F_11_x64-0078D6.svg" alt="Windows 10/11 x64">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933.svg" alt="Node.js >= 22">
  <a href="../SECURITY_DISCLOSURE.md"><img src="https://img.shields.io/badge/安全模型-路径围栏_%2B_进程树强杀_%2B_审批流-10B981.svg" alt="Security Disclosure"></a>
</p>

**Muse-Win-Harness (MWH) 让云端 [Muse](https://muse.ai) 在你的 Windows 电脑上真正动手干活，同时把每一道安全闸门留在你手里。** 无需 WSL2、无需 Hyper-V 虚拟机、无需 Docker：它通过标准 **Streamable HTTP MCP (`/mcp`)** 与 **REST (`/api/v1`)** 双协议网关暴露 **7 个默认核心工具**（及 1 个默认隐藏的条件注册工具 `desktop_hands`），用 `realpath` 物理路径围栏阻断 NTFS Junction 越界，用 Win32 Job Object 绑定每一棵子进程树，在每次写文件前自动创建 Git Shadow 快照，并在无边框桌面壳底部弹出实时审批灵动岛。

> [!IMPORTANT]
> **早期预览版 (`v0.1.0`) 与安全边界声明（No Security Washing）**
>
> **无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流**。MWH 运行在当前 Windows 登录用户会话下，不包含任何针对 `muse.ai` 的非官方反代、Cookie 窃取或私有接口破解。使用前请务必阅读《[安全边界如实披露表](../SECURITY_DISCLOSURE.md)》与文末「[已知限制](#6-已知限制known-limitations)」。

## 目录

- [1. 为什么选择 MWH](#1-为什么选择-mwh)
- [2. 桌面壳与浮岛界面示意（纯矢量 Mockup）](#2-桌面壳与浮岛界面示意纯矢量-mockup)
- [3. 暴露的 Muse 工具矩阵 (7 默认 + 1 条件注册)](#3-暴露的-muse-工具矩阵-7-默认--1-条件注册)
- [4. 快速开始与 Muse 配对](#4-快速开始与-muse-配对)
- [5. 四档权限实测矩阵与三层全局急停](#5-四档权限实测矩阵与三层全局急停)
- [6. 已知限制（Known Limitations）](#6-已知限制known-limitations)
- [7. 文档地图与参与贡献](#7-文档地图与参与贡献)

## 1. 为什么选择 MWH

<table>
  <tr>
    <td width="50%" valign="top">
      <b>关键处先问，四档权限一键切换。</b><br>
      收敛底层隔离模式与审批策略为四档直观模式：<code>plan</code>（只读计划）、<code>confirm</code>（改文件前问，默认）、<code>autonomous</code>（工作区内常规读写自动快照放行）、<code>full-access</code>（允许跨目录普通读写，带 2 小时自动降级保护）。无论处于哪一档，递归删除（<code>rm -rf</code> / <code>Remove-Item -Recurse</code>）、强制推送（<code>git push --force</code>）、磁盘格式化与敏感凭据路径（<code>.env*</code>、<code>~/.ssh</code>、<code>~/.aws</code>）始终强制要求人工审批。
    </td>
    <td width="50%" valign="top">
      <b>浮岛点击即回执，不用回聊天框打「批了」。</b><br>
      当操作返回 <code>CONFIRMATION_REQUIRED</code>（含 <code>approvalId</code>）并在底部浮岛点击「允许」后，守护进程立即执行并写入脱敏回执（<code>CONSUMED</code>）。Muse 直接调用 <code>job_control(action="poll", approvalId="appr_...")</code> 即可秒级拉取结果；若目标文件在获批前已被重命名或删除，过期目标守卫会自动拦截中止。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>真进程树强杀 + 三层全局急停。</b><br>
      所有 PowerShell 与外部代理子进程全程携带 <code>windowsHide: true</code>（零黑框闪烁）并纳入 Win32 Job Object（<code>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</code>）。浮窗「强杀」精确终结单作业及派生孙进程；「全局急停」一次性清空<b>全部活跃 Job 进程树 + 在途内置 ReAct 循环 + 挂起态待审批队列</b>。
    </td>
    <td width="50%" valign="top">
      <b>写前自动快照，单点一键回滚。</b><br>
      文件修改或批准任务执行前自动在 <code>.mwh/checkpoints/</code> 生成确定性快照（完整支持未跟踪文件、<code>.env</code> 保护副本与中文 CJK 文件名）。「审计」面板按工作区路径折叠收纳，支持单条一键回滚并在还原前执行完整性校验（损坏即报 <code>CHECKPOINT_RESTORE_FAILED</code> 中止）。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>动态接入本地 ACP 代理。</b><br>
      通过 <code>%USERPROFILE%\.mwh\acp-profiles.json</code> 或设置面板热添加任意支持 Agent Client Protocol（JSON-RPC 2.0 over stdio）的本地编码代理，支持增量事件流（<code>events</code>/<code>wait</code>）、运行中实时引导（<code>steer</code>）、梯度中断（<code>interrupt</code>）与死会话续跑（<code>resume</code>），严格受限于 <code>ChildMode &lt;= ParentMode</code> 权限天花板与 Git Worktree 隔离。
    </td>
    <td width="50%" valign="top">
      <b>启动预检防假死，无密钥配对零冲突。</b><br>
      双击 <code>MWH启动.cmd</code> 先执行 <code>--ensure-daemon-only</code> 验证 <code>127.0.0.1:19820</code> 端口与鉴权，失败即停不开空窗；配对口令与 <code>SKILL.example.md</code> 零密钥、零说教，直接通过 <code>pc_status</code> 完成握手核验。
    </td>
  </tr>
</table>

## 2. 桌面壳与浮岛界面示意（纯矢量 Mockup）

<p align="center">
  <img src="../../assets/brand/mwh-ui-mockup.svg" alt="MWH 无边框桌面壳、20px 侧边设置抽屉、24px 五栏高级配置中心与底部实时审批灵动岛矢量示意图" width="96%">
</p>

<p align="center">
  <sub><i>注：上图为仓内纯手绘 SVG 矢量示意图（零真实截图、零真实域名或工作区路径），如实对应 32px 顶栏、左侧 320px/20px 抽屉、右侧等宽五栏高级配置面板（连接 / 权限 / 工作区 / 代理 / 审计）及底部实时审批浮岛。</i></sub>
</p>

## 3. 暴露的 Muse 工具矩阵 (7 默认 + 1 条件注册)

| 工具名 | 类别 | 默认暴露 | 支持动作 (`action`) 与功能简述 |
| :--- | :--- | :---: | :--- |
| `pc_status` | `read` | 是 | 探测主机系统信息、当前权限档位 (`profile`)、隧道状态、最近审批回执 (`lastApprovalReceipt`) 与已配置的 ACP/CLI 代理。 |
| `fs_explore` | `read` | 是 | 围栏内高性能文件读取 (`read`)、目录列举 (`list`)、Glob 模式匹配 (`glob`) 与正则内容搜索 (`grep`)。 |
| `fs_mutate` | `write` | 是 | 创建写前 Git Shadow 快照后执行文件写入 (`write`)、精确片段替换 (`edit`)、移动重命名 (`move`) 或删除 (`delete`)。 |
| `exec_command` | `sensitive_write` | 是 | 在无黑框 (`CREATE_NO_WINDOW`) 与 Win32 Job Object 管控下执行 PowerShell 命令，支持 `fastTrackMs`（默认 8000ms）快慢双轨自动转后台作业。 |
| `job_control` | `write` | 是 | 控制后台作业与审批单：8KB UTF-8 边界对齐分页拉取 (`poll`)、增量事件流 (`events`)、运行中引导 (`steer`)、标准输入写入 (`stdin`)、强杀进程树 (`abort`)、审批决策 (`approve` / `reject`) 与状态查询 (`status`)。 |
| `subagent_dispatch` | `sensitive_write` | 是 | 在 `ChildMode <= ParentMode` 权限天花板与可选 Git Worktree 隔离下派发与控制本地 ACP/CLI 代理或内置循环 (`run` / `resume` / `events` / `wait` / `steer` / `interrupt` / `list` / `profiles`)。 |
| `git_checkpoint` | `write` | 是 | 对工作区已跟踪与未跟踪文件创建确定性快照 (`create`)、查询状态 (`status` / `diff`) 或执行单点一键回滚 (`rollback`)。 |
| `desktop_hands` | `sensitive_write` | 条件注册 `[Experimental]` | 桌面截屏 (`screenshot`)、鼠标移动/点击 (`mouse_move` / `mouse_click`) 与键盘输入 (`keyboard_type`)。**默认关闭且对模型完全不可见**；仅当 `config.yaml` 中 `desktopHands.enabled: true` 时才注册暴露。 |

## 4. 快速开始与 Muse 配对

### 环境要求与安装构建

- **操作系统**：Windows 10 / Windows 11 (x64)
- **运行环境**：Node.js `>= 22.0.0`（根目录提供 [`.nvmrc`](../../.nvmrc)）与 Git

```powershell
# 1. 启用仓库内置 Git Hooks（防止误提交运行时生成的 SKILL.md）
git config core.hooksPath .githooks

# 2. 安装后端、前端与桌面壳依赖
npm ci
npm --prefix frontend ci
npm --prefix shell ci

# 3. 构建前端资源与 TypeScript 后端
npm run build:ui
npm run build
```

### 启动与配对三步法（完整排障见 [`docs/PAIRING.md`](../PAIRING.md)）

1. **启动桌面壳**：直接双击根目录 [`MWH启动.cmd`](../../MWH启动.cmd)（自动完成宿主预检并拉起无边框窗口）；在左侧活动栏点击 **MWH** 图标打开抽屉 → **连接器与隧道**，启动 `Cloudflare Quick Tunnel`，复制 `MCP 端点` 与 `Bearer Token`。
2. **配置 Muse 连接器**：在 Muse 中新建自定义连接器填入上述 URL 与 Token（切勿把真实 Token 贴到聊天框），随后点击抽屉上的 **复制配对口令** 粘贴到**新开的**会话中。
3. **验证握手**：让 Muse 调用 `pc_status` —— 只有成功返回当前权限档位、工作区路径与隧道状态才算真正接通。临时隧道重启换域名后只需更新连接器 URL（Token 不变）；若遇 `401`/`403`，请按 [`docs/PAIRING.md`](../PAIRING.md) 执行「删旧连接器 → 新开旁聊 → 重建」恢复流程。

### 运行验证门禁

```powershell
npm run build
npm --prefix frontend run lint
npm --prefix frontend run build
npm run test:ui-contract
npm run test:kernel-safety   # 依次运行 gate1 + gate2 + gate3 + gate4 + gate:acp
npm run gate5                # 生产控制面与桌面壳 CDP 全链路 E2E 门禁
node scripts/negative_test_p1.mjs
node scripts/negative_test_p2.mjs
node scripts/negative_test_p3.mjs
```

## 5. 四档权限实测矩阵与三层全局急停

完整矩阵与证据链见 [`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md)：

| 统一权限档位 (`profile`) | 底层映射 | 工作区内读 / 白名单命令 | 工作区内写文件 / 普通命令 | 跨工作区路径读写 | 敏感路径 (`.env*`, `~/.ssh`) 与高危破坏命令 (`rm -rf`, `push -f`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`plan`（计划模式）** | `read-only` × `smart-risk` | `SUCCESS` | `DENIED` (`READ_ONLY_MODE_*_DENIED`) | `DENIED` | `DENIED` |
| **`confirm`（变更前确认，默认）** | `workspace-write` × `smart-risk` | `SUCCESS` | `CONFIRMATION_REQUIRED`（浮岛弹窗确认） | `DENIED` (`PATH_CONFINEMENT_VIOLATION`) | 敏感路径 `DENIED`；高危命令 `CONFIRMATION_REQUIRED` (`critical` + HMAC `once`) |
| **`autonomous`（自主模式）** | `workspace-write` × `auto-workspace` | `SUCCESS` | `SUCCESS`（自动创建写前快照并执行） | `DENIED` (`PATH_CONFINEMENT_VIOLATION`) | 敏感路径 `DENIED`；高危命令 `CONFIRMATION_REQUIRED` (`critical` + HMAC `once`) |
| **`full-access`（完全访问）** | `danger-full-access` × `unattended-yolo` | `SUCCESS` | `SUCCESS`（支持 2 小时自动降级） | `SUCCESS`（允许跨目录普通读写） | `CONFIRMATION_REQUIRED`（`critical` + HMAC 强制单次人工审批，绝不豁免） |

## 6. 已知限制（Known Limitations）

1. **无操作系统内核级真沙箱**：MWH 运行在宿主机当前用户会话下，不提供 Hyper-V、WSL2 或 Windows AppContainer 内核级强隔离。防御边界由应用层 `realpath` 围栏、NTFS Junction 重解析点拦截、敏感凭据黑名单、Win32 Job Object 进程树管控、写前 Git Shadow 快照与人机审批流共同构成（详见 [`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md)）。
2. **`workspace-acl-experimental` 尚未实装（Fail-Closed）**：底层类型预留的 `workspace-acl-experimental` 在 v0.1.0 中未实装；若显式请求切换至该模式，内核将按 Fail-Closed 策略直接拒绝并返回 `MODE3_SANDBOX_UNAVAILABLE_FAIL_CLOSED`，原模式保持不变。
3. **外部 BYOK CLI 代理的围栏边界**：通过 `subagent_dispatch` 派发的第三方本地 CLI 作为独立外部进程运行。MWH 对其强制执行 **权限天花板（`ChildMode <= ParentMode`）**、**Git Worktree 独立工作树隔离**、**环境变量敏感凭据剥离** 与 **Win32 Job Object 进程树强杀**，但无法在外部二进制进程内部钩取其原生系统调用。
4. **`desktop_hands` 默认隐藏且受限于 Windows UIPI `[Experimental]`**：桌面截屏与键鼠注入工具默认关闭且不出现在工具列表中；即使显式开启 `desktopHands.enabled: true`，受 Windows 用户界面特权隔离（UIPI）限制，普通权限运行的 MWH 无法向管理员提权（Elevated）窗口注入键鼠事件。
5. **公网隧道外部依赖限制 `[Experimental]`**：默认的 `Cloudflare Quick Tunnel`（`*.trycloudflare.com`）依赖本机或指定目录存在 `cloudflared.exe`，且每次重启会更换随机子域名；`Named Tunnel`、`Tailscale Funnel` 与 `Custom Reverse Proxy` 依赖用户自备域名/Tailnet/证书环境。
6. **Gate-A2 滑窗超时基准对高磁盘 I/O 抖动敏感**：`npm run gate:acp` 中的 Gate-A2 用例通过百毫秒级滑窗定时器结合工作区文件签名扫描验证「活跃续命 vs 静默超时强杀」；在宿主机磁盘 I/O 极高负载时，同步目录扫描耗时可能带来偶发时序波动。

## 7. 文档地图与参与贡献

- **文档总索引**：[`docs/README.md`](../README.md)
- **架构设计说明书**：[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)
- **Muse 配对与排障指南**：[`docs/PAIRING.md`](../PAIRING.md)
- **安全边界如实披露表**：[`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md)
- **桌面壳与注入式 UI 规范**：[`docs/UI.md`](../UI.md)
- **架构决策记录 (ADR)**：[`docs/ADR.md`](../ADR.md)
- **贡献指南与合规声明**：[`CONTRIBUTING.md`](../../CONTRIBUTING.md) · [`SECURITY.md`](../../SECURITY.md) · [`DISCLAIMER.md`](../../DISCLAIMER.md) · [`CHANGELOG.md`](../../CHANGELOG.md)

本项目基于 [Apache License 2.0](../../LICENSE) 开源，属独立社区工程，与 `muse.ai` 或 Meta Platforms, Inc. 无隶属或背书关系。

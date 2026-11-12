# Muse-Win-Harness (MWH) Documentation Index / 文档地图

> **语言切换：** [English](../README.md) | [简体中文](./readme/README_zh.md) | [繁体中文](./readme/README_zh-TC.md) | [日文](./readme/README_ja.md)

本目录按「**正式规范文档**」与「**多语言 README**」两层组织，所有正式规范文档均直接位于 `docs/` 根目录下，严禁在 `docs/` 根目录堆放带日期的一次性临时文件。

## 1. 正式规范文档（Core Specifications）

| 文档路径 | 定位与职责 | 核心读者 |
| :--- | :--- | :--- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | **系统架构设计说明书**：启动预检链路（`--ensure-daemon-only`）、双协议网关（`/mcp` + `/api/v1`）、单流水线安全内核、ACP 代理调度器与 7+1 工具矩阵。 | 架构师 / 核心贡献者 |
| [`PAIRING.md`](./PAIRING.md) | **Muse 连接器配对与故障恢复指南**：首次配对三步法、Cloudflare 临时隧道换域名后的 URL 更新、401/403 根因排查及「删旧连接器 → 新开旁聊 → 重建」完整恢复闭环。 | 终端用户 / 运维者 |
| [`SECURITY_DISCLOSURE.md`](./SECURITY_DISCLOSURE.md) | **安全边界如实披露表（No Security Washing）**：四档权限 × 6 类动作可复现实测矩阵、浮窗停止与三层全局急停杀伤边界、SSRF 防护网段、远程自批阻断与残余风险清单。 | 安全审计员 / 终端用户 |
| [`UI.md`](./UI.md) | **桌面伴随壳与注入式 UI 规范**：无边框 `BrowserWindow(chrome.html)` + `BrowserView(muse.ai)` 架构、20px 侧边抽屉、24px 四栏高级配置中心、底部实时审批灵动岛与人工巡检手册。 | 前端 / 桌面端开发者 |
| [`DESIGN.md`](./DESIGN.md) | **视觉与组件规范（参数级）**：六条设计公理（少用主题色 / 无描边分层 / 大而宽 / 内部弱化边界 / iOS 手感 / 文案简洁）、明暗双主题令牌表、圆角·间距·字号三套尺度、Switch 开关与设置行的完整参数契约、状态矩阵与反例禁止清单。 | 前端 / 桌面端开发者 |
| [`ADR.md`](./ADR.md) | **架构决策记录（ADR-001 ~ ADR-012）**：关键技术选型（Koffi FFI、Git Shadow 快照、HMAC 移动端审批、ACP 动态注册表、单窗内嵌注入等）的背景、备选与取舍。 | 核心贡献者 / 代码审查员 |
| [`WORKFLOW_BRANCH_TESTING.md`](./WORKFLOW_BRANCH_TESTING.md) | **分支开发与实机隔离测试规范**：Git 分支指针隔离、Git Worktree 并行测试、窗口顶栏分支标识与双击启动自检流程。 | 贡献者 / 测试人员 |

## 2. 多语言主文档（Multi-language READMEs）

| 语言版本 | 路径 | 说明 |
| :--- | :--- | :--- |
| **English (Primary)** | [`../README.md`](../README.md) | 仓库根主文档（English） |
| **简体中文 (Primary ZH)** | [`./readme/README_zh.md`](./readme/README_zh.md) | 简体中文完整版主文档 |
| **繁体中文** | [`./readme/README_zh-TC.md`](./readme/README_zh-TC.md) | 繁体中文精要版文档 |
| **日文** | [`./readme/README_ja.md`](./readme/README_ja.md) | 日文精要版文档 |

## FAQ：本地图片在 VSCode 预览不显示

路径与 SVG 本身无误（显式 `width`/`height`、体积 ≤12KB 的纯矢量）。主因是 VSCode **受限模式（Restricted Mode）**未信任工作区，或仅打开了单个文件而非文件夹工作区。处理：执行 `Workspaces: Trust Workspace` 信任当前仓库后，用 `Ctrl+Shift+V` 重新打开 Markdown 预览。GitHub 上相对路径渲染正常。

<p align="center">
  <img src="../../assets/brand/mwh-cover.svg" alt="Muse-Win-Harness：面向 Windows 10/11 的本地 Agent 受控執行底座與桌面伴隨殼" width="100%">
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="./README_zh.md">简体中文</a> |
  <a href="./README_zh-TW.md"><b>繁體中文</b></a> |
  <a href="./README_ja.md">日本語</a> |
  <a href="../README.md">文檔地圖</a>
</p>

<p align="center">
  <a href="../../CHANGELOG.md"><img src="https://img.shields.io/badge/版本-0.1.0_Early_Preview-2B7FFF.svg" alt="Version 0.1.0"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/授權-Apache_2.0-1B6FEF.svg" alt="Apache-2.0 License"></a>
  <img src="https://img.shields.io/badge/平台-Windows_10_%2F_11_x64-0078D6.svg" alt="Windows 10/11 x64">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933.svg" alt="Node.js >= 22">
</p>

**Muse-Win-Harness (MWH) 是專為 Windows 10/11 原生環境打造的本地受控執行底座與桌面伴隨殼，讓雲端 [Muse](https://muse.ai) 安全、受控地操作你的 Windows 電腦。** 無需 WSL2、Hyper-V 或 Docker，透過標準 **Streamable HTTP MCP (`/mcp`)** 與 **REST (`/api/v1`)** 雙協議閘道器暴露 **7 個預設核心工具**（及 1 個條件註冊工具 `desktop_hands`），結合 `realpath` 路徑圍欄、Win32 Job Object 處理程序樹強控、寫前 Git Shadow 快照與桌面底部即時審批靈動島。

> [!IMPORTANT]
> **安全邊界如實披露（No Security Washing）**
>
> **無 OS 級真沙箱，依賴路徑圍欄+進程樹管控+審批流**。完整四檔權限實測矩陣與殘餘風險請參閱 [`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md)。

## 核心亮點

- **統一四檔權限模式**：`plan`（唯讀計畫）、`confirm`（變更前確認，預設）、`autonomous`（工作區內自動快照放行）、`full-access`（跨目錄讀寫 + 2 小時自動降級；高危破壞性指令與 `.env*`/`~/.ssh` 仍強制要求 HMAC 人工審批）。
- **浮島審批即刻回執**：在桌面底部浮島點擊「允許」後立即寫入 `CONSUMED` 脫敏回執，雲端直接透過 `job_control(action="poll", approvalId="...")` 讀取結果。
- **三層全域急停與一鍵回滾**：`POST /api/v1/daemon/emergency-kill` 一次終結所有活躍 Win32 Job Object 處理程序樹、中斷內建 ReAct 迴圈並作廢所有待審批單；寫前自動建立 Git Shadow 快照，支援單條一鍵回滾。

## 快速開始

```powershell
git config core.hooksPath .githooks
npm ci
npm --prefix frontend ci
npm --prefix shell ci
npm run build:ui
npm run build

# 雙擊 MWH啟動.cmd（先執行 --ensure-daemon-only 預檢，再開啟無邊框桌面殼）
.\MWH启动.cmd
```

## 文檔導航

- **完整英文主文檔**：[`README.md`](../../README.md)
- **完整簡體中文主文檔**：[`docs/readme/README_zh.md`](./README_zh.md)
- **文檔總索引**：[`docs/README.md`](../README.md)
- **配對與排障指南**：[`docs/PAIRING.md`](../PAIRING.md)
- **架構設計與安全披露**：[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) · [`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md)

本專案採用 [Apache License 2.0](../../LICENSE) 授權，屬獨立社群專案，與 `muse.ai` 或 Meta Platforms, Inc. 無關。

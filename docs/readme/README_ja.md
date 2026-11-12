<p align="center">
  <img src="../../assets/brand/mwh-cover.svg" alt="Muse-Win-Harness: Windows 10/11 向けローカル Agent 実行基盤＆デスクトップコンパニオンシェル" width="100%">
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="./README_zh.md">简体中文</a> |
  <a href="./README_zh-TW.md">繁體中文</a> |
  <a href="./README_ja.md"><b>日本語</b></a> |
  <a href="../README.md">ドキュメント一覧</a>
</p>

<p align="center">
  <a href="../../CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.1.0_early_preview-2B7FFF.svg" alt="Version 0.1.0"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-1B6FEF.svg" alt="Apache-2.0 License"></a>
  <img src="https://img.shields.io/badge/platform-Windows_10_%2F_11_x64-0078D6.svg" alt="Windows 10/11 x64">
  <img src="https://img.shields.io/badge/node-%3E%3D22.0.0-339933.svg" alt="Node.js >= 22">
</p>

**Muse-Win-Harness (MWH) は、クラウド上の [Muse](https://muse.ai) エージェントを Windows 10/11 PC に安全かつ制御可能な形で接続するローカル実行エンジン＆デスクトップコンパニオンシェルです。** WSL2・Hyper-V・Docker 不要で動作し、標準の **Streamable HTTP MCP (`/mcp`)** と **REST (`/api/v1`)** デュアルプロトコルゲートウェイを通じて **7 つの基本ツール**（＋条件付き登録ツール `desktop_hands`）を公開します。

> [!IMPORTANT]
> **セキュリティ境界の誠実な開示（No Security Washing）**
>
> **OS カーネルレベルのサンドボックスではなく、アプリケーション層のパスフェンス（`realpath`＋NTFS Junction 遮断）・Win32 Job Object プロセスツリー制御・書き込み前 Git Shadow スナップショット・承認フローに依存します。** 詳細は [`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md) をご確認ください。

## 主な特徴

- **4 段階の権限プロファイル**：`plan`（読み取り専用）、`confirm`（変更前確認・デフォルト）、`autonomous`（ワークスペース内自動スナップショット＆実行）、`full-access`（2 時間自動ダウングレード付き。ただし `rm -rf`・`git push --force`・`.env*` 等の危険操作は常に HMAC 承認が必須）。
- **フローティングアイランド即時承認レシート**：画面下部の承認アイランドで許可すると即座に `CONSUMED` レシートが記録され、モデル側は `job_control(action="poll", approvalId="...")` で完了を取得できます。
- **3 層緊急停止（Emergency Kill）＆ 1 クリックロールバック**：すべての実行中 Job Object プロセスツリー、内蔵 ReAct ループ、保留中の承認キューを一括停止・無効化。ファイル変更前の Git Shadow スナップショットから 1 クリックで復元可能です。

## クイックスタート

```powershell
git config core.hooksPath .githooks
npm ci
npm --prefix frontend ci
npm --prefix shell ci
npm run build:ui
npm run build

# MWH启动.cmd を実行（--ensure-daemon-only プリフライト検証後にシェルを起動）
.\MWH启动.cmd
```

## ドキュメント

- **英語版フルドキュメント (Primary)**: [`README.md`](../../README.md)
- **簡体字中国語フルドキュメント**: [`docs/readme/README_zh.md`](./README_zh.md)
- **ドキュメントインデックス**: [`docs/README.md`](../README.md)
- **ペアリング＆復旧ガイド**: [`docs/PAIRING.md`](../PAIRING.md)
- **アーキテクチャ＆セキュリティ開示**: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) · [`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md)

本プロジェクトは [Apache License 2.0](../../LICENSE) の下で公開されている独立したコミュニティプロジェクトであり、`muse.ai` または Meta Platforms, Inc. とは提携していません。

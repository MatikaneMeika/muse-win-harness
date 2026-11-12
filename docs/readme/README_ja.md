<p align="center">
  <img src="../../assets/brand/mwh-cover.svg" alt="Muse-Win-Harness: クラウド AI に安全な Windows ローカル実行の手を — フォルダ境界・変更前スナップショット・デスクトップ承認" width="100%">
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
  <a href="../../DISCLAIMER.md"><img src="https://img.shields.io/badge/built_with-Vibe_Coding_%2B_Gates-F59E0B.svg" alt="Vibe Coding Disclosure"></a>
</p>

**クラウド上の AI は優秀ですが、ブラウザの中に閉じ込められています。Muse-Win-Harness (MWH) は、ブレーキをあなたの手に残したまま、[Muse](https://muse.ai)（または標準 MCP / REST クライアント）に Windows PC 上で動く「手」を与えます。**

WSL2・Hyper-V・Docker は一切不要。ネイティブ Windows コンパニオンウィンドウと標準 MCP (`/mcp`) / REST (`/api/v1`) ブリッジを通じて、許可したフォルダだけへのアクセス制限、ファイル編集前の自動スナップショット保存、そして画面右下のフローティングアイランドでのワンクリック承認を提供します。

> [!IMPORTANT]
> **誠実なセキュリティ境界と Vibe Coding 開示（No Security Washing）**
>
> 1. **OS カーネルレベルのサンドボックスではありません**：MWH は現在の Windows ユーザー権限で動作し、アプリケーション層のパスフェンス・Win32 Job Object プロセスツリー制御・書き込み前スナップショット・人間による承認フローで安全性を担保します。詳細は [`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md) をご覧ください。
> 2. **Vibe Coding / AI 支援開発による構築**：本プロジェクトは AI コーディングエージェントとの協業（**Vibe Coding**）と自動検証ゲートによって構築されました。AI 生成コードには予期せぬエッジケースが含まれる可能性があるため、重要なデータは事前にバックアップの上、[`DISCLAIMER.md`](../../DISCLAIMER.md) をご確認ください。

<p align="center">
  <img src="../../assets/brand/mwh-ui-mockup.svg" alt="Muse-Win-Harness のデスクトップ画面" width="96%">
</p>

<p align="center">
  <sub>示意图</sub>
</p>

## 主な特徴

- **ワンクリックで切り替えられる 4 段階の権限モード**：左サイドバーの MWH ドロワーから `plan`（読み取り専用）、`confirm`（変更前に確認・デフォルト）、`autonomous`（ワークスペース内で自動スナップショット＆実行）、`full-access`（2 時間自動ダウングレード付き）を即座に切り替え可能。`rm -rf`・`git push --force`・`.env*` / `~/.ssh` などの危険な操作はどのモードでも必ず人間の承認を要求します。
- **画面右下の承認アイランドで即座に完了**：チャット欄に「承認」と入力する必要はありません。フローティングアイランドで「1 回許可」をクリックすれば即座に実行・レシート記録され、Muse 側が `job_control(action="poll")` で結果を受け取ります。
- **変更前の自動スナップショット＆プロセスツリーごと緊急停止**：すべてのファイル変更前にスナップショットを保存し、いつでも 1 クリックでロールバック可能。停止時は親プロセスだけでなく派生した子・孫プロセスまで一括終了します。

## クイックスタート

```powershell
git config core.hooksPath .githooks
npm ci
npm --prefix frontend ci
npm --prefix shell ci
npm run build:ui
npm run build

# MWH启动.cmd をダブルクリック（デーモンの事前ヘルスチェック後にウィンドウを起動）
.\MWH启动.cmd
```

## ドキュメント

- **英語版フルドキュメント (Primary)**: [`README.md`](../../README.md)
- **簡体字中国語フルドキュメント**: [`docs/readme/README_zh.md`](./README_zh.md)
- **ドキュメント一覧**: [`docs/README.md`](../README.md)
- **ペアリング＆復旧ガイド**: [`docs/PAIRING.md`](../PAIRING.md)
- **アーキテクチャ・セキュリティ開示・免責事項**: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) · [`docs/SECURITY_DISCLOSURE.md`](../SECURITY_DISCLOSURE.md) · [`DISCLAIMER.md`](../../DISCLAIMER.md)

本プロジェクトは [Apache License 2.0](../../LICENSE) の下で公開されている Vibe Coding 発の独立したコミュニティプロジェクトであり、`muse.ai` または Meta Platforms, Inc. とは一切提携していません。

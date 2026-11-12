# Contributing to Muse-Win-Harness (MWH)

Thanks for helping improve MWH. This guide covers the local setup, build, and the
verification gates a change must pass before it can be merged.
感谢参与 MWH 的开发。以下为本地环境、构建与验证门禁的最小流程。

## 1. 环境要求 / Requirements

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 x64 |
| Node.js | `>= 22`（仓库根目录 `.nvmrc` 固定为 `22`） |
| Git | 任意近期版本，需在 `PATH` 中可用 |

Windows 10/11 x64, Node.js 22+, and Git are required. Linux/macOS are not supported targets.

## 2. 启用提交钩子 / Enable the pre-commit hook

```bash
git config core.hooksPath .githooks
```

该钩子会拒绝提交运行时生成的 `connectors/muse-skill-template/SKILL.md`
（该文件由守护进程重写，仓库只保留 `SKILL.example.md`）。

## 3. 安装依赖 / Install dependencies

```bash
npm ci
npm --prefix frontend ci
npm --prefix shell ci
```

三个 `package-lock.json`（根目录、`frontend/`、`shell/`）均已归一化到
`https://registry.npmjs.org/`，提交前请勿把个人镜像地址写回 lockfile。

## 4. 构建 / Build

```bash
npm run build:ui && npm run build
```

`build:ui` 先构建前端产物，`build` 再编译 TypeScript 到 `dist/`。门禁脚本运行的是
`dist/` 下的编译产物，所以**先构建再跑门禁**。

## 5. 验证门禁 / Verification gates

```bash
npm run test:kernel-safety   # gate1 + gate2 + gate3 + gate4 + gate:acp
npm run test:ui-contract     # 桌面壳 / 前端 UI 契约静态门禁
npm run gate5                # 桌面 E2E（需要可用的本地环境）
node scripts/negative_test_p1.mjs
node scripts/negative_test_p2.mjs
node scripts/negative_test_p3.mjs
```

- 三个 `negative_test_p*.mjs` 断言的是**必须被拒绝**的行为（越界写入、危险命令、
  审批绕过等）。它们属于回归防线，**不要为了让测试通过而修改这些脚本**，请修复实现。
- 若某个门禁因本机环境（缺失的可选 CLI、端口占用）无法运行，请在 PR 描述中写明
  具体门禁名与原因，而不是静默跳过。

## 6. 提交规范 / Commit & PR

- 小步提交，一个提交只做一件事；提交信息用祈使句描述意图。
- 改动工具 schema、权限档位或 UI 契约时，同步更新：
  - `src/tools/definitions.ts`（工具定义）
  - `connectors/muse-skill-template/SKILL.example.md`（对外模板）
  - `docs/UI.md` / `docs/ARCHITECTURE.md` 中受影响的段落
- 开启 PR 时请使用 `.github/pull_request_template.md`，并附上已运行的门禁结果。

## 7. 安全边界 / Security

MWH 不是 OS 级真沙箱，安全模型依赖路径围栏、Win32 Job Object 进程树管控与审批流。
涉及安全边界、审批流或沙箱语义的改动，请先阅读 [`SECURITY.md`](./SECURITY.md) 与
[`docs/SECURITY_DISCLOSURE.md`](./docs/SECURITY_DISCLOSURE.md)，并单独说明风险评估。

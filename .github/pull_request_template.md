## 变更摘要 / Summary

<!-- 这个 PR 做了什么，为什么需要它。关联 issue：Closes #__ -->

## 变更类型 / Type of change

- [ ] Bug fix（不改变现有契约）
- [ ] New feature（新增工具 / 配置项 / 通道能力）
- [ ] Refactor（无行为变化）
- [ ] Docs / CI / Tooling
- [ ] Breaking change（会影响工具 schema、权限档位语义或 UI 契约）

## 影响面 / Scope

- 涉及模块：<!-- src/network · src/pipeline · src/tools · src/executors · frontend · shell -->
- 涉及通道：<!-- MCP /mcp · REST /api/v1 · 桌面浮层 · 子代理 -->
- 是否改动权限档位或审批流：<!-- 否 / 是（请说明四个档位各自的行为变化） -->
- 是否改动工具 schema：<!-- 否 / 是（已同步 definitions.ts 与 SKILL.example.md） -->
- 是否改动 UI 契约：<!-- 否 / 是（已同步 test_ui_contract.mjs 与 docs/UI.md） -->

## 已运行的验证 / Verification run

> 请粘贴实际命令与结果；未运行的项保留并注明原因。

```bash
npm run build
npm --prefix frontend run lint
npm run build:ui
npm run test:ui-contract
npm run test:kernel-safety   # gate1 + gate2 + gate3 + gate4 + gate:acp
npm run gate5
node scripts/negative_test_p1.mjs
node scripts/negative_test_p2.mjs
node scripts/negative_test_p3.mjs
```

- 结果：<!-- 全部通过 / 列出失败项与原因 -->

## 安全自查 / Security checklist

- [ ] 没有放宽路径围栏、进程树管控或审批流（或已在下方说明并附风险评估）
- [ ] 没有把 `TUNNEL_RUNTIME_TOKEN`、HMAC 签名、本机绝对路径写进代码、日志或测试夹具
- [ ] 未提交运行时生成的 `connectors/muse-skill-template/SKILL.md`（由守护进程重写）
- [ ] 未修改 `scripts/negative_test_p*.mjs` 来让测试变绿
- [ ] lockfile 未写回个人镜像地址（应为 `https://registry.npmjs.org/`）

## 备注 / Notes

<!-- 截图、迁移说明、回滚方式、后续 TODO。 -->

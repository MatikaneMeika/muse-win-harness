---
name: Feature request
about: 为 MWH 提一个新能力或改进建议 / Propose a capability or improvement
title: '[Feature] '
labels: ['enhancement']
assignees: ''
---

## 需求背景 / Problem

<!-- 现在的工作流卡在哪里？请描述真实场景，而不是直接给实现方案。 -->

## 期望能力 / Proposed behavior

<!-- 你希望 MWH 做什么；若涉及新工具或新参数，请给出期望的调用形状。 -->

```jsonc
// 可选：期望的调用示例
{ "tool": "<tool_name>", "params": { } }
```

## 影响面 / Scope

- 涉及通道：<!-- MCP /mcp · REST /api/v1 · 桌面浮层 · 子代理 -->
- 涉及权限档位：<!-- plan / confirm / autonomous / full-access；是否会新增审批点 -->
- 是否新增工具：<!-- 是 / 否；若是，是否应为条件暴露（如 desktopHands.enabled） -->
- 是否影响 UI 契约（`scripts/test_ui_contract.mjs`）：<!-- 是 / 否 -->

## 备选方案 / Alternatives considered

<!-- 现在你是怎么绕过这个限制的？其他工具怎么解决？ -->

## 安全与权限考量 / Security considerations

<!-- 新能力是否会扩大路径围栏边界、绕过审批、或引入新的 destructive 操作面？ -->

## 补充信息 / Additional context

---
name: Bug report
about: 报告 MWH 的可复现缺陷 / Report a reproducible defect
title: '[Bug] '
labels: ['bug']
assignees: ''
---

## 缺陷描述 / What happened

<!-- 一句话说明现象；请描述「实际行为」而非猜测的根因。 -->

## 复现步骤 / Steps to reproduce

1.
2.
3.

**期望行为 / Expected behavior**：

## 环境 / Environment

| 项目 | 值 |
| --- | --- |
| MWH 版本 | <!-- v0.1.0 / commit sha --> |
| Windows 版本 | <!-- Windows 11 23H2 (22631) --> |
| Node.js 版本 | <!-- node -v --> |
| 权限档位 | <!-- plan / confirm / autonomous / full-access --> |
| 触发通道 | <!-- MCP /mcp · REST /api/v1 · 桌面浮层 · 子代理 --> |
| 涉及工具 | <!-- pc_status / fs_explore / fs_mutate / exec_command / job_control / subagent_dispatch / git_checkpoint / desktop_hands --> |

## 证据 / Evidence

<!-- 相关日志、错误码、approvalId、jobId、截图。请务必先脱敏： -->
<!-- 删除 TUNNEL_RUNTIME_TOKEN、HMAC 链接、本机用户名与绝对路径中的个人信息。 -->

```text
（在此粘贴脱敏后的日志）
```

## 是否与安全边界相关 / Security relevance

- [ ] 这是审批流 / 路径围栏 / 进程树管控相关的绕过或越权问题
  <!-- 若是，请不要在本 issue 中公开利用细节，改用 SECURITY.md 中的私下披露流程。 -->
- [ ] 普通功能缺陷

## 补充信息 / Additional context

<!-- 是否稳定复现？最近一次正常工作的版本？是否使用了云隧道？ -->

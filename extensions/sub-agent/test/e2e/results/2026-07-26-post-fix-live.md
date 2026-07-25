# sub-agent live E2E 复测结果 — 2026-07-26

背景：针对 2026-07-25 报告（`2026-07-25-live.md`）的发现，extension 做了优化
（`src/manager.ts`、`src/contracts.ts` 重写，`test/` 新增 14 例）。本文件是修复后的独立复测证据，
不覆盖 `2026-07-25-live.md`；与 `2026-07-25-post-fix-live.md`（targeted 验收，16 项）互补——
本次是另一会话/另一模型（k3）下的全宽度回归。
执行环境：macOS、Pi 0.82.0、TUI 交互会话、模型 k3（kimi-coding），thinking max。

## 发现修复验证

| 编号 | 问题 | 验证 | 结论 |
| --- | --- | --- | --- |
| F-2（中） | list 模型可见输出只有计数，分页不可达 | list 现在返回完整 JSON：items 含 agentId/state/label/lastRunId/activeToolCount/capabilityToolCount/readyDeliveryCount/degradedExtensionCount/unavailableToolCount；`nextCursor` 暴露在 content 中。实测 limit=2 翻页：第 1 页 pg-1/pg-2 + cursor，第 2 页 pg-3，无重复、覆盖完整。deliveries 视图同样输出完整 item（deliveryId/runId/outcome/state/sequence/completedAt）。direct lookup 按请求顺序返回（L4 可验证且通过） | **已解决** |
| F-1（低） | 槽满时 send 报 CONCURRENCY_LIMIT 掩盖 BUSY | 8 个 sleeper 占满槽位后向 RUNNING agent send → `SUBAGENT_BUSY`（源码确认检查顺序已改为：解析 agent → LOST/TERMINATING/BUSY → 槽位） | **已解决** |
| F-3（提示） | 未知字段/超长 task live 不可达 | 未改动，属正常分层防御；单元测试覆盖 | 维持原判 |
| F-4（提示） | CANCEL_ALREADY_REQUESTED 窗口小 | 同块双 cancel 仍确定性命中；行为不变 | 维持原判 |

## 额外改进（超出报告范围）

- 所有错误结果新增机器可读头：`SUBAGENT_ERROR code=... operation=... sideEffects=... retry=...`，
  模型不再需要从文本反推错误码，print 模式输出同样带该头。
- wait 的 TIMEOUT 结果在 content 中附带 JSON details（pending runId 与状态）。
- 单元测试从 85 → 99 例。

## 回归矩阵

| 项 | 结果 |
| --- | --- |
| L0 `npm run check` | PASS |
| L1 `npm test`（99 例） | PASS |
| C1 同块 9 spawn → 8 成功 + 1 `SUBAGENT_CONCURRENCY_LIMIT` | PASS |
| C2' 槽满时 send RUNNING agent → `SUBAGENT_BUSY` | PASS（F-1 修复点） |
| C4 同块双 wait 重叠 → TIMEOUT + `SUBAGENT_WAIT_CONFLICT` | PASS |
| C7 同块双 cancel → `CANCEL_REQUESTED` + `SUBAGENT_CANCEL_ALREADY_REQUESTED` | PASS |
| 批量 cancel 8 run → wait-all 8×`CANCELLED`（带取消原因） | PASS |
| kill ×11（IDLE，正确 lastRunId） | PASS |
| V 抽查（blank task / 非法 mode / 重复 states / 不存在 agent / 假 cursor）→ 对应错误码 | PASS |
| P1 子 agent 工具清单无 `subagent_*` | PASS |
| IO 2 agent 并发 append：40 行、各 20、0 撕裂 | PASS |
| L1 翻页 / L3 deliveries 过滤 / L4 direct lookup 顺序 | PASS（F-2 修复后可完整执行） |
| Phase H print 模式快速失败无副作用 | PASS |
| 清理：list agents/deliveries 均空；临时目录删除 | PASS |

## 结论

2026-07-25 报告中的两个实质问题（F-1、F-2）均已解决且无回归；模型可见性改进
（list JSON、错误头、TIMEOUT details）使 RUNBOOK 全部用例——包括此前 BLOCKED 的
L1/L4——现在都能通过模型路径端到端执行。

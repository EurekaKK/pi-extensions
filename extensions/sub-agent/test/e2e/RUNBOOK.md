# sub-agent 端到端测试 Runbook

本目录的测试是**真实环境集成测试**：通过真实 Pi 交互式会话中的六个 `subagent_*` 工具调用驱动，
会产生真实模型调用与少量 API 成本。按仓库约定，它们**不属于**默认 `npm test`，必须显式触发。

## 流水线分层

| 层 | 内容 | 触发方式 | 成本 |
| --- | --- | --- | --- |
| L0 静态 | Biome + tsc | `npm run check` | 无 |
| L1 单元 | Vitest + faux sidecar | `npm test` | 无 |
| L2 非交互模式 | print 模式快速失败语义 | `test/e2e/headless-mode.sh` | 极低（一次模型调用） |
| L3 真实工具 | 本 runbook 的 live 矩阵 | 在交互式 Pi 会话中逐节执行 | 中（多次子 agent 运行） |

L3 必须由加载了 sub-agent extension 的交互式 Pi 会话执行（TUI 模式；管理操作在其他模式返回
`SUBAGENT_UNSUPPORTED_MODE`）。执行者按本文件顺序调用工具，并新建
`results/<日期>-post-fix-live.md`；`results/2026-07-25-live.md` 是历史证据，不得覆盖或改写。

## 约定

- 每轮先在 OS 临时目录创建唯一目录和 ownership marker，并把解析后的绝对路径写入任务文本：

  ```bash
  E2E_TMP_BASE="${TMPDIR:-/tmp}"
  E2E_TMP_BASE="${E2E_TMP_BASE%/}"
  E2E_ROOT="$(mktemp -d "$E2E_TMP_BASE/subagent-e2e.XXXXXXXX")"
  E2E_RUN_ID="$(node -p 'crypto.randomUUID()')"
  printf '%s\n' "$E2E_RUN_ID" >"$E2E_ROOT/.subagent-e2e-owner"
  E2E_ROOT_REAL="$(cd "$E2E_ROOT" && pwd -P)"
  E2E_TMP_REAL="$(cd "$E2E_TMP_BASE" && pwd -P)"
  ```

  本轮所有 fixture 都位于 `$E2E_ROOT_REAL`。不得复用固定 `$HOME/.subagent-e2e`，也不得删除没有本轮
  ownership marker 的目录。
- 子 agent 任务保持微小（固定回显、`sleep`、小文件读写），避免无关成本。
- 每个 case/attempt 都记录：case ID、前置 Agent/run ID、期望、原样的模型可见 `content`、结构化
  `details.code`/`outcome` 和结论。结论只能是 PASS、FAIL、N/A、BLOCKED 或 NOT RUN；分别统计，不得把
  N/A/BLOCKED/NOT RUN 计入 PASS。
- `details` 必须从实际持久化的 tool result 或 UI 的结构化结果读取，不得根据 `content` 文案反推或补写。
- 重试必须新增独立 attempt，并保留原 attempt 的失败证据；不得用新 fixture 的重试结果覆盖或冒充首次 PASS。
- 凡是预期失败的用例，成功反而记 FAIL。
- Pi 父模型只能看见 `content`；`details` 是 UI、测试和程序化消费者的完整权威数据。list 的模型可见
  `content` 必须是紧凑 JSON，足以恢复 ID、状态和 cursor；不以 `details` 代替模型路径验证。
- 所有预期管理错误都必须同时验证：`content` 首行是
  `SUBAGENT_ERROR code=<CODE> operation=<OPERATION> sideEffects=<SIDE_EFFECTS> retry=<RETRY>`，且四项与
  `details` 完全一致；后续自然语言仅用于人类阅读。delivery 以结构化 `outcome` 为准。

新结果文件逐个 attempt 使用以下列，长 content 可在表后用同一 attempt ID 的代码块原样展开：

| Case/attempt | 前置 Agent/run | 期望 | 实际模型可见 content | details code/outcome | 结论 |
| --- | --- | --- | --- | --- | --- |

## Phase V：输入校验（无模型成本）

| 用例 | 调用要点 | 期望 |
| --- | --- | --- |
| V1 | spawn 缺 `task` | `SUBAGENT_INPUT_INVALID` |
| V2 | spawn `task: "   "` | `SUBAGENT_INPUT_INVALID` |
| V3 | spawn 带未知字段 | `SUBAGENT_INPUT_INVALID`（见注 1） |
| V4 | spawn `label` 含 `\n` | `SUBAGENT_INPUT_INVALID` |
| V5 | spawn `label` 81 个 code point | `SUBAGENT_INPUT_INVALID` |
| V6 | spawn `projectContext: "bogus"` | `SUBAGENT_INPUT_INVALID` |
| V7 | spawn `tools: ["bash","bash"]` | `SUBAGENT_INPUT_INVALID` |
| V8 | spawn `tools: [""]` | `SUBAGENT_INPUT_INVALID` |
| V9 | spawn `task` 70000 字节 | `SUBAGENT_INPUT_TOO_LARGE`（见注 1） |
| V10 | send 缺 `message` | `SUBAGENT_INPUT_INVALID` |
| V11 | send `message: " "` | `SUBAGENT_INPUT_INVALID` |
| V12 | send `agentId: ""` | `SUBAGENT_INPUT_INVALID` |
| V13 | wait `runIds: []` | `SUBAGENT_INPUT_INVALID` |
| V14 | wait 17 个 runId | `SUBAGENT_INPUT_INVALID` |
| V15 | wait 重复 runId | `SUBAGENT_INPUT_INVALID` |
| V16 | wait `mode: "bogus"` | `SUBAGENT_INPUT_INVALID` |
| V17 | wait `timeoutMs: -1` | `SUBAGENT_INPUT_INVALID` |
| V18 | wait `timeoutMs: 1.5` | `SUBAGENT_INPUT_INVALID` |
| V19 | list `limit: 0` | `SUBAGENT_INPUT_INVALID` |
| V20 | list `limit: 17` | `SUBAGENT_INPUT_INVALID` |
| V21 | list `agentIds` 与 `view` 同传 | `SUBAGENT_INPUT_INVALID` |
| V22 | list `view: "bogus"` | `SUBAGENT_INPUT_INVALID` |
| V23 | list `states: ["BOGUS"]` | `SUBAGENT_INPUT_INVALID` |
| V24 | list `states: ["IDLE","IDLE"]` | `SUBAGENT_INPUT_INVALID` |
| V25 | cancel 缺 `reason` | `SUBAGENT_INPUT_INVALID` |
| V26 | cancel `reason` 3000 字节 | `SUBAGENT_INPUT_TOO_LARGE` |
| V27 | kill `agentId: ""` | `SUBAGENT_INPUT_INVALID` |
| V28 | spawn `tools: ["subagent_spawn"]` | `SUBAGENT_TOOL_FORBIDDEN` |
| V29 | list `cursor: "bogus"` | `SUBAGENT_CURSOR_STALE` |
| V30 | send 给不存在的 agent | `SUBAGENT_AGENT_NOT_FOUND` |
| V31 | wait 不存在的 runId | `SUBAGENT_RUN_NOT_FOUND` |
| V32 | cancel 不存在的 agent | `SUBAGENT_AGENT_NOT_FOUND` |
| V33 | kill 不存在的 agent | `SUBAGENT_AGENT_NOT_FOUND` |
| V34 | list `agentIds: ["agent_nonexistent"]` | `SUBAGENT_AGENT_NOT_FOUND` |

## Phase F：功能生命周期

| 用例 | 步骤 | 期望 |
| --- | --- | --- |
| F1 | spawn 固定回显任务 → wait mode=all | `outcome=RESULT`，正文含回显标记 |
| F2 | 对已交付 runId 再次 wait | `SUBAGENT_RUN_ALREADY_DELIVERED` |
| F3 | 同一 agent：send 存入口令 → wait；再 send 询问口令 → wait | 第二次报告含第一次的口令（私有上下文保留） |
| F4 | list view=agents | 直接从 content JSON 核对 IDLE、lastRunId、各工具/delivery/降级计数；完整 model 只在 details 核对 |
| F5 | kill IDLE agent，`expectedLastRunId` 正确 | `KILL_REQUESTED`，state `TERMINATING` |
| F6 | 对已 kill agent 直接查找 | `SUBAGENT_AGENT_NOT_FOUND` |
| F7 | 对已 kill agent send | `SUBAGENT_AGENT_NOT_FOUND` |
| F8 | kill 时 `expectedLastRunId` 错误 | `SUBAGENT_KILL_STALE` |
| F9 | spawn 快速任务后、wait 前 list view=deliveries | content JSON 可见 `READY` delivery；wait 后 `items: []`（恰好一次） |

## Phase C：并发与运行中操作

不同 fixture 不得共享 Agent/run 或释放槽位后的重试结果。每个 fixture 都使用 `$E2E_ROOT_REAL` 下的独立 barrier
子目录；清理上一 fixture 的 delivery 和 IDLE Agent 后再开始下一项。阻塞任务应先写自己的 ready marker，再执行
`sleep 600`，避免人工操作期间自然完成。

按以下顺序准备和执行：

1. **C1 原子准入 fixture**：先确认 Manager 中没有既存 Agent/run，再在同一并行工具块发起 9 个阻塞 spawn；
   确认 8 个成功项各自的 ready marker、记录其 Agent/run 和另 1 个错误后，取消、wait 并 kill 清理全部成功项。
2. **C2-R 独立 fixture**：创建 8 个已写 ready marker 的 RUNNING run，槽位必须保持为 8；向其中一个 RUNNING
   Agent send。记录结果后完整清理。
3. **C2-I 独立 fixture**：先完成并 wait 一个快速任务，保留该 IDLE Agent；再用另外 8 个已写 ready marker 的
   RUNNING run 填满槽位；只向该 IDLE Agent send。记录结果后完整清理。不得复用 C2-R 的目标或先释放一个槽位。
4. **运行中操作 fixture**：创建独立阻塞 run，依次执行 C13、C3、C5、C8、C6、C9、C10；必须在 C6
   发出取消前完成 C8。C7 使用另一个独立阻塞 run；C4 使用一个写 ready marker 后约 5 秒自然完成的独立 run，
   使胜出的 wait 能在合理时间内正常交付。
5. **C11/C12 fixture**：按下文“确定性取消”在全新测试 session 中执行，不复用前述任何 Agent/run。

| 用例 | 步骤 | 期望 |
| --- | --- | --- |
| C1 | 9 个并行 spawn | 恰好 8 个成功，1 个 `SUBAGENT_CONCURRENCY_LIMIT` |
| C2-R | 槽满时向 RUNNING Agent send | content 首行 code 为 `SUBAGENT_BUSY`，含 currentRunId；不排队、不影响当前 run |
| C2-I | 槽满时向独立的 IDLE Agent send | content 首行 code 为 `SUBAGENT_CONCURRENCY_LIMIT`；Agent 保持 IDLE |
| C3 | wait `timeoutMs: 1500` 于 RUNNING run | `TIMEOUT`；content 追加 JSON 中含精确 runId、`state: "RUNNING"`，run 未被取消 |
| C4 | 同一块内两个 wait 重叠相同 runId | 恰好一个 `SUBAGENT_WAIT_CONFLICT`，另一个正常返回 |
| C5 | kill RUNNING agent | `SUBAGENT_KILL_BLOCKED`；任务未中断 |
| C6 | cancel 精确 active runId | `CANCEL_REQUESTED`，state `CANCELLING` |
| C7 | 同一并行块内重复 cancel 同一阻塞 run | 一个 `CANCEL_REQUESTED` + 一个 `SUBAGENT_CANCEL_ALREADY_REQUESTED` |
| C8 | cancel 同 agent 但 runId 错误 | `SUBAGENT_CANCEL_STALE` |
| C9 | wait 被取消的 run | `outcome=CANCELLED`，工具结果 `isError=true` |
| C10 | kill 已 CANCELLED 且 IDLE 的 agent | `KILL_REQUESTED` |
| C11 | barrier 后并行 cancel 7 个精确 run → wait all | 7 个 `CANCEL_REQUESTED`；随后 7 个 `outcome=CANCELLED` |
| C12 | C11 wait all 后立即 spawn | 成功（取消终态已回收 slot） |
| C13 | list agents `states: ["RUNNING"]` | content JSON 只含运行中 Agent |

### C11/C12 确定性取消

在没有既存 Agent/run 的新测试 Pi session 中执行：

1. 创建 `$E2E_ROOT_REAL/c11`。为 7 个任务分配固定编号和唯一 marker 路径
   `$E2E_ROOT_REAL/c11/<n>.ready`。
2. 并行 spawn 7 个 Agent。每个任务必须要求 Child 用 bash 执行以下等价命令，其中 `<marker>` 替换为该任务的
   绝对路径，并且命令结束前不得返回报告：

   ```bash
   marker='<marker>'
   printf 'ready\n' >"${marker}.tmp"
   mv "${marker}.tmp" "$marker"
   sleep 600
   ```

   `mv` 完成才表示该 run 已越过 barrier；每个任务只能写自己的 marker。
3. 父端确认 7 个 marker 全部存在；然后用一次 direct
   `subagent_list({ "agentIds": [<七个精确 agentId>] })` 从 content JSON 确认 7 项均为 `RUNNING`，且
   `currentRunId` 分别匹配记录值。任一条件不满足，本 attempt 立即记 FAIL，不得发 cancel 后补记 PASS。
4. 在同一并行工具块对 7 组精确 agentId/runId 发出 cancel。七次调用都必须返回
   `CANCEL_REQUESTED`；任何 terminal、stale、not-found 或其他结果都使本 attempt 失败。
5. 对 7 个 runId 执行 wait all。必须恰好交付 7 个 `CANCELLED`；`RESULT` 不是等价成功。
6. wait all 返回后立即执行 C12 快速 spawn；spawn 成功后 wait 至终态，证明 slot 已回收。
7. kill 所有 IDLE Agent 并确认 list 为 0，然后结束该测试 Pi session。异常路径直接结束 session 以回收
   sidecar，不依赖对 RUNNING Agent 执行 kill。

## Phase IO：多 agent 并发读写（共享 cwd）

准备：`$E2E_ROOT_REAL/io/shared.txt`（空）、`race.txt`。

| 用例 | 步骤 | 期望 |
| --- | --- | --- |
| IO1 | 并行 3 个 agent，各自 `echo "M<n> $i" >> shared.txt` ×20 | wait 全部 RESULT；文件恰有 60 行；每个 marker 恰好 20 行且无撕裂行 |
| IO2 | 并行 2 个 agent，各自一次性覆写 race.txt 为 500 行单一标记 | 全部 RESULT；最终文件为 500 行且全为同一标记（无混写撕裂） |
| IO3 | 并行 3 个 agent 读取 shared.txt 行数并回报 | 三个报告一致且为 60（并发读一致） |
| IO4 | agent A 写 `value.txt`；A 交付后 agent B 读取 | B 报告内容与 A 写入一致（跨 agent 文件可见性） |

## Phase P：策略与能力

| 用例 | 步骤 | 期望 |
| --- | --- | --- |
| P1 | spawn 任务“列出你可用的全部工具名” | 报告中不含任何 `subagent_*`（深度一策略） |
| P2 | spawn `tools: ["read"]` | 成功；agent 能力收敛到显式集合 |
| P3 | spawn `tools: []` | 成功（空数组 = 无工具） |
| P4 | spawn `tools: ["definitely_not_a_tool"]` | `SUBAGENT_EXPLICIT_TOOL_MISSING` |
| P5 | spawn `label: "测试🧪标签"` | 成功；直接从 list content JSON 核对 label、ID、state 和工具计数 |
| P6 | spawn `projectContext: "inherit"`（默认） | 成功 |

## Phase L：列表与分页

先确认 Manager 中没有既存 Agent/run，再在独立 fixture 中创建并 wait 至少 5 个 IDLE Agent。把 spawn 返回的
全部 agentId 作为预期集合并固定下来；从第一次分页请求开始到最后一页返回前，不得 spawn、send、kill、reload
或修改筛选条件。这样该已知集合就是第一页 cursor 的 high-water snapshot 目标集合。每次调用都从模型可见单行
JSON 读取 `items` 和 `nextCursor`，同时与完整 `details` 核对顺序和 cursor 字节值。

| 用例 | 步骤 | 期望 |
| --- | --- | --- |
| L1 | list agents `limit: 2`，后续请求保持相同参数并携带上一页 `nextCursor`，循环到 cursor 省略 | 页数不限；每页 ≤2 项、全程无重复，合集恰好等于固定的 high-water 目标集合 |
| L2 | list agents `states: ["IDLE"]` | content JSON 只含 IDLE，items 顺序与 details 一致 |
| L3 | list deliveries `states: ["READY"]`（F9 中） | content JSON 只含 READY 项，items 顺序与 details 一致 |
| L4 | list `agentIds: [b, a]` 直接查找 | content JSON 的两项严格按请求的 b、a 顺序返回 |
| L5a | 使用 `"bogus"`、普通单字符篡改，以及末位非规范 base64url 别名（解码字节可与原签名相同）的真实 cursor | 三者均返回模型可见 `SUBAGENT_CURSOR_STALE`；cursor 必须是规范编码 |
| L5b | 把 agents 第一页的合法 cursor 用于 `view: "deliveries"` | `SUBAGENT_CURSOR_STALE`；证明是合法签名 cursor 的 query/view 不匹配 |
| L5c | 把带 `states: ["IDLE"]` 的合法 cursor 用于不同 states 组合 | `SUBAGENT_CURSOR_STALE`；不得用畸形 cursor 代替此项 |
| L5d | 若本轮包含 Manager reload，把 reload 前合法 cursor 用于新 epoch | `SUBAGENT_CURSOR_STALE` |

L1 必须持续翻页直到 `nextCursor` 字段完全省略，不能假设两页覆盖全部。最后一页的 content 和 details 都不得保留
`nextCursor`；空查询结果必须是 `items: []`。

## Phase H：非交互模式（自动化）

```bash
test/e2e/headless-mode.sh
```

| 用例 | 期望 |
| --- | --- |
| H1 print 模式调用 subagent_list | 输出含 “interactive parent session”，快速返回，无配置/子进程残留 |

## 已知执行注意事项

1. V3/V9：未知字段与超长 task 可能在到达 extension 前被模型 API 层剥离/截断，live 路径不可达；
   校验逻辑由 `test/contracts.test.ts` 覆盖，live 执行时记 N/A 而非 FAIL。
2. C2-R/C2-I 是不同状态的独立验收项。任何先释放槽位再重试、复用目标或把两个结果合并记录的做法都不能证明
   send 错误优先级。
3. C7：协作取消的终态提交极快，顺序重复 cancel 通常命中 `SUBAGENT_RUN_ALREADY_TERMINAL`。
   确定性命中 `SUBAGENT_CANCEL_ALREADY_REQUESTED` 需在同一并行工具块内发起两个相同 cancel。
   `SUBAGENT_CANCEL_STALE` 要求目标 agent 仍有 active run。
4. F4、P5 和 Phase L 的 PASS 必须来自模型实际收到的 content JSON；只查看 `details` 或自然语言计数不能作为
   模型可见契约的证据。

## 清理

1. 对仍在运行的精确 run 先 cancel 并 wait 至终态，再 kill 所有 IDLE Agent；确认最终 agent list 为 0。
2. 结束测试 Pi session，确认本 session 对应的 Guardian、Worker process group 和 session spool 已清理。
3. 删除临时目录前重新解析路径并验证 ownership marker；任一检查失败都停止，不执行删除：

   ```bash
   E2E_ROOT_REAL_NOW="$(cd "$E2E_ROOT_REAL" && pwd -P)"
   case "$E2E_ROOT_REAL_NOW" in
     "$E2E_TMP_REAL"/subagent-e2e.*) ;;
     *) echo "refusing cleanup outside OS temp directory" >&2; exit 1 ;;
   esac
   test -f "$E2E_ROOT_REAL_NOW/.subagent-e2e-owner" || exit 1
   test "$(cat "$E2E_ROOT_REAL_NOW/.subagent-e2e-owner")" = "$E2E_RUN_ID" || exit 1
   rm -rf -- "$E2E_ROOT_REAL_NOW"
   ```

4. 在 `extensions/sub-agent` 运行 `npm run check && npm test`，并把结果写入新的 post-fix 结果文件。

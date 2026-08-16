# context-management extension 实现规格

状态：Proposed（experimental）
日期：2026-08-16
适用范围：计划新增的 extensions/context-management experimental v1
实现完成条件：本文“验收标准”全部满足

本文使用 MUST、MUST NOT、SHOULD、MAY 表示强制性。

## 1. 背景

Pi 的原生 session 已经保存完整、分支化的对话历史，并提供自动压缩、手动 /compact、session tree 和
CompactionEntry。context-management 不建立第二份对话账本，也不把“上下文管理”缩减为另一种摘要提示词。

本 extension 把模型每次实际收到的内容视为从完整 Pi Session Record 编译出来的 Active Context，并统一负责：

1. 计算请求预算并为模型推理与回答保留固定空间；
2. 保留最近的完整对话，同时机械缩减已经重复或被可靠替代的旧工具证据；
3. 在旧前缀退出近期窗口前，提前生成可安装的 Compaction Checkpoint；
4. 在任何 provider 请求发送前执行最终预算检查和必要的阻塞恢复；
5. 让模型能够按精确引用重新读取被缩减的原始证据；
6. 从仓库级长期记忆中按当前请求召回少量相关内容；
7. 完全接管 Pi 原生 compaction 的语义，同时复用 Pi 的 session、持久化和 UI 生命周期。

本文是实现规格，不授权实现、发布、commit、push 或创建 PR。

## 2. 产品目标

实现 MUST 达到以下目标：

1. Pi Session Record 始终是完整、追加式、分支感知的事实源。
2. 每次 LLM 调用都从当前 Conversation Branch 编译独立的 Active Context。
3. Active Context 保留固定内容、一个可选 Checkpoint、完整近期对话、请求相关召回内容和当前 run 输入。
4. 每次普通请求至少预留 20,000 tokens 的 Generation Headroom。
5. 旧工具证据先经过确定性的生命周期缩减，再决定是否需要语义压缩。
6. Checkpoint 只替换闭合的旧前缀，不压缩 Protected Tail，不堆叠多个摘要。
7. 普通情况下在后台提前准备 Checkpoint，并在 idle 边界安装。
8. 达到阻塞阈值或最终预算检查失败时，在下一次 provider 请求前完成恢复，不等待 agent_settled。
9. 任何压缩失败都不得安装空、截断或机械无效的 Checkpoint，也不得回退到 Pi 默认摘要器。
10. Raw Evidence 即使不再默认进入 Active Context，仍能按稳定引用从当前 branch 精确恢复。
11. Repository Memory 能跨 session、跨同一仓库的 worktree 保存并按需召回长期知识。
12. Memory Record 的语义正文由模型用 CommonMark 自由表达，机器只管理可靠的外层元数据和机械约束。
13. V1 零配置，所有预算、阈值、上限和行为规则均由本规格固定。
14. 所有模式都能安全加载；无 UI 的模式不得等待不存在的交互。
15. 默认测试不得访问真实模型、真实用户 session、真实用户 memory、付费 API 或不受控网络。

## 3. 非目标与部署假设

V1 MUST NOT：

- 维护或注入 Working State；
- 实现任务计划、todo、goal 或进度跟踪；
- 每轮生成语义状态摘要；
- 删除、覆盖或改写 Pi Session Record 中的 Raw Evidence；
- 自动搜索或模糊召回 session evidence；
- 对任意 bash、edit、write、图片或 extension-defined tool 进行语义猜测式缩减；
- 使用独立的便宜模型、fallback 模型或可配置 compactor 模型；
- 把 Repository Memory 自动发布到 ADR、README、AGENTS.md 或其他项目文件；
- 根据年龄、TTL、分数或容量自动淘汰 Memory Record；
- 让 agent 在没有用户明确移除意图时自行 forget；
- 提供配置文件、环境变量覆盖、feature flag 或项目级调参；
- 增加遥测、后台上传或未说明的网络请求；
- 支持多个 context management 或 compaction extension 并存；
- 检测、排序、仲裁或兼容其他 extension 对 context、provider payload 或 compaction 结果的修改；
- 使用 Pi 私有字段、monkey patch、私有 SessionManager 写接口或第二种 Checkpoint 持久化格式；
- 自动提升版本、移除 private、发布、commit、push 或创建 PR。

V1 以 context-management 是当前 Pi runtime 中唯一的上下文治理和压缩 owner 为部署假设。违反该假设的行为
未定义，extension 不增加任何防御或兼容层。

## 4. 名称与注册资源

Extension、目录和 package 名均为 context-management。

公开用户命令：

~~~text
/context-management-status
~~~

复用而不重新注册的 Pi 原生命令：

~~~text
/compact [focus]
~~~

LLM 工具：

~~~text
context_management_evidence_read
context_management_memory_write
context_management_memory_search
context_management_memory_read
context_management_memory_forget
~~~

内部全局标识 MUST 使用 context_management 前缀。建议固定为：

~~~text
context_management.checkpoint.v1
context_management.compaction.details.v1
context_management.memory.v1
context_management.recall.memory.v1
context_management.recall.evidence.v1
context_management.status
~~~

根 package 入口 MUST 为 extensions/context-management/index.ts，并只转发
extensions/context-management/src/index.ts 的默认导出。

## 5. 已核实的 Pi 公开行为

实现可以依赖本机 @earendil-works/pi-coding-agent 0.82.1 的以下公开行为：

1. context event 在每次 LLM 调用前触发，handler 可以异步返回完整替换后的 AgentMessage 数组。
2. context event 收到 messages 的深拷贝；修改投影不会修改 agent state 或 Pi Session Record。
3. context handler 在 AgentMessage 转换为 provider Message 和 payload 之前执行。
4. context handler 的异常会被 Pi 捕获，因此 extension 不能依赖 throw 阻止 provider 请求。
5. ctx.abort() 会同步请求中止当前 agent signal；阻塞恢复失败时必须显式调用它。
6. before_agent_start 提供当前原始用户 prompt、完整 system prompt 和 systemPromptOptions。
7. agent_settled 只在 Pi 自身 retry、auto-compaction retry 和 queued continuation 全部结束后触发。
8. session_before_compact 会覆盖 manual、threshold 和 overflow 三种原因，并可返回自定义 CompactionResult。
9. 若 session_before_compact 返回 undefined，Pi 会调用默认摘要器；本 extension 必须始终返回有效结果或明确
   cancel，不能用异常表达失败。
10. CompactionResult 可以指定 summary、firstKeptEntryId、tokensBefore、usage 和 extension-specific details。
11. Pi 会把 extension 返回的结果追加为原生 CompactionEntry，并重新构建 session context。
12. ctx.compact() 会调用同一原生 compaction 生命周期，但该 API 不返回 Promise；完成和失败通过 callback
    观察。
13. 手动 ctx.compact() 会先 abort 当前 agent，因此不得在活动 run 内用它安装阻塞 Checkpoint。
14. ReadonlySessionManager.getBranch() 返回当前 leaf 到 root 的完整 branch，包括已被 CompactionEntry 从模型
    context 隐藏的历史条目。
15. ReadonlySessionManager.buildContextEntries() 返回 Pi 当前 compaction-aware 的可见 entry 投影。
16. Pi session entry ID 在 branch 内稳定；fork 复制历史 entry 时保留这些 entry ID。
17. ctx.model 提供当前模型及 contextWindow、maxTokens 等容量元数据。
18. ctx.modelRegistry.getProvider() 返回当前 runtime 的最终 Provider；Provider 公开 streamSimple。
19. ctx.modelRegistry.getApiKeyAndHeaders() 能解析当前模型的最终认证、headers 和 provider env。
20. getAgentDir() 是公开 API，并尊重 PI_CODING_AGENT_DIR。
21. withFileMutationQueue() 是 Pi 公开的进程内逐文件写队列。
22. Extension tool 可声明 sequential execution，但未知外部工具仍不得被假定为串行。

若公开契约变化并使本文行为不可实现，必须先修订规格；不得通过读取私有字段或复制 Pi 内部 runtime 绕过。

## 6. 总体架构

context-management 包含两个同 package、不同生命周期的子系统：

1. Context Runtime：session-scoped，编译每次模型请求、管理 evidence 和 compaction。
2. Repository Memory：repository-scoped，跨 session 保存并检索长期知识。

数据流为：

~~~text
Pi Session Record ──► branch projection ──► Evidence reduction ──┐
                         │                                      │
                         └──► Checkpoint + Protected Tail ───────┤
Repository Memory ──► Memory retrieval ──► Memory Pack ─────────┤
Explicit evidence read ───────────────────► Evidence Pack ──────┤
Fixed Envelope ─────────────────────────────────────────────────┤
                                                                ▼
                                                        Context Compiler
                                                                │
                                                                ▼
                                                    Final Request Preflight
                                                       │             │
                                                    passes       Budget Recovery
                                                       │             │
                                                       └──────┬──────┘
                                                              ▼
                                                        provider request
~~~

### 6.1 第一不变量：事实源与投影分离

Pi Session Record MUST 保留完整原始 branch 历史。Active Context、Evidence Stub、Memory Pack、Evidence Pack、
Prepared Checkpoint 和 token 估算均为可丢弃、可重建的派生状态。

除原生 CompactionEntry 外，Context Runtime MUST NOT 为对话历史建立外部持久化副本。

### 6.2 第二不变量：单 Checkpoint

一个 Conversation Branch 的 Active Context 最多包含一个 installed 或 pending Compaction Checkpoint。更新时
必须滚动合并旧 Checkpoint 与新退出 Protected Tail 的前缀，禁止摘要堆叠。

### 6.3 第三不变量：先机械、后语义

预算恢复 MUST 先物化全部符合条件的确定性 Evidence reduction，再决定是否安装或生成 Checkpoint。不能把能够
机械判定的重复内容交给模型摘要器处理。

### 6.4 第四不变量：发送前闭合

provider 请求只能在完整 tool-call/result batch 结束后进入 Context Compiler 和 Final Request Preflight。
extension 不得中断正在流式返回的 provider response，不得中断正在执行的 tool，不得生成缺少对应结果的
tool-call 投影。

### 6.5 第五不变量：失败关闭

如果完整 Budget Recovery 已经耗尽全部 eligible compactable prefix，并在本轮自动 Memory Pack 整包抑制后仍
不能构造合法请求，Context Runtime MUST 在 context handler 返回前调用 ctx.abort()，返回最后一个结构闭合的
安全投影，并报告明确错误。已经 abort 的 signal 必须阻止该 provider 请求发送。

context handler 自身 MUST 捕获所有内部异常；不得依赖 Pi 对 handler exception 的吞掉行为。

## 7. 生命周期与 branch 状态

每个 extension runtime 实例 MUST 维护独立的 session-scoped coordinator。至少包含：

~~~ts
interface ContextRuntimeState {
  runtimeGeneration: number;
  branchEpoch: number;
  runGeneration: number;
  projectionEpoch: number;
  installedCheckpoint?: InstalledCheckpoint;
  pendingCheckpointCommit?: PendingCheckpointCommit;
  preparation: PreparationState;
  memoryPack: MemoryPackState;
  memoryPackSuppressed: boolean;
  evidencePack: EvidencePackState;
  estimatorCalibration: EstimatorCalibration;
  reductionStats: ReductionStats;
  blockingState?: BlockingState;
}
~~~

具体 TypeScript 可以拆分，但必须保留相同语义。

runtimeGeneration 标识一个 extension runtime 实例，只在 teardown 时失效。branchEpoch 在当前 runtime 内每次
session branch projection 被 tree navigation、native compaction 或显式 rebuild 替换时递增；普通 entry append
不递增。runGeneration 在每次新 agent run 开始时递增，只约束 Memory/Evidence Pack 等 run-scoped 状态。

### 7.1 session_start

session_start MUST：

1. 读取当前 branch；
2. 查找最新 reachable CompactionEntry；
3. 恢复本 extension 的 Checkpoint Installation Entry，或把没有本 extension details 的最新原生 entry 作为
   Legacy Compaction Summary；
4. 重建 evidence reference 索引和当前 projection metadata；
5. 解析 Repository Identity，加载或禁用 Repository Memory；
6. 清空任何上一 runtime 的 Memory Pack、Evidence Pack 和 Prepared Checkpoint；
7. 不启动 timer、watcher 或模型请求。

新的 session runtime 从独立 runtimeGeneration、branchEpoch 0 和 runGeneration 0 开始。

### 7.2 before_agent_start

普通用户请求开始时 MUST：

1. 递增 runGeneration；
2. 记录该 run 的 root user input 锚点；
3. 清空上一 run 的 Evidence Pack；
4. 根据当前用户输入构建并冻结新的 Memory Pack；
5. 将 memoryPackSuppressed 设为 false；
6. 准备本 run 所需的 memory authoring 与 recall prompt guidance；
7. 不等待 background compaction。

同一 agent run 内的 steering、tool turns 和 follow-up 不重建 Memory Pack。

### 7.3 agent_settled

agent_settled MUST：

1. 清空本 run 的完整 Evidence Pack 和 admission candidate；
2. 结束该 run 的 Memory Pack 并清除 memoryPackSuppressed；
3. 若存在 Pending Checkpoint Commit，立即请求原生 compaction 生命周期提交同一候选；
4. 否则若存在仍然兼容的 ready Prepared Checkpoint，立即请求安装；
5. 若仍在 preparing，不等待；candidate 完成后再次检查 ctx.isIdle()，在 verified idle 时请求安装；
6. 允许在满足 Net Savings Gate 或 correctness reduction 时开始新 Projection Epoch；
7. 不自动写 Memory Record。

### 7.4 session_shutdown

session_shutdown MUST：

1. 递增 runtimeGeneration，使所有旧异步回调失效；
2. abort background compactor、同步 compactor、memory I/O wait 和 lock wait；
3. 清空所有瞬时 Pack、Prepared Checkpoint 和 Pending Checkpoint Commit；
4. 幂等释放 timer、文件锁和 listener；
5. 不为尚未安装的候选写 CompactionEntry。

## 8. Active Context 组成与顺序

概念顺序固定为：

~~~text
Fixed Envelope
Installed/Pending Compaction Checkpoint（可选）
Protected Tail 的稳定前缀
Recall Suffix：
  Memory Pack（本轮未被抑制时）
  Evidence Pack
当前 agent run 的 root user input
该 run 后续完整 assistant/tool/steering 消息
Generation Headroom（不属于输入内容）
~~~

Fixed Envelope 由 Pi 拥有，不作为 message 插入。Checkpoint、Tail 和 Pack 是 Context Compiler 的输入。

### 8.1 Recall Suffix 的物理投影

Memory Pack 和 Evidence Pack MUST 作为不可持久化的 synthetic custom AgentMessage 注入到该 run 的 root user
input 之前。Pi Session Record 中不得追加 Pack 正文。

顺序 MUST 为 Memory Pack 在前、Evidence Pack 在后。Pack 内容不变时，后续 provider call MUST 复用相同文本、
相同排序和相同 synthetic timestamp，避免无意义地破坏 prompt cache。若 Budget Recovery 触发本轮 Memory Pack
整包抑制，后续 call 不再注入它；不得重新排名、部分淘汰或在该 run 内恢复。

显式 Evidence Read 工具的持久化 tool result MUST 只包含短确认和 reference，不得复制完整 Raw Evidence。
完整内容只存在于当次 run 的 Evidence Pack 中。

### 8.2 无 Checkpoint 的首次投影

如果 branch 从未 compact，Active Context 使用从 branch 根开始的原始可见消息，直到旧前缀满足 Checkpoint 条件。
Evidence reduction 仍可在不安装 Checkpoint 的情况下建立新的 Projection Epoch。

### 8.3 有 Checkpoint 的投影

如果存在 installed 或 pending Checkpoint，Context Compiler MUST：

1. 只投影一个 compactionSummary message；
2. 从 Checkpoint 的 firstKeptEntryId 开始保留 raw tail；
3. 加入 Checkpoint 安装后追加的当前 branch entries；
4. 不重新投影 Checkpoint 已覆盖的普通消息；
5. 允许 Evidence Reference 指回仍保留在完整 branch 中的 covered entry。

### 8.4 Fixed Envelope

Fixed Envelope 至少包括：

- ctx.getSystemPrompt() 返回的最终 system prompt；
- 当前 active tools 的名称、描述和参数 schema；
- Pi 已经加入 system prompt 的 AGENTS.md、skills、环境和能力说明；
- provider 请求必需但可从公开逻辑估算的固定包装开销。

Context Runtime MUST 计量 Fixed Envelope，但 MUST NOT 摘要、删除或重排它。

## 9. Token 估算与预算

### 9.1 固定常量

~~~text
Generation Headroom G = 20,000 tokens
Memory Pack limit      = 8,192 tokens
Explicit memory search = min(10 stubs, 4,096 tokens)
Memory Summary limit   = 256 tokens
Memory Content limit   = 10,240 UTF-8 bytes
Repository Memory limit = 8 MiB serialized UTF-8
~~~

所有常量在 V1 中硬编码。

### 9.2 Safe Input Budget

对当前模型：

~~~text
W = model.contextWindow
G = 20,000
B = Safe Input Budget = W - G
~~~

如果 W 小于或等于 G，普通 provider 请求 MUST 失败并说明模型窗口不足；不得把 G 静默调低。

### 9.3 Raw Estimate

实现 MUST 使用同一套纯函数估算：

- system prompt 文本；
- active tool schema 的稳定 JSON；
- 每个 AgentMessage 的文本、tool arguments 和图片等价成本；
- synthetic Pack 包装；
- Pi compaction summary 包装；
- compactor prompt 包装。

V1 MAY 复用 Pi 公开 estimateTokens()，但 Fixed Envelope、synthetic message 和 tool schema 的估算必须由本
extension 补齐。不能只使用 ctx.getContextUsage()，因为它描述上一已完成请求及 trailing estimate，不是待发送
完整请求。

### 9.4 Provider usage 校准

每次普通 provider 请求前，Runtime MUST 保存该请求的 raw estimate。收到同 provider/model 的成功 assistant
usage 后，如果 usage 能给出正数 prompt token 数，则计算：

~~~text
reportedPrompt = input + cacheRead + cacheWrite
ratio = reportedPrompt / rawEstimate
~~~

每个 provider/model 在当前 runtime 内保留最近 8 个有效 ratio。校准因子取：

~~~text
calibration = max(1, 最近 8 个 ratio 的最大值)
correctedEstimate = ceil(rawEstimate × calibration)
~~~

无有效 usage 时 calibration 为 1。校准只修正低估，不用 provider usage 把当前估算向下调。该状态不持久化。

### 9.5 Final Request Estimate

Final Request Estimate MUST 是完整待发送 Active Context 的 corrected estimate，而不是各层独立估算的任意
相加近似。分层估算只用于 status 展示，完整 projection 必须再整体估算一次以包含包装成本。

### 9.6 Final Request Preflight

每次 context event 返回前 MUST 检查：

~~~text
Final Request Estimate <= Safe Input Budget
~~~

Preflight 本身只判断，不修改 projection。失败后进入同一个 Pre-Provider Compaction Barrier 中的 Budget
Recovery。恢复后必须重建并重新整体估算，禁止沿用恢复前数字。

## 10. Protected Tail

Protected Tail target 为：

~~~text
T = clamp(floor(B × 10%), 20,000, 64,000 tokens)
~~~

Checkpoint Output Budget hard ceiling H 与 T 相同。

### 10.1 tail 选择

Context Compiler MUST 从当前 branch leaf 向前累积可见 raw entries，直到达到 T，然后继续向前扩展到最近的合法
闭合边界：

1. 不从 toolResult 开始；
2. 不拆开一个 assistant toolCall 与它的全部对应 toolResult；
3. 不拆开一个 Pi internal turn；
4. 优先从用户或 LLM-visible custom message 开始；
5. 一个闭合单元自身超过 T 时完整保留，允许实际 tail 超过 target。

T 是 target，不是截断上限。禁止为了严格满足 T 而破坏对话闭合。

### 10.2 compactable prefix

Protected Tail 之前、尚未被 installed Checkpoint 覆盖的闭合 raw prefix 是 newly eligible prefix。滚动压缩输入为：

~~~text
installed checkpoint（如果存在）
+ newly eligible prefix
~~~

如果 newly eligible prefix 为空，不得自动生成等价 Checkpoint。

### 10.3 current run 保护

当前 run 的 root user input、其后的 assistant/tool messages 和 queued steering 始终属于 Protected Tail。即使单个
run 超过 T，也不得在它尚未 settled 时把未闭合部分加入 background Preparation Snapshot。

## 11. Evidence Lifecycle

### 11.1 适用范围

V1 有两类确定性 reduction：

1. Exact Tool Duplicate：适用于所有能够稳定序列化的 finalized tool-call/result pair。
2. Built-in Evidence Supersession：只适用于 Pi 内置 read、grep、find、ls 的文本结果。

除上述规则外，所有工具证据保持 raw。尤其：

- edit 和 write 结果表示 mutation，不做 tool-specific supersession；
- bash 语义不能从命令字符串可靠推导，不做 tool-specific supersession；
- 图片 read 不做 read supersession；
- extension-defined tool 不做 tool-specific supersession；
- error result 不被后续成功或失败结果 supersede；
- 不依据相似文本、路径包含、范围包含、时间新旧或模型判断缩减。

### 11.2 finalized pair

只有同时存在以下内容时才形成 finalized pair：

1. assistant message 中完整 tool call；
2. 匹配 toolCallId 的完整 toolResult；
3. result 已结束且不再 streaming；
4. call 和 result 都位于同一 Conversation Branch；
5. 序列化过程中没有未知或不可表示值。

缺失、重复关联或部分 streaming 的 pair 保持 raw，并且不得进入 compactable prefix 的切点。

### 11.3 稳定序列化

机器 fingerprint MUST 使用：

- UTF-8；
- object key 递归字典序；
- array 保持原顺序；
- JSON primitive 保持类型；
- 字符串换行规范化为 LF；
- 不把 number 和数字字符串视为相同；
- SHA-256 全长十六进制摘要。

fingerprint 只进入 Runtime Metadata，不进入 Active Context 或 status。

### 11.4 Exact Tool Duplicate

两个 pair 只有在以下字段全部完全相同时才是 Exact Tool Duplicate：

- tool name；
- 稳定序列化后的原始 validated input；
- result content，包括所有 text/image block；
- isError；
- usage；
- 对结果语义有影响的完整 details。

较新的 pair 保留完整 payload。较旧 pair 在离开 Protected Tail 后可以把 result payload 替换为 Duplicate
Evidence Stub。tool call、toolCallId、消息角色和发生顺序必须保留。

### 11.5 Built-in input normalization

Built-in reducer 只在参数能够按当前 Pi 内置工具契约完整验证时工作。任何未知字段、错误类型、NaN、Infinity
或不能规范化的路径都会让该 pair 保持 raw。

共同规则：

1. path 相对 tool 执行时的 ctx.cwd 解析；
2. 路径使用 Node path normalization；
3. 能安全 realpath 时使用 realpath，目标已不存在时使用规范化 absolute path；
4. 大小写不做跨平台猜测，遵循当前文件系统字符串结果；
5. optional 参数展开为当前 Pi 版本的实际默认值；
6. 最终 key 使用稳定 JSON。

V1 默认值：

~~~text
read:
  offset = 1
  limit  = absent sentinel

grep:
  path       = cwd
  glob       = absent sentinel
  ignoreCase = false
  literal    = false
  context    = 0
  limit      = 100

find:
  path  = cwd
  limit = 1000

ls:
  path  = cwd
  limit = 500
~~~

read 的 absent limit 不得与任意显式 limit 合并，因为 Pi 的默认 byte/line truncation 与显式 line limit 不等价。

### 11.6 Built-in supersession

同一 branch 中，较新的成功文本结果只有在 tool name 和完整 normalized effective input 都相同时，才
conclusively supersede 较旧成功结果。

如果内容不同，旧结果成为 Superseded Evidence；如果完整 pair 也相同，则按 Exact Tool Duplicate 处理。
较新的结果必须保持完整，直到它自己满足后续 reduction 条件。

### 11.7 Evidence Stub

Stub 必须保留原 toolResult role、toolCallId 和 timestamp。正文固定为一行：

~~~text
[context-management: evidence <old-ref> superseded by <new-ref>]
~~~

或：

~~~text
[context-management: duplicate evidence <old-ref>]
~~~

Stub MUST NOT 包含：

- 原工具 input；
- payload excerpt；
- 原始或压缩后大小；
- fingerprint；
- truncation metadata；
- score、置信度或语义摘要；
- 不适用的读取路径。

### 11.8 Projection Epoch 与 cache 稳定性

Context Runtime MUST 维护 Projection Epoch。一个 epoch 内已经发送过的稳定 prefix 不因普通新证据到达而立即
原地改写；新 branch activity 只追加在 suffix。

如果同一 epoch 内出现内容不同的 conclusively superseding result，Runtime MUST 在新结果之后追加一行瞬时
Supersession Marker，使模型知道旧观察已经失效：

~~~text
[context-management: <old-ref> is superseded by <new-ref>]
~~~

下一个 Projection Epoch 把关系物化为旧 Evidence Stub，并移除 marker。

以下边界允许开始新 epoch：

- agent_settled 或 verified idle；
- Checkpoint installation；
- Pre-Provider Compaction Barrier；
- session/tree/branch projection rebuild。

### 11.9 Net Savings Gate

普通 opportunistic reduction 只有在候选完整 projection 相比当前 projection 至少节省：

~~~text
max(2,048 tokens, floor(currentProjectionTokens × 5%))
~~~

时才开始新 epoch。

以下情况绕过 Net Savings Gate：

- Budget Recovery；
- Checkpoint installation；
- 内容不同且 mechanically proven 的 correctness supersession；
- session/tree/branch 必须重建 projection。

Gate 比较完整 projection，而不是只相加被删除 payload 的 gross size。

## 12. Evidence Reference 与显式读取

### 12.1 reference 格式

每个可召回 Raw Evidence tool result 的 canonical reference 为：

~~~text
cm-evidence:v1:<session-entry-id>
~~~

reference 不包含 session ID，因此 Pi fork 复制历史 entry 后仍可解析。它只在当前 Conversation Branch 中有效：
同一 ID 不 reachable 时必须返回 not applicable。

Runtime MUST 从 branch entry ID 机械生成 reference；模型不得创建 ID。

### 12.2 reference 暴露

reference 只在以下位置进入模型上下文：

- Evidence Stub；
- Supersession Marker；
- compactor 输入中的 source annotation；
- Compaction Checkpoint 自己保留的 Evidence References；
- Explicit Evidence Read 的短 tool result；
- Evidence Pack 每项的 source header。

Protected Tail 中普通完整 tool result 不需要重复附加 reference。

### 12.3 compactor source annotation

构建 Normalized Compactable Input 时，每个可召回 tool result 前 MUST 加入机器生成的 reference annotation。
annotation 只属于 compactor input，不改写普通 Active Context 或 Session Record。

### 12.4 context_management_evidence_read

参数：

~~~ts
{
  reference: string;
}
~~~

执行 MUST：

1. 要求 reference 语法完全匹配 v1；
2. 要求目标 entry 位于当前 Conversation Branch；
3. 要求目标是 finalized tool result；
4. 读取该 result 的完整 call source、tool name、input、content、error state 和相关 details；
5. 在内存中创建一个 Evidence Admission Candidate；
6. 持久化的 tool result 只返回 reference 和“等待下一 provider preflight admission”的短确认；
7. 不搜索相邻 entry，不接受裸 entry ID，不做 fuzzy fallback。

持久化确认正文固定为：

~~~text
[context-management: evidence read requested for <reference>; full content is run-scoped and subject to next-request admission]
~~~

工具 MUST 使用 sequential execution mode，避免与其他 context-management memory/evidence mutation 并行。
这不代表未知外部工具会串行，最终 admission 仍只在完整 tool batch 后进行。

目标包含 image block 而当前模型不支持 image input 时，该 candidate 必须 admission failure；不得只返回图片
旁边的 text note 冒充完整 evidence。

### 12.5 Evidence Pack admission

Pre-Provider Compaction Barrier 按工具调用的 source order 处理 admission candidate：

1. 先保留本 run 已 admitted 的全部 items；
2. 临时加入下一个完整 item；
3. 重建 Active Context 并执行 Final Request Preflight；
4. 若失败，执行完整 Budget Recovery 后重试；
5. 若通过，该 item 成为 pinned Evidence Pack item；
6. 若仍不通过，不加入该 item，并把当前 projection 中对应 evidence-read tool result 改为明确的 admission
   failure；
7. 继续处理后续 candidate。

一个 item 必须完整加入或完整拒绝。不得截断、二次摘要或只返回 excerpt。

admission failure 投影 MUST 把对应 toolResult 标记为 error，并至少包含 reference、所需 estimated tokens 和
当前 Safe Input Budget。该失败投影只影响模型可见 context；Pi Session Record 中仍保留上述短确认和原始 source
evidence，不持久化完整副本。

Evidence Pack 没有独立 token cap。已经 admitted 的 item 在本 run 剩余时间内 pinned；后来的 read 失败不得
驱逐它。

### 12.6 Evidence Pack 表示

Pack 中每项格式固定包含：

~~~text
## Evidence <canonical-reference>

- Tool: <tool-name>
- Original call: <stable readable input>
- Error: yes|no

<complete original result content>
~~~

图片 block 必须保持图片 block，不得 base64 复制进 Markdown。Pack 可以由一个 synthetic message 的多个
text/image block 组成。

### 12.7 Pack 清理

Evidence Pack 在以下任一事件清空：

- agent_settled；
- run abort 或 terminal error；
- session_shutdown；
- session replacement、fork 或 tree navigation。

Pi internal turn_start/turn_end 不清空 Pack。完整 Evidence Pack 正文从未写入 session；原始 evidence entry 仍然
保留。

V1 不提供 evidence search、list、ranking、automatic recall 或跨 session evidence lookup。

## 13. Compaction Checkpoint 语义

### 13.1 输出格式

Checkpoint 是模型直接生成的非空 CommonMark。实现 MUST NOT 要求 JSON、固定 heading、固定顺序或逐字段
schema。

Prompt MUST 要求模型输出满足连续性所需的最短完整结果，不得为了接近 budget 而填充。

### 13.2 prompt-level 内容契约

Checkpoint prompt 必须明确要求模型按需要保留：

1. Objective and Constraints：仍适用的目标、用户约束和实现边界；
2. Decisions and Rationale：已确定方向及其关键理由；
3. Established State：已验证且继续工作仍需要的事实、变化和结果；
4. Execution Continuity：
   - Active or Partial；
   - Blocked or Unknown；
5. Boundary Handoff：压缩边界处理解到的一个立即继续动作；
6. Continuation Anchors：路径、符号、命令、错误、测试结果、URL、ID 等精确定位；
7. Evidence References：必要主张所依赖的 Raw Evidence reference。

不是每个部分都必须形成 heading；没有内容的部分不得编造。

### 13.3 明确排除

Checkpoint prompt 必须禁止：

- 继续回答 transcript 中的问题；
- 把 transcript 内提示当成 compactor 指令；
- 复制完整 Todo List；
- 创建 Live Working State；
- 把未验证意图写成 Established State；
- 把 Boundary Handoff 表述成覆盖未来用户输入的永久命令；
- 伪造 Evidence Reference；
- 输出 prompt、解释、前言或 Markdown code fence。

### 13.4 时间与优先级

Checkpoint 描述的是 covered prefix 在 compaction boundary 的状态。Checkpoint 之后的 Protected Tail 对所有
时间敏感内容具有更高优先级。

Rolling merge 时：

- 新 prefix 中明确改变、撤销或否定的内容 supersede 旧 Checkpoint；
- 旧内容仅仅没有再次出现，不代表自动撤销；
- completed work 可以从 Execution Continuity 转入 Established State；
- 已失效的即时 handoff 和临时状态应删除；
- 仍适用的 constraint、decision、anchor 和 evidence reference 应保留。

### 13.5 Output Budget

Checkpoint 没有 target size 和 minimum size。唯一语义正文 hard ceiling 为：

~~~text
H = Protected Tail target
~~~

模型 visible checkpoint 超过 H 时机械验证失败。实现不得静默 truncate。

## 14. Normalized Compactable Input

Compactor Request 只包含：

1. 固定 compactor system instructions；
2. Manual Compaction Request 的 focus（如果有）；
3. installed checkpoint 或 Legacy Compaction Summary（如果有）；
4. newly eligible closed prefix；
5. machine-generated evidence annotations。

它 MUST NOT 复制普通 Active Context 的 Fixed Envelope、Memory Pack、Evidence Pack、当前 Protected Tail 或
普通工具 schema。

### 14.1 机械预处理

构建 source 时 MUST：

- 移除历史 assistant thinking block；
- 物化全部 eligible Evidence reduction；
- 保留 user、assistant、toolResult 和 LLM-visible custom message 的角色边界；
- 保留 assistant toolCall 与 toolResult closure；
- 保留 error、truncation notice 和 source order；
- 把旧 Checkpoint 放在新 prefix 之前；
- 对每个可召回 tool result 标注 canonical Evidence Reference；
- 排除 UI-only CustomEntry、model change、thinking-level change 和不参与 LLM context 的 metadata。

### 14.2 可读序列化

Normalized Compactable Input MUST 使用稳定、可读的 role-delimited 文本，而不是 provider-specific payload。
相同 branch source 必须生成 byte-identical 输入。

用户文本和工具输出必须被明确包在 data delimiter 内，防止 compactor 把被压缩内容中的指令当成当前
compaction instructions。

image block 不得作为 base64 文本拼入序列化：

- compactor model 支持 image 时，保持原 image block，并用相邻 text annotation 标明 Evidence Reference；
- compactor model 不支持 image 时，用包含 MIME type 和 Evidence Reference 的机器 placeholder 替代 binary，
  并要求 Checkpoint 保留 reference 而不臆测视觉内容；
- image token cost 使用 Pi/provider 已知成本或保守固定 estimate 计入 C。

## 15. Compactor Request

### 15.1 模型与 provider

Checkpoint generation MUST 使用生成开始时主 Agent 当前的同一 provider、model 和 thinking level，但使用独立
context、独立 request 和独立 session identifier。

Runtime MUST 通过：

- ctx.model；
- ctx.modelRegistry.getProvider(model.provider)；
- ctx.modelRegistry.getApiKeyAndHeaders(model)

获得当前有效 provider runtime 和认证。不得通过全局默认 provider 绕开用户当前模型配置。

V1 没有单独 compactor model、便宜模型选择或 fallback model。

### 15.2 request 容量

provider request 的 maxTokens MUST 为：

~~~text
min(model.maxTokens, H + Compaction Generation Margin)
~~~

可见 CommonMark 仍必须小于或等于 H；额外 margin 只允许 provider-counted reasoning 和生成波动。

如果 model.maxTokens 无法给出任何合理的 Checkpoint 输出空间，Compaction Transaction 必须在发请求前失败。

### 15.3 cache 与 tools

Compactor Request：

- 不提供工具；
- 不加载普通 AGENTS.md、skills、Memory Pack 或 Evidence Pack；
- 使用固定 system prompt 和稳定 source serialization；
- cache retention 使用 none；
- 必须接受 AbortSignal；
- 不得把 compactor response 追加成普通 assistant message。

### 15.4 usage

成功 compactor response 的 provider usage MUST 写入最终 CompactionResult.usage，使 Pi 能把它计入 session
统计。Prepared candidate 在尚未安装时只在内存保存 usage。

## 16. Compaction Feasibility 与阈值

### 16.1 变量

~~~text
W = compactor model.contextWindow
B = W - Generation Headroom
H = clamp(floor(B × 10%), 20,000, 64,000)
R = 20,000
O = corrected estimate of fixed compactor prompt and serialization wrappers
M = clamp(floor(W × 0.5%), 1,024, 4,096)
C = corrected estimate of Normalized Compactable Input
L = max(32,768, floor(W × 10%))
~~~

其中：

- H 是 Checkpoint visible output hard ceiling；
- R 是 H 之外的 Compaction Generation Margin；
- O 必须实测当前固定 prompt，而不是写死一个猜测；
- M 只覆盖校准后的剩余误差；
- C 包括 rolling merge 时的 installed checkpoint；
- L 是 Preparation Lead。

### 16.2 Blocking Compaction Threshold

Checkpoint generation 可行的必要条件为：

~~~text
C + H + R + O + M <= W
~~~

因此：

~~~text
C_block = W - H - R - O - M
~~~

当 C 大于或等于 C_block 时，下一次普通 provider 请求必须进入 blocking recovery。

如果一次新 tool batch 使 C 直接跳过可行区间，而没有 compatible Prepared Checkpoint，Synchronous
Compaction MUST 在发请求前报告 infeasible 并 fail closed；不得丢弃 source 以强行生成。

### 16.3 Background Preparation Threshold

~~~text
C_prepare = max(0, C_block - L)
~~~

当 C 首次大于或等于 C_prepare，且没有 compatible preparing/ready candidate 时，Runtime MUST 启动一次
Prepared Compaction。

没有 Green、Yellow、Orange、Red 状态。status 只显示数值、preparing、ready、blocking 和 last failure。

### 16.4 参考值

忽略动态 O 时：

| W | B | H | M | C_block | L | C_prepare |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 200,000 | 180,000 | 20,000 | 1,024 | 158,976 | 32,768 | 126,208 |
| 1,000,000 | 980,000 | 64,000 | 4,096 | 911,904 | 100,000 | 811,904 |

实际阈值还必须减去 corrected O。

## 17. Prepared Compaction

### 17.1 Preparation Snapshot

Background preparation 开始时 MUST 冻结：

- runtimeGeneration；
- branchEpoch；
- current leaf lineage fingerprint；
- installed checkpoint ID 和内容 fingerprint；
- newly eligible prefix 的首尾 entry ID；
- firstKeptEntryId；
- compactable source fingerprint；
- allowed Evidence Reference set；
- schema/version；
- manual focus compatibility，普通 background 为 none；
- 使用的 model/provider 仅作为 provenance，不作为安装兼容条件。

Snapshot 之后的新 branch entries 继续追加到 raw tail，不加入本次 candidate。

### 17.2 后台执行

Prepared Compaction：

1. 每个 runtime 同时最多一个；
2. 使用 session-scoped AbortController，不绑定当前 run 的 signal；
3. 不阻塞当前普通 provider 请求；
4. TUI 不显示 spinner、toast 或 preparation failure；
5. 状态通过 /context-management-status 查看；
6. 成功后进入 ready；
7. 机械无效时直接丢弃，不立即 regeneration；
8. transport failure 记录 last preparation failure，但不终止当前 run；
9. session_shutdown 时必须 abort。

### 17.3 candidate 兼容性

安装前 MUST 重新验证：

- runtimeGeneration 未变化；
- branchEpoch 未变化；
- 当前 branch 仍包含完全相同的 covered prefix；
- firstKeptEntryId 仍 reachable；
- 中间没有另一个 CompactionEntry 改变 installed boundary；
- schema/version 仍兼容；
- Manual Compaction Focus 与 candidate 的 focus 相同；
- candidate 自身仍通过 Checkpoint Validation。

以下事件使 candidate 失效：

- session replacement；
- fork 或 tree navigation 改变 branch；
- intervening compaction；
- covered prefix 或 retained boundary 改变；
- runtime format version 改变。

active model change 本身不使 candidate 失效。

### 17.4 idle 安装

ready candidate 在以下最早时机请求安装：

- 首个 agent_settled；
- candidate 完成时 runtime 已 verified idle；
- manual/native compaction hook 正好请求同一兼容边界。

安装 MUST 调用 ctx.compact() 进入 Pi 原生 lifecycle，并在 session_before_compact 中返回已生成的同一 candidate；
不得重新生成。

由于 ctx.compact() 是 fire-and-forget，Runtime MUST 使用 onComplete/onError 跟踪 installing 状态。installing
期间不得再次触发安装。

## 18. Pre-Provider Compaction Barrier

context event 是 V1 的 Pre-Provider Compaction Barrier。它在完整上一 provider/tool batch 后、下一 provider
request 前执行。

Barrier MUST 按顺序：

1. 验证 current runtimeGeneration、branchEpoch 和 branch reachability；
2. 处理 Evidence Admission Candidate；
3. 物化所有 Budget Recovery 可用的 deterministic reduction；
4. 编译 candidate Active Context；
5. 计算 C、阈值和 Final Request Estimate；
6. 如果只跨过 C_prepare，启动 background preparation 后继续；
7. 如果达到 C_block 或 preflight 失败，执行 Budget Recovery；
8. 使用 Budget Recovery 返回的最终 projection；未触发 recovery 时使用步骤 4 的 projection；
9. 通过后返回 messages；
10. recovery 或最终校验失败则 ctx.abort() 并返回闭合安全投影。

Barrier 可以 await in-flight preparation 或完成 Synchronous Compaction，但不得调用 ctx.compact()，因为后者会
abort 当前 run。

## 19. Budget Recovery

Budget Recovery 固定为：

~~~text
1. 立即物化所有 eligible deterministic Evidence reduction
2. 重建 projection 并 preflight
3. 若已通过，继续同一 run
4. 否则安装 compatible ready Prepared Checkpoint；没有 ready 时 await compatible in-flight preparation
5. 若安装了 prepared candidate，使用它重建并 preflight；若已通过，继续同一 run
6. 若请求仍失败且存在 eligible compactable prefix，执行 Synchronous Compaction
7. 使用最新 checkpoint 重建并 preflight；若已通过，继续同一 run
8. 只有当前已不存在 eligible compactable prefix 时，才允许继续最后兜底
9. 若本轮自动 Memory Pack 非空，整包抑制该 Pack
10. 重建 projection 并执行最终 preflight
11. 通过则继续同一 run；失败则 fail closed
~~~

步骤 1 绕过 Net Savings Gate 和普通 epoch 延迟。

步骤 4 的 candidate 若失效、失败或无法安装，Runtime MUST 丢弃它并进入步骤 6，不能把 prepared failure 当作
同步压缩已经完成。prepared candidate 安装后若新追加历史留下了额外 eligible prefix，步骤 6 MUST 把当前
installed/pending checkpoint 与该 prefix 做 Rolling Checkpoint Merge。只有成功同步压缩后已无更多 eligible
prefix，或一开始就没有可压缩旧前缀，步骤 8 才成立。同步压缩生成或验证失败仍按 Rejected Compaction fail
closed，不能靠移除 Memory Pack 掩盖 compactor failure。

步骤 9 是压缩空间耗尽后的最后一次可选输入回收，只影响当前 agent run：

- 不删除、改写或降权 Repository Memory；
- 不改变已经冻结的 Pack 选择结果，只是不再把整包投影给模型；
- 不逐条淘汰、不重新排名，也不缩成更小的临时 Pack；
- 不移除或截断 Explicit Evidence Read 已准入并固定的 Evidence Pack；
- 下一次普通用户请求重新构建新的 Memory Pack，memoryPackSuppressed 从 false 开始。

若没有 Memory Pack，或移除整个 Pack 后仍超预算，则不得再删减 Fixed Envelope、Checkpoint、Protected Tail、
当前 active run 或 Evidence Pack；请求 fail closed。

### 19.1 await prepared candidate

只有 in-flight candidate 的 Snapshot 仍然覆盖当前所需旧 prefix 时才能 await。等待期间必须响应当前 run
AbortSignal 和 session shutdown。

candidate 只覆盖冻结 prefix；等待期间新增的 closed messages 留在 raw tail，不使 candidate 失效。

### 19.2 Synchronous Compaction

Synchronous Compaction 与 Prepared Compaction 使用完全相同的：

- source selection；
- prompt；
- current provider/model；
- budgets；
- validation；
- retry；
- checkpoint representation。

区别仅在于它阻塞下一 provider 请求，并在验证成功后立即成为当前内存 projection 的 Checkpoint。

### 19.3 blocking UI

在 TUI 中，blocking compaction MUST 使用 Pi 可用的 working message 明确显示正在恢复上下文；成功后恢复默认
working message。失败必须通知简短原因。

RPC、json 和 print 模式不得等待 UI；它们执行相同 barrier，并通过正常错误/终止语义暴露失败。

## 20. Checkpoint Validation 与 retry

### 20.1 机械验证

candidate 只有同时满足以下条件才有效：

1. provider response 正常完整结束；
2. 提取到非空 CommonMark text；
3. visible text estimate 小于或等于 H；
4. response 没有以 length 或 error 结束；
5. 每个符合 canonical pattern 的 cm-evidence:v1 reference 都能在 allowed set 中解析；
6. summary 不包含 provider thinking block；
7. firstKeptEntryId、coverage 和 source fingerprint 与 Snapshot 相符；
8. candidate metadata 能按 v1 schema 完整序列化。

Runtime MUST NOT 判断 heading、段落顺序、语义完整度、重要性或事实质量。

### 20.2 background invalid result

background candidate 验证失败时：

- 丢弃 candidate；
- 记录短机械失败原因；
- 不立即 regeneration；
- 普通 run 继续；
- 后续跨 blocking threshold 时可同步再生成。

### 20.3 manual 和 blocking invalid result

Manual Compaction Request 或 Synchronous Compaction 首次得到机械无效 candidate 时，MUST 恰好 regeneration
一次。第二次 prompt 应附加第一次的机械失败原因，不得要求模型自评语义。

第二次仍无效则 Rejected Compaction。

provider transport retry 与这一次 regeneration 独立，不消耗 regeneration 次数。

### 20.4 provider transport retry

Compactor 调用 MUST 使用 Pi 公开的 completeSummarization retry 入口或等价的 provider-owned streamSimple
retry wrapper，传递 AbortSignal。确定性 auth、capacity、validation error 和 abort 不得按 transport failure
重试。

V1 对每次 compactor provider 请求设置 300,000 ms timeout，并关闭 provider SDK 内层 retry；外层复用 Pi 的
transient-error 分类，最多 retry 3 次，base delay 为 2,000 ms 的指数退避。transport retry 不改变 source、
session identifier 或机械 regeneration 计数。

## 21. Pending Checkpoint Commit

### 21.1 创建

活动 run 内的 Synchronous Compaction 或 ready candidate installation 不能调用 ctx.compact()。验证成功后，
Runtime MUST：

1. 把 candidate 标记为 Pending Checkpoint Commit；
2. 立即在当前及后续 context projection 中使用它；
3. 保留 Raw Evidence 和 session branch 不变；
4. 继续同一 agent loop。

### 21.2 投影

pending checkpoint 在 Active Context 中与 installed checkpoint 语义相同：

- 替换 covered prefix；
- 从 firstKeptEntryId 保留 raw tail；
- 参与下一次 Rolling Checkpoint Merge；
- status 明确显示 pending durable commit。

### 21.3 提交

Runtime 在首个可用的 native compaction lifecycle 中返回完全相同的：

- summary；
- firstKeptEntryId；
- tokensBefore；
- usage；
- versioned details。

不得为持久化重新调用模型。

通常在 agent_settled 调用 ctx.compact()。如果 Pi 在 settled 前因 threshold/overflow 主动触发
session_before_compact，则该 hook MAY 直接提交 pending candidate，并取消后续重复提交。

### 21.4 提交失败

append 或 native lifecycle 失败时：

- 报告 checkpoint 只在内存生效、尚未 durable；
- 不声称已经持久化；
- 当前 runtime MAY 继续使用仍有效的 pending projection；
- session_shutdown 丢弃 pending；
- Raw Evidence 保持完整，恢复后需要时重新 compact。

## 22. 原生 compaction 完全接管

### 22.1 session_before_compact

对 manual、threshold、overflow 每一种 reason，handler 都必须：

1. 捕获全部内部错误；
2. 优先提交兼容的 Pending Checkpoint Commit；
3. 其次复用或 await compatible Prepared Checkpoint；
4. 否则同步运行相同 Compaction Transaction；
5. 成功返回 extension CompactionResult；
6. 失败返回 cancel: true 并报告原因。

handler MUST NOT 返回 undefined。Pi 默认摘要器在本 extension 启用时永远不得被调用。

### 22.2 /compact [focus]

用户原生 /compact 命令保持不变。customInstructions 作为 Compaction Focus：

- 只约束本次生成需要额外保留的内容；
- 不改变 V1 budgets、validation 或持久化 schema；
- 与普通 background candidate focus 不兼容时不得复用；
- 不永久写入 Runtime 设置；
- 已有 compatible focused candidate 可以复用。

### 22.3 Pi host 职责

Pi 继续负责：

- slash command dispatch；
- CompactionEntry append；
- branch parent/leaf 关系；
- session context rebuild；
- session_compact event；
- compaction UI lifecycle；
- usage 汇总。

这些 host 职责不构成第二个 compaction owner。

## 23. Checkpoint Installation Entry

### 23.1 durable carrier

唯一 durable Checkpoint carrier 是 extension-authored native Pi CompactionEntry：

- summary 保存完整 CommonMark Checkpoint；
- firstKeptEntryId 保存 raw tail 边界；
- tokensBefore 保存生成前完整 projection estimate；
- usage 保存 compactor usage；
- details 保存 v1 machine metadata。

不得 append 额外 CustomEntry 作为第二份 checkpoint。

### 23.2 details schema

details 至少包含：

~~~ts
interface ContextManagementCompactionDetailsV1 {
  type: "context_management.compaction.details.v1";
  schemaVersion: 1;
  checkpointId: string;
  coveredThroughEntryId: string;
  firstKeptEntryId: string;
  sourceFingerprint: string;
  checkpointFingerprint: string;
  createdAt: string;
  evidenceReferences: string[];
}
~~~

details MUST NOT 包含：

- Raw Evidence payload；
- Memory Record；
- compactor prompt；
- credentials、headers 或 env；
- Fixed Envelope；
- model thinking；
- 完整 Normalized Compactable Input。

### 23.3 restore

session_start、resume、reload、fork 和 tree navigation 后，Runtime 使用当前 branch 上最新 reachable 且通过
机械 schema 校验的 details 恢复 installed checkpoint。

details 损坏时不得信任 coverage。该 CompactionEntry 作为 Legacy Compaction Summary 处理，而不是扫描私有
session 文件修复。

### 23.4 session_compact

session_compact 后 Runtime MUST：

1. 从 event.compactionEntry 重新读取实际 durable summary、boundary 和 details；
2. 只有 details 通过 v1 mechanical validation 时才标记 installed；
3. 清除已提交的 Pending Checkpoint Commit 和相关 Prepared candidate；
4. 递增 branchEpoch；
5. 重建 projection 和 evidence reachability；
6. 对未知或损坏 details 使用 Legacy Compaction Summary 规则。

## 24. Legacy Compaction Summary

如果最新 reachable CompactionEntry 没有本 extension v1 details：

1. 把其 summary 作为 opaque installed prefix；
2. 使用其原生 firstKeptEntryId；
3. 不声称它符合当前 checkpoint prompt；
4. 不立即读取并重新压缩全部 covered history；
5. 不改写旧 entry；
6. 下一次正常 Rolling Checkpoint Merge 把 legacy summary 与 newly eligible prefix 一起生成当前格式
   Checkpoint。

在第一次 merge 前，Legacy Summary 和 Pi 保留的 raw tail 直接参与 Active Context。

## 25. Model、branch 与 tree 变化

### 25.1 model_select

model change 后：

- 下一次普通请求立刻使用新 W、B、T、H、阈值和 Fixed Envelope estimate；
- 已 installed/pending Checkpoint 保持有效；
- 已 ready Prepared Checkpoint 不因 model change 单独失效；
- 新的 compactor generation 使用变化后的当前模型；
- estimator calibration 按 provider/model 分桶。

如果新模型窗口无法容纳当前 projection，下一 context barrier 立即 Budget Recovery。

### 25.2 fork

Pi fork 后新 runtime：

- 通过复制的 entry ID 恢复 reachable installed checkpoint 和 Evidence Reference；
- 不继承旧 runtime 的 Prepared candidate、Pack 或 calibration；
- Repository Identity 按目标 cwd 重新解析；
- 同一 Git common dir 的 worktree 共享 Repository Memory。

### 25.3 tree navigation

tree navigation 改变 leaf 后 MUST：

- discard Prepared candidate、Pending Checkpoint Commit 和 Packs；
- 递增 branchEpoch，并重建 latest CompactionEntry 和 evidence index；
- 不把离开 branch 的 evidence 视为 applicable；
- 不修改 Repository Memory。

Pi branch_summary entry 作为普通 LLM-visible历史，可以进入 Protected Tail 并在以后被 rolling merge。

## 26. Repository Identity

### 26.1 Git repository

Runtime 在 session_start 以 ctx.cwd 执行只读 Git discovery：

~~~text
git rev-parse --path-format=absolute --git-common-dir
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
~~~

每条命令必须有 timeout 并响应 session AbortSignal。只有第一条成功且返回存在目录时，才按 Git repository
处理。

identity source 为 git common dir 的 realpath。Repository Key 为：

~~~text
git-<lowercase SHA-256 of UTF-8 canonical common-dir path>
~~~

因此：

- 同一 clone 的 worktrees 共享 memory；
- 独立 clone 使用不同 memory；
- remote URL 不参与 identity；
- repository 移动到新 canonical path 后形成新 identity；
- symlink alias 通过 realpath 合并。

### 26.2 non-Git project

Git discovery 失败时，identity source 为 ctx.cwd 的 realpath：

~~~text
dir-<lowercase SHA-256 of UTF-8 canonical cwd path>
~~~

V1 不向项目目录写 UUID，也不猜测非 Git 项目的更高层根目录。

### 26.3 store path

Repository Memory 唯一文件为：

~~~text
<getAgentDir()>/context-management/repositories/<repository-key>/memory.json
~~~

extension 不得向自身源码、安装目录或项目目录写 runtime state。

## 27. Memory store 格式

### 27.1 JSON envelope

memory.json 是唯一持久化事实源。格式为 UTF-8 JSON：

~~~json
{
  "schemaVersion": 1,
  "repository": {
    "key": "git-...",
    "identityKind": "git-common-dir",
    "canonicalPath": "/absolute/path/to/.git",
    "createdAt": "2026-08-16T00:00:00.000Z"
  },
  "records": [
    {
      "id": "mem_...",
      "kind": "decision",
      "title": "Use one rolling checkpoint",
      "summary": "The runtime maintains one checkpoint and merges new eligible history into it.",
      "contentMarkdown": "## Decision\n\n...",
      "scope": {
        "kind": "repository",
        "paths": ["src/context/"]
      },
      "origin": {
        "sessionId": "...",
        "entryId": "...",
        "gitBranch": "feat/example",
        "gitHead": "...",
        "trigger": "primary-agent-tool"
      },
      "createdAt": "2026-08-16T00:00:00.000Z",
      "fingerprint": "sha256:...",
      "supersedes": [],
      "supersededBy": null
    }
  ]
}
~~~

JSON field order MUST 稳定，文件末尾保留一个 LF，便于人工检查和确定性测试。

canonicalPath 是 machine-local inspection metadata，不进入 Memory Pack 或模型工具输出。

### 27.2 Memory Record kind

kind 只能为：

~~~text
decision
verified-change
learning
milestone
~~~

含义：

- decision：用户或项目已选择的方向；
- verified-change：已经完成且有验证依据的仓库变化；
- learning：未来仍可复用的仓库知识；
- milestone：已完成的持久成果。

不存在 progress、todo、next-step、working-state 或 arbitrary kind。

### 27.3 model-authored fields

模型负责提供：

- kind；
- title；
- summary；
- contentMarkdown；
- optional scope kind；
- optional paths；
- optional supersedes IDs。

Runtime 负责生成或校验：

- schemaVersion；
- repository metadata；
- ID；
- origin；
- timestamps；
- fingerprint；
- branch name；
- Git HEAD；
- supersededBy 反向关系；
- byte/token limits。

contentMarkdown 没有 required headings 或 semantic JSON schema。普通 CommonMark 的 heading、list、emphasis、
table、link 和 code fence 均允许。

### 27.4 mechanical validation

成功写入要求：

- title trim 后非空；
- summary trim 后非空且 estimate 不超过 256 tokens；
- contentMarkdown trim 后非空；
- contentMarkdown UTF-8 byte length 不超过 10,240；
- kind 有效；
- scope 有效；
- path 是项目根内的规范化 repository-relative path 或目录 prefix；
- supersedes 中每个 ID 存在、尚未 superseded 且不等于新 ID；
- 所有字符串是合法 Unicode 且不含 NUL；
- 完整序列化文件不超过 8 MiB。

Runtime 不校验 Markdown heading、论证质量、事实正确性、重要性或写作风格。

### 27.5 scope

scope 结构为：

~~~ts
type MemoryScope =
  | { kind: "repository"; paths: string[] }
  | { kind: "branch"; branch: string; paths: string[] };
~~~

模型省略 scope 时使用 repository 和空 paths。

选择 branch 时，Runtime MUST 填入写入时的当前 Git branch；模型不能指定任意 branch 名。detached HEAD 或
non-Git project 不允许 branch scope，并返回明确错误。

paths 为空表示不限制路径。paths 只约束自动 applicability 和检索，不改变 store ownership。

### 27.6 fingerprint 与 idempotency

Memory fingerprint 输入固定为：

- kind；
- NFKC + LF-normalized title；
- NFKC + LF-normalized summary；
- LF-normalized contentMarkdown；
- canonical scope；
- sorted unique supersedes IDs。

正文不做 trim、空白折叠或 Markdown 重排。

同一 active record fingerprint 已存在时，Memory Write MUST 返回现有 record ID，不写新记录、不更新时间。
语义相似不能触发 dedup。

### 27.7 ID

ID MUST 使用：

~~~text
mem_<uuidv7>
~~~

ID 不含 title、path、branch 或 repository key。

## 28. Memory 文件一致性与并发

### 28.1 读取

每次 session_start 首次读取和每次 mutation 的 read-modify-write 都必须完整校验：

- regular file；
- 不跟随意外 symlink；
- byte size 不超过 8 MiB；
- JSON 可解析；
- schemaVersion 恰好为 1；
- repository key 与目录一致；
- records 机械字段有效；
- ID 唯一；
- supersession 关系无自环、无悬空引用。

文件不存在表示 empty store，不是错误。

### 28.2 Unavailable Memory Store

存在但不能安全解析或校验的文件：

- 原样保留；
- 禁用该 repository 的 activation、search、read、write 和 forget；
- /context-management-status 显示 unavailable 和 exact path；
- 首次相关操作报告明确原因；
- Context Runtime 继续工作；
- 不自动备份、覆盖、迁移或“修复”。

### 28.3 进程内队列

所有 memory.json mutation MUST 以 absolute target path 调用 withFileMutationQueue()，并把完整
read-validate-modify-serialize-write 放在 callback 内。

### 28.4 跨进程锁

因为同一 Repository Memory 可被多个 Pi 进程和 worktree 同时写入，进程内队列不足以避免 lost update。
V1 MUST 使用 Node 标准库实现同目录 advisory lock，不增加 runtime dependency。

锁目录：

~~~text
memory.json.lock
~~~

获取规则：

1. 用 mkdir 原子创建 lock directory；
2. 写入包含 PID、hostname、nonce、createdAt、heartbeatAt 的 owner.json；
3. 持锁期间每 5 秒原子更新 heartbeat；
4. 获取失败时以 25–100ms jitter 重试，最长 5 秒，并响应 AbortSignal；
5. heartbeat 在 2 分钟内视为 active，不得抢锁；
6. 超过 2 分钟时，只有 owner hostname 等于当前 host 且 process.kill(pid, 0) 明确返回 ESRCH，才能把整个 lock
   directory 原子 rename 为唯一 stale path 后重新竞争；
7. EPERM、未知 host、owner 损坏或状态不确定时不得抢锁，写操作明确失败；
8. stale lock 只包含 extension 自己的 owner metadata；清理失败时保留并报告，不扩大删除目标；
9. 释放前验证 nonce，依次 unlink owner.json、rmdir exact lock directory；
10. 任一步失败不得继续执行更强或更宽的删除。

读操作不需要锁，但 mutation 必须在锁内重新读取最新文件，不能使用 activation 时的旧快照写回。

### 28.5 原子写

持锁且通过进程内 queue 后：

1. 在 memory.json 同目录创建权限 0600 的唯一 temp file；
2. 写入完整 bytes；
3. fsync temp file；
4. 再次验证 byte limit；
5. rename 覆盖 memory.json；
6. fsync parent directory；
7. 清理 exact temp file；
8. 更新 in-memory Derived Memory Index。

`rename` 是写入提交点。失败语义分为：

- `rename` 之前任一步失败：保留原 memory.json，返回“未写入”，并清理 exact temp file；
- `rename` 成功：新 memory.json 已生效；后续 parent-directory fsync 失败时不得谎报“未写入”或尝试不可靠的
  rollback。Runtime 必须重新读取并完整校验新文件，更新 in-memory Derived Memory Index，并把操作作为成功返回，
  同时给出明确 warning：写入已生效，但异常崩溃或断电后的目录项持久性未经确认。

任一可观察结果都不得留下部分 JSON。提交点之前的失败不得改变 memory.json；提交点之后的结果以重新读取到的
memory.json 为准。

### 28.6 8 MiB failure

若候选文件超过 8 MiB，写入原子失败。错误必须包含：

- 当前文件 byte size；
- 候选 byte size；
- 8 MiB 上限；
- exact memory.json path；
- “没有写入或删除任何 record”；
- 指引用户先用 memory search/read 或直接查看文件，明确指定要 forget 的 obsolete record ID 后再重试。

不得自动淘汰最旧、最低分、superseded 或任何其他 record。

## 29. Memory authoring

### 29.1 主 Agent 信任模型

context-management MUST 通过工具描述和 prompt guideline 明确告诉主 Agent：

- 用户明确要求记住时应写；
- 即使用户没有明确要求，只要模型判断是长期有用的 decision、verified change、learning 或 milestone，也可以
  主动写；
- 不把当前任务进度、临时计划、下一步或容易从仓库直接重建的噪音写入；
- 不保存 credentials、secret 或无关个人信息；
- correction 应写新 record 并显式 supersede，不能静默改旧正文；
- forget 只响应用户明确移除请求。

该指导是正常、可信的工具使用契约，不降级成 low-priority hint。

V1 没有后台 transcript observer，不在 agent_settled 自动调用模型判断记忆。

### 29.2 context_management_memory_write

参数：

~~~ts
{
  kind: "decision" | "verified-change" | "learning" | "milestone";
  title: string;
  summary: string;
  contentMarkdown: string;
  scope?: {
    kind?: "repository" | "branch";
    paths?: string[];
  };
  supersedes?: string[];
}
~~~

工具 MUST：

1. 解析当前 Repository Identity；
2. 校验 author fields；
3. 自动附加 current session/entry/Git provenance；
4. 执行 exact idempotency；
5. 原子创建新 record，并在同一 transaction 设置旧 records 的 supersededBy；
6. 返回新建或复用的 ID、kind、title、scope 和 byte sizes；
7. 不把完整 contentMarkdown 重复放入 tool result。

### 29.3 supersession

Memory correction 通过新 record 的 supersedes IDs 表达。成功 transaction 后：

- 新 record.supersedes 保存 sorted IDs；
- 每个旧 record.supersededBy 指向新 ID；
- 旧 record 保留在 JSON 供人工 audit；
- 自动 activation、model search 和 model read 排除 superseded record；
- supersession 不等于 physical deletion。

V1 不支持取消 supersession 或建立多层 active fork；一个 active record 被 supersede 后不能再被另一个新
record 二次 supersede。

### 29.4 context_management_memory_forget

参数：

~~~ts
{
  id: string;
}
~~~

只有当前用户输入或 steering 明确要求移除该 memory 时，主 Agent 才可以调用。

Runtime 不做自然语言意图分类；该边界由工具 contract 和主 Agent 遵守。工具执行时：

1. 接受当前 repository 中任意 exact record ID，包括 inactive 或 superseded record；
2. 如果其他 record 的 supersedes/supersededBy 引用它，整个操作失败并列出关联 ID，要求用户先明确处理关系；
3. 原子物理删除该 record；
4. 不写 tombstone；
5. 返回已删除 ID 和 title；
6. 不支持 bulk、query、glob 或 all。

Agent 自主 judgment 不能调用 forget。

## 30. Derived Memory Index

memory.json 是唯一 source of truth。Derived Memory Index：

- session runtime 内存中构建；
- 成功 mutation 后增量或完整重建；
- 不写磁盘；
- reload 可以丢弃重建；
- 不保存 retrieval score；
- 不保存 TTL、lastAccessedAt 或 popularity。

### 30.1 跨进程 refresh

Runtime 必须保存最近一次成功加载的 file identity：

~~~ts
{
  exists: boolean;
  dev?: bigint;
  ino?: bigint;
  size?: bigint;
  mtimeNs?: bigint;
}
~~~

在每次 before_agent_start 自动 activation，以及 memory search/read/write/forget 前，先 lstat memory.json。identity
变化时完整重读、校验并重建 Derived Memory Index；未变化时复用内存索引。

这使另一个 Pi 进程的成功原子写在当前 session 的下一次用户 run 可见，不需要 watcher 或 polling timer。
mutation 获取跨进程锁后仍必须无条件重读，不能只依赖 identity fast path。

### 30.2 lexical normalization

检索 normalization 固定为：

1. Unicode NFKC；
2. locale-independent lower case；
3. path separator 统一为 /；
4. ASCII/Latin identifier 按非字母数字、snake_case、kebab-case 和 camelCase 边界切分；
5. 保留完整 path、symbol 和 command literal 作为 exact token；
6. 连续 Han 字符同时生成单字 token 和相邻 bigram；
7. 其他 Unicode letter/number run 作为 token；
8. 不 stemming，不使用语言 stop-word list。

### 30.3 indexed fields

每个 active record 索引：

- scope.paths；
- title；
- summary；
- contentMarkdown；
- CommonMark inline/fenced code 中的 literal；
- kind；
- ID 仅供 exact lookup，不参加 BM25。

## 31. Automatic Memory Activation

### 31.1 activation query

每次普通 user run 在 before_agent_start 构造 query：

- 当前用户 prompt；
- 从 prompt 中机械提取的显式 repository-relative/absolute path；
- backtick code literal 和 identifier-like symbol；
- slash command、shell command 首 token 和明确命令名。

Protected Tail、上一 Checkpoint 和完整历史不得作为 query text。

上一 run Memory Pack 的 record IDs 只形成 continuity candidate，不拼入 query。

### 31.2 applicability filter

候选必须：

- schema valid；
- non-superseded；
- repository identity 匹配；
- repository scope，或 branch scope 与当前 branch 完全相同；
- paths 为空，或当前 query 的显式 path 至少一个位于该 path/prefix 内。

当 record 有 paths 而当前 query 没有显式 path 时，它不参与 automatic activation，但仍可通过显式
memory search 在相关 query 下发现。

V1 不根据 Git merge 状态自动把 branch memory 升级为 repository memory，不根据 HEAD 年龄使 record 失效。

### 31.3 ranking groups

过滤后按以下组依次排序：

1. 当前 query 与 scope path、code symbol 或 command literal exact match；
2. title 或 summary 有 lexical match；
3. 只有 contentMarkdown 有 lexical match；
4. 上一 Memory Pack 中存在、但当前没有 lexical match 的 continuity record。

一个 record 只进入最高匹配组。

### 31.4 BM25

组 1–3 内使用当前 candidate set 的 BM25：

~~~text
k1 = 1.2
b  = 0.75
~~~

索引文档以 title terms 重复 3 次、summary terms 重复 2 次、body terms 1 次构成。scope path、code literal 和
command exact match 只决定 group，不额外持久化 boost。

同组排序：

1. BM25 descending；
2. preceding Memory Pack membership true first；
3. createdAt descending；
4. ID ascending。

组 4 按 createdAt descending、ID ascending。

没有 time decay、TTL 或 persistent score。

### 31.5 Memory Pack assembly

Memory Pack limit 为 8,192 estimated tokens。按 ranking 顺序逐条：

1. 完整表示能放下则 inline full record；
2. 完整表示放不下则尝试 Memory Stub；
3. 连 Stub 也放不下才 omit；
4. 继续尝试后续 candidate，避免一个大 record 阻塞所有更小 record；
5. Pack 组装完成后整体 estimate 必须不超过 limit。

Pack 在该 agent run 内 frozen；显式 memory search/read 不修改它。唯一例外是完整 Budget Recovery 已完成同步压缩
但仍超预算时，Runtime 把整个自动 Pack 标记为 suppressed 并在该 run 剩余时间停止投影。原选择结果保持冻结，
不得部分淘汰或重新排名；下一 agent run 正常重新构建。

### 31.6 full representation

完整 Memory Record 投影包含：

~~~text
## Memory <id>: <title>

- Kind: <kind>
- Scope: <scope>
- Paths: <paths or none>
- Summary: <summary>

<contentMarkdown>
~~~

不包含 canonical store path、fingerprint、origin session ID 或 superseded records。

### 31.7 Memory Stub

Stub 包含：

~~~text
## Memory <id>: <title>

- Kind: <kind>
- Scope: <scope>
- Paths: <paths or none>
- Summary: <summary>
- Full body: <UTF-8 bytes> bytes
- Read: use context_management_memory_read with this exact ID
~~~

Stub 不包含正文 excerpt，不生成第二个摘要。

## 32. Explicit memory tools

### 32.1 context_management_memory_search

参数：

~~~ts
{
  query: string;
}
~~~

search MUST：

- 要求非空 query；
- 使用相同 applicability、normalization、groups 和 BM25；
- 只返回 Memory Stub；
- 最多 10 stubs；
- 总输出最多 4,096 estimated tokens；
- 先触及任一上限即停止；
- 不改变 Memory Pack 或 score；
- 不返回 superseded/inactive record；
- 不提供 dump-all 空查询。

### 32.2 context_management_memory_read

参数：

~~~ts
{
  id: string;
}
~~~

read MUST：

- 只接受 exact ID；
- 要求 record 当前 applicable 且 non-superseded；
- 返回 title、summary、完整 contentMarkdown、kind、scope、paths、createdAt 和 supersession metadata；
- 不做 read-time truncation；
- 不把 canonical store path、fingerprint 或 unrelated records 暴露给模型；
- 不改变 Memory Pack。

因为成功写入的 contentMarkdown 最多 10 KiB，完整 read 始终受 write-time bound。

## 33. /context-management-status

### 33.1 契约

该命令是用户可见、read-only、非持久操作。它 MUST NOT：

- 触发 compaction；
- 安装 Prepared Checkpoint；
- 开始新 Projection Epoch；
- 重建 Memory Pack；
- admission evidence；
- 写、forget 或 supersede memory；
- 追加 session entry；
- 注册等价 LLM tool。

命令在 busy 时可以立即读取最后一个一致 runtime snapshot，不等待 agent_settled。

### 33.2 输出

输出至少包括：

- current provider/model；
- model context window W；
- Generation Headroom G；
- Safe Input Budget B；
- estimator calibration；
- 当前完整 Final Request Estimate；
- remaining safe input；
- Fixed Envelope estimate；
- Checkpoint estimate 和 coverage；
- Protected Tail estimate、target 和实际 entry range；
- Memory Pack occupancy、record/stub count 和本轮 suppressed 状态；
- Evidence Pack occupancy、item/candidate count；
- current run input estimate（存在时）；
- projection epoch；
- cumulative duplicate/supersession count 和 estimated savings；
- background state：idle、preparing、ready、installing 或 last failure；
- blocking state；
- pending durable commit；
- Repository Identity kind、memory record count、serialized bytes 和 availability；
- memory.json exact path，仅对用户命令显示。

### 33.3 保密

status MUST NOT 输出：

- Raw Evidence；
- Memory Content；
- Memory Summary；
- system prompt text；
- tool schema 正文；
- compactor prompt；
- provider payload；
- fingerprint；
- auth、headers、env 或 credentials。

### 33.4 示例形状

具体排版可以按终端宽度调整，但语义应接近：

~~~text
Context management
  Model: anthropic/...
  Window: 200,000
  Safe input: 180,000   Headroom: 20,000
  Projection: 112,430  Remaining: 67,570
  Fixed: ...  Checkpoint: ...  Tail: ...  Memory: ...  Evidence: ...
  Checkpoint: ready / pending commit / none
  Preparation: preparing C=... threshold=...
  Reductions: ... results, ... estimated tokens saved
  Memory: 24 records, 182,110 / 8,388,608 bytes
~~~

## 34. 错误与可观察行为

### 34.1 错误分类

至少区分：

~~~text
context estimate failure
context cannot fit
compaction infeasible
compactor auth failure
compactor transport failure
checkpoint validation failure
checkpoint persistence failure
evidence reference invalid
evidence not reachable
evidence admission failure
memory unavailable
memory validation failure
memory lock timeout
memory content too large
memory store too large
memory supersession conflict
memory forget conflict
operation aborted
~~~

错误类型 MUST 带 context_management 前缀或稳定 code，测试不得依赖 provider 原始字符串。

### 34.2 background errors

Background Preparation error：

- 不产生 unsolicited notification；
- 记录 last failure code 和时间；
- status 可见；
- 不改变当前 projection；
- 不自动 fallback。

### 34.3 manual errors

用户 /compact 失败必须通过 Pi compaction UI 和简短 notification 可见。handler 返回 cancel: true，防止默认
compactor。

### 34.4 blocking errors

blocking failure 必须：

1. 清除 working message；
2. 给出失败阶段和可操作原因；
3. 调用 ctx.abort()；
4. 确保下一 provider request 未发送；
5. 保留 Session Record、installed durable checkpoint 和 Repository Memory；
6. 不发送由 extension 伪造的普通 assistant answer。

### 34.5 Memory error

Memory subsystem error 只禁用或失败该次 memory 操作，不得让普通 Context Runtime 请求失败，除非一个已经
加入当前 Memory Pack 的 in-memory representation 自身破坏 projection invariant；此时丢弃整个 Memory Pack
并重新 preflight，不丢弃 session history。

这条错误隔离与 Budget Recovery 的超预算整包抑制是两条独立路径；两者都只抑制当前 agent run 的自动 Memory
Pack，不改写 memory.json。

## 35. 模式支持

### 35.1 TUI

支持全部功能：

- status command；
- manual /compact focus；
- background state inspection；
- blocking working message；
- notification；
- memory/evidence tools。

### 35.2 RPC

支持 Context Compiler、compaction、memory/evidence tools 和通过 RPC 可调用的命令。不得依赖终端组件。

### 35.3 json 与 print

支持普通自动 projection、background preparation、blocking recovery 和 tools。UI 方法可能无显示，Runtime
不得等待确认、selector、editor 或 terminal input。

### 35.4 headless failure

headless blocking failure 通过当前 run 的 abort/error 语义返回，并保留可机读的稳定 error code。不得只依赖
toast。

## 36. Abort、race 与资源

### 36.1 AbortSignal

以下长操作必须接受并向下传递 AbortSignal：

- Git identity discovery；
- background/synchronous compactor request；
- provider transport retry wait；
- evidence full-content assembly；
- memory lock acquisition；
- memory read/write/fsync。

用户 abort 当前 run 时：

- 当前 blocking compaction abort；
- 当前 evidence admission abort；
- session-scoped background preparation MAY 继续，除非 runtime shutdown；
- 不安装部分 candidate。

### 36.2 generation guard

所有 async callback 在改变 state 前必须验证：

- runtimeGeneration；
- branchEpoch；
- 涉及 run-scoped Pack 时的 runGeneration；
- coordinator 仍 active；
- operation nonce；
- relevant candidate/lock owner identity。

stale callback 只清理自身资源，不更新新 runtime。

### 36.3 single-flight

每个 runtime：

- 最多一个 background compactor；
- 最多一个 blocking compactor；
- 最多一个 native checkpoint installation；
- memory mutation 由 per-file queue 和 cross-process lock 串行；
- evidence admission 在 context barrier 内串行。

manual compaction 到达时，如果 blocking compactor 已运行，必须共享兼容 promise 或等待其结束；不得对相同 source
并发生成两个 candidate。

### 36.4 无长期资源

extension factory 不启动 process、timer、watcher 或 model request。

session_start 之后按需创建的 heartbeat/timer 必须：

- 只在实际 lock 或 operation 生命周期存在；
- unref（适用时）；
- finally 清理；
- session_shutdown 幂等清理。

## 37. 安全与权限

### 37.1 文件

Runtime 只写：

- Pi 原生 session 文件，由 Pi 自己 append CompactionEntry；
- getAgentDir() 下的 context-management repository memory；
- memory atomic-write temp 和 lock metadata。

不写项目目录，不自动写 Authority Source。

### 37.2 网络

唯一网络调用是使用当前已配置 provider/model 生成 Checkpoint。Memory retrieval、Evidence reduction、ranking 和
token estimate 全部本地执行。

README MUST 说明 background preparation 会产生一次额外模型请求及相应费用。

### 37.3 凭据

Runtime 只通过 ModelRegistry 获取 request auth 并直接传给 Provider；不得记录、显示或持久化 apiKey、OAuth
credential、headers 或 provider env。

### 37.4 memory 内容

工具 prompt 应阻止主动保存 secret，但 Runtime 不做不可靠的 secret classifier。memory.json 是 machine-local
明文文件；README 必须说明 exact location、内容、权限、清理方式和不应存储凭据。

创建目录和文件 SHOULD 使用当前用户私有权限；memory.json 和 temp file MUST 为 0600，目录 SHOULD 为 0700。

## 38. 建议实现结构

实现 SHOULD 保持模块职责明确，至少等价于：

~~~text
extensions/context-management/
├── index.ts
├── src/
│   ├── index.ts
│   ├── constants.ts
│   ├── runtime/
│   │   ├── coordinator.ts
│   │   ├── compiler.ts
│   │   ├── budget.ts
│   │   ├── branch.ts
│   │   └── status.ts
│   ├── evidence/
│   │   ├── references.ts
│   │   ├── reducers.ts
│   │   ├── projection.ts
│   │   └── tool.ts
│   ├── compaction/
│   │   ├── source.ts
│   │   ├── prompt.ts
│   │   ├── generator.ts
│   │   ├── validation.ts
│   │   └── lifecycle.ts
│   └── memory/
│       ├── identity.ts
│       ├── schema.ts
│       ├── store.ts
│       ├── lock.ts
│       ├── index.ts
│       ├── retrieval.ts
│       └── tools.ts
├── test/
├── README.md
├── package.json
├── tsconfig.json
└── biome.json
~~~

文件名可局部调整，但：

- domain/pure functions 不得依赖 UI；
- provider generation 与 source selection 分离；
- memory persistence 与 retrieval ranking 分离；
- tool handler 不直接复制 coordinator 内部 mutable state；
- index.ts 只做注册和 wiring，不堆积算法。

## 39. Package 与依赖

package MUST：

- ESM；
- private true；
- Node >=22.19.0；
- pi-package keyword；
- Pi entry 只有 ./index.ts；
- peerDependencies 使用当前 @earendil-works scope 和 "*"；
- TypeBox 通过 peerDependency 使用；
- 不引入新的非 Pi runtime dependency；
- 使用 Node crypto、fs、path、os 和 child_process/公开 pi.exec 完成本地能力。

如果实现发现必须增加 runtime dependency，必须先修订规格并取得用户确认。

## 40. 测试策略

### 40.1 默认隔离

所有文件测试使用临时 agentDir、临时 Git repository 和内存 SessionManager/fake branch。

默认测试 MUST NOT：

- 读取真实 getAgentDir()；
- 读取真实项目 memory；
- 修改真实 ~/.pi；
- 使用真实凭据或 provider；
- 访问网络；
- 依赖测试执行顺序。

### 40.2 Budget 与 estimate

覆盖：

- W <= 20,000 fail；
- 200k 和 1m 参考公式；
- T/H clamp 上下限；
- M clamp 上下限；
- dynamic O；
- provider usage 8-sample calibration；
- calibration 不向下修正；
- complete projection estimate；
- Fixed Envelope 和 tool schema；
- preflight 恰好等于 budget；
- preflight 超 1 token。

### 40.3 Protected Tail

覆盖：

- 普通 user/assistant turn；
- toolCall + 多个并行 toolResult；
- oversized single turn；
- error result；
- custom/branch summary；
- 不以 toolResult 开始；
- current active run 永不进入 compactable prefix。

### 40.4 Evidence

覆盖：

- stable serializer；
- Exact Tool Duplicate 每个比较字段；
- read/grep/find/ls defaults；
- path normalization；
- image exclusion；
- error exclusion；
- unknown/custom tool raw；
- same input different output supersession；
- different range/path 不 supersede；
- Stub exact text 和 closure；
- epoch marker；
- Net Savings Gate；
- correctness/budget bypass；
- exact branch-local reference；
- fork 后 reference；
- off-branch rejection；
- Pack admission、pin、later failure 和 settled cleanup；
- 完整 evidence 不写入 evidence-read tool result。

### 40.5 Checkpoint

覆盖：

- normalized source deterministic；
- thinking removal；
- previous checkpoint rolling merge；
- Legacy Summary；
- focus compatibility；
- output empty/length/over-budget rejection；
- forged reference rejection；
- first invalid exactly one regeneration；
- background invalid no immediate regeneration；
- active model switch不使 candidate 失效；
- session/tree/intervening compaction 使 candidate 失效；
- AbortSignal；
- usage carried to CompactionResult。

### 40.6 Barrier 与 persistence

用 fake Provider 和 ExtensionRunner 覆盖：

- 每次 provider call 前执行 compiler；
- prepare threshold starts non-blocking work；
- blocking threshold waits/compacts；
- evidence reduction first；
- final preflight rebuild；
- prepared candidate 安装后仍超预算且另有 eligible prefix 时继续同步压缩；
- compactor 失败直接 fail closed，不通过 Pack suppression 掩盖；
- eligible compactable prefix 耗尽后仍超预算时整包抑制本轮自动 Memory Pack；
- Memory Pack 抑制后重新 preflight 并继续同一 run；
- 不部分淘汰、不重新排名，也不移除 Evidence Pack；
- 无 Pack 或整包抑制后仍超预算时 fail closed；
- failure calls ctx.abort before provider send；
- context handler 不抛出；
- mid-run checkpoint 立即用于下一 turn；
- pending candidate 在 settled 原样提交；
- crash 前没有第二持久载体；
- session_before_compact 永不返回 undefined；
- manual/threshold/overflow 都由 extension result 接管；
- Pi default summarizer 未调用；
- CompactionEntry restore/fork/tree semantics。

### 40.7 Repository Memory

覆盖：

- Git common-dir worktree identity；
- independent clone separation；
- symlink realpath；
- non-Git cwd identity；
- JSON deterministic serialization；
- missing file；
- corrupt/unknown schema unavailable；
- 10 KiB exact boundary和 over-limit；
- 8 MiB exact boundary和 atomic rejection；
- idempotent fingerprint；
- explicit supersession；
- forget relationship conflict；
- no tombstone；
- branch/path applicability；
- detached HEAD branch-scope rejection；
- lock contention、timeout、abort、stale verified owner和未知 owner；
- atomic temp/rename cleanup；
- mutation 内重新读取避免 stale snapshot；
- successful write updates in-memory index。

### 40.8 Retrieval

覆盖：

- Latin/camel/snake/kebab/path tokenization；
- Han unigram/bigram；
- ranking group precedence；
- BM25 k1/b；
- deterministic ties；
- prior-pack continuity；
- no time decay；
- full-to-stub downgrade；
- later small record after oversized record；
- 8192 cap；
- search 10/4096 dual cap；
- read full body；
- inactive/superseded exclusion；
- Pack frozen through internal turns。
- 同步压缩后的本轮整包 suppression 不修改 Repository Memory，下一 run 正常重建；

### 40.9 Modes 与 UI

覆盖：

- TUI status；
- busy status read-only；
- headless no dialog wait；
- background no unsolicited notify；
- blocking working message cleanup；
- status 不泄露正文、prompt、fingerprint 或 credentials；
- session_shutdown cleanup 幂等。

## 41. 文档要求

实现时 extensions/context-management/README.md MUST 覆盖：

- 用途和 experimental 状态；
- 安装、启用、卸载；
- 注册命令和工具；
- Active Context 的五类输入和 20k headroom；
- background 与 blocking compaction；
- /compact 完全接管；
- Evidence Reference 和精确 read；
- Repository Memory 自动/显式写入；
- memory.json exact location、8 MiB/10 KiB limits 和人工清理；
- background model 请求的费用与网络副作用；
- 不写项目目录；
- 不支持其他 context/compaction extension 并存；
- TUI、RPC、json、print 差异；
- check、test 和 smoke test 命令。

根 README.md MUST 从 extension 创建时登记 context-management。

## 42. 验证命令

实现交付前，在 extensions/context-management 中至少运行：

~~~bash
npm run check
npm test
~~~

并从 package 根入口做本机 Pi 无副作用 smoke test，确认：

- 只解析 extensions/context-management/index.ts；
- 启动页显示 context-management；
- 不显示 src；
- 不重复加载；
- 无模型请求时也能安全启动和退出。

实现前的纯规格文档修改不运行代码检查。

## 43. 验收标准

V1 只有在以下全部成立时才完成：

1. 每次普通 provider request 前都经过 Context Compiler 和 Final Request Preflight。
2. 20,000-token Generation Headroom 在所有模型与模式中一致执行。
3. Protected Tail 保持完整 turn/tool closure。
4. Exact Duplicate 和四个 built-in reducer 只做本规格允许的确定性缩减。
5. Raw Evidence 保持在 Pi Session Record，可按 canonical reference 精确读取。
6. Evidence Pack 完整、run-scoped、admission-aware、已准入项不淘汰。
7. Checkpoint 使用自由 CommonMark，机械验证且单实例 rolling merge。
8. Background threshold 能非阻塞准备；blocking threshold 能在当前 loop 下一 provider request 前恢复。
9. blocking failure 不发送 provider request，不调用 Pi default summarizer。
10. manual、threshold、overflow compaction 全部通过 session_before_compact 接管。
11. durable Checkpoint 只使用 extension-authored Pi CompactionEntry。
12. pending commit crash 不损坏 Raw Evidence，恢复后能重新 compact。
13. model switch、fork、tree navigation 和 Legacy Summary 行为符合本文。
14. Repository Identity 让同 clone worktree 共享、独立 clone 隔离。
15. memory.json 是唯一 store，单 body 10 KiB、整库 8 MiB，超限原子失败且给出人工整理指引。
16. Memory Write 信任主 Agent 的长期价值判断，但不后台观察 transcript。
17. Memory Forget 只接受 exact ID，并由用户明确移除意图触发。
18. Automatic Memory Activation、BM25 ranking、8192 pack、Stub downgrade 和显式 search/read 可重复测试；全部
    eligible compactable prefix 耗尽后仍超预算时只整包抑制本轮自动 Memory Pack，下一 run 正常重建。
19. memory corruption 只禁用 memory，不阻断普通 Context Runtime。
20. 多进程 memory mutation 不产生 lost update 或 partial JSON。
21. /context-management-status 只读且不泄露敏感正文。
22. V1 没有配置面、第二模型、第二 Checkpoint store、Working State 或 todo duplication。
23. README、根索引、check、test 和真实 package-root smoke test 完成。

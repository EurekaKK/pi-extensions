# goal

为 Pi 提供 session 级的自主目标循环。用户创建一个不可变目标后，主 Agent 持续工作；每次完整 run settled
以后，extension 会用隔离 evaluator 判断 `continue`、`complete` 或 `fail`。只要仍有合理路径，`continue`
就会自动启动下一次主 run，不需要用户逐轮催促。

## 状态

`experimental`

第一版只提供 `/goal`，接口和 evaluator 判定 prompt 仍可能根据真实使用反馈调整。

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和使用 `@earendil-works/*` package scope 的本机最新版 Pi。从仓库根目录安装：

```bash
pi install ./extensions/goal
```

通过 `pi config` 启用或停用。卸载：

```bash
pi remove ./extensions/goal
```

卸载不会修改已有 session。Goal lifecycle 和 evaluation 记录仍保留在对应 Pi session 中；重新安装 extension
后可以再次解析这些记录。

## 命令

```text
/goal
/goal resume
/goal cancel
```

`/goal` 使用 Pi 原生多行编辑器创建目标，不接受行内目标文本。一个 session 同时最多有一个当前 goal。目标以
editor 返回值为准，保留其中的换行和内部空白，并作为第一条普通 user message 发送；Pi editor 自身会 trim 整体
首尾空白。后续 steering 可以补充信息或影响路径，但不能替换目标或降低完成标准。

`/goal resume` 只恢复 `paused` 或 `error`：

- 主阶段中断时启动新的 continuation run；
- evaluator 中断时重跑同一次逻辑 evaluation，不重复之前的主 run。

`/goal cancel` 不要求确认，会提交取消状态、请求停止当前主 run 或 evaluator，并清除状态行，但不会回滚已经发生的
文件修改、命令、网络请求或其他副作用。Pi 公开 extension API 不能立即取消 retry backoff 或 auto-compaction；
extension 会阻止迟到工具调用并在下一个公开 agent 边界再次 abort。`failed` 状态下 cancel 只负责 dismiss；历史
evaluation 仍保留。

任何其他参数只显示这三个命令的固定用法。没有 `/goal status`：活动状态始终显示在 TUI footer。也没有
`/goal pause`：使用 Escape 暂停。

## 状态和循环

活动 goal 持续显示为：

```text
Goal: running     00:12:34  目标概述
Goal: evaluating  00:13:02  目标概述
Goal: paused      00:13:08  目标概述
Goal: failed      01:23:45  目标概述
Goal: error       01:23:45  目标概述
```

概述只通过折叠目标空白生成，不调用模型。时间只累计 `running` 和 `evaluating`；暂停、错误、失败和 Pi 退出后的
离线时间不计入。

一次主 run 包含 Pi 在一次 `agent_start` 到 `agent_settled` 之间的所有 LLM turn、工具调用、retry、overflow
compaction retry 和已排队 continuation。只有成功 settled 的主 run 才会触发 evaluation。Escape、cancel 或
最终基础设施错误中止的 run 不评估。

Evaluator 返回：

- `continue`：仍存在具体、合理、尚未尝试的路径；报告会滚动显示，并自动启动下一主 run；
- `complete`：目标和必要验证已有足够证据；清除状态行，不额外启动“总结”run；
- `fail`：在当前信息、能力、权限和目标指定方针内没有可行路径；状态持续显示；
- evaluator 自身的 provider、网络、snapshot 或格式问题属于 `error`，不伪装成语义 `fail`。

Evaluation 结果像工具结果一样留在对话滚动区：折叠时显示编号、decision 和短理由，展开后显示 progress、reason、
next action 和 evidence。只有 goal 状态行固定显示。

Goal 没有 waiting 状态，也没有硬性 evaluation 次数或时长上限。Evaluation 次数和有效运行时长只用于帮助
evaluator 识别重复、停滞和需要优化的路线，不能单独成为 fail 理由。

## 输入、暂停和恢复

`running` 时普通输入沿用 Pi 原生 steering 边界：不会立即打断当前 assistant turn，而是在当前 turn 及其工具
调用结束后、下一次 LLM 调用前投递。Extension 不创建自己的 steering 队列。

`evaluating` 时提交普通输入会使当前 evaluator 结果失效并中止它；该输入随后作为正常 user message 启动新的
主 run，之后再评估。被中止的 evaluator 不增加 evaluation 次数。

主 run 中按 Escape 使用 Pi 原生 abort：尚未投递的 steering/follow-up 会恢复到编辑器，goal 进入
`paused`。Evaluator 运行时主 Agent 已 idle，因此 extension 会直接消费 Escape、中止 evaluator 并进入
`paused`。

`paused` 和 `error` 时普通 prompt 会被拒绝，直到 `/goal resume` 或 `/goal cancel`。`failed` 时可以正常聊天，
但 failed 状态会一直显示，直到 cancel dismiss 或成功创建另一个 goal。

如果 Pi 退出前状态是 `running`，下次打开同一 session 会自动继续主阶段；如果是 `evaluating`，只重跑 evaluator，
不会重复已完成的主 run。`paused`、`error` 和 `failed` 原样恢复。恢复 continuation 会要求主 Agent 先检查中断前
可能已经发生的副作用，避免盲目重复。

Pi 的自动 `triggerTurn` 不执行 `before_agent_start`，所以自动 continuation 和 `continue` evaluation 的可见模型
内容会直接携带完整不可变 goal contract；普通 user-run 仍在 `before_agent_start` 中追加同一 contract。

## Session、branch 与 compaction

Goal 属于整个 Pi session，不属于单个 branch：

- `/tree` 不回滚 goal、evaluation 次数或有效运行时间；
- 暂停后切换 tree branch，再 resume 仍是同一个不可变目标；
- `running` 或 `evaluating` 时阻止 tree、fork、new 和 session switch，先按 Escape 暂停；
- 新 session 和 fork session 不继承活动 goal，原 session 仍保留；
- compaction 后 evaluator 使用当前 compaction-aware 上下文，不重新暴露已经压缩掉的完整原始历史。

创建 goal 时可见的 compaction-aware 上下文被记录为 session entry anchor。主 Agent 和 evaluator 需要时从临时
snapshot 按需读取，而不是每轮把全部上下文复制进 system prompt。

## Evaluator 隔离

每次 evaluation 都创建一个新的、内存 session 的裸 Pi Agent：

- 使用主 Agent 当前模型和 thinking level；
- 从当前 cwd、agentDir、project trust 和落盘 settings 重建 Pi retry、provider timeout 和 transport 设置；
- 不加载用户 extensions、skills、prompt templates、themes 或项目 context files；
- 不继承主 Agent 的 read、bash、edit、write 或其他工具；
- 只提供三个 snapshot 只读工具和一个结构化 report 提交工具；
- evaluation 完成后立即 dispose，不复用 evaluator transcript。

Evaluator 获得的 bundle 包括：不可变目标、当前 compaction-aware context、目标创建上下文、全部已接受 evaluation、
主 Agent 的工具能力说明、evaluation 次数、有效运行时长和相关图片。Snapshot 内容被视为待判断证据，不能覆盖
evaluator system contract。

为了支持由 extension 注册的模型 provider，evaluator 会桥接主 session 当前有效 provider 的 auth 和 stream。
它不会加载 provider extension 的其他事件 hook。因此依赖全局 `before_provider_request`、
`before_provider_headers` 或 `after_provider_response` hook 才能工作的模型会进入 `error`。

当前 model、thinking level 和动态 provider auth 直接继承主 context/runtime。Pi 没有向 extension 公开主 session 的
SettingsManager/ModelRuntime，因此纯内存设置或 CLI-only runtime override 不能保证被 evaluator 精确继承。

Evaluator 的 token、usage 和费用不计入主 Pi session 的 footer 或 `/session` 统计；第一版不额外收集或展示。

## 注册资源

Extension 注册：

- slash command `goal`；
- footer status `goal.status`；
- custom session entries `goal.lifecycle.v1` 和 `goal.evaluation.v1`；
- custom messages `goal.evaluation.message.v1` 和隐藏的 `goal.control.v1`；
- evaluator 私有工具 `goal_snapshot_read`、`goal_snapshot_search`、`goal_snapshot_image` 和
  `goal_submit_evaluation`；
- goal 生命周期、输入、session 导航和 Escape 处理器。

Evaluator 工具不会注册到主 Agent。

## 持久化与临时文件

长期状态只写入当前 Pi session 的版本化 custom entries，不创建项目级状态文件。记录包含原始目标、状态转换、
有效运行时间、run/evaluation 标识和完整的已接受 evaluation report。Custom lifecycle entries 本身不进入主
LLM context；可见 evaluation message 会进入正常对话上下文。

Evaluation entry 是权威 commit，滚动区 custom message 只是投影。Pi 的 `sendMessage` 返回 void，没有 enqueue
acknowledgement；恢复会按 session entry 做 best-effort 补发和去重，但进程恰好在 send/落盘之间退出时无法保证严格
exactly-once 投影。

每次主 run 或 evaluation 会在操作系统临时目录创建权限受限的 snapshot：目录 `0700`、文件 `0600`。它可能
包含对话、tool output 和图片，只能由 evaluator 的受限工具访问。正常完成、暂停、取消、错误和退出都会清理；
hard crash 的残留由同 session 下次启动和操作系统做 best-effort 清理。

## 模式支持

| 模式 | 行为 |
| --- | --- |
| TUI | 完整支持命令、状态、循环、暂停和自动恢复 |
| RPC | 安全加载；goal 命令返回不支持，不显示状态且不自动恢复 |
| print | 安全加载；不启动 timer、evaluator 或自动恢复 |
| json | 安全加载；不启动 timer、evaluator 或自动恢复 |

非 TUI 打开原本活动的 session 不改变持久化状态，也不累计时间；以后用 TUI 打开再恢复。

## 权限与副作用

主 Agent 仍使用当前 Pi 已启用的工具、project trust 和权限。Goal 不自动批准权限、不提升 trust、不绕过安全
控制。目标循环可能让主 Agent 多次执行原本获准的文件、shell 或网络操作；cancel、fail 和 error 均不回滚这些
副作用。

Evaluator 唯一的网络行为是调用当前模型 provider。它不能执行 shell、修改项目、读取 snapshot root 外文件、
调用主 Agent 工具或加载其他资源。Extension 不发送遥测或后台上传。

## 限制

- 普通 steering 只能在 Pi 原生 assistant-turn/tool-use 边界生效，不能立即打断当前 turn。
- Escape 暂停主 run 时，pending steering/follow-up 按 Pi 默认恢复到编辑器。
- Hard crash 可能少计最后一个尚未 checkpoint 的 active time segment。
- Evaluator usage 不进入主 Pi token/cost 统计。
- Evaluator 不继承全局 provider request hooks。
- 完整功能只支持 TUI。
- 临时目录 hard crash 清理是 best-effort。
- 主 Agent 没有文件读取能力时，不能读取 creation-context snapshot；extension 不为此扩大权限。
- Pi editor 会 trim goal 的整体首尾空白；内部空白按返回值保留。
- Extension abort 不能保证立即取消 retry backoff 或 auto-compaction，只能在公开 agent/tool 边界继续拦截。
- 自动消息没有 enqueue acknowledgement，投影和 kickoff 恢复是 session-entry 驱动的 best-effort 语义。
- Evaluator 无法继承主 session 的纯内存/CLI-only settings override。
- 后注册的其他 `before_agent_start` handler 仍可能覆盖 goal 已追加的 system prompt；Pi 没有 hook finalizer。

## 开发

在 package 目录运行：

```bash
npm run check
npm test
```

真实加载 smoke test 必须从 `extensions/goal/` package 根目录加载，确认 Pi 只解析根 `index.ts`，启动页只显示
一次 `goal`，不显示 `src` 或重复名称。默认自动化测试使用 fake Provider 和临时目录，不访问真实凭据、用户
session、付费模型或不受控网络。

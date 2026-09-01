# plan

提供用户主动启动、模型起草、人类审批的 Planning Workflow，并把执行进度完全交给 Todo。

Plan 只负责：

```text
用户 /plan start → 只读调研 → plan_submit → 人类审批 → Todo handoff
```

**Todo 保持唯一执行进度真源**：Plan 不跟踪执行、不持有 executing 状态、不写 `todo:snapshot`。审批通过后，
Todo 会收到由 Plan 请求、由 Todo 自己持久化的链接初始列表（全部 `pending`），随后进入执行阶段时，
Plan 的 UI 与门禁全部关闭。

## 状态

`experimental`

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和本机最新版 Pi。安装采用 npm 式两步：先从仓库根目录把 package
复制到 `~/.pi/agent/my-extensions/plan/`，再登记该副本。仓库脚本一步完成：

```bash
scripts/install-extension.sh plan
```

脚本会递归安装 Plan 声明的安装期依赖 `todo` 与 `sub-agent`，并把内部包依赖（`config-store`、
`progress-widget-protocol`、`todo-protocol`）vendor 进副本。Plan 不要求安装 `progress-widget`；后者缺席时
Plan 使用自己的输入框上方 fallback。使用 `pi config` 启用或停用。卸载：

```bash
pi remove ~/.pi/agent/my-extensions/plan
rm -rf ~/.pi/agent/my-extensions/plan
```

卸载不会级联卸载 todo/sub-agent。**不要与官方 Plan Mode 示例同时启用**：两者都占用 `/plan` 与
`--plan`，会产生歧义；启用本 extension 前请先停用官方示例。

## 注册资源

本 extension 注册：

| 资源 | 名称 | 说明 |
| --- | --- | --- |
| 命令 | `/plan` | 只读状态与 `start/approve/revise/cancel/retry` 控制 |
| CLI flag | `--plan` | 布尔；目标作为 flag 前的定位消息传入 |
| 模型工具 | `plan_submit`、`plan_read` | 提交 Proposal / 精确读取 revision 与 Step |
| 消息渲染器 | `plan:start`、`plan:proposal-card`、`plan:revise-request`、`plan:kickoff` | 工作流各阶段的 transcript 消息 |
| Widget key | `plan:status` | `progress-widget` 缺席时位于输入框上方的活动 Plan fallback |
| Event bus | `progress-widget:state`；监听 `progress-widget:attach` / `progress-widget:release` | 向组合 Progress Widget 投影活动 phase 与 Plan reference |
| session entry | `plan:change`（v1） | append-only 状态变更（见「持久化与分支」） |

不注册键盘快捷键、timer、watcher、socket 或外部进程；Planning Mode 的工具策略见
「Planning Mode 工具策略」。

## 配置

配置位于 `<agentDir>/plan/config.json`（通常 `~/.pi/agent/plan/config.json`），首次加载自动创建：

```json
{
  "version": 1,
  "additionalReadOnlyTools": []
}
```

- `additionalReadOnlyTools`：部署者断言为只读、允许在 Planning Mode 使用的额外工具名。Plan 不推断
  工具副作用；未注册的名称会被跳过并在有 UI 时提示一次。
- 修改配置后执行 `/reload`。配置损坏时 Plan 安全停用并提示一次。

本机已启用只读调研子 Agent（`subagent_plan`）：`~/.pi/agent/sub-agent/config.json` 中的
`subagent_plan` 只允许 `read/grep/find/ls`、Tavily Search/Extract 与 Memory Search/Read，深度为 1，
不允许 bash、文件写入或再次委派。若你的环境中没有该配置项，Plan 仍可规划，只是没有委派调研；
README 依赖配置片段见 `extensions/sub-agent/README.md`。

## 用户命令

```text
/plan                 # 只读状态
/plan start <objective>
/plan <objective>     # start 简写
/plan approve
/plan revise [feedback]
/plan cancel
/plan retry
--plan                # CLI：布尔 flag；目标需作为 flag 前的消息：pi "<objective>" --plan
```

- 只有用户能启动与批准。模型只能 `plan_submit`、`plan_read`，并在合适时建议 `/plan start`。
- `plan_submit` 后，完整 Proposal 与审核提示以普通 Markdown 输出进入 transcript；不会打开 overlay、
  selector、editor 或其他阻塞式审核 UI。工作流保持 reviewing，直到用户显式执行审批命令。
- 当前 Todo 列表非空时，Proposal 输出会在审批前警告列表将被替换；`/plan approve` 的完成反馈仍披露
  替换前的列表大小。
- `/plan revise` 在 reviewing 内回到 drafting；从 inactive 延续 lineage 时，objective 默认沿用
  已批准 revision 的 objective（持久化进 revise-request 并呈现在消息与状态里）。
- 恢复（resume/reload/fork/tree）只恢复 phase、门禁与 Progress Widget 投影，不自动打开审核 UI、
  不自动 retry、不自动执行。
- 分支上已有活动工作流时，`--plan` 不启动新 workflow，而是恢复既有门禁并提示一次。

活动 Plan 的 phase、Plan ID、revision（存在时）和 Workspace Mutation 封锁提示显示在输入框上方。
启用 `progress-widget` 时，Plan 进入组合组件，固定顺序为
`Subagents → Plan → Todos → Goal → 输入框`；Compact 与 Full View 的 Plan 区段都占一行。组合组件缺席、
禁用或释放投影时，`plan:status` fallback 显示同样内容。handoff 完成或取消后清除 Plan 区段。

## 模型工具

- `plan_submit`：仅在 drafting 阶段可用；提交下一个不可变 revision（`objective`、`overview`、
  `steps: [{title, details}]`，全部字段必填、拒绝未知字段、title 唯一）。返回简短回执并停止等待审批。
- `plan_read`：无参读状态；`plan_id + revision` 读精确 revision；加 `step_id` 读精确 Step；
  可选 `offset`/`limit` 按 Unicode code point 分页。已批准 revision 会只读 join 当前 Todo
  （linked 状态、missing、discovered unlinked），Todo 仍是状态权威。`plan_read` 常驻
  Plan Suggestion guideline（模型在 Workspace Mutation 前最多建议一次并等待用户选择）。

状态机（来自已验证原型）：

```text
inactive → drafting → reviewing → handoff_pending → inactive
                  ↑          │
                  └─ revise ─┘
```

活动状态没有 `executing`。`/plan start` 新起 lineage；`/plan revise` 在 reviewing 内回到 drafting，
或存在 Latest Approved Plan 时从 inactive 延续 lineage（objective 默认沿用已批准 revision）。

## 示例

```text
# 交互式：用户显式启动规划
/plan start 把 todo 升级到 v3 并加入 plan-step 关联

# 模型只读调研后提交（写入类工具被门禁阻断；Tavily / memory / subagent_plan 可用）
plan_submit({ objective, overview, steps: [{ title, details }] })

# 人类审批：阅读 transcript 中的完整 Proposal 后显式执行命令
/plan approve
# 或：/plan revise <feedback>、/plan cancel

# 执行：Todo 持有唯一进度；模型按 kickoff 消息读取第一个 Step 并用 todo_write 推进
plan_read({ plan_id, revision, step_id })

# 对已批准 Plan 重新规划（objective 默认延续）
/plan revise 新 revision 需覆盖剩余全部工作

# CLI 一次性规划：调研并提交 Proposal；JSON/print 下不审批、不 handoff、不自动执行
pi "设计 X 的实现方案" --plan
```

## Planning Mode 工具策略

fail-closed allowlist（默认）：

- 内置只读：`read`、`grep`、`find`、`ls`
- 调研：`tavily_search`、`tavily_extract`、`memory_search`、`memory_read`
- Plan：`plan_submit`、`plan_read`
- 委派：`subagent_plan`（已注册时）

禁用的能力：`bash`/`powershell`、`edit`/`write`、普通 `subagent`/`subagent_fork`/`send_message`、
`todo_write`、Memory 写入、未知 custom tools。另有一道 `tool_call` 守卫，即使其他 extension 重新
激活被禁工具也会被阻断。

这是**模型工具级策略，不是操作系统沙箱**。用户自己在终端执行的 `!`/`!!` 命令不受此门禁约束，
属于用户的显式权限。文档化该边界：恶意 extension 或外部进程不在保证范围内。

## 持久化与分支

- 状态随 Pi session branch 保存，全部为 append-only custom entries：
  - `plan:change` v1：start / submit（完整 Proposal，每 revision 一次）/ revise-request / approve
    （含 handoffId）/ handoff-complete / cancel。
- 已批准 revision 不可变；历史条目保留可审计；删除 session 即删除 Plan 数据。
- 形状损坏的当前版本 `plan:change` 条目会被跳过，每个 session 最多提示一次 sanitized 警告，
  其余有效历史不受影响。
- Todo 快照 v3 由 Todo 独占写入；handoff 的初始列表携带 `handoffId` origin 与每项精确
  `{planId, planRevision, stepId}` source。
- 崩溃窗口（Todo 已提交但缺少 handoff-complete）在恢复时视为已生效完成：关闭门禁、提示一条
  “请直接继续”，不自动重发 kickoff。
- 未提交的 handoff 保持 `handoff_pending`，可 `/plan cancel`（未提交时）或 `/plan retry`（幂等）。

## 模式支持

| 模式 | 工具 | 命令 | 审核体验 | Gate/门禁 |
| --- | --- | --- | --- | --- |
| TUI | 支持 | 支持 | 完整 transcript Proposal + `/plan` 决策命令 | 支持 |
| RPC | 支持 | 支持 | custom message + `prompt` 调用 `/plan` 命令 | 支持 |
| JSON | 支持 | 不支持 | Proposal 事件；无审批 | 支持（`--plan` 时） |
| print | 支持 | 不支持 | Proposal 输出；无审批 | 支持（`--plan` 时） |

JSON/print 下 `--plan` 允许调研并提交 Proposal，但不能审批、不能 handoff、不会自动执行。

## 与 Goal 的已知限制

v1 不协调 active/armed Goal：Planning Mode 会按 unknown tool 拒绝 goal 工具，而 Goal Driver 仍可能
在 settled 后注入下一轮。**同时启用 armed Goal 与 Planning Workflow 不受支持**；规划前请先
`/goal pause`。

## 权限与副作用

- 不访问网络、不启动进程/timer/watcher/socket；无遥测。
- 唯一持久化副作用：首次加载创建 `<agentDir>/plan/config.json`；每次 mutation 通过 Pi
  `appendEntry()` 写入当前 session。
- Proposal 正文会出现在模型工具参数、Pi session、provider 日志与导出会话中；不要把机密写进 Plan。
- Plan 从不直接写 `todo:snapshot`；Todo 的写入、校验、widget 语义完全不变。

## 开发

```bash
npm run check
npm test
```

真实加载 smoke test 必须从 package 根目录执行，确认启动页显示 `plan`（且不显示 `src` 或重复入口），
并确认 `plan_submit`/`plan_read`/`/plan`/`--plan` 注册。
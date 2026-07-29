# todo

为 Pi 提供对话级的多步骤执行记忆。LLM 可以创建一个 Todo List、补充新发现的工作，并用
`pending`、`in_progress`、`completed` 和 `cancelled` 四种状态持续记录进度。

存在活动列表时，交互界面会常驻显示 Todo 摘要；每连续完成五个非 `todo` 工具调用，extension 还会在第五个
工具结果末尾追加一条提醒，向 LLM 列出所有尚未解决的事项。

该 extension 不会自动续跑 Agent、启动新的对话轮次、阻止 LLM 返回用户或代替用户作决定。提醒只有在 LLM
仍然调用工具时才会出现。

## 状态

`experimental`

功能和工具契约仍可能根据实际使用反馈调整。

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和本机最新版 Pi。从仓库根目录安装本地 package：

```bash
pi install ./extensions/todo
```

使用 `pi config` 启用或停用该 extension。卸载：

```bash
pi remove ./extensions/todo
```

extension 不创建独立状态文件；卸载它不会修改已有 Pi session。Todo 数据会随对应 session 保留，直到该
session 被删除。

## 注册资源

extension 注册：

- LLM 工具 `todo`，支持 `create`、`add`、`update` 和 `list` 四个 action。
- UI widget `todo:status`，用于展示当前活动列表。
- custom session entries `todo:snapshot` 和 `todo:counter`，分别保存列表快照和提醒计数。
- `session_start`、`session_tree`、`session_shutdown`、`tool_execution_start`、`tool_execution_end`、
  `tool_result` 和 `message_end` 生命周期处理器。执行结束与消息结束处理器共同确保参数校验失败、被其他
  extension 拦截等未进入工具执行器的失败结果也会纳入提醒计数。

它不注册 slash command、键盘快捷键、CLI flag、消息 renderer、timer、watcher、进程或 socket。

## 使用方式

`todo` 是提供给 LLM 的工具，不是用户命令。一个 conversation branch 最多有一个活动列表；新列表的 Todo ID
从 `1` 开始，并且只在当前列表内有效。

### 创建列表

所有新事项初始都是 `pending`：

```json
{
  "action": "create",
  "items": [
    "调查 Pi session 的持久化机制",
    "实现 Todo 状态和工具",
    "补充提醒与分支恢复测试"
  ]
}
```

已有活动列表时，第二次 `create` 会失败，并向 LLM 列出全部尚未解决的事项。必须先逐项完成或取消它们。

### 添加事项

工作过程中发现新的必要步骤时，可以向当前列表追加一项或多项：

```json
{
  "action": "add",
  "items": [
    "验证并行工具调用时的提醒计数"
  ]
}
```

extension 不按文本自动去重；不同 ID 始终代表不同 Todo。没有活动列表时，`add` 会失败。

### 更新状态

`update` 支持一次原子更新多项：

```json
{
  "action": "update",
  "updates": [
    {
      "id": 1,
      "status": "completed"
    },
    {
      "id": 2,
      "status": "cancelled",
      "reason": "上游 API 已移除该工作路径"
    }
  ]
}
```

整个批次会先完成校验，再统一写入。只要一项使用了不存在或重复的 ID、非法状态转换、重复状态，或者不符合取消
理由规则，整批都会失败，不产生部分更新。

允许的单向转换为：

| 当前状态 | 允许的目标状态 |
| --- | --- |
| `pending` | `in_progress`、`completed`、`cancelled` |
| `in_progress` | `completed`、`cancelled` |
| `completed` | 无 |
| `cancelled` | 无 |

`completed` 和 `cancelled` 都是不可变的终态，不能 reopen。进入 `cancelled` 必须提供非空 `reason`；
其他目标状态不能携带 `reason`。Todo 文本创建后也不能修改：如果描述或范围已经不再准确，应取消原事项并新增
一个事项。

当列表中的所有 Todo 都成为终态时，列表会自动关闭并从当前状态中移除；没有 `close` action。之后可以创建
一个完全无关联的新列表，ID 重新从 `1` 开始。

### 查看列表

```json
{
  "action": "list"
}
```

`list` 返回全部 Todo、状态和取消理由，不受 widget 五项展示上限影响。没有活动列表时会成功返回
`No active Todo List.`。查询不会改变 Todo，也不会重置提醒计数。

## 提醒与常驻展示

只有存在活动列表时才维护提醒计数：

- 每个非 `todo` 工具结果都计一次，无论原工具成功还是失败。
- 同一次 LLM 输出中的多个并行工具调用分别计数，并按 Pi 报告的实际完成顺序处理。
- 第五个连续结果会保留原工具的内容、错误状态、details 和 usage，并在内容末尾追加一条 Todo 提醒。
- 提醒列出所有 `pending` 和 `in_progress` 事项，随后将计数重置为零；再连续调用五次才会再次提醒。
- 成功的 `create`、`add` 或 `update` 会重置计数。
- `list` 和被拒绝的 Todo 修改既不增加也不重置计数。被拒绝的修改会直接说明错误，并再次列出全部未解决事项。

提醒不是新的 user message，不会自动启动 Agent run，也不会在 LLM 已向用户返回后生成额外 turn。因此，它能在
工具使用过程中提示进度，但不保证 Todo 会在无人干预时持续执行至结束。

在 TUI 中，`todo:status` widget 会常驻显示最多五项，依次优先展示
`in_progress`、`pending`、`completed`、`cancelled`，各组按 ID 升序。标题汇总已完成、已取消、未解决和
未展示的数量；取消项会显示理由。提醒计数不会显示在 widget 中。列表关闭后 widget 自动清除。

## 持久化与分支

Todo state 只保存在当前 Pi session 的版本化 custom entries 中：

- `todo:snapshot` 只在成功创建、添加、更新或自动关闭列表时保存完整列表。
- `todo:counter` 为每个计数中的非 Todo 工具结果保存一条小型记录。
- custom entries 本身不进入 LLM context；`todo` 工具的文本结果和追加的提醒属于正常对话上下文。

`Ctrl+D` 退出不是删除。下次恢复同一个 session 时，活动列表和 `0..4` 的提醒计数都会恢复，但恢复动作本身
不会触发提醒。例如退出前计数为 `3`，恢复后第二个非 Todo 工具结果会触发提醒。

状态跟随 conversation branch：

- tree navigation 会恢复目标节点可见的 Todo 状态。
- 从较早节点 fork 只继承 fork 点以前的状态；其他 branch 后续的完成、取消或关闭不会泄漏进来。
- 返回列表关闭前的历史节点可以看到当时仍活动的列表，这属于历史状态恢复，不是 reopen。

extension 不在 session 外保存状态副本。删除 Pi session 会一并移除 Todo 数据；Pi 交互界面会优先将 session
文件移入系统废纸篓，失败时才直接删除，所以清空废纸篓前，底层文件仍可能被操作系统恢复。

Todo 数量、文本长度和 session 工具调用次数没有固定总上限。snapshot 与小型 counter 分开保存，以避免每次
普通工具调用都复制完整列表，但长时间且高频使用的 session 仍会持续增长。

## 模式支持

| 模式 | `todo` 工具 | 提醒 | session state | widget |
| --- | --- | --- | --- | --- |
| TUI | 支持 | 支持 | 支持 | 常驻显示 |
| RPC | 支持 | 支持 | 支持 | 通过 UI bridge；客户端可选择不显示 |
| JSON | 支持 | 支持 | 支持 | 不显示 |
| print | 支持 | 支持 | 支持 | 不显示 |

所有模式使用相同的工具、状态机、提醒和持久化语义。没有 UI 的模式不会等待交互；UI 投影失败也不会改变 Todo
状态或工具结果。

## 限制

- Todo List 只属于一个 Pi session，不是项目级、仓库级、用户全局或跨 session 的任务系统。
- 每个 branch 同时只能有一个活动列表，列表之间没有父子、来源或替代关系。
- 不支持 reopen、delete、手动 close、文本编辑、优先级、依赖关系、截止时间、负责人、标签或外部项目同步。
- 没有 slash command、快捷键、用户侧 Todo 编辑器或提醒间隔配置；提醒阈值固定为五次。
- 不会自动 follow-up、自动 continuation、拦截正常回复或提供专用的等待用户输入协议。
- Pi 分别在工具执行结束和结果消息落盘两个事件中提供计数与内容替换能力。因此极端情况下，如果进程恰好在第五
  次调用的计数重置已经写入 session、但提醒尚未附加到结果消息之间异常终止，这一次提醒可能丢失；正常退出和
  恢复不受影响。
- 不保证有限的 session 内存或磁盘占用；Pi 自身的 tool call 和 result 通常也会随 session 增长。

## 权限与副作用

extension：

- 不访问网络，不发送遥测或后台上传。
- 不启动外部进程、timer、watcher 或 socket。
- 不读取凭据、项目文件或与 Todo 无关的文件。
- 不向项目目录、package 安装目录或用户目录写入独立状态文件。
- 唯一的持久化副作用是通过 Pi 向当前 session 追加 `todo:snapshot` 和 `todo:counter` entries。

Todo 文本和 cancellation reason 会随 session 保存，可能包含用户或 LLM 写入的信息。它们会出现在 `todo`
工具返回和提醒中，从而进入正常对话上下文；不应把不希望保存在 session 或发送给所用模型 provider 的敏感
内容写入 Todo。

## 开发

在 package 目录运行：

```bash
npm run check
npm test
```

真实加载 smoke test 必须从 `extensions/todo/` package 根目录加载，确认 Pi 只解析根 `index.ts`，启动页显示
`todo`，并且没有重复加载或额外命令。

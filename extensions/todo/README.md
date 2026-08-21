# todo

为 Pi 提供模型可见的结构化任务列表。模型通过 `todo_write` 工具每次发送完整列表；每次成功写入都会把
完整快照追加到当前 Pi session，后写覆盖先写。

`todo:status` widget 在编辑器上方常驻显示当前计划；它跨 turn 保留，直到计划被清空或终结：模型可以用
`todo_write({ todos: [] })` 显式清空；当一次写入的结果是非空的全部 `completed` 列表时，extension 视为计划完成，
自动按空列表落盘并清除 widget，不依赖模型再发一次空数组。session 关闭同样会移除 widget。

本 extension 不提供部分更新、回读工具、ID、取消状态、状态机、reminder 或自动续跑。

## 状态

`experimental`

功能和工具契约仍可能根据实际使用反馈调整。

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和本机最新版 Pi。安装采用 npm 式两步：先从仓库根目录把 package
复制到 `~/.pi/agent/my-extensions/todo/`，再登记该副本。仓库脚本一步完成：

```bash
scripts/install-extension.sh todo
# 等价于：
#   rsync -a --delete --exclude node_modules --exclude .DS_Store \
#     extensions/todo/ ~/.pi/agent/my-extensions/todo/
#   pi install ~/.pi/agent/my-extensions/todo
```

使用 `pi config` 启用或停用该 extension。卸载：

```bash
pi remove ~/.pi/agent/my-extensions/todo
rm -rf ~/.pi/agent/my-extensions/todo
```

卸载不会删除 agent 配置文件，也不会修改已有 Pi session。不再需要时，可手动删除
`<agentDir>/todo/config.json`。

## 配置

首次加载时，extension 会在 Pi agent 目录创建：

```text
<agentDir>/todo/config.json
```

通常为：

```text
~/.pi/agent/todo/config.json
```

默认内容：

```json
{
  "version": 1,
  "allowParallelInProgress": false
}
```

- `allowParallelInProgress: false`：同一时间最多一个 Todo 处于 `in_progress`；标记多个时调用失败。
- `allowParallelInProgress: true`：允许多个 Todo 同时处于 `in_progress`，适合会并行启动 subagent 或后台
  命令的工作方式。

该配置是部署级策略，所有 session 共享。extension 在加载时读取一次；修改后需要执行 Pi `/reload`。
配置文件损坏、字段非法或版本不支持时，`todo_write` 不会注册，并在有 UI 时提示错误。

## 注册资源

extension 注册：

- LLM 工具 `todo_write`。
- UI widget `todo:status`。
- custom session entry `todo:snapshot`（version 2）。
- `session_start`、`session_tree`、`session_shutdown` 生命周期处理器。

它不注册 slash command、键盘快捷键、CLI flag、消息 renderer、timer、watcher、进程或 socket。

## 使用方式

`todo_write` 是提供给 LLM 的工具。每次调用发送完整列表，新列表完全替换旧列表；没有逐项编辑或部分更新。

### 建立计划

```jsonc
todo_write({
  "todos": [
    { "content": "调查 session 持久化机制", "status": "in_progress" },
    { "content": "实现 todo 工具", "status": "pending" },
    { "content": "补充恢复测试", "status": "pending" }
  ]
})
```

成功结果：

```text
Updated todo list: 2 pending, 1 in progress, 0 completed.
```

### 更新计划

下一次调用仍然发送完整列表。已完成项直接标成 `completed`；不再需要的项从列表中删掉即可。

```jsonc
todo_write({
  "todos": [
    { "content": "调查 session 持久化机制", "status": "completed" },
    { "content": "实现 todo 工具", "status": "in_progress" }
  ]
})
```

状态只有：

- `pending`：尚未开始。
- `in_progress`：正在处理。
- `completed`：已完成。

没有 `cancelled`、关闭操作或 terminal 约束。列表项没有 ID，`content` 在同一次调用内不允许重复；如果任务
描述或范围变了，直接在下一次全量列表中写新内容。

### 清空计划

发送空数组即清空当前计划：

```jsonc
todo_write({ "todos": [] })
```

清空会持久化 `todos: []`，并清除 widget。

### 计划完成自动终结

当一次写入非空且所有项都是 `completed` 时，extension 视为计划已完成：快照按 `todos: []` 落盘，widget 立即清除，
工具结果返回 `All N todos completed. Todo list cleared.`。模型无需再发送空数组；旧版本写入的全 `completed`
快照在 session 恢复时也会被隐藏。

### 校验

- `content` trim 后必须非空。
- 同一次调用内 trim 后的 `content` 不能重复。
- 状态必须是三态之一；未知字段会被 schema 拒绝。
- `allowParallelInProgress: false` 时，多个 `in_progress` 会被拒绝，并且不会写入 session。

## Widget 语义

`todo:status` 在编辑器上方显示当前计划：

- `todo_write` 成功时显示最新列表。
- turn 边界不会清空或隐藏列表。
- session 恢复、fork 和 tree navigation 后显示目标 branch 的最后一条有效快照。
- 空列表 `[]` 清空 widget；非空但全部 `completed` 的写入同样视为终态并清空。

TUI 最多显示 5 项，顺序为 `in_progress`、`pending`、`completed`，超出的项在 header 中显示 `+N`。RPC 模式
通过 UI bridge 发送纯文本行；JSON 和 print 模式不调用 UI。

## 持久化与分支

每次成功的 `todo_write` 都会向当前 Pi session 追加一条 custom entry：

```ts
{
  version: 2,
  todos: [{ content, status }, ...]
}
```

custom entry 不进入 LLM context。恢复时读取当前 conversation branch 上最后一条有效 version 2 快照；
多个快照后写覆盖先写。

- 最后一条有效 v2 快照会持续显示；后续 user message 不会隐式清空计划。唯一例外是终态：全部 `completed` 的列表在写入时就按空列表落盘，旧版本遗留的全 `completed` 快照在恢复时也会被隐藏。
- fork 和 tree navigation 只读取目标 branch；其他 branch 的写入不会泄漏进来。
- `Ctrl+D` 退出不是删除，session 恢复遵循上述规则。
- 删除 Pi session 会一并删除 Todo 数据。Pi 可能先把 session 文件移入系统废纸篓。

旧版 `todo:snapshot` version 1 和 `todo:counter` 会被直接忽略，不迁移、不转换。

## 模式支持

| 模式 | `todo_write` 工具 | session 持久化 | widget |
| --- | --- | --- | --- |
| TUI | 支持 | 支持 | 编辑器上方常驻，显式清空或计划终结 |
| RPC | 支持 | 支持 | 通过 UI bridge；客户端可选择不显示 |
| JSON | 支持 | 支持 | 不显示 |
| print | 支持 | 支持 | 不显示 |

所有模式使用相同的工具、校验和持久化语义。无 UI 模式不会等待 UI；UI 投影失败不会改变 Todo 状态或工具
结果。

## 限制

- Todo List 只属于调用工具的那个 agent session，不是项目级、仓库级、用户全局或跨 session 的任务系统。
- 不支持部分更新、回读工具、ID、优先级、依赖、截止时间、负责人、标签或外部项目同步。
- 没有 `cancelled` 状态、reopen、显式 close 或状态转换校验；旧列表不会被运行时强制关闭。
- 没有 slash command、快捷键、用户编辑器、reminder 或自动续跑。
- 没有模型可调用的回读工具；UI 恢复会读取 session 快照，但列表一致性仍由模型负责。
- 没有固定总上限；Todo 数量、文本长度和 session 工具调用次数可以持续增长。

## 权限与副作用

extension：

- 不访问网络，不发送遥测或后台上传。
- 不启动外部进程、timer、watcher 或 socket。
- 不读取凭据、项目文件或与 Todo 无关的文件。
- 首次加载时在 `<agentDir>/todo/config.json` 创建默认配置。
- 每次成功 `todo_write` 通过 Pi `appendEntry()` 向当前 session 追加 custom entry。
- 不向项目目录、extension 源码目录或安装目录写状态。

Todo 文本会随 session 保存，并出现在工具调用和工具结果中，因此会进入正常对话上下文和 provider 日志边界；
不应把不希望持久化或发送给模型 provider 的敏感内容写入 Todo。

## 开发

在 package 目录运行：

```bash
npm run check
npm test
```

真实加载 smoke test 必须从 `extensions/todo/` package 根目录加载，确认 Pi 只解析根 `index.ts`，启动页显示
`todo`，且 `todo_write` 正常注册。

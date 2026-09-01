# progress-widget

把 Goal、活动 Plan、直接 Sub-agent Run 和 Todo 投影到 Pi 输入栏上方的一个组合 widget，并在 Compact / Full 两种视图间切换。它只负责显示，不改变四个生产者 extension 的领域状态或工具协议。

## 状态

`experimental`

## Extension 依赖

- `goal`
- `plan`
- `sub-agent`
- `todo`

从仓库根目录安装时，`scripts/install-extension.sh progress-widget` 会递归安装并登记以上依赖。依赖被禁用或加载失败时，对应区段缺席，其余区段继续工作。

运行时代码依赖内部 `progress-widget-protocol` package；安装脚本会自动 vendor，不需要单独安装。

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和本机最新版 Pi：

```bash
scripts/install-extension.sh progress-widget
```

脚本把依赖闭包分别复制到 `~/.pi/agent/my-extensions/<name>/`，按依赖优先顺序逐个执行 `pi install`。使用 `pi config` 启用或停用。卸载不级联：

```bash
pi remove ~/.pi/agent/my-extensions/progress-widget
rm -rf ~/.pi/agent/my-extensions/progress-widget
```

Goal、Plan、Sub-agent 和 Todo 不会被自动卸载。

## 注册资源

- Widget key：`progress-widget:status`，位于编辑器上方。
- 快捷键：`Ctrl+Option+O`（Pi key：`ctrl+alt+o`），切换 Compact / Full View。
- 命令：`/progress-widget [compact|full|switch]`。
- Event bus：监听 `progress-widget:state`，并发送 `progress-widget:attach` / `progress-widget:release`。
- `session_start`、`session_shutdown` 生命周期处理器。

不注册 LLM 工具、CLI flag、provider、网络请求、timer、watcher、进程或 socket。

## 使用示例

```text
/progress-widget
/progress-widget full
/progress-widget compact
/progress-widget switch
```

每个 session 从 Compact View 开始。快捷键只切换 widget；Pi 的 `Ctrl+O` 独立控制 transcript 卡片展开。

Compact View 固定按 `Subagents → Plan → Todos → Goal → 输入框` 排列：Sub-agent 一行，活动 Plan 一行，Todo 最多两行，Goal 两行。Full View 使用相同区段顺序，显示仍有活动 Run 时的全部直接 Sub-agent ID、状态和 description、活动 Plan phase/reference、所有 Todo，以及完整 Goal。

### TUI 显示样式

- 区段标题使用主题 `accent` 色和粗体；统计、轮次等重要概要与 `Objective:` 标签同样使用 `accent` 强调色，但保持正常字重。
- 状态图标和 Sub-agent 状态词使用语义色：活动项为 `accent`、正在中断为 `warning`、完成为 `success`、失败或阻塞为 `error`，其余为 `muted`。
- 正文保持正常字重；活动与失败项使用 `text`，待处理、暂停和已结算项使用 `muted`，完成的 Todo 与 Goal 另加删除线。
- Sub-agent ID 使用 `dim`。颜色只作用于对应片段，不给整行统一着色，也不硬编码 RGB 或背景色。

若终端跟随系统切换浅色/深色外观，Pi 主题也应设置为 `light/dark` 或对应的自定义浅色/深色主题对。RPC 模式仍发送无 ANSI 样式的纯文本。

## 限制

- 只统计主 Agent 的直接 Sub-agent，不包含 descendants。
- Sub-agent 区段仅在存在 `running` 或 `interrupting` Run 时显示。
- Full View 不限制条目数，可能占用较多终端高度。
- Pi extension 快捷键不能通过 `keybindings.json` 重映射；若与其他 extension 冲突，可使用命令。
- 若本 extension 未启用，Goal、Plan、Todo 和 Sub-agent 各自显示 Compact fallback widget。

## 权限与副作用

不访问网络、文件、凭据或项目内容，不启动后台资源。仅使用 Pi event bus 和 UI API。

## 持久化

不持久化。视图模式、状态快照和投影所有权只存在于当前 session runtime；session 替换或 reload 后恢复 Compact View。

## 模式支持

| 模式 | 行为 |
| --- | --- |
| TUI | 完整 widget、快捷键和命令 |
| RPC | 通过 UI bridge 发送纯文本 widget；命令可切换视图，无快捷键 |
| JSON | 安全加载，不调用 UI |
| print | 安全加载，不调用 UI |

## 开发

```bash
npm run check
npm test
```

真实 smoke test 必须从 package 根目录加载，确认启动页只显示一次 `progress-widget`。

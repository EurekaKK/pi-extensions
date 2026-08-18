# context-management

为 Pi 提供与 DeepSeek Harness 对齐的上下文压缩：在发送前 spill 过大的纯文本 tool result，压力到达后再
按 head/tail 修剪 tool result，必要时用当前模型生成带固定结构的 Checkpoint。Pi session 仍是完整账本；
extension 只改模型可见投影，并把成功的 Checkpoint 持久化为原生 `CompactionEntry`。

本 extension 不注册 LLM 工具，也不提供 Repository Memory、Evidence Pack 或 `evidence_read`。

## 状态

`experimental`

配置项、压缩阈值和 spill 路径仍可能随 dsh / Pi 对齐而调整。

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和本机最新版 Pi。从仓库根目录安装本地 package：

```bash
pi install ./extensions/context-management
```

使用 `pi config` 启用或停用。卸载：

```bash
pi remove ./extensions/context-management
```

卸载不会删除 agent 配置、spill 文件或已写入 session 的 CompactionEntry。不要同时启用其他会改写 `context`
或接管 compaction 的 extension。

## 配置

首次加载时创建：

```text
<agentDir>/context-management/config.json
```

通常为 `~/.pi/agent/context-management/config.json`。目录权限 `0700`，文件权限 `0600`。默认内容：

```json
{
  "version": 1,
  "auto": true,
  "thresholdRatio": 0.8,
  "retainRatio": 0.16,
  "maxTokens": 8192,
  "compactionRetries": 1,
  "prune": {
    "thresholdChars": 8192,
    "headChars": 4096,
    "tailChars": 1024
  },
  "spill": {
    "maxInlineBytes": 50000
  }
}
```

- `auto`：是否在 `context` 屏障上自动 prune-then-summarize。`false` 时仍允许用户手动 `/compact`。
- `thresholdRatio` / `retainRatio`：相对当前模型 `contextWindow`。默认在 80% 窗口触发，保留约 16% 作为
  Protected Tail。`retainRatio` 必须小于 `thresholdRatio`。
- `maxTokens`：summarizer 输出上限，并与模型 `maxTokens` 取较小值。
- `compactionRetries`：压力压缩在一次成功 checkpoint 后若仍超阈值，额外再试的次数。
- `prune.*`：Unicode code point 计的 tool-result head/tail 修剪。修剪后长度必须 ≤ `thresholdChars`。
- `spill.maxInlineBytes`：纯文本 tool result 的 UTF-8 内联上限。

配置在加载时读取一次；修改后执行 `/reload`。文件损坏、未知字段或版本不支持时，extension fail-closed：不注册
命令和生命周期，有 UI 时在 `session_start` 提示一次。

## 注册资源

- 用户命令 `/context-management-status`
- `session_start`、`before_agent_start`、`context`、`agent_end`、`agent_settled`、`session_before_compact`、
  `session_compact`、`session_tree`、`session_shutdown`、`tool_result`

不注册 LLM 工具、键盘快捷键、CLI flag、widget、timer、watcher、进程或 socket。

## 管道

1. **Spill**（`tool_result`）：跳过内置 `read`，避免 read-spill-read 循环。仅处理纯文本；含图片的结果保持内联。
   超过 `maxInlineBytes` 时写入 spill 文件，模型可见内容改为 head/tail 预览加路径和召回说明：
   `Use read with offset/limit, or grep this path to search within it.` 写入失败则保持原文。
2. **Prune**：投影仍低于阈值时，只对已经修剪过的 `toolCallId` 重新应用 stub，避免大结果复活。达到
   `thresholdRatio` 后，对超过 `prune.thresholdChars` 的 tool result 保留 head + 固定标记 + tail。原生
   `/compact` 路径也会 prune。
3. **Summarize**：prune 后仍超阈值，且存在可压缩前缀时，用当前模型 replay 最近一次请求的 system prompt、
   active tools 和待压缩消息，再追加固定的八段 Compact 指令。输出经 framing 后替换前缀：
   preamble + `<compacted-summary>` + 正文 + `</compacted-summary>`。Checkpoint 必须比被替换前缀更短，否则
   失败。成功候选先进入内存投影，idle 后再通过 `context.compact()` 写成 CompactionEntry。

压力路径生成失败时发出 warning 并继续当前 turn，不会 abort provider 请求。手动 `/compact` 与 overflow 生成
失败时取消原生 compaction，不回退到 Pi 默认 summarizer。忽略 Pi 的 `focus` / `customInstructions` 和
`keepRecentTokens` 切点。手动和 overflow 按 dsh `retainTokens = 0` 只保留最新一个 conversation unit，并把该
边界作为 `firstKeptEntryId` 写回。Pi 因阈值触发的原生 compaction 使用 `retainRatio`。没有可压缩前缀则取消。

## 状态命令

`/context-management-status` 只读显示当前窗口、阈值、retain、投影、校准、tail range、已修剪 tool result
数量和 checkpoint 状态。它不触发 spill、prune 或 summarization。

## 模式支持

| 模式 | 行为 |
| --- | --- |
| TUI | 完整支持；同步压缩时显示 working message；通知可用 |
| RPC | 相同 spill / prune / compact 语义，不等待终端 UI |
| JSON | 相同语义，不显示 spinner |
| print | 相同语义，不等待交互 UI |

所有模式都安全加载。无 UI 时跳过 notify / working message。

## 权限、副作用与限制

- summarizer 会把 replay 后的会话发给当前模型 provider；没有额外遥测或后台上传。
- Compactor 请求 timeout 为 5 分钟；关闭 provider SDK 内层 retry，并对 transient error 最多 3 次指数退避。
  另加一次机械 validation regeneration。请求响应 `AbortSignal`。
- spill 文件位于 `<agentDir>/context-management/spill/<session-hash>/`，目录 `0700`、文件 `0600`。内容是
  工具输出明文。卸载或结束 session 后不会自动删除；不再需要时可手动删除该目录。
- Checkpoint 只通过 Pi 原生 CompactionEntry 持久化。estimator calibration、pending checkpoint 和已修剪
  `toolCallId` 只存在内存，随 session/tree/shutdown 重置。
- 不提供 Memory、Evidence 引用、后台预压缩、独立便宜 summarizer，也不改写 Pi session 中的原始消息。
- 不假设自己与其他 context/compaction owner 共存。

## 持久化

- `<agentDir>/context-management/config.json`：部署级配置。
- `<agentDir>/context-management/spill/...`：溢出的 tool result 原文。
- Pi session `CompactionEntry.details`：`context_management.compaction.details.v1`，含 coverage 与
  fingerprint。无法校验的 compaction 按 opaque legacy checkpoint 使用。

## 开发

在 package 目录运行：

```bash
npm run check
npm test
```

真实加载 smoke test 必须从 `extensions/context-management/` package 根入口加载，确认 Pi 只解析根
`index.ts`，启动页只显示一次 `context-management`：

```bash
smoke_root="$(mktemp -d)"
mkdir "$smoke_root/agent"
PI_AGENT_DIR="$smoke_root/agent" pi --offline --no-session --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-extensions -e ./index.ts --verbose
rmdir "$smoke_root/agent" "$smoke_root"
```

在空输入处按 `Ctrl-D` 退出。最后两个 `rmdir` 只会删除仍为空的 smoke 目录。

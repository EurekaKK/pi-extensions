# sub-agent

在一个交互式 Pi session 中创建最多八个并发 Child Agent。每个 Child Agent 保留自己的对话上下文；父 Agent
通过显式 `wait` 拉取终态报告，报告不会异步插入父对话。

该 extension 适合可独立委派的代码调查、实现和验证。它不是权限沙箱、任务队列、跨 session 作业系统或远程
执行服务。

## 状态

`experimental`

## 安装、启用与卸载

要求 Node.js `>=22.19.0`、POSIX 平台和本机最新版 Pi。package 安装时会预编译 Guardian/Worker sidecar：

```bash
pi install ./extensions/sub-agent
```

通过 `pi config` 启用或停用。卸载：

```bash
pi remove ./extensions/sub-agent
```

卸载不会删除用户配置；不再需要时可手动删除实际 Pi agent dir 下的 `sub-agent/` 目录。

## 配置

首次受支持的交互式 `session_start` 会通过 Pi `getAgentDir()` 创建：

```text
<agent-dir>/sub-agent/config.json
```

默认内容：

```json
{
  "version": 1,
  "model": "inherit",
  "thinkingLevel": "inherit",
  "requiredExtensionPaths": []
}
```

- `model` 可设为固定的 `{ "provider": "...", "id": "..." }`。
- `thinkingLevel` 可设为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。
- `requiredExtensionPaths` 是必须在 Child runtime 中成功重新加载的绝对、file-backed extension 入口。

配置是最多 64 KiB 的严格 UTF-8 JSON，不接受未知字段、JSONC、隐式转换或自动迁移。目录权限为 `0700`，
新文件为 `0600`；已有文件永不覆盖或重排。当前 session 使用启动快照，修改后执行 Pi `/reload`。

固定模型不存在、未认证，或模型不精确支持期望 thinking level 时，spawn 会失败，不会 fallback 或静默
clamp。

## 注册资源

六个可并行调用的 LLM 工具：

- `subagent_spawn`：创建 Agent 并启动首个 run。
- `subagent_send`：只向 `IDLE` Agent 发送一个新 run；忙时不排队。
- `subagent_wait`：按 run ID 以 `any`/`all` 拉取终态 delivery。
- `subagent_list`：列出 Agent 或未读 delivery 元数据，不读取报告正文。
- `subagent_cancel`：对精确的 active run 请求协作取消。
- `subagent_kill`：只移除 `IDLE` Agent，不中断正在执行的任务。

人类命令：

```text
/subagent list
/subagent cancel <agentId> <runId>
/subagent kill <agentId> <lastRunId>
/subagent config
```

extension 还注册 session lifecycle、父状态 transient、`tool_result`、`turn_end` 和 `agent_settled` hooks。
不注册 watcher、socket、遥测、快捷键或后台上传。

### 模型可见结果与完整 details

Pi 父模型只接收工具结果的 `content`；`details` 面向 UI、测试和程序化消费者，是完整的权威数据。管理工具因此
同时维护两个兼容但职责不同的视图：

- `subagent_list` 的 `content` 是单行紧凑 JSON，包含下一次管理调用所需的 Agent/delivery ID、状态、计数、
  顺序和 `nextCursor`。它不包含 Child report 正文、完整模型配置、extension path 或 worker generation；
  完整诊断字段仍只在 `details` 中。
- 管理错误的 `content` 首行固定为
  `SUBAGENT_ERROR code=<CODE> operation=<OPERATION> sideEffects=<SIDE_EFFECTS> retry=<RETRY>`，其值与
  `details` 一致；后续行保留面向人的 message 和 guidance。调用者应按稳定 code 分支，不应解析自然语言。
- spawn 在 extension 降级或工具不可用时，会在现有成功文案后追加有界的紧凑 JSON 警告摘要；未降级时不追加。
  未截断的诊断数据保留在 `details`。
- wait 超时时，会在现有说明后追加紧凑 JSON，列出 mode、timeout 和仍 pending 的 run ID/state。timeout 仍只是
  观察结果，不会取消 run。

`content` 是模型的操作摘要，不替代 `details`；程序化消费者需要完整诊断数据时仍应读取 `details`。

## 使用示例

概念性工具调用：

```text
subagent_spawn({
  "task": "审阅缓存失效逻辑，给出有文件和行号依据的风险报告",
  "label": "cache audit",
  "projectContext": "inherit"
})
```

保存返回的 `agentId` 和 `runId`，然后拉取：

```text
subagent_wait({
  "runIds": ["run_..."],
  "mode": "all",
  "timeoutMs": 30000
})
```

timeout 只是观察结果，不取消 run。终态正文只交付一次；不确定未读 ID 时：

```text
subagent_list({ "view": "deliveries" })
```

复用 Child 的私有上下文：

```text
subagent_send({
  "agentId": "agent_...",
  "message": "根据刚才的审阅修复第一个问题并运行定向测试"
})
```

`cancel` 成功后仍须 `wait` 取得 `CANCELLED`、`FAILED`、`RESULT` 或 `LOST` 终态。`kill` 只接受当前
`lastRunId` 匹配的 `IDLE` Agent。

## 运行语义与限制

- 只支持深度一：Child capability 会移除六个 `subagent_*` 管理工具。
- 每个 session 最多八个 `RUNNING`/`CANCELLING` run；工具并行调用由 Manager 原子协调。
- Child 只获得父端冻结的可信 project context，不获得父对话历史。`projectContext: "none"` 不注入该快照。
- 默认工具能力是父端工具名与可重新加载 Child registry 的交集。显式 `tools` 是硬要求；缺失即 spawn 失败。
- Child extension 初始化最多执行一次干净降级重建。第三方 extension factory 或 lifecycle 已产生的外部副作用
  不保证可回滚。
- success report 最大 256 KiB；单次 wait 最终文本最大 1 MiB。Child thinking、中间 stream、tool 参数和
  tool result 不会交付给父 Agent。
- report 是不可信模型文本。delivery 信封中的 ID/outcome 和结构化 details 才是 Manager 权威状态；正文中的
  保留控制标记会被转义。父模型使用 `content` 中的 delivery 信封操作；UI、测试和程序化消费者可用
  `details` 交叉核对完整状态。
- Guardian/Worker 或 IPC 丢失会在进程组清理确认后产生 `LOST`；这不表示 Child 没有发生外部副作用。
- Agent 不跨 Pi session 恢复。reload/session shutdown 会停止 sidecar 并删除 session 临时 spool。
- 当前 Pi 公共 API 的 tool execute result 不支持直接设置 `isError`。本 extension 通过自己的
  `tool_result` hook 修正失败 delivery 和管理错误；更早加载的 sibling hook 可能先看到 Pi 的初始
  `isError: false`。最终持久化结果及后续 hooks 会看到修正值。

## 权限与副作用

父进程按需启动一个 detached Guardian；Guardian 启动一个 detached Worker process group。每个 Child
Agent 在 Worker 内使用独立 Pi `AgentSession`，但共享父 session 的工作目录，所以继承的工具和 extension
可以读写同一项目、启动命令或访问网络。

本 extension 自身：

- 读取 Pi settings、`auth.json`/`models.json` 所在 agent 环境以及已启用 extension 入口；
- 在 `<agent-dir>/sub-agent/config.json` 写入默认配置（只在文件缺失时）；
- 在 OS 临时目录创建 `0700` session spool，并写入 `0600` report 文件；
- 启动并在 shutdown、父 lease EOF、协议破坏或 worker loss 时回收 Guardian/Worker 进程组；
- 不主动请求网络、不上传数据、不记录独立日志。

网络请求可能来自 Child 模型 provider、继承工具或继承 extension。required/optional extension lifecycle 也
可能产生它们自己的外部副作用。

## 持久化与清理

唯一跨 session 持久化是用户配置。Agent、run、mailbox、cancel 状态和 pagination cursor 都只属于当前
Manager epoch。

成功报告先原子写入临时 spool；Parent 校验 owner、mode、路径、size 和 SHA-256 后才 commit 为 `READY`。
`wait` 在返回前再次以 no-follow file descriptor 复验。delivery 经
`READY → CLAIMED → AWAITING_PERSISTENCE`，只有父 `turn_end` 同时确认 tool result 和 SessionManager branch
entry 后才不可逆地成为 `DELIVERED` 并删除 spool。未持久化则回滚为 `READY`。

正常 shutdown 会删除整个私有 spool。进程崩溃时 Guardian 依靠父 lease EOF 清理；系统强制断电后遗留的 OS
临时目录可按平台临时文件策略清理。

## 模式支持

只有 TUI interactive 模式执行管理操作。RPC、JSON 和 print 模式仍可安全加载并注册同样的工具，但调用会
快速返回 `SUBAGENT_UNSUPPORTED_MODE`，不会创建配置、临时目录或子进程，也不会等待 UI。

当前实现依赖 POSIX process group、negative-PGID signal 和 no-follow 文件语义；Windows 会安全加载并返回
`SUBAGENT_UNSUPPORTED_PLATFORM`。

## 开发

```bash
npm run check
npm test
```

`npm run build:sidecar` 单独把 `sidecar/*.ts` 编译到 `dist/sidecar/`。`prepare`、`prepack` 和测试前置步骤
都会构建 sidecar。真实加载 smoke test 必须从 package 根目录执行，确认 Pi 只解析 `index.ts`，启动页名称为
`sub-agent`。

# sub-agent

在父 Pi 进程中创建并管理独立的子 Agent。子 Agent 拥有自己的 Pi `AgentSession`、模型上下文和持久
session；父模型通过 dsh 风格工具委派、继续、发现和中断它们。

v2 移除了 v1 的 Guardian/Worker sidecar、IPC、mailbox 和 spool，全部 child 都在父进程内运行。

## 状态

`experimental`

功能和工具契约仍可能根据实际使用反馈调整。

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和本机最新版 Pi。从仓库根目录安装本地 package：

```bash
pi install ./extensions/sub-agent
```

使用 `pi config` 启用或停用。卸载：

```bash
pi remove ./extensions/sub-agent
```

卸载不会删除配置或 child session 文件。

## 配置

配置位于：

```text
<agentDir>/sub-agent/config.json
```

通常为 `~/.pi/agent/sub-agent/config.json`。首次加载自动创建默认配置：

```json
{
  "version": 2,
  "delegationTools": [
    {
      "toolName": "subagent",
      "provider": "spawn",
      "backgroundMode": "continuable",
      "maxDepth": 3,
      "agentOptions": {
        "model": "inherit",
        "thinkingLevel": "inherit"
      },
      "toolFilter": null,
      "persona": null
    },
    {
      "toolName": "subagent_fork",
      "provider": "fork",
      "backgroundMode": "one-shot",
      "maxDepth": 3,
      "agentOptions": {
        "model": "inherit",
        "thinkingLevel": "inherit"
      },
      "toolFilter": null,
      "persona": null
    }
  ],
  "reportDelivery": "wakeup"
}
```

- `delegationTools`：每个委派工具实例一个配置；`toolName` 是模型看到的工具名。
- `provider`：`spawn` 或 `fork`。
- `backgroundMode`：`continuable`（省略 `run_in_background` 时后台）或 `one-shot`（默认前台）。
- `maxDepth`：该工具实例的委派深度上限，root 为 0。
- `agentOptions`：该工具实例的 child 默认 model 与 thinking level。
- `toolFilter`：该工具实例的 child 工具过滤，可选 `{ "allow": [...], "deny": [...] }`。
- `persona`：该工具实例给 child 追加的 system prompt section。
- `reportDelivery`：`wakeup` 或 `quiet`。

配置修改后执行 `/reload` 生效。v1 配置不会被迁移；`version` 必须是 2。

## 注册资源

父侧工具：

- `subagent`：spawn 子 Agent，默认后台 continuable。该工具带一条 dsh 风格 `promptGuidelines`：默认后台、同一条消息并行开启独立委派，只有下一步依赖结果时才前台等待。
- `subagent_fork`：fork 父已完成轮次，默认前台 one-shot。
- `send_message`：继续一个后台子 Agent 的会话。
- `interrupt_agent`：中止目标 Agent 当前轮次。
- `list_agents`：列出直接子 Agent 或整棵委派树。

continuable child 额外注册 `report`，父 Agent 不可见。

## 使用示例

启动后台子 Agent：

```text
subagent({ "description": "cache audit", "prompt": "审阅缓存失效逻辑并给出风险报告" })
```

返回：

```text
started subagent <childId>
```

这段原始工具结果仍会提供给父模型，保证它能用 child ID 继续控制 Agent。TUI 卡片采用更可读的展示：调用行和
折叠结果以 `description` 为主，后台任务显示 `Started · <description>`；child ID 只在展开卡片时显示。前台任务
显示 `Completed · <description>`，折叠时附带结果首行，展开后显示完整结果。

等待结算通知，或继续发送消息：

```text
send_message({ "subagent_id": "<childId>", "message": "根据刚才的审阅修复第一个问题" })
```

前台等待结果：

```text
subagent({ "description": "...", "prompt": "...", "run_in_background": false })
```

基于当前父对话 fork：

```text
subagent_fork({ "description": "follow-up review", "prompt": "审阅上一轮结论并补充测试" })
```

## 运行语义

- child 共享父工作目录，不是沙箱；可以读写项目、执行 bash、访问网络。
- child `hasUI: false`，不能向用户提问或请求 UI 权限。
- spawn child 看不到父对话；fork child 只继承父已完成轮次。
- 父模型只收到 child 最终文本、`report` 和结算通知；child 中间步骤留在 child session。
- `interrupt_agent` 只停当前轮次，保留 child、已排队消息和后代。
- 超过 `maxDepth` 的委派在启动时拒绝。

## 持久化与清理

continuable child session 保存在：

```text
<agentDir>/sub-agent/sessions/<parentSessionId>/<childId>.jsonl
```

父 session 存活期间，`send_message` 可以冷恢复 child。父 session shutdown 后文件保留，不会自动恢复
执行。不再需要时可手动删除对应 `<parentSessionId>` 目录。

## 模式支持

| 模式 | 前台 subagent / subagent_fork | 后台 continuable | list_agents | send_message / interrupt_agent |
| --- | --- | --- | --- | --- |
| TUI | 支持 | 支持 | 支持 | 支持 |
| RPC | 支持 | 支持 | 支持 | 支持 |
| JSON | 支持 | 不支持 | 支持 | 不支持 |
| print | 支持 | 不支持 | 支持 | 不支持 |

## 开发

```bash
npm run check
npm test
```

真实加载 smoke test 必须从 package 根目录执行，确认启动页显示 `sub-agent`。

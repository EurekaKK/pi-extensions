# sub-agent 特殊约束

- v2 不使用 sidecar 进程；不要重新引入 `sidecar/`、`dist/sidecar/`、IPC 协议或 mailbox/spool。
- child 通过 Pi 公开 `createAgentSessionServices()` / `createAgentSessionFromServices()` 在父进程内创建。
- child session 文件只写入 `<agentDir>/sub-agent/sessions/<parentSessionId>/`；不得写 extension 源码目录。
- extension factory 会在每个 child session 中重新执行；模块级状态必须并发安全。
- 默认测试使用 `fauxProvider` 和临时目录，不得访问真实 `~/.pi`、凭据、模型或网络。
- 修改 child 生命周期、并发、深度、冷恢复或结算通知时，必须增加针对性回归测试。

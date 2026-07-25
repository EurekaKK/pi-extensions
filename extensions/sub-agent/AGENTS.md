# sub-agent 特殊约束

- `sidecar/*.ts` 是源码，`dist/sidecar/*.js` 是运行时直接依赖且必须跟踪的构建产物；修改 sidecar 后必须重新构建并保持两者同步。
- `test/e2e/` 只用于本地真实环境验证，整个目录不得暂存或提交。
- 当前实现只面向 POSIX；除非用户明确要求，不增加 Windows 兼容逻辑。
- 进程生命周期、并发状态、取消、kill 和 session 清理属于核心不变量；相关修改必须有针对性回归测试，并验证 shutdown 后没有子进程继续运行。

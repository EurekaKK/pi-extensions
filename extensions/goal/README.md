# goal

为 Pi 提供 dsh 风格的 session 目标管理。目标由模型工具和用户命令共同维护；active + armed 的目标在 Agent
idle 后由 Goal Round Driver 自动继续，无需独立 evaluator。

当前 goal 的 phase、round、activation 和 objective 通过 `goal.status` widget 在编辑器上方常驻显示，与 Todo
进度区位于同一区域。

## 状态

`experimental`

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和本机最新版 Pi。安装采用 npm 式两步：先从仓库根目录把 package
复制到 `~/.pi/agent/my-extensions/goal/`，再登记该副本。仓库脚本一步完成：

```bash
scripts/install-extension.sh goal
# 等价于：
#   rsync -a --delete --exclude node_modules --exclude .DS_Store \
#     extensions/goal/ ~/.pi/agent/my-extensions/goal/
#   rsync 本仓库内部依赖（packages/*）到副本的 node_modules/
#   pi install ~/.pi/agent/my-extensions/goal
```

本包依赖仓库内部的 `config-store` 包；Pi 对本地路径安装不运行 `npm install`，脚本会把依赖一并复制进副本。

使用 `pi config` 启用或停用。卸载：

```bash
pi remove ~/.pi/agent/my-extensions/goal
rm -rf ~/.pi/agent/my-extensions/goal
```

卸载不会修改已有 Pi session。

## 配置

配置位于：

```text
<agentDir>/goal/config.json
```

通常为 `~/.pi/agent/goal/config.json`。首次加载自动创建默认配置：

```json
{
  "version": 1,
  "defaultMaxGoalRounds": 256,
  "blockedAfterConsecutiveRounds": 3
}
```

- `defaultMaxGoalRounds`：创建目标时未显式指定 round cap 时使用的默认值。
- `blockedAfterConsecutiveRounds`：Goal Round 内模型自主 `blocked` 的最小连续 round 数。三条 goal 工具的 `promptGuidelines` 会写入这个数字，并说明困难、不确定或仍有工作可做不等于 blocked。

配置修改后执行 `/reload` 生效。配置损坏时 goal 工具和命令不会注册。

## 模型工具

- `get_goal`：读取当前目标、CAS ref、phase、rounds 和 activation。
- `create_goal(objective, max_goal_rounds?)`：在当前直接人类轮次创建目标。
- `update_goal(goal_id, revision, action, ...)`：edit / pause / resume / complete / blocked。

所有更新必须使用 `get_goal` 返回的精确 `goal_id` 和 `revision`。三条工具共用一条 `promptGuidelines`，内容随 `blockedAfterConsecutiveRounds` 生成。

## 用户命令

```text
/goal
/goal <objective>
/goal edit <objective>
/goal pause
/goal resume
/goal clear
```

裸 `/goal` 显示当前状态：

```text
Status: active
Objective: ...
Rounds: 3/256
Activation: armed

Commands: /goal edit <objective>, /goal pause, /goal clear
```

## Goal Round

active + armed 的目标在 Agent settled 后自动注入：

```text
<goal_round>
Objective: "..."
Round: 4/256

Continue working toward the objective in this same session...
</goal_round>
```

- 每个 round 消耗一次 `roundsStarted`。
- 达到 `maxGoalRounds` 后自动 block，code 为 `round-limit`。
- 模型完成目标时调用 `update_goal complete`；被阻塞时调用 `update_goal blocked`。

## UI 进度区

`goal.status` widget 位于编辑器上方：

- 第一行显示 phase、已开始 round/上限和 activation；blocked 时附带 blocker code。
- 第二行显示 objective，并按 active、paused、blocked、complete 使用不同状态标记。
- `/goal` 命令或 goal mutation 工具成功后立即刷新。
- active、paused、blocked 和 complete 都保留显示；只有 `/goal clear`、目标 branch 不存在 goal 或 session
  shutdown 时清除。

TUI 使用宽度感知组件；RPC 通过 UI bridge 发送相同的纯文本两行。JSON 和 print 模式不调用 UI。

## 恢复与 fork

goal 内容、phase、revision 和 round 数会随 session 持久化。session 恢复、fork 或 tree navigation 后：

- goal 状态保留；
- `activation` 变为 `disarmed`；
- 必须用户显式 `/goal resume`，或在直接人类轮次中让模型 `update_goal resume`。

## 状态

持久 phase 只有：

```text
active | paused | blocked | complete
```

进程内 activation 只有：

```text
armed | disarmed
```

## 持久化

- `goal:change`：每次 mutation 追加完整快照或 clear tombstone。
- `goal:round`：记录已准入的 Goal Round。

v1 的 evaluator、lifecycle entries、evaluation entries 和 snapshot 数据不兼容、不迁移。

## 模式支持

| 模式 | goal 工具 | /goal command | Goal Round Driver | 进度 widget |
| --- | --- | --- | --- | --- |
| TUI | 支持 | 支持 | 支持 | 编辑器上方常驻 |
| RPC | 支持 | 按 Pi 命令能力 | 支持 | 通过 UI bridge |
| JSON | 支持 | 不支持 | 不支持 | 不显示 |
| print | 支持 | 不支持 | 不支持 | 不显示 |

## 开发

```bash
npm run check
npm test
```

真实加载 smoke test 必须从 package 根目录执行，确认启动页显示 `goal`。

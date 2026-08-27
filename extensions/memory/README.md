# memory

为精确的 Working Directory 保存并动态召回本地长期记忆（Directory Memory）。本 extension 正处于分阶段实现中：
#7 + #8 打通完整的写入/读取路径——在前台直接人类轮次中，primary Agent 通过 `memory_write`（`add` 或
`supersede`）提交一条经过验证的 Memory Record，收到含完整内容的 Memory Write Receipt；#9 提供有界、确定性的
本地词法搜索（`memory_search` / `memory-search`）与 active 记录列表（`memory-list`）：Agent 与用户先搜出紧凑结果，
再用 `memory_read` 或 `memory-read` 命令精确读取完整记录（含显式指定 superseded revision）。自动召回与遗忘由后续
issue 提供，README 中标记为「尚未实现」。

## 状态

`experimental`

Store 格式、配置字段和命令输出仍可能调整。README 的完整版（含真实性风险说明与正式文档）由 #13 收尾；
本文件是面向当前实现范围的过程性说明。

## 设计要点（当前已实现）

- **Directory Identity**：当前 Working Directory 的规范 real path（`realpath`）。符号链接别名收敛到同一身份；
  父、子、兄弟目录互不相同；目录移动时 Store 自然跟随，无 agent 全局注册表。写入/读取都以该规范身份定位
  Store，provenance 记录写入时的规范目录身份。
- **Store 位置**：`<cwd>/<CONFIG_DIR_NAME>/memory/store.json`（当前 Pi 的 `CONFIG_DIR_NAME` 为 `.pi`），
  即每个目录自己的 Pi 配置区内，不放在 Pi agent 目录，也没有全局目录注册表。
- **严格版本化 Store**：单个版本化 JSON 文档（`version: 1`、`schema: memory.store.v1`、单调 `revision`、
  目录元数据、记录数组）。记录包含身份、版本、active/superseded 状态、摘要、内容、supersedes 引用、来源
  （provenance）与时间戳。
- **首次写入安全初始化**：Store 缺失时，第一次写入在同一事务内创建 `0700` 的 Store 目录（支持的平台上）、
  作用域 ignore 标记 `<storeDir>/.gitignore`（内容 `*`，使 Store 默认排除在 Git 之外；已有用户标记时原样
  保留，绝不覆盖）与 `0600` 的 `store.json`。
- **记录身份与幂等**：记录 id 由规范化后的 content+summary 的 SHA-256 确定性派生（`memory-<hex>`）。
  完全相同（规范化后）的 content+summary 再次写入返回 no-op 收据，Store revision 与文件字节均不变；
  任一字段不同则新增记录。不同规范形态（CRLF/LF、分解/预组合 Unicode）被归一化后视为相同。
- **Auditable supersede（#8）**：`memory_write` 的 `operation: "supersede"` 在同一个 add 事务管线内执行，
  不新增独立写入路径。请求必须携带精确的 `targetId` 与 `targetRevision`（当前 active 记录的 id 与 revision）
  以及完整替代 content 与可检索 summary。成功时仅在追加处新增一个不可变 revision（`revision = target.revision + 1`、
  `supersedes: {id, revision}`、完整 provenance），并把目标记录的 `state` 改为 `superseded` 而不改动其历史
  content/provenance；Store revision 只递增一次，链的 leaf 保持 `active`。目标缺失（`MEMORY_TARGET_NOT_FOUND`）、
  目标 revision 陈旧（`MEMORY_TARGET_STALE`）、目标已被 supersede（`MEMORY_TARGET_INACTIVE`）以及替代
  content+summary 派生的记录身份与其他记录冲突（`MEMORY_IDENTITY_COLLISION`）都在任何文件写入前被事务性拒绝，
  绝不产生字节变更；add 携带 target 字段、supersede 缺少任一 target 字段则报 `MEMORY_INPUT_REJECTED`。与目标
  规范化后完全相同的替代按既有幂等策略返回 no-op。并发对同一目标的 supersede 由 `withFileMutationQueue` 串行化，
  只有一个能提交，另一个收到 inactive 错误，Store 保持一致。
- **输入规范与捕获策略**：写入前对 summary/content 做确定性归一化（CRLF/CR → LF，NFC 组合），并拒绝
  空内容、超长内容、控制字符（保留 tab 与换行）以及保守检测的 secret-like 内容（私钥、`sk-`/`AKIA`/`ghp_`/
  `xoxb-`/Bearer 和 password/api-key 赋值等常见凭据形态）。策略拒绝不会产生任何 Store 变更。
- **写入权限**：`memory_write` 只在前台直接人类轮次可用——`input` 事件 source 为 `interactive` 或 `rpc`
  时授权；extension source input、extension custom follow-up，以及 `agent_settled`、`session_start`、
  `session_tree`、`session_shutdown` 都会 fail-closed 复位。
  session 分支上持久存在 `subagent:descriptor`（sub-agent extension 写入）时拒绝写入但读取保持可用；该字符串是
  两个源码隔离 extension 之间的持久 session protocol，未形成安装依赖，任一侧改名时必须同步更新并回归测试；
  `proactiveWrites: false` 配置直接拒绝写入。`memory_read`、`memory_search`、`memory-search` 与
  `memory-list` 不做权限检查，任何来源（含 subagent）都可搜索与读取。
- **有界确定性搜索（#9）**：`memory_search` 只检索 active 记录；superseded 记录永不进入搜索结果，但
  `memory_read` 仍可按精确 id（+revision）读取历史。排序完全由模型无关的纯词法相关性决定：查询与记录先做
  NFKC 兼容归一化 + 小写折叠，Unicode 拉丁字母（含组合标记）与数字连续段为词元，任意其他字符（含标点、
  连字符、下划线）都是分隔符，所以 `npm-workspaces`、`npm, workspaces`、`npm workspaces` 等价；Han（CJK
  表意，覆盖当前 Unicode Unified Ideograph 扩展范围）连续段每个字产生一个词元并
  对相邻字对产生重叠 bigram，单字段只产生单字词元，混合 CJK/Latin 与孤立单字因此都是确定性的。相关性分数是
  整数：对每个查询词元累加「查询出现次数 ×（摘要次数 × `SUMMARY_WEIGHT`(2) + 内容次数）」，重复词与服务端重复
  出现都被放大，摘要匹配显式高于内容匹配；零词法重叠的记录被排除，绝不拿最新记录填充结果。排序先按分数降序，
  同分才按 recency（`updatedAt`、再 `createdAt`，均降序）作确定性 tie-break，最后按 `id` 升序、`revision` 升序，
  recency 永远不能把不相关的新记录抬到旧记录之上。结果数受 `recall.maxRecords`（及工具可选 `limit`，取两者
  较小值）约束；query 受 `store.maxSummaryChars` 字符上限约束。渲染文本受 `recall.maxChars` 字符预算约束，
  超出部分显式报告 `omittedCount`（记录预算之外）
  与 `truncatedCount`（字符预算之外）并在文本尾部注明。紧凑结果只含 id/revision/summary/provenance/score/
  时间戳，绝不包含完整 content；`memory_search` 与两个命令都是同一只读 Store 路径上的薄适配器，无写入权限、
  无独立语义。无 embeddings/向量库/SQLite/网络/重排模型/provider/watcher，也不新增运行时依赖。
- **事务与原子提交**：每次写入都是一个完整的「读取—校验—变更—原子写回」事务，整体包在 Pi 的
  `withFileMutationQueue(storePath, ...)` 中，因此并发写入串行化、不丢失更新。提交使用 Store 同目录下的
  独占临时文件（`O_EXCL`）、flush/sync 后原子 rename；任何失败（写入、sync、rename、取消）都会清理临时
  文件并保持先前 Store 字节权威。
- **fail-closed Store 处理**：corrupt / unreadable / over-limit / unsupported-version 的 Store 绝不会被
  当作空 Store 覆盖；写入与读取都报对应稳定错误。目录移动后 Store 随目录保留，下一次成功写入会把 Store
  的目录元数据更新为当前规范 Directory Identity，无需全局迁移注册表。
- **不可变记录与收据**：每条记录携带不可变 provenance——来源 session、可用的当前 leaf entry、规范
  Directory Identity，author 固定为 `primary-agent`。每次 `memory_write` 返回含完整持久化内容、记录身份、
  来源与 outcome（added / no-op / superseded，superseded 一并携带新记录与替换掉的旧记录）的收据
  （`memory:write-receipt`）；`memory_read` 返回结构化结果
  （`memory:read-result`）。工具结果同时提供紧凑/展开两种 TUI 渲染，RPC/JSON/print 模式不等待 UI。
- **无信任门槛（维护者决定）**：本版本不要求 Pi project trust，也不引入第二套信任系统；由 #4 规格提出的
  真实性风险将在 #13 的正式文档中说明。

## 尚未实现

- 自动召回（before-agent-start 注入）、可见指纹去重与 `memory_forget`（物理遗忘）。

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和本机最新版 Pi。安装采用 npm 式两步：先从仓库根目录把 package 复制到
`~/.pi/agent/my-extensions/memory/`，再登记该副本。仓库脚本一步完成：

```bash
scripts/install-extension.sh memory
```

Pi 对本地路径安装不运行 `npm install`；仓库脚本会先解析完整安装计划，再镜像 package，并把本包声明的内部
package 代码依赖（`config-store`）递归 vendor 进副本。

使用 `pi config` 启用或停用该 extension。卸载：

```bash
pi remove ~/.pi/agent/my-extensions/memory
rm -rf ~/.pi/agent/my-extensions/memory
```

卸载不会删除部署配置，也不会修改已有 Pi session。不再需要时，可手动删除 `<agentDir>/memory/config.json`。

## Extension 依赖

无安装期依赖（不声明 `piExtensionDependencies`）。运行期代码依赖仅仓库内部包 `config-store`，由安装脚本
vendor；`@earendil-works/pi-ai`、`@earendil-works/pi-tui`、`typebox` 与 `@earendil-works/pi-coding-agent`
均为 Pi 提供的 peer 依赖。

## 配置

部署配置严格、带版本，位于 Pi agent 目录（不是项目目录）：

```text
<agentDir>/memory/config.json
```

首次加载时自动创建。默认内容：

```json
{
  "version": 1,
  "schema": "memory.config.v1",
  "proactiveWrites": true,
  "automaticRecall": true,
  "store": {
    "maxStoreBytes": 1000000,
    "maxRecords": 500,
    "maxContentChars": 2000,
    "maxSummaryChars": 200
  },
  "recall": {
    "maxRecords": 8,
    "maxChars": 6000
  },
  "git": {
    "diagnosticTimeoutMs": 2000
  }
}
```

- `proactiveWrites`：写入开关（默认开启；关闭后 `memory_write` 报
  `MEMORY_WRITE_DENIED`，读取工具不受影响）。`automaticRecall` 为后续版本的独立开关。
- `store.*`：Store 文档与记录的规模上限。写入同时受内容/摘要字符上限与记录数上限约束；
  落盘文档还受 `maxStoreBytes` 字节上限约束。
- `recall.*`：搜索与列表的预算——`maxRecords` 是单次 `memory_search`/`memory-list` 返回的记录数上限
  （工具可选 `limit` 超过它会被钳制），`maxChars` 是模型可见渲染文本的字符预算，超出部分显式截断。
- `git.diagnosticTimeoutMs`：Git 跟踪诊断的短超时。

以上数值均为**实验性默认策略**，后续评测可能调整，不视为公共契约。配置在整个进程加载一次，修改后执行 Pi
`/reload`。配置文件损坏、版本/字段非法、超限或不可读时，extension **fail-closed** 停用：不注册任何命令或
工具，有 UI 时最多提示一次清除过敏感信息的警告。

## 注册资源

当前注册：

- LLM 工具 `memory_write`（add / supersede；仅 primary 前台 Agent）、`memory_read`（精确读取，无权限限制）、
  `memory_search`（有界词法搜索，无权限限制）。
- 用户命令 `memory-status`（只读诊断）、`memory-read <record-id> [<revision>]`（精确读取的便捷命令）、
  `memory-search <query...> [--limit <n>]` 与 `memory-list [<limit>]`（搜索与 active 列表的便捷命令，复用
  同一只读 Store 逻辑，无独立语义）。
- 无 UI widget、无 custom entry、无消息渲染器；工具结果的紧凑/展开渲染随工具注册。

## 使用

工具调用示例（`memory_write`）：

```text
memory_write(operation="add", summary="Build uses npm workspaces", content="The monorepo is managed with npm workspaces; never mix pnpm or Yarn.")
```

成功收据（模型可见文本，含完整内容）：

```text
memory_write · added (Store revision 0 → 1)

Record: memory-<hex>
Revision: 1
State: active
Directory: /path/to/project
Provenance: session <session-id> · entry <entry-id> · primary-agent

Summary: Build uses npm workspaces
Content:
The monorepo is managed with npm workspaces; never mix pnpm or Yarn.
```

完全相同的记忆再次写入时收据头部为 `memory_write · no-op (identical memory is already present; Store unchanged)`，
Store revision 与文件字节不变。

修正一条过时的记忆（supersede）：

```text
memory_write(operation="supersede", targetId="memory-<hex>", targetRevision=1,
             summary="npm workspaces (corrected)",
             content="The monorepo uses npm workspaces; pnpm is allowed in strict mode.")
```

成功收据为 `memory_write · superseded (Store revision 1 → 2)`，结构化 details 含 `outcome: "superseded"`、新记录
`record` 与替换掉的 `replaced`（目标 revision，`state: "superseded"`）；模型可见文本同时展示新记录与「Replaced record」
两段完整 content、身份与关系元数据，不隐藏任何一方的持久化内容。与目标规范化后完全相同的替代返回 no-op 收据
（`... identical correction ...`），Store 不变。

读取：

```text
memory_read(id="memory-<hex>")
/memory-read memory-<hex>
```

- 未找到时工具与命令都报告稳定错误码 `MEMORY_RECORD_NOT_FOUND`（命令输出 `... was not found`）。

搜索与列表：

```text
memory_search(query="npm workspaces", limit=5)
/memory-search npm workspaces --limit 5
/memory-list
/memory-list 5
```

- `memory_search` 只检索 active 记录，按词法相关性排序（见「设计要点」），返回紧凑命中：
  id/revision/summary/provenance/score/时间戳，不含完整 content。
- `memory-search` 命令把 `--limit <n>` 之外的整段参数当作查询（数值开头的查询不会被当作 limit，位置无歧义）；
  非法参数输出 `Usage: /memory-search <query...> [--limit <n>]`。`memory-list` 按 recency 列出 active 记录，
  `[<limit>]` 为可选整数。
- 结果文本示例：

  ```text
  memory_search · 2 matches for "npm" (limit 8 · 1 omitted)
  1. memory-<hex> (revision 1 · score 4 · updated 2025-01-02T00:00:00.000Z)
     Summary: Build uses npm workspaces
     Provenance: primary-agent · session <session-id> · /path/to/project
  ```

  当渲染文本触及 `recall.maxChars` 预算时，末尾显式标注 `… N more matches not shown (character budget …)`，
  结构化 details 同时携带 `omittedCount` 与 `truncatedCount`。

- `memory-status` 报告规范 Directory Identity、Store 健康、revision、记录计数、预算与 Git 跟踪状态，
  **不暴露**记录内容；缺失 Store 为 `missing (no Store yet)`，corrupt/unreadable/over-limit/unsupported
  各显示对应错误状态且从不写入。

## 限制

- 本版本已有搜索与精确读取，但无自动召回与遗忘；`memory_write` 支持 `operation: "add"` 与 `"supersede"`。
- 搜索是纯词法（大小写/标点折叠、拉丁与数字词元、中文重叠 bigram + 单字词元、摘要加权），不是语义检索；
  无关记录得分为零并被排除，词法相似但语义无关的记录可能以低分出现。
- 目录身份是精确匹配：父、子、兄弟目录不共享记忆，无继承、无仓库根发现、无跨目录 Store。
- v1 不验证 Store 的来源真实性；目录移动或复制后，下一次成功写入会采用当前规范 Directory Identity。
- 不读取、索引、总结或改写 Pi 的 Global User Instructions。
- 无后台观察者、reviewer、定时器、watcher、socket 或网络请求；Git 检查仅在被调用时短时运行子进程。
- 搜索/列表/读取不建立任何索引、不写任何文件、不触发任何写入事务；
  corrupt/unreadable/over-limit/unsupported Store 报稳定错误且字节不变。
- 不要求模型/Provider；所有模式（TUI、RPC、JSON、print）安全加载，无 UI 等待。
- 不发布到 AGENTS.md / README / ADR / Git；发布是独立的显式文档动作。
- 信任门槛按维护者决定推迟到后续版本（见「设计要点」）。

## 权限与副作用

- 仅在 Pi agent 目录创建/读取部署配置；仅读取/写入 Working Directory 内 `.pi/memory/` 下的 Store。
- 搜索/列表/读取是完全只读的：不创建 Store、不创建目录、不修改任何文件；无效输入与取消也绝不产生字节变更。
- 首次写入创建 `.pi/memory/`（0700）、作用域 `.gitignore` 标记（已有用户标记时保留）与 `store.json`
  （0600）；权限在支持 POSIX 模式的平台生效。
- 每次写入都是 Pi `withFileMutationQueue` 包住的完整事务：读取—校验—变更—独占临时文件 + sync +
  原子 rename；失败或取消时先前 Store 字节权威，临时文件被清理。
- `memory-status` 严格只读；Git 诊断只执行只读命令（`rev-parse`、`ls-files`、`check-ignore`），带超时与
  取消，不修改仓库配置。

## 持久化

- 部署配置：`<agentDir>/memory/config.json`（版本化）。
- Memory Store：`<cwd>/<CONFIG_DIR_NAME>/memory/store.json`（版本化，随目录移动）。
- 本版本不写入 session 状态；记录 provenance 引用 session/entry 身份但不读取或复制会话内容。

## 模式支持

- TUI：工具结果由紧凑（单行调用 + 数行结果）与展开（完整文本）两种渲染器呈现；`memory-search`/`memory-list`
  命令通过 notify 展示紧凑结果。
- RPC：与 TUI 相同的 Store 契约；`memory_search` 结果经结构化 details（`memory:search-result`，含
  `matchedCount`/`omittedCount`/`truncatedCount` 与紧凑 hits）与文本 content 返回，无终端假设。
- JSON / print：不等待 UI，无 UI 时命令静默完成；工具行为与 TUI 完全一致。

## 开发命令

```bash
npm run check   # Biome 格式/lint + TypeScript 类型检查
npm test        # Vitest（临时目录 + 共享 FakePiHost，不访问真实 ~/.pi 或用户项目）
```
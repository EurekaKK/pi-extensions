# memory

为精确的 Working Directory 保存并动态召回本地长期记忆（Directory Memory）。本 extension 正处于分阶段实现中：
本版本（#6）只建立「可诊断」地基——严格部署配置、精确目录身份（Directory Identity）、版本化 Memory Store 的
只读校验与分类、`memory-status` 诊断命令，以及有界、可取消的 Git 跟踪提示。写入、搜索/读取、自动召回等
记忆功能由后续 issue 提供，README 中标记为「尚未实现」。

## 状态

`experimental`

Store 格式、配置字段和命令输出仍可能调整。README 的完整版（含真实性风险说明与正式文档）由 #13 收尾；
本文件是面向当前实现范围的过程性说明。

## 设计要点（当前已实现）

- **Directory Identity**：当前 Working Directory 的规范 real path（`realpath`）。符号链接别名收敛到同一身份；
  父、子、兄弟目录互不相同；目录移动时 Store 自然跟随，无 agent 全局注册表。
- **Store 位置**：`<cwd>/<CONFIG_DIR_NAME>/memory/store.json`（当前 Pi 的 `CONFIG_DIR_NAME` 为 `.pi`），
  即每个目录自己的 Pi 配置区内，不放在 Pi agent 目录，也没有全局目录注册表。
- **严格版本化 Store**：单个版本化 JSON 文档（`version: 1`、`schema: memory.store.v1`、单调 `revision`、
  目录元数据、记录数组）。记录包含身份、版本、active/superseded 状态、摘要、内容、supersedes 引用、来源
  （provenance，author 固定为 `primary-agent` 并带可选的 `entryId`）与时间戳。
- **Supersession 语义**：链条 A ← B ← C 中只有叶子 C 是 `active`，A 与 B 为 `superseded`。携带
  `supersedes` 引用的记录仍可为 `active`（叶子）；根记录被 supersede 时可不携带 `supersedes` 引用。图形级
  校验要求引用目标 id/版本精确匹配、新记录版本 = 目标版本 + 1、无环、每目标至多一个直接后继，且记录状态
  与图一致：有后继即为 `superseded`，无后继即为 `active`。
- **只读分类**：`memory-status` 区分 missing / healthy / corrupt / unreadable / over-limit / unsupported。
  失败状态**绝不**当作空 Store，也**绝不**被状态检查覆盖或改写。Store 文档的读取复用 `config-store` 的
  通用严格 JSON 读取器（有界字节、常规文件检查、读前读后 TOCTOU、fatal UTF-8、严格 JSON、可取消），并把
  其稳定的失败原因映射回上述分类。严格校验拒绝畸形记录、重复身份、非法 supersession 图（引用缺失/版本
  过期/版本非目标+1/重复 supersede/环/状态与图不一致）和超限文档。
- **Git 诊断**：只读、有界（默认 2 秒超时）、可取消（传递 AbortSignal）、非 Git 目录安全降级，
  且从不修改仓库级 ignore/exclude 文件。Store 目录内含作用域 ignore 标记（`memory/.gitignore`，
  内容 `*`）可使 Store 默认排除在 Git 之外；该标记由后续写入功能在首次初始化时创建，状态命令本身不写文件。
- **无信任门槛（维护者决定）**：本版本不要求 Pi project trust，也不引入第二套信任系统；由 #4 规格提出的
  真实性风险将在 #13 的正式文档中说明。

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
vendor。

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

- `proactiveWrites` / `automaticRecall`：写入与自动召回的独立开关（默认开启；显式搜索/读取工具不受影响）。
  当前版本尚无写入/召回功能，字段为后续版本预留。
- `store.*`：Store 文档与记录的规模上限。
- `recall.*`：自动召回的单次记录数与字符预算。
- `git.diagnosticTimeoutMs`：Git 跟踪诊断的短超时。

以上数值均为**实验性默认策略**，后续评测可能调整，不视为公共契约。配置在整个进程加载一次，修改后执行 Pi
`/reload`。配置文件损坏、版本/字段非法、超限或不可读时，extension **fail-closed** 停用：不注册任何命令或
工具，有 UI 时最多提示一次清除过敏感信息的警告。

## 注册资源

当前注册：

- 用户命令 `memory-status`（只读诊断；见下）。
- 无 LLM 工具、无 UI widget、无 custom entry、无消息渲染器。

后续版本将新增 `memory_write` / `memory_search` / `memory_read` / `memory_forget` 工具与对应命令/渲染器。

## 使用

```text
/memory-status
```

输出示例（健康 Store）：

```text
memory-status · usable
Directory: /path/to/project
Store: /path/to/project/.pi/memory
Store health: healthy
Store revision: 2
Records: 1 active · 1 superseded
Recall budget: 8 records · 6000 chars
Proactive writes: enabled · Automatic recall: enabled
Git: untracked by git
```

- 输出报告规范 Directory Identity、Store 路径、健康分类、revision、active/superseded 计数、配置的召回预算
  与 Git 跟踪状态；**不暴露**任何记录内容。Directory Identity 成功解析时，Store 路径与 Git 诊断 cwd/相对
  pathspec 均由规范 real path 派生，符号链接别名在显示路径与诊断上都会收敛；身份解析失败时保留基于原 cwd
  的安全错误报告。
- Store 尚未创建时显示 `missing (no Store yet)`；corrupt / unreadable / over-limit / unsupported 显示为错误
  状态并附原因，且状态检查不写入任何文件。
- Git 行是咨询性的：非 Git 目录显示 `not a git repository`，超时/取消/不可用各有稳定表述，不影响其他输出。

## 限制

- 本版本无记忆写入、搜索、读取、遗忘与自动召回；写路径（含 Store 初始化与作用域 ignore 标记创建）由后续
  issue 提供。
- 目录身份是精确匹配：父、子、兄弟目录不共享记忆，无继承、无仓库根发现、无跨目录 Store。
- 不读取、索引、总结或改写 Pi 的 Global User Instructions。
- 无后台观察者、reviewer、定时器、watcher、socket 或网络请求；Git 检查仅在被调用时短时运行子进程。
- 不要求模型/Provider；所有模式（TUI、RPC、JSON、print）安全加载，无 UI 等待。
- 不发布到 AGENTS.md / README / ADR / Git；发布是独立的显式文档动作。
- 信任门槛按维护者决定推迟到后续版本（见「设计要点」）。

## 权限与副作用

- 仅在 Pi agent 目录创建/读取部署配置；仅读取 Working Directory 内 `.pi/memory/` 下的 Store。
- 状态命令严格只读；后续写入将使用 Pi 的 `withFileMutationQueue` 包住完整事务，并以临时文件 + rename
  原子提交。
- Git 诊断只执行只读命令（`rev-parse`、`ls-files`、`check-ignore`），带超时与取消，不修改仓库配置。

## 持久化

- 部署配置：`<agentDir>/memory/config.json`（版本化）。
- Memory Store：`<cwd>/<CONFIG_DIR_NAME>/memory/store.json`（版本化，随目录移动）。
- 本版本不创建 Store 文件；Store 由后续写入功能初始化。

## 模式支持

- TUI / RPC：`memory-status` 通过 UI notify 展示结果。
- JSON / print：命令不依赖 UI，不等待任何界面；无 UI 时静默完成，行为一致。

## 开发命令

```bash
npm run check   # Biome 格式/lint + TypeScript 类型检查
npm test        # Vitest（临时目录 + 共享 FakePiHost，不访问真实 ~/.pi 或用户项目）
```
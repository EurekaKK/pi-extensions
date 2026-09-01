# pi-extensions

用于开发和维护 [Pi coding agent](https://pi.dev/) extensions 的 monorepo。每个 extension 都是独立维护的 Pi package；安装时可通过显式依赖组成 closure，运行、测试、版本与发布边界仍由各 package 自己负责。

## 文档职责

- 本文件面向使用者和维护者，说明项目结构、开发入口和 extension 索引。
- [`AGENTS.md`](./AGENTS.md) 面向修改仓库的 Agent，定义实现、验证和发布约束。
- [`requirements/`](./requirements/) 保存仓库级需求及其 ID、描述和实现分支，创建流程见目录内说明。
- 各 extension 的具体功能、权限和使用方法记录在各自的 `README.md` 中。

## 约定结构

```text
pi-extensions/
├── AGENTS.md
├── README.md
├── package.json
├── package-lock.json
├── requirements/
├── eval/
├── extensions/
│   └── <extension-name>/
├── templates/
│   └── extension/
└── scripts/
```

- `extensions/`：独立 extension packages。
- `requirements/`：每个仓库级需求一份 Markdown 记录，并通过仓库脚本分配 ID、创建分支。
- `eval/`：独立的 Python Harbor 评测夹具，不是 Pi extension，也不加入 npm workspaces。
- `templates/extension/`：创建新 extension 的标准脚手架。
- `scripts/`：仓库级开发与发布辅助脚本。

仓库使用 npm workspaces 管理各个独立 extension。评测 adapter 使用 uv，说明见 [`eval/README.md`](./eval/README.md)。

## 环境要求

- 本机最新版 Pi，使用 `@earendil-works/*` package scope。
- Node.js `>=22.19.0`。
- npm；仓库不混用 pnpm 或 Yarn。
- 评测夹具另需 Python `3.12` 与 [uv](https://docs.astral.sh/uv/)；Harbor 以 peer 声明在 `eval/`。

## 安装

本仓库的 extension 采用 npm 风格安装：先把 package 复制到 Pi agent 目录下的
`~/.pi/agent/my-extensions/<name>/`，再把该副本登记进 Pi。Pi 对本地路径包只登记原路径、
不做复制，因此必须先复制再登记，运行中的 Pi 才能与开发工作树解耦；Pi 对本地安装也不运行
`npm install`，所以脚本会把 extension 声明的仓库内部依赖（`packages/<dep>/`）一并 vendor 进副本的
`node_modules/`（见 ADR-0034）。

```bash
# 安装或更新（复制 + pi install），可一次传多个名字
scripts/install-extension.sh todo goal

# 卸载（脚本不处理卸载）
pi remove ~/.pi/agent/my-extensions/todo
rm -rf ~/.pi/agent/my-extensions/todo
```

- 若 extension 在 package.json 中声明了 `piExtensionDependencies`（对其他 extension 的安装期
  依赖），脚本会递归解析全部请求根的依赖 closure：检测未知名字、自依赖和环，按「依赖优先」的
  稳定拓扑顺序把依赖 extension 也逐个镜像到 `~/.pi/agent/my-extensions/<name>/` 并分别
  `pi install`；多个请求根与菱形依赖只处理一次。任何校验失败时脚本不会写入任何文件。
- 修改代码后重新运行脚本即可同步副本（按内容比较，已安装副本也能正确更新）；重启 Pi 或在会话内
  `/reload` 后生效。
- `@earendil-works/*` core 包由 Pi 自带（声明为 `peerDependencies`），副本无需 `npm install`。
- 各 extension 的启用/停用（`pi config`）与状态文件位置见各自 README。

## 开发约定

新 extension 应：

1. 从 `templates/extension/` 创建到 `extensions/<kebab-case-name>/`。
2. 使用 TypeScript、ESM、Biome、严格类型检查和 Vitest。
3. 在自己的 `package.json` 中显式声明 Pi extension 入口和全部依赖。
4. 保持源码隔离，不直接引用其他 extension 的源码；需要安装期依赖时，在 `piExtensionDependencies`
   中显式声明（要求与示例见 `templates/extension/README.md` 的「Extension 依赖」章）。
5. 完成 README，并在下方索引中登记。

workspace 建立后，统一使用以下命令：

```bash
npm install
npm run check --workspaces
npm test --workspaces
```

代码任务在交付前验证受影响的 extension；版本发布前执行全仓验证，并使用本机 Pi 进行真实加载 smoke test。详细要求见 [`AGENTS.md`](./AGENTS.md)。

## 需求记录

新需求在实现前通过仓库命令分配 `REQ-NNNN`、写入描述，并创建 `req-NNNN-<slug>` 分支；完整命令、命名规则和并发限制见 [`requirements/README.md`](./requirements/README.md)。

## Extension 状态

- `experimental`：功能或接口仍可能变化。
- `stable`：文档和验证完整，没有已知阻断问题。
- `deprecated`：不再推荐使用，并提供原因及迁移说明。

## Extension 索引

| 名称 | 状态 | 说明 | 路径 |
| --- | --- | --- | --- |
| `context-management` | experimental | 按 dsh 方式 spill、prune 并生成结构化 Checkpoint，接管 Pi 原生 compaction | [`extensions/context-management`](./extensions/context-management/) |
| `goal` | experimental | 通过模型工具管理 session Goal，并由 Goal Round Driver 自动续跑 active goal | [`extensions/goal`](./extensions/goal/) |
| `memory` | experimental | 为精确 Working Directory 保存并动态召回本地长期记忆 | [`extensions/memory`](./extensions/memory/) |
| `plan` | experimental | 用户启动与审批的规划工作流；完整 Proposal 持久化，执行进度交接给 Todo | [`extensions/plan`](./extensions/plan/) |
| `progress-widget` | experimental | 在输入栏上方统一投影直接 Sub-agent Run、活动 Plan、Todo 与 Goal，支持 Compact / Full View | [`extensions/progress-widget`](./extensions/progress-widget/) |
| `sub-agent` | experimental | 在父 Pi 进程内运行 spawn/fork 子 Agent，支持后台 continuable 会话、report 与结算通知 | [`extensions/sub-agent`](./extensions/sub-agent/) |
| `tavily-web-search` | experimental | 通过 Tavily Search/Extract 对接公开网页，结果包在 Tavily Envelope 中 | [`extensions/tavily-web-search`](./extensions/tavily-web-search/) |
| `todo` | experimental | 通过 `todo_write` 每次全量替换模型任务列表，并提供按轮次清空的计划条 | [`extensions/todo`](./extensions/todo/) |

新增、重命名、弃用或删除 extension 时，必须同步维护此索引。

## 评测夹具

要用 Harbor 对当前工作树跑 Terminal-Bench，使用 [`eval/`](./eval/) 里的 Pi TUI adapter。它不是可 `pi install` 的 extension。不要使用 Harbor 内置的 `pi` agent。

## License

本项目使用 [MIT License](./LICENSE)。各 extension 除非另有明确说明，均采用相同许可证。

# pi-extensions

用于开发和维护 [Pi coding agent](https://pi.dev/) extensions 的 monorepo。每个 extension 都是独立的 Pi package，可以单独安装、运行、测试和发布。

## 文档职责

- 本文件面向使用者和维护者，说明项目结构、开发入口和 extension 索引。
- [`AGENTS.md`](./AGENTS.md) 面向修改仓库的 Agent，定义实现、验证和发布约束。
- 各 extension 的具体功能、权限和使用方法记录在各自的 `README.md` 中。

## 约定结构

```text
pi-extensions/
├── AGENTS.md
├── README.md
├── package.json
├── package-lock.json
├── extensions/
│   └── <extension-name>/
├── templates/
│   └── extension/
└── scripts/
```

- `extensions/`：独立 extension packages。
- `templates/extension/`：创建新 extension 的标准脚手架。
- `scripts/`：仓库级开发与发布辅助脚本。

仓库使用 npm workspaces 管理各个独立 extension。

## 环境要求

- 本机最新版 Pi，使用 `@earendil-works/*` package scope。
- Node.js `>=22.19.0`。
- npm；仓库不混用 pnpm 或 Yarn。

## 开发约定

新 extension 应：

1. 从 `templates/extension/` 创建到 `extensions/<kebab-case-name>/`。
2. 使用 TypeScript、ESM、Biome、严格类型检查和 Vitest。
3. 在自己的 `package.json` 中显式声明 Pi extension 入口和全部依赖。
4. 保持独立，不直接引用其他 extension 的源码。
5. 完成 README，并在下方索引中登记。

workspace 建立后，统一使用以下命令：

```bash
npm install
npm run check --workspaces
npm test --workspaces
```

代码任务在交付前验证受影响的 extension；版本发布前执行全仓验证，并使用本机 Pi 进行真实加载 smoke test。详细要求见 [`AGENTS.md`](./AGENTS.md)。

## Extension 状态

- `experimental`：功能或接口仍可能变化。
- `stable`：文档和验证完整，没有已知阻断问题。
- `deprecated`：不再推荐使用，并提供原因及迁移说明。

## Extension 索引

| 名称 | 状态 | 说明 | 路径 |
| --- | --- | --- | --- |
| `bash-permissions` | experimental | 在 LLM 的内置 bash 调用执行前按三色规则判定风险 | [`extensions/bash-permissions`](./extensions/bash-permissions/) |
| `tavily-web-search` | experimental | 通过 Tavily 搜索公共互联网，并以受限 Extract 检查候选来源 | [`extensions/tavily-web-search`](./extensions/tavily-web-search/) |

新增、重命名、弃用或删除 extension 时，必须同步维护此索引。

## License

本项目使用 [MIT License](./LICENSE)。各 extension 除非另有明确说明，均采用相同许可证。

# pi-extensions 项目规则

## 文档职责

- `README.md` 面向项目使用者，说明项目用途、仓库结构、使用方式和 extension 索引。
- 本文件面向修改仓库的 Agent，只记录会影响实现、验证和发布的项目约束。
- extension 的功能、权限、副作用和用法写在各自的 `README.md` 中，不堆积到根文档。

## 仓库结构

- 所有 extension 位于 `extensions/<name>/`；只有 `extensions/` 下的一级目录代表独立 extension。
- `templates/extension/` 是新 extension 的脚手架来源。首次创建 extension 时若模板尚不存在，应先建立与本文件一致的模板。
- `scripts/` 仅存放仓库级开发与发布辅助脚本，不包含 extension 运行时代码。
- extension 之间必须保持独立，不得直接引用兄弟 extension 的源码或依赖其未声明的文件。
- 每个 extension 必须能够独立安装、运行、检查、测试和发布。
- 子目录 `AGENTS.md` 按需创建，只补充该 extension 的特殊约束，不复制根规则。

## Git 忽略准则

- 是否忽略应依据文件职责，而不是目录名、文件类型或是否由工具生成。
- 运行、安装、测试或发布所必需的内容应跟踪；仅与本机、会话或单次运行有关且可重建的内容应忽略。
- 优先使用范围明确的忽略规则，避免 `dist/`、`build/`、`test/` 等可能误伤有效内容的宽泛规则。
- 修改 `.gitignore` 前先确认文件是否已被跟踪及被何处使用；`.gitignore` 不等于取消已有提交。
- 证据不足或两种选择会影响使用方式时，说明判断依据并请求用户确认，不擅自决定。
- 设计草稿、调研材料和真实环境验证记录不会因实现或提交任务而自动成为交付物，是否跟踪以明确的交付范围为准。

## Extension 基线

每个 `extensions/<name>/` 至少包含：

```text
package.json
README.md
index.ts
src/index.ts
test/
tsconfig.json
biome.json
```

- 目录名使用 `kebab-case`。
- `src/index.ts` 是标准实现入口，必须默认导出 Pi extension 工厂函数。
- package 根目录必须有薄适配入口 `index.ts`，内容只做 `export { default } from "./src/index.js";`，不得复制
  实现或产生副作用。Pi 对本地 package 的启动页短名取自入口父目录：直接加载 `src/index.ts` 会错误显示为
  `src`，加载根 `index.ts` 才会显示 extension 目录名；`package.json.name` 和工厂函数名都不参与这个显示名的
  计算，不能替代根入口。
- package 使用 ESM，`package.json` 设置 `"type": "module"`。
- TypeScript 开启 `strict`；不使用 `any` 绕过类型检查。外部数据先按 `unknown` 接收并校验。
- Pi 工具参数使用 TypeBox schema；类型导入使用 `import type`。
- Node.js 版本下限与当前 Pi 一致，设为 `>=22.19.0`。
- `package.json` 必须包含 `pi-package` keyword，并把根适配入口作为唯一 Pi 入口：

  ```json
  ["./index.ts"]
  ```

  不得声明 `./src/index.ts`，也不得同时启用根入口与实现入口。用 include/exclude pattern 同时枚举两者的
  workaround 也不允许：Pi 的 package resolver 与自动发现路径对 manifest pattern 的处理不同，可能导致
  同一 extension 被加载两次。实现代码仍保留在 `src/index.ts`，由根入口静态转发。
- 若 `package.json` 使用 `files` allowlist，必须包含根 `index.ts`；`tsconfig.json` 的 `include` 也必须包含
  `index.ts`，保证发布包不会漏掉适配入口且该文件经过类型检查。
- npm 发布身份尚未确定前，package 名暂与目录名一致，并设置 `"private": true` 防止误发布。
- 工具、命令、状态键和其他全局标识必须带 extension 前缀；用户可见 label 不强制带前缀。

## Package 与依赖

- 仓库统一使用 npm workspaces，根目录只维护一份 `package-lock.json`，不得混用 pnpm 或 Yarn。
- 每个 extension 自带开发配置，并在自己的 `devDependencies` 中声明 Biome、TypeScript 和 Vitest；配置一致性由模板保证。
- Pi 核心包使用当前 `@earendil-works/*` scope，放入 `peerDependencies`，版本范围按官方要求使用 `"*"`，不得打包进 extension。
- 运行时依赖放入 `dependencies`，不得依赖 `devDependencies` 才能运行。
- 能用 Node.js 标准库或 Pi API 完成时，不新增运行时依赖。
- 新增运行时依赖前，必须说明用途、替代方案和供应链风险并取得确认。
- 禁止在运行时下载或执行未声明的依赖。

## Pi API 与运行时行为

- 以本机最新版 Pi 的文档、示例和已安装类型定义为实现依据；不要凭记忆猜测 API。
- 新代码只面向迁移后的 `@earendil-works/*` 包，不为 `@mariozechner/*` 旧 scope 增加兼容分支。
- 模式支持由功能语义决定，不默认限制为 interactive；所有模式都必须安全加载，不得等待不存在的 UI，并在 README 中说明行为差异。
- 不在 extension 工厂函数中启动进程、socket、watcher、timer 等长生命周期资源。
- 长生命周期资源应按需或在 `session_start` 中启动，并在 `session_shutdown` 中幂等清理。

## 安全、副作用与状态

- 不进行未在 extension README 中说明的网络请求、遥测或后台上传。
- 不读取、打印或持久化与功能无关的凭据。
- 写入项目目录外、启动长期进程或执行破坏性命令，必须是明确设计的一部分，并在 README 中说明权限、影响和清理方式。
- 状态生命周期应与功能语义一致：能仅存于内存的状态不持久化，需要 session 恢复的状态使用 Pi session，只有真正跨 session 的需求才使用外部持久化。
- 不得向 extension 源码目录或安装目录写入运行时状态。
- 外部持久化必须说明存储位置、数据内容和清理方式；格式应带版本，并能容忍文件缺失或损坏。
- 修改文件时使用 Pi 的 `withFileMutationQueue()` 包住完整的读取—修改—写入过程。
- 长任务必须响应并向下传递 `AbortSignal`；外部命令和网络请求必须设置合理超时。
- 不假设工具串行执行；共享内存状态和重复清理必须具备并发安全性。

## 检查与测试

每个 extension 必须提供：

```bash
npm run check  # Biome 格式/lint + TypeScript 类型检查
npm test       # Vitest 自动化测试
```

- 不要求每次编辑后立即验证。
- 一个代码任务准备交付或宣称完成前，在受影响的 extension 中运行一次 `check` 和 `test`。
- 测试优先覆盖可观察契约和关键不变量；权限、安全、预算、并发、取消与清理等边界发生变化时，必须增加针对性回归测试。
- 纯文档修改不运行代码验证。
- 修改根级共享配置或准备发布时，运行全部 workspaces 的完整检查与测试。
- 发布 extension 前，额外使用本机最新版 Pi 做一次无副作用的真实加载 smoke test。
- 新 extension 或入口变更的 smoke test 必须从 package 目录加载或安装，不能用 `-e src/index.ts` 代替；应
  验证 Pi 最终只解析到 `<extension>/index.ts`，并确认启动页 `[Extensions]` 显示 extension 目录名，不是
  `src`、`dist` 或重复的两个名称。`pi list` 只证明 package 已登记，不能代替此命名验证。
- 默认测试不得访问真实 `~/.pi`、用户项目、凭据、真实模型、付费 API 或不受控网络服务。
- 文件测试使用临时目录，Pi API 使用 mock/fake。需要真实环境的集成测试必须单独标记并显式触发。
- 无法执行应有验证时，必须说明原因和未验证范围，不得声称已经验证。

## 文档、状态与发布

- 根 `README.md` 索引从 extension 创建时就登记全部项目；新增、重命名、弃用或删除时必须同步更新。
- extension 状态只使用：
  - `experimental`：默认状态，功能或接口仍可能变化。
  - `stable`：README 完整，检查、测试和真实 Pi smoke test 已通过，且没有已知阻断问题。
  - `deprecated`：不再推荐使用，README 必须说明原因、替代方案或迁移方式。
- 每个 extension README 必须覆盖：用途与状态、安装/启用/卸载、注册资源、示例、限制、权限与副作用、持久化、模式支持和开发命令。
- 各 extension 使用独立 SemVer。普通代码任务不得自动提升版本；只有明确的发布任务才修改版本号、移除 `private` 或执行发布。
- 当前不要求维护 `CHANGELOG.md`，不记录固定的 Pi 测试版本，也不假设存在 CI。
- 仓库和各 package 使用 MIT 许可证；引入第三方代码或资源时必须核对许可证兼容性。

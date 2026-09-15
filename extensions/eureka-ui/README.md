# eureka-ui

把内置工具在 transcript 中的显示压成三档（`hidden` / `line` / `native`），并把"当前正在执行什么"收敛成编辑器上方**一行普通文本**；该行固定在 progress-widget 上方、与它空一行隔开，视觉上像正常输出而不是状态面板。

## 状态

`experimental`

## 安装、启用与卸载

从仓库根目录安装（脚本会把 package 复制到 `~/.pi/agent/my-extensions/eureka-ui/` 再 `pi install`）：

```bash
scripts/install-extension.sh eureka-ui
```

**加载顺序要求**：`~/.pi/agent/settings.json` 的 `packages` 数组中，`my-extensions/eureka-ui` 必须排在 `my-extensions/progress-widget` **之前**。Pi 按 `setWidget` 的插入顺序渲染 above-editor 的 widget，eureka-ui 只在 `session_start` 注册一次自己的键，而 progress-widget 会在内容变化时重设自己的键（重设会排到末尾）；先加载才能保证活动行一直在上面。

`pi install`（以及安装脚本）只把新条目**追加**到 `packages` 末尾，不会重排：要么先安装 eureka-ui 再安装 progress-widget，要么手工把 eureka-ui 移到前面。顺序相反时活动行会先出现在 progress-widget 下方，直到 progress-widget 下一次因内容由空转非空而重设自己的键，才会回到上方。

卸载（卸载不级联，progress-widget 不受影响）：

```bash
pi remove ~/.pi/agent/my-extensions/eureka-ui
rm -rf ~/.pi/agent/my-extensions/eureka-ui
```

## 注册资源

- **覆盖注册**内置工具 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`，只接管 `renderCall` / `renderResult`；`execute`、参数 schema、描述与 prompt 文本都委托给 Pi 内置的 definition 工厂。
- `powershell` 默认 `native`。Pi 直到 0.85 才公开导出它的 definition 工厂；运行环境缺少该导出时 eureka-ui 自动跳过它（保持原生渲染），不会加载失败。
- **widget**：key `eureka-ui:activity`，`placement: aboveEditor`，整场常驻（空闲渲染 0 行，`session_shutdown` 清理）。
- 不注册 LLM 工具、slash 命令、快捷键或 CLI flag。

## 使用示例

配置位于 `~/.pi/agent/eureka-ui/config.json`（首启自动创建）：

```json
{
  "version": 1,
  "tools": {
    "read": { "mode": "hidden" },
    "bash": { "mode": "line" },
    "powershell": { "mode": "native" },
    "edit": { "mode": "line" },
    "write": { "mode": "line" },
    "grep": { "mode": "hidden" },
    "find": { "mode": "hidden" },
    "ls": { "mode": "hidden" }
  }
}
```

| `mode` | transcript 表现 |
| --- | --- |
| `hidden` | 不渲染工具行（0 行）；工具**失败**时破例显示一行红色摘要 |
| `line` | 一行调用+结果摘要，原地更新：`$ npm test · ✓ 2 lines · 1.2s` |
| `native` | 完全不注册覆盖，保持 Pi 内置渲染 |

修改配置后需要 `/reload` 或重启 Pi 生效（不做文件监听）。

展开查看完整输出：`Ctrl+O`（`app.tools.expand`）展开全部被接管工具并委托内置渲染（含 diff、语法高亮、截断提示）；`line` 档的行还可以单独点击展开/收起。

活动行（编辑器上方，progress-widget 之上）：

```text
Running npm test, src/auth.ts… (+1)        ← 并行时最多两条 + 计数
Ran npm test · 0.3s                        ← 工具全部结束、agent 未 settle
Failed npm test · exit 1                   ← 错误保留下一条用户消息
```

空闲时活动行不占任何高度。

## 限制

- **图片结果无法隐藏**：Pi 在工具 renderer 之外渲染结果里的图片，`hidden` 档对该部分无效。
- `hidden` 档折叠时没有任何可点击的行，只能通过 `Ctrl+O` 整体展开。
- 覆盖注册会把内置工具的注册归属（`sourceInfo`）从 `builtin` 改为本扩展。依赖"`source === "builtin"`"判断工具可用性的第三方扩展（例如 `pi-subagents`）可能据此认为这些工具不可用；本仓库的 `sub-agent` 按工具名解析，不受影响。
- **展开态没有内置的默认外壳**：被接管工具统一声明 `renderShell: "self"`——这正是折叠的 `hidden` 档能渲染 0 行的机制——因此 `Ctrl+O` 展开后不再有 Pi 默认的背景色与内边距（`edit` 内置本就是 `self`，不受影响）。展开内容本身（diff、语法高亮、截断提示）仍来自内置 renderer，没有重写。
- 若其它扩展也覆盖同一个内置工具，生效者取决于加载顺序。
- 活动行与 progress-widget 的上下顺序取决于加载顺序（见安装一节），Pi 不提供显式的 widget 排序 API。
- `powershell` 在缺少 definition 导出的 Pi 版本上无法接管。

## 权限与副作用

- 只读取自己的 `config.json`，运行时不写任何文件、不联网、不启动进程。
- 覆盖注册只替换渲染槽位，工具行为不变：`execute` 委托给 Pi 内置实现（`createXToolDefinition`）。
- 不读取、打印或持久化凭据。

## 持久化

- `~/.pi/agent/eureka-ui/config.json`（目录 0700、文件 0600，`version: 1`，由 `config-store` 严格校验）。
- 文件缺失时按默认值创建；内容损坏、超限或版本不符时 **fail-closed**：不注册任何覆盖（效果等同全部 `native`），只在 `session_start` 提示一次，不静默回退默认档位。
- 不向扩展源码目录写入运行期状态；活动行状态只存在于内存。

## 模式支持

- `tui`：完整功能（活动行为组件，带主题颜色）。
- `rpc`：活动行以 `string[]` 形式发布，不含颜色。
- `print` / `json`：无 UI；配置加载与覆盖注册照常，渲染不生效，不影响会话。

## 开发

```bash
npm run check   # Biome + tsc --noEmit
npm test        # Vitest
```

无副作用的真实加载 smoke test（在 package 目录执行；需要真实终端，退出时在空输入处按 `Ctrl-D`）：

```bash
smoke_root="$(mktemp -d)"
mkdir "$smoke_root/agent"
PI_CODING_AGENT_DIR="$smoke_root/agent" pi --offline --no-session --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-extensions --approve -e ./index.ts --verbose
rm -rf "$smoke_root"
```

`PI_CODING_AGENT_DIR` 是 Pi 自己的 agent 目录变量（`PI_AGENT_DIR` 只是本仓库 `scripts/install-extension.sh` 的变量，Pi 不读取；用它运行 smoke test 会落到真实 `~/.pi/agent`），`--approve` 用于跳过项目信任提示。运行会在临时目录里创建 `eureka-ui/config.json`，所以清理用 `rm -rf`。启动页 `[Extensions]` 必须只显示一次，且解析到 `extensions/eureka-ui`（不是 `src` 或 `dist`）。

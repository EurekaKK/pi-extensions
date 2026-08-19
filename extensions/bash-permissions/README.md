# bash-permissions

在 LLM 调用 Pi 内置 `bash` 工具前，用用户维护的正则规则将命令判定为绿色、黄色或红色，并按风险级别直接执行、要求复审或拒绝执行。

它用于降低合作型 LLM 误操作的风险，不是 OS 沙箱，也不是不可绕过的安全边界。

## 状态

`experimental`

## 安装、启用与卸载

从仓库根目录安装本地 package：

```bash
pi install ./extensions/bash-permissions
```

使用 `pi config` 启用或停用该 extension。卸载本地 package 配置：

```bash
pi remove ./extensions/bash-permissions
```

卸载不会删除用户规则；如不再需要，可手动删除 Pi agent 目录下的 `bash-permissions/` 配置目录。

## 配置

extension 在每次 `session_start` 时通过 Pi 的 `getAgentDir()` 定位配置目录：

```text
<agent-dir>/bash-permissions/
├── yellow.json
└── red.json
```

默认环境中 `<agent-dir>` 是 `~/.pi/agent`；设置 `PI_CODING_AGENT_DIR` 时会随之改变。首次启动会从 package 的 `defaults/` 复制缺失文件，但绝不覆盖或升级已有用户文件。当前 session 使用启动时生成的不可变快照；修改文件后执行 Pi 自带的 `/reload` 才会生效。

两个文件都是严格 JSON，顶层格式为：

```json
{
  "version": 1,
  "rules": []
}
```

黄色规则支持 `suggest` 和 `review`：

```json
{
  "name": "Git 强制推送",
  "pattern": "\\bgit\\s+push\\b.*--force\\b",
  "type": "suggest",
  "message": "强制推送可能覆盖远端历史。",
  "suggestedCommand": "git push --force-with-lease"
}
```

`suggestedCommand` 只是返回给 LLM 的纯文本，不会被自动执行，也不会展开捕获组。`review` 规则禁止提供该字段。红色规则只包含 `name`、`pattern` 和 `message`。

`pattern` 使用大小写敏感的 Node.js 原生 `RegExp`，不接受 flags。可使用两个动态占位符：

- `{{cwd}}`：当前 Pi session 的工作目录。
- `{{home}}`：当前用户主目录。

路径会先转义为正则字面量，再替换所有占位符。其他双花括号占位符会使当前 session 禁用 extension。

配置限制为每个文件 256 KiB、每个文件 256 条规则、每条正则 4096 个 JavaScript 字符。任一文件的 JSON、schema、版本、占位符或正则无效时，两个文件都不会形成策略；`session_start` 不会抛错。有 UI 时会通知一次失败原因，状态栏持续显示 `bash-permissions: disabled`，该 session 的 bash 调用不受本 extension 保护。正常运行时不占用状态栏；TUI 欢迎页的 `[Extensions]` 区域会显示一次 `bash-permissions`。

## 使用示例

- 绿色：未命中任何规则，原始命令不经修改直接交给 Pi 执行。
- 黄色：第一次命中不会执行；只有紧接着的下一次 LLM 响应原样重试，才放行一次。
- 红色：每次命中都拒绝执行，黄色复审资格不能覆盖红色结果。

判定颜色时只匹配 Matching View，不匹配原始 Command。Matching View 会先拼接 Bash 反斜杠续行（含 CRLF；普通单引号内除外，旧式反引号命令替换遵循 Bash 的预处理语义），再只从整段文本开头剥掉最多 12 层包装：`!`、`command`、`time`、`nohup`、`exec`、`env`、`sudo`、`doas` 以及 `NAME=value`。包装名本身可以带 `/bin`、`/usr/bin`、`/usr/sbin`、`/sbin` 前缀；剥掉包装后，剩余命令保留自己的路径（`sudo /bin/rm` 的视图是 `/bin/rm`）。不会在 `;`、`|` 等分隔符之后继续剥皮。该视图从不执行，也不改写即将交给 bash 的 Command。

黄色复审的同一性仍是原始 Command：只把 CRLF 转为 LF 并去掉首尾空白。包装层不同，或内部空格、换行、引号、参数、shell 结构有任何变化，都视为新命令。

## 注册资源

extension 注册以下事件钩子：

- `session_start`、`session_shutdown`、`session_tree`：创建或加载配置，并在 session 或分支切换时重置状态。
- `input`、`message_start`：用户新消息到达时清除黄色资格。
- `turn_start`、`turn_end`：限定黄色资格只能用于下一次 LLM 响应。
- `tool_call`：只检查 LLM 发起的 Pi 内置 `bash` tool call。

初始化失败时使用状态键 `bash-permissions` 显示 `disabled`；正常运行不注册常驻状态。没有自定义工具、slash command、快捷键、CLI flag、watcher 或配置编辑器。

## 限制

- 采用黑名单；绿色只表示未命中当前规则，不代表经过安全证明。
- 只检查命令文本，不解析 shell AST，也不解析变量、命令替换或程序运行后的真实路径。
- Matching View 只从整段开头剥包装，不是 shell 解释器。引号中的命令样文本、`bash -c` 载荷、以及 `;`、`|` 之后的命令仍留在视图里，因此 `echo 'rm -rf'` 仍可能命中 `rm -rf` 规则。超过 12 层的包装、无法识别的 wrapper 选项、`if`/`while`/`coproc` 等结构都不会被剥掉。
- 规则看到的是剥皮后的视图。针对 `sudo`/`doas` 等包装层本身的用户规则，在包装被剥掉后可能不再命中；当前默认模板仍带包装前缀，下一轮才会改 Starter Policy。
- 默认正则仍覆盖常见命令分隔符、分组和部分包装形式。为限制正则回溯，默认模板自身也有 12 层前缀和 8–16 项 option/assignment 上限；数组、算术表达式或复杂动态拼接仍可能误判或漏判。
- 不处理用户主动输入的 `!`/`!!`、RPC 客户端直接执行 bash，或其他 extension 调用的进程 API。
- 默认规则面向 macOS 和 Linux 的 Bash 命令；Windows 可以安全加载，但不完整覆盖 PowerShell 或 `cmd.exe`。
- Node.js 原生正则没有执行超时。用户应避免嵌套或重叠量词等可能造成灾难性回溯的表达式。
- 其他 extension 可以按加载顺序修改同一个 tool call；本 extension 只能检查其 handler 实际收到的完整命令文本。

## 权限与副作用

extension 读取 package 内的默认模板和两个用户配置文件。首次启动或文件缺失时，会创建 `<agent-dir>/bash-permissions/` 并复制缺失的 JSON 文件；这是唯一新增的文件系统副作用。

它不发起网络请求、遥测或后台上传，不启动进程、watcher、timer、socket，不记录独立命令日志，也不读取与本功能无关的凭据。

## 持久化

外部持久化仅包含 `yellow.json` 和 `red.json`。策略快照及黄色复审资格只保存在当前 session 内存中。Pi 自身仍按原有行为保存 tool call 和 tool result；本 extension 不复制这些记录。

清理时删除实际 `<agent-dir>/bash-permissions/` 目录即可。再次启用后，缺失文件会从当时安装版本的默认模板重新创建。

## 模式支持

TUI、RPC、JSON 和 print 模式都应用相同的命令判定策略。TUI 欢迎页会在 `[Extensions]` 中显示一次 `bash-permissions`，不显示正常运行的常驻 footer；有 UI 时会通知首次创建的配置路径和初始化错误，并仅在初始化失败时常驻显示 `disabled`。JSON/print 不等待交互，初始化失败时不抛错、也不拦截 bash，正常启动不输出状态噪声。

## 开发

```bash
npm run check
npm test
```

package 根目录的 `index.ts` 是用于 Pi 启动页显示名称的薄适配入口；实现及可直接测试的标准入口仍为 `src/index.ts`。

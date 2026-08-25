# tavily-web-search

通过 Tavily `/search` 发现公开网页 hits，再用 `/extract` 按模型提供的 URL 抽取正文。结果包在 Tavily Envelope 里，标明来源；标题、snippet 和正文视为不可信外部数据。

这是合作型 LLM 的检索工具，不是浏览器、本机 WebFetch、网络沙箱或事实判定器。Search 只给 hits；要读页面请再调用 Extract。

## 状态

`experimental`

这是一次 breaking 重写：`tavily_open`、Ref、session 账本、本地 cache 和本机域名政策已删除。旧 config 若仍含 `domains` / `budgets` / `cache` 等字段，extension 会 fail closed，需要换成下方默认配置。

## 安装、启用与卸载

要求 Node.js `>=22.19.0`、本机最新版 Pi，以及有效的 Tavily API key。

安装采用 npm 式两步：先从仓库根目录把 package 复制到
`~/.pi/agent/my-extensions/tavily-web-search/`，再登记该副本。仓库脚本一步完成：

```bash
scripts/install-extension.sh tavily-web-search
```

Pi 对本地路径安装不运行 `npm install`；仓库脚本会先解析完整安装计划，再镜像 package，并把本包声明的内部 package 代码依赖递归 vendor 进副本。

通过 `pi config` 启用或停用。启动 Pi 前提供 key（`TAVILY_API_KEYS` 优先，逗号分隔即成池；`TAVILY_API_KEY` 作为单 key 回退）：

```bash
export TAVILY_API_KEYS="<key1>,<key2>,<key3>"   # 可选：顺序即池顺序

export TAVILY_API_KEY="<your Tavily API key>"   # 无池时的单 key 兼容
```

extension 不会把 key 写入配置或 session。它在加载时读一次环境变量；修改后需重启 Pi。卸载：

```bash
pi remove ~/.pi/agent/my-extensions/tavily-web-search
rm -rf ~/.pi/agent/my-extensions/tavily-web-search
```

卸载不会删除用户配置。不再需要时可手动删除 agent dir 下的 `tavily-web-search/`。

## Extension 依赖

无。

## 配置

加载时通过 `getAgentDir()` 定位：

```text
<agent-dir>/tavily-web-search/config.json
```

文件缺失时创建默认文件，已有文件绝不覆盖、合并或升级。目录权限 `0700`，文件权限 `0600`。修改后执行 `/reload`。

默认配置：

```json
{
  "version": 1,
  "searchDepth": "basic",
  "extractDepth": "basic",
  "maxResults": 5,
  "searchTimeoutMs": 40000,
  "extractTimeoutMs": 40000
}
```

- `searchDepth`：`basic`、`advanced`、`fast` 或 `ultra-fast`。
- `extractDepth`：`basic` 或 `advanced`。
- `maxResults`：1–20，Search 默认条数。
- `searchTimeoutMs` / `extractTimeoutMs`：单次 HTTP 超时。

未知字段或旧 schema 会使 extension 禁用（不注册工具、不联网）。缺少或空的 `TAVILY_API_KEYS` / `TAVILY_API_KEY` 同样 fail closed：不注册工具、不向 Tavily 发请求。

## API Key 池

支持给 Tavily 配置多个 API key，遇到限额类错误自动往下换一个 key。

- 池声明与顺序：`TAVILY_API_KEYS` 逗号分隔，按顺序组成池；只设 `TAVILY_API_KEY` 时视为单 key 池。
- Active Key 从池首开始，遇到 **Key Error**（401 鉴权、432/433 额度、429 限流）就把 Active Key 前进一位（循环），并把本次调用记为失败返回给模型，错误文本告知已换到哪个 key（如 `key 1/3; rotated to key 2/3`）。extension 不自行重试，由模型自行决定重试本次调用（重试会自动用新 key）。
- 换完一圈：两次成功之间连续 Key Error 数达到池大小时，错误文本升级为 `all N pool keys are unavailable; wait before retrying`，之后仍继续轮换、不熔断不冷却；任何一次成功清零计数。
- 超时、取消和其他请求错误不是 Key Error，不触发轮换。
- 轮换状态只存内存（Active Key 下标 + 连续失败计数），重启 Pi 后从池首重新开始；轮换消息只含 key 序号，不含 key 本身，也不会把 key 写入配置或磁盘。

## 注册资源

- `tavily_search`：Tavily Search。参数 `query`；可选 `include_domains`（最多 300）、`exclude_domains`（最多 150）、`time_range`（`day` | `week` | `month` | `year`）。
- `tavily_extract`：Tavily Extract。参数 `urls`（1–20 个 URL，由模型提供，不必来自某次 Search）；可选 `query`（按问题重排 chunk）。

两个工具注册静态 `renderCall` / `renderResult` 紧凑 TUI renderer（见「TUI 展示」），不注册 slash command 或 widget。缺 key 或配置失败时不注册工具、不联网，并在 `session_start` 通知一次。

两个工具结果的 `details` 携带最小版本化结构化元数据，字段带 `tavily_` 前缀：

- `tavily_details_version`：恒为 `1`。
- Search：`tavily_hit_count`。
- Extract：`tavily_url_count`、`tavily_page_count`、`tavily_failed_count`。

details 只服务 TUI 渲染与诊断，不进入给 LLM 的 content envelope；所有模型所需信息都在 envelope 里。不包含 timing、API key 或原始 Tavily 响应。

## TUI 展示

紧凑 renderer 只影响支持渲染的客户端展示，不改变机器可读的工具语义与结果。

- `renderCall`：Search 显示工具名 + 截断的 query；Extract 显示工具名 + URL 数。参数尚未完成时只显示固定工具名占位符。
- `renderResult` 优先检查 `isError`：折叠态只显示错误首行，展开态显示完整错误文本，均不读取 `details`。
- `isPartial`（流式/部分结果）时只显示 `in progress…` 占位符，不读取可能未完成的结果。
- 折叠态不显示 Envelope XML、snippet 或正文：Search 显示 `N hits · 截断 query`；Extract 显示 `N URLs · M pages · K failed`。`details` 缺失或畸形时回退固定摘要（`Search complete` / `Extract complete`）。
- 展开态显示原 content 全文（仍带 `<untrusted_external_data>` 标记）。
- 所有渲染文本先剥除 C0/C1 控制字符（含 ESC）；折叠摘要限制可见宽度，展开正文由 TUI 按终端宽度无损换行。
- 不展示 API key、Tavily 原始响应或内部 stack。

## 使用示例

```text
tavily_search({ "query": "Node.js current LTS release" })
```

```text
tavily_extract({ "urls": ["https://nodejs.org/en/about/previous-releases"] })
```

Search Envelope 外层为 `<tavily_search>`，每条 hit 含 title、URL、snippet、score。Extract Envelope 外层为 `<tavily_extract>`，含成功页正文与失败 URL。网页文本在 `<untrusted_external_data>` 内。

## 限制

- 只调用 `https://api.tavily.com/search` 和 `https://api.tavily.com/extract`。不做 Crawl、Map、Research。
- 不把 Extract 绑到某次 Search；模型自己复制 URL。本机不滤域名或 IP。
- 不缓存、不记 session 额度账本、不跨调用熔断。不重试任何错误：遇到 Key Error（401/432/433/429）时把 Active Key 前进一位并返回错误消息，由模型决定是否重试；连续 Key Error 达到池大小后报告全部 key 不可用。
- 不在本 extension 里截断 Envelope。若同时启用 context-management，超大纯文本 tool result 由它 spill/prune；不启用时全文进入 context。
- 401 / quota / 超时 / 取消返回工具错误，下一次调用仍会请求 Tavily；其中 401/quota/429 会先轮换 key。

## 权限与副作用

- 使用环境变量中的 Tavily API key（或 key 池）向 Tavily 发 HTTPS 请求。轮换状态（Active Key 下标、连续失败计数）仅存内存，不写入磁盘。
- 无遥测、无后台上传、不把 key 写入磁盘。
- 响应 `AbortSignal`：用户取消 turn 时中止 `fetch`。

## 持久化

仅用户维护的 `config.json`。不写 Pi custom session entry。

Pi 自身会按 session 持久化工具调用参数与结果（包括 `details`），因此 query、候选 URL、抽取 URL 与展示给模型的网页正文可能出现在 Pi session 文件中。

## 模式支持

| 模式 | 行为 |
| --- | --- |
| TUI / RPC / JSON / print | 相同工具语义；`renderCall` / `renderResult` 只影响 TUI 展示；无 UI 时跳过 notify |

所有模式都安全加载。工厂函数不启动进程、socket 或 timer。

## 开发命令

```bash
npm run check
npm test
npm run test:integration:tavily   # 需要 TAVILY_API_KEY，非默认
```

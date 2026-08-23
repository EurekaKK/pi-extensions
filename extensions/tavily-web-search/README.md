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

通过 `pi config` 启用或停用。启动 Pi 前提供：

```bash
export TAVILY_API_KEY="<your Tavily API key>"
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

未知字段或旧 schema 会使 extension 禁用（不注册工具、不联网）。缺少或空的 `TAVILY_API_KEY` 同样 fail closed：不注册工具、不向 Tavily 发请求。

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
- 不缓存、不记 session 额度账本、不跨调用熔断、不自动重试 429。
- 不在本 extension 里截断 Envelope。若同时启用 context-management，超大纯文本 tool result 由它 spill/prune；不启用时全文进入 context。
- 401 / quota / 超时 / 取消返回工具错误，下一次调用仍会请求 Tavily。

## 权限与副作用

- 使用环境变量中的 Tavily API key 向 Tavily 发 HTTPS 请求。
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

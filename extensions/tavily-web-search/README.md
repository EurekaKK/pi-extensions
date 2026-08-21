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
# 等价于：
#   rsync -a --delete --exclude node_modules --exclude .DS_Store \
#     extensions/tavily-web-search/ ~/.pi/agent/my-extensions/tavily-web-search/
#   pi install ~/.pi/agent/my-extensions/tavily-web-search
```

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

不注册 slash command、widget、自定义 renderer。缺 key 或配置失败时不注册工具、不联网，并在 `session_start` 通知一次。

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

## 模式支持

| 模式 | 行为 |
| --- | --- |
| TUI / RPC / JSON / print | 相同工具语义；无 UI 时跳过 notify |

所有模式都安全加载。工厂函数不启动进程、socket 或 timer。

## 开发命令

```bash
npm run check
npm test
npm run test:integration:tavily   # 需要 TAVILY_API_KEY，非默认
```

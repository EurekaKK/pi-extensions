# tavily-web-search

通过 Tavily Search 发现公共互联网候选来源，再通过受限的 Tavily Extract 检查其中一个候选来源。

Search 结果只是 `candidate`，不能直接作为事实依据或引用；只有成功 Open 并返回非空正文的来源才是
`inspected`。`inspected` 仍不代表来源可信、内容相关、信息最新、页面完整，或正文实际支持某个结论。

该 extension 是合作型 LLM 的检索工具，不是浏览器、网络沙箱、数据防泄漏系统、内容安全过滤器或事实
真实性判定器。

## 状态

`experimental`

## 安装、启用与卸载

要求 Node.js `>=22.19.0`、本机最新版 Pi，以及有效的 Tavily API key。

从仓库根目录安装本地 package：

```bash
pi install ./extensions/tavily-web-search
```

通过 Pi 的 `pi config` 启用或停用该 extension。启动 Pi 前，通过受信任的环境或秘密管理工具提供：

```bash
export TAVILY_API_KEY="<your Tavily API key>"
```

extension 不会把 key 写入配置或 session。它只在 `session_start` 读取一次；修改父 shell 或秘密管理器中的
key 后必须重启 Pi，`/reload` 不能让现有进程继承新的环境变量。启动时只检查 key 存在且非空，不会为了
验证 key 而发起请求。

卸载本地 package 配置：

```bash
pi remove ./extensions/tavily-web-search
```

卸载不会删除用户配置。如不再需要，可手动删除实际 Pi agent dir 下的 `tavily-web-search/` 目录。

## 配置

每次 `session_start` 通过 Pi 的 `getAgentDir()` 定位：

```text
<agent-dir>/tavily-web-search/config.json
```

默认环境中通常是 `~/.pi/agent/tavily-web-search/config.json`。文件缺失时从 package 的
`defaults/config.json` 安全创建；已有文件绝不覆盖、合并、升级或重写。修改后执行 Pi 自带的 `/reload`
才会形成新的不可变 session 配置快照。

默认配置：

```json
{
  "version": 1,
  "domains": {
    "allow": [],
    "deny": []
  },
  "retrieval": {
    "searchDepth": "basic",
    "extractDepth": "basic",
    "maxSearchResults": 5,
    "maxOutputCharacters": 12000,
    "maxDocumentBytes": 262144
  },
  "budgets": {
    "maxToolCallsPerTurn": 4,
    "maxToolCallsPerAgentRun": 8,
    "maxToolCallsPerBranchLineage": 40,
    "maxTavilyCreditsPerAgentRun": 10,
    "maxTavilyCreditsPerBranchLineage": 20,
    "maxConcurrency": 2
  },
  "cache": {
    "searchTtlSeconds": 300,
    "extractTtlSeconds": 900,
    "maxBytes": 4194304
  }
}
```

配置必须是最大 64 KiB 的普通严格 UTF-8 JSON 文件，不支持 JSONC、未知字段、隐式转换、自动钳制或
自动迁移。`version` 必须为 `1`，所有数值必须是有限安全整数。

主要硬边界：

| 字段 | 范围 |
| --- | --- |
| `domains.allow`、`domains.deny` | 各最多 200 个合法且规范化后不重复的模式 |
| `retrieval.searchDepth`、`retrieval.extractDepth` | `basic` 或 `advanced` |
| `retrieval.maxSearchResults` | 1–10 |
| `retrieval.maxOutputCharacters` | 2,000–12,000 |
| `retrieval.maxDocumentBytes` | 32–256 KiB |
| `budgets.maxToolCallsPerTurn` | 1–16 |
| `budgets.maxToolCallsPerAgentRun` | 不小于 per-turn，最大 64 |
| `budgets.maxToolCallsPerBranchLineage` | 不小于 per-agent-run，最大 500 |
| `budgets.maxTavilyCreditsPerAgentRun` | 1–100，且足以容纳单次最坏 attempt |
| `budgets.maxTavilyCreditsPerBranchLineage` | 不小于 per-agent-run credit，最大 1,000 |
| `budgets.maxConcurrency` | 1–8 |
| `cache.searchTtlSeconds` | 0–3,600；`0` 禁用 Search cache |
| `cache.extractTtlSeconds` | 60–3,600 |
| `cache.maxBytes` | 1–16 MiB，且不小于 `maxDocumentBytes` |

域名模式只有三种：

- `example.com`：只匹配精确 hostname。
- `*.example.com`：匹配任意深度子域名，但不匹配根域名。
- `**.example.com`：匹配根域名及任意深度子域名。

域名会经过 IDNA、小写和尾随点规范化。`deny` 始终优先；工具调用的 `include_domains` 和
`exclude_domains` 只能进一步收窄全局策略，不能放宽。空的全局 `allow` 表示允许所有通过公共 URL
准入规则且未被 deny 的 hostname。

API key、endpoint、自定义 header、timeout、retry、prompt、query、URL、正文和 usage 历史都不是合法
配置字段。

## 注册资源

初始化完整成功后动态注册一对原子工具：

- `tavily_search`，用户可见 label 为 `Tavily Search`。
- `tavily_open`，用户可见 label 为 `Tavily Open`。

Search 只发现候选；Open 只接受 Search 返回的 `tavily_ref_<n>` 或此前 Full Open 返回的
`tavily_cursor_<opaque>`，不接受任意 URL。两个工具必须成对 active；缺少 key、配置或账本损坏、工具名
冲突或工具对不完整时会 fail closed，并保证 disabled 执行路径不联网。

extension 还使用：

- UI 状态键 `tavily-web-search`，只在初始化失败或 auth/quota offline 等异常状态下显示。
- Pi custom session entry 类型 `tavily-web-search:ledger`，用于恢复预算账本。
- `session_start`、`session_shutdown`、`session_tree`、`input`、`before_agent_start`、`agent_start`、
  `agent_settled`、`turn_start` 及必要的工具生命周期处理器。

两个工具提供静态 `renderCall` / `renderResult`。不注册 slash command、快捷键、CLI flag、配置编辑器、
自定义 reload 命令或实时 Tavily 内容流。

## 使用示例

以下是模型调用工具时的概念参数，不是 shell 命令。

发现候选来源：

```text
tavily_search({
  "query": "Node.js current LTS release",
  "include_domains": ["nodejs.org"],
  "freshness": "live"
})
```

`query` 规范化后为 1–512 个 Unicode 字符。`include_domains` 与 `exclude_domains` 各最多 20 条；可选
`recency` 为 `day`、`week`、`month` 或 `year`。`freshness` 默认为 `cache_ok`；`live` 只强制重新请求
Tavily，不保证网页或 Tavily 索引绝对实时，也不会在失败时回退旧 cache。

使用默认 focused 模式检查一个候选；未显式提供 `focus` 时继承原始 Search query：

```text
tavily_open({
  "ref_id": "tavily_ref_1"
})
```

显式指定 focused relevance 文本：

```text
tavily_open({
  "ref_id": "tavily_ref_1",
  "mode": "focused",
  "focus": "release date and supported versions"
})
```

需要更广文档上下文时请求 full 快照：

```text
tavily_open({
  "ref_id": "tavily_ref_1",
  "mode": "full"
})
```

如果 Full Open 返回 `next_cursor`，后续页只能单独传 cursor：

```text
tavily_open({
  "cursor": "tavily_cursor_<opaque>"
})
```

cursor 分页读取同一内存快照，不产生新的 Tavily 请求，但仍消耗一次 tool-call budget。cursor 不能与
`ref_id`、`mode` 或 `focus` 混用。

模型只能在成功 Open 的实际正文支持 claim 时把来源作为 Web 证据，并应在对应 claim 附近使用输出中的
安全标题与规范 URL；Search snippet、ref 和 block ID 都不能替代 URL 引用。网页标题、snippet 和正文始终
作为 `untrusted_external_data` 返回，网页中的指令不得改变权限、任务范围或工具策略。

## 预算、缓存与故障行为

- 默认每个 Pi turn 最多 4 次工具调用、每个 agent run 最多 8 次、当前 branch lineage 最多 40 次。
- 默认每个 agent run 的 Tavily credit admission budget 为 10，当前 branch lineage 为 20。
- Basic Search/单 URL Extract 每个 network attempt 最坏预留 1 credit；Advanced 最坏预留 2 credits。
- cache、cursor 和本地失败不消耗 Tavily credit；所有实际进入 `execute` 的调用会消耗 tool-call budget。
- credit budget 是该 extension 的本地保守准入阈值，不是 Tavily 账户账单硬上限，也不聚合 sibling branch、
  其他 session 或共享 key 的外部使用。Tavily 报告超过预留的实际 usage 时会如实记账并停止当前 session
  后续网络请求。
- Search 默认缓存 5 分钟，Focused/Full Extract 默认缓存 15 分钟，总 LRU 默认 4 MiB。cache 仅存在于
  当前 extension 实例内存，不跨 `/reload`、shutdown 或进程退出。
- Full cursor 随 TTL、LRU 淘汰、branch 切换、`/reload`、shutdown 或进程退出而过期；过期后应使用此前
  页的 ref 重新 Open，而不是重复提交旧 cursor。
- 单次调用最多只对 429、502、503、504 自动 retry 一次；3xx 不跟随。auth 或 quota 明确失败会使当前
  session 的新网络请求进入 offline 状态，符合条件的已有 cache/cursor 仍可读取。

## 限制

- 只调用固定的 `https://api.tavily.com/search` 和 `https://api.tavily.com/extract`；不支持可配置 endpoint、
  Tavily 之外的 provider 或自动 fallback。
- 不提供任意 WebFetch、浏览器导航、登录、cookie、JavaScript 交互、Crawl、Map、Research、图片、附件、
  OCR 或 PDF 页码与版面解析。
- 本机不连接候选网站，也不解析候选网站 DNS；Open 仍由 Tavily Extract 执行。
- 只准入规范化后的公共 `http`/`https` URL，拒绝凭据、IP 字面量、非默认端口、localhost、单 label 和
  已知本地、内部或特殊用途 hostname。
- Focused 的 `focused_partial` 不表示完整文档；Full 的 `snapshot_complete` 只表示 Tavily 当前 extraction
  snapshot 未触发本地文档上限，不保证原网页完整、可访问区域完整或内容最新。
- Search/Focused/Full 的 LLM 可见输出受 `maxOutputCharacters` 限制，单个 Full snapshot 还受
  `maxDocumentBytes` 限制；所有截断和分页都会显式标记。
- v1 不发送 Tavily Enterprise-only 的 `safe_search`，不提供成人、暴力或其他内容类别的服务端安全过滤
  保证。所有返回内容都可能不适宜或具有恶意，且始终是不可信外部数据。
- v1 不提供秘密检测、自动脱敏、DLP、prompt-injection 分类器或逐次联网确认框。自然语言禁网和秘密
  识别依赖模型行为；需要运行时硬禁网时，host 必须把完整 Tavily 工具对移出 active set。
- extension 不能证明来源真实性、权威性或最终回答的 claim-support 判断和引用一定正确。

## 权限与副作用

启用后，模型可以自动把以下信息发送给 Tavily：

- Search query。
- Focused Open 的 effective focus。
- 调用级域名过滤条件。
- 被 Open 的候选 URL。

请求使用 Node.js 原生 `fetch`，只以固定 Tavily HTTPS endpoint 为应用层目的地，API key 只进入
`Authorization` header。extension 不发送 cookie、referer、用户身份、项目文件或遥测，不读取项目文件、
剪贴板、其他环境变量或其他工具结果来自动构造请求，也不记录 Tavily 原始响应或独立搜索历史。

Node.js `fetch` 受 Pi 进程已安装的 global dispatcher 及 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 等代理
配置影响。extension 不读取这些变量来改变 endpoint，也不覆盖宿主代理；用户必须同时信任自己的
Pi/Node 代理配置，因为代理在相应部署中可能观察 Authorization、query、focus 和 URL。

文件系统副作用仅为在实际 Pi agent dir 下创建并读取 `tavily-web-search/config.json`。不在项目或 extension
安装目录写运行时状态，不启动后台进程、watcher、socket、遥测或长期 timer；只有可取消的请求 deadline
与 retry 等待会使用短期 timer。

## 持久化与隐私

extension 自己只额外持久化：

- `<agent-dir>/tavily-web-search/config.json`。
- Pi session 内不参与 LLM context 的 namespaced 预算账本。
- Search tool result `details` 中恢复 ref 所需的最小、有界元数据。

它不持久化 API key、Tavily 原始响应、完整正文的额外副本、独立 query/URL 历史、磁盘 cache、debug log
或遥测。账本不保存 query、focus、URL、标题或正文。

Pi 自身仍会持久化工具参数和发给 LLM 的 tool result，因此 query、focus、候选 URL、引用 URL 和展示给
模型的网页正文可能存在于 Pi session 文件；`details` 不发送给 LLM，但也属于 session 持久化数据。“内存
cache 不落盘”不等于网页内容不会出现在 Pi session。

启用 session 持久化时，当前分支可在 reload 或进程恢复时从 custom ledger 重建预算，并从 Search details
恢复合法 refs。`--no-session` 下只保证当前进程内的 branch 切换和 `/reload` 恢复；进程退出后 refs 与预算
账本不能恢复。cursor 和内存 cache 从不恢复。

清理时删除实际 `<agent-dir>/tavily-web-search/` 目录即可。再次启用后会按当时安装版本重新创建缺失默认
配置。

## 模式支持

interactive、RPC、JSON 和 print 模式使用相同工具语义。非交互模式不等待确认框或人工输入。

- Interactive 提供紧凑的折叠/展开 renderer；正文展开态明确标记 `untrusted web content`，不流式显示
  Tavily 内容。
- RPC 可以通过结构化 UI bridge 接收状态和通知，不把这些事件混入工具结果，也不要求客户端回应。
- JSON 和 print 不调用 UI API；正常启动不打印状态噪声。
- 初始化失败只禁用本 extension 并通过 Pi 原生 extension error 路径报告，其他 extension 和 Pi session
  继续运行。缺失或孤立的工具对不会向模型注入 Tavily schema、description 或 prompt。

## 开发

默认检查和测试完全离线，不读取真实用户配置、真实 key、真实 Pi session、真实模型或不受控网络：

```bash
npm run check
npm test
```

真实 Tavily 集成测试必须显式运行，要求 `TAVILY_API_KEY`，缺失时明确失败。它使用临时 agent dir，最多
发起三次真实 Tavily 请求并报告安全的 credits 摘要：

```bash
npm run test:integration:tavily
```

真实模型行为评测也必须显式运行，需要当前 Pi 可用的模型认证和 `TAVILY_API_KEY`。任一缺失时结果必须
显示为 `skipped`，不能算作通过：

```bash
npm run test:model-eval
```

交付前还应使用临时 agent dir 和 dummy non-empty key 完成本机 Pi 的无付费、零网络加载 smoke test，并
分别验证成功动态注册完整工具对，以及缺 key 时 session 仍可用、工具未暴露且零网络。

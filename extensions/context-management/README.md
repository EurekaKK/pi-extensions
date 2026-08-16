# context-management

为 Pi 提供发送前上下文编译、滚动 Checkpoint、可精确召回的 Evidence，以及跨 session 的 Repository Memory。
Extension 接管每一次模型请求前的上下文投影和全部原生 compaction 路径，目标是在长任务中保留近期完整对话、关键
决策与可验证工具结果，同时不把临时 working state 或 Todo 再复制一份。

## 状态

`experimental`

第一版没有用户配置项；预算、阈值和文件上限均为固定规格。

## 安装、启用与卸载

要求 Node.js `>=22.19.0` 和使用 `@earendil-works/*` scope 的本机最新版 Pi。从仓库根目录安装：

```bash
pi install ./extensions/context-management
```

通过 `pi config` 启用或停用。卸载：

```bash
pi remove ./extensions/context-management
```

卸载不会删除已写入的 Repository Memory 或 Pi session 中的原生 CompactionEntry。重新启用后，extension 会把
带有效 v1 details 的最新 compaction 恢复成自己的 Checkpoint；其他 compaction 作为 opaque legacy summary 使用。

不要同时启用其他会改写 context 或接管 compaction 的 extension。V1 将自己视为唯一 owner，不提供共存协议。

## Active Context

每次普通 provider request 发送前，extension 按固定顺序编译：

1. Pi 的固定 system prompt、AGENTS.md、skills 与 active tool schemas；
2. 至多一个已安装或待提交的滚动 Checkpoint；
3. Protected Tail，也就是近期闭合的完整对话和当前 run；
4. 按当前用户输入自动召回的 Repository Memory；
5. 本 run 显式请求并通过预算准入的完整 Evidence。

Memory Pack 与 Evidence Pack 是不可持久化的 synthetic messages，位于本 run root user input 之前。相同 pack 在同一
run 内保持文本、顺序和 timestamp 稳定。模型 context window 始终保留 20,000 tokens 的 generation headroom；
最终完整投影超过 `contextWindow - 20,000` 时不会侥幸发送。

Protected Tail 的目标是 safe input 的 10%，并限制在 20,000–64,000 tokens。它不会从 tool result 开始、拆开
tool call/result closure 或压缩尚未 settled 的当前 run；单个闭合 turn 超过目标时会完整保留。

## Background 与 blocking compaction

当可压缩旧前缀接近当前模型的独立 compactor 容量时，extension 用同一个当前模型和 provider 在隔离 context 中
预生成 Checkpoint。这个后台请求不阻塞当前普通请求；新对话继续追加，生成完成后在最早的 idle/settled 时机通过
Pi 原生 compaction lifecycle 安装。

如果下一次发送前已经达到 blocking threshold 或完整请求超预算，extension 会在该 `context` barrier 中先做确定性
Evidence reduction，再复用兼容的 prepared candidate，必要时同步生成 Checkpoint。同步生成会阻塞这一次发送；
在 TUI 中显示 working message。成功候选立即替换内存投影，当前 agent loop 可以继续，settled 后再持久化成唯一的
原生 CompactionEntry。如果压缩空间耗尽后仍只差自动 Memory Pack，本 run 会移除整个 pack 后重试；不会部分淘汰、
重排 Memory，也不会移除已准入 Evidence。仍放不下则 abort，provider request 不会发送。

后台和同步 compactor 都会产生一次额外的当前模型网络请求、token 用量和费用。Compactor 不加载主 Agent tools，
不执行项目操作，也不把完整 normalized source 另行持久化。

原生 `/compact [focus]` 保持原命令入口，但 manual、threshold 和 overflow 三种路径全部由本 extension 返回摘要结果；
Pi 默认 summarizer 不再作为 fallback。`focus` 只作用于当次 checkpoint。

## Evidence Reference

被确定性缩减的 finalized tool result 会留下 branch-local reference：

```text
cm-evidence:v1:<session-entry-id>
```

模型可调用 `context_management_evidence_read` 请求一个 exact reference。持久化 tool result 只记录短确认；完整原始
call、result、details 和图片在下一 provider preflight 中按 source order 整项准入，成功后固定到本 run 的
Evidence Pack。它不会截断、摘要、跨 branch 搜索或 fuzzy fallback；当前模型不支持图片时，含图片的 evidence 会
明确失败。Evidence Pack 在 `agent_settled`、abort、tree/session replacement 或 shutdown 时清空。

普通机械缩减包括 exact duplicate，以及参数完全归一化一致的内置 `read`、`grep`、`find`、`ls` supersession。
错误、图片、未知参数或无法证明等价的结果不会按 built-in supersession 缩减。Raw Evidence 始终保留在 Pi session
branch。为保持 provider prefix cache 稳定，首次确认内容变化时先在新结果后追加瞬时 supersession marker；旧结果离开
Protected Tail 后的下一 Projection Epoch 才物化为 stub。Checkpoint 只保存可回读的 reference。

## Repository Memory

主 Agent 可以主动保存四类长期知识：`decision`、`verified-change`、`learning`、`milestone`。用户明确要求记住时应
写入；即使没有明确要求，模型判断内容对未来 session 长期有用时也可以写。不应保存当前进度、Todo、临时计划、
下一步、容易从仓库重建的噪音、credentials、secret 或无关个人信息。

注册工具：

- `context_management_memory_write`：创建记录；精确 fingerprint 幂等，correction 用新记录显式 `supersedes`；
- `context_management_memory_search`：非空 query，最多 10 个 metadata stubs / 4,096 estimated tokens；
- `context_management_memory_read`：读取一个当前 applicable、active 的 exact ID，正文不在读取时截断；
- `context_management_memory_forget`：只在当前用户明确要求移除时调用，物理删除一个 exact ID；有关联则整次失败。

每条 `summary` 最多 256 estimated tokens，`contentMarkdown` 最多 10,240 UTF-8 bytes。自动 Memory Pack 最多
8,192 estimated tokens，使用 scope/branch/path applicability、exact literal、BM25 和上一 pack continuity 排名；
先尝试完整记录，放不下则用带摘要和 exact read 指引的 stub。Pack 在一个 run 内冻结，search/read 不改变它。

Memory 不写项目目录。Git repository 与所有 worktree 通过 canonical git common dir 共享一个 store；独立 clone
分开。非 Git 项目按 canonical cwd 分开。文件位置：

```text
<Pi agent dir>/context-management/repositories/<repository-key>/memory.json
```

`memory.json` 是 UTF-8、schemaVersion 1 的唯一事实源，最大 8 MiB；单文件写入使用进程内 mutation queue、同目录
跨进程 advisory lock、0600 temp、fsync 和 rename，目录使用私有权限。超过 8 MiB 时不会自动淘汰记录，错误会给出
exact path、当前/候选大小，并要求先 search/read 或人工检查后明确 forget obsolete ID。损坏、未知 schema、symlink
或非普通文件会原样保留并禁用该 repository 的全部 Memory 能力；Context Compiler 仍继续工作。

`rename` 是写入提交点：此前失败会保留旧文件并报告未写入；如果 `rename` 已成功但父目录 `fsync` 失败，新文件仍按
已生效处理，工具成功返回并明确警告“崩溃持久性未经确认”，不会尝试不可靠的回滚。

该文件是本机明文，可能包含模型或用户写入的仓库知识。清理方式是先通过 exact `memory_forget` 删除无关联记录，或在
Pi 完全退出后由用户自行检查并管理上述 exact 文件。不要在其中保存凭据。

## 状态命令

`/context-management-status` 是只读用户命令，显示当前模型窗口、safe input、完整 projection、校准、各层占用、
Checkpoint coverage、tail range、pack、reduction、background/blocking state、Repository Identity、record/bytes
和 exact memory path。它不会触发 compaction、重建 pack、准入 Evidence、写 session entry 或输出 Memory/Evidence
正文、prompt、fingerprint、provider payload 或凭据。

## 模式支持

| 模式 | Context barrier / compaction | Memory 与 Evidence 工具 | 状态 |
| --- | --- | --- | --- |
| TUI | 完整支持；blocking 时显示 working message | 支持 | `/context-management-status` 通知 |
| RPC | 相同预算与失败关闭语义，不等待终端 UI | 支持 | 通过 UI bridge 返回 |
| JSON | 相同语义，不显示后台通知或 spinner | 支持 | 命令输出由宿主呈现 |
| print | 相同语义，不等待交互 UI | 支持 | 命令输出由宿主呈现 |

所有模式都安全加载。后台 preparation 不主动 toast；headless 模式的 blocking failure 通过正常 abort/error 语义暴露。

## 权限、副作用与限制

- 普通请求和 compactor 请求会把其各自的上下文发送给当前模型 provider；extension 不另做遥测或后台上传。
- Compactor provider 请求 timeout 为 5 分钟；关闭 provider SDK 内层 retry，并复用 Pi 的 transient-error 分类做最多
  3 次指数退避。该 transport retry 与机械 validation regeneration 分开计数并响应 abort。
- 读取当前 Pi session branch、Git identity 和 Repository Memory；Git identity查询启动短生命周期 `git` 子进程，带
  timeout 和 abort。
- 只在 Pi agent dir 下写 `memory.json`、精确 temp/lock metadata；不写项目目录或 extension 安装目录。
- Checkpoint 只通过 Pi 原生 CompactionEntry 持久化；完整 Evidence Pack、Memory Pack、prepared candidate 和 estimator
  calibration 只存在内存。
- V1 没有配置项、embedding/vector search、time decay、自动 memory observer、memory 升级/迁移或自动清理。
- Memory authoring 信任主模型的语义判断；Runtime 只做类型、关系、大小、scope、Unicode 和文件一致性校验，不判断
  事实正确性或重要性。

## 开发

在 package 目录运行：

```bash
npm run check
npm test
```

真实加载 smoke test 必须从 `extensions/context-management/` package 根入口加载，确认 Pi 只解析根 `index.ts`，
启动页只显示一次 `context-management`，不显示 `src`，并能在不发起模型请求时安全启动和退出。

```bash
smoke_root="$(mktemp -d)"
mkdir "$smoke_root/agent"
PI_AGENT_DIR="$smoke_root/agent" pi --offline --no-session --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-extensions -e ./index.ts --verbose
rmdir "$smoke_root/agent" "$smoke_root"
```

在空输入处按 `Ctrl-D` 退出。最后两个 `rmdir` 只会删除仍为空的 smoke 目录；若 Pi 写入了意外文件，它们会安全失败，
便于先检查副作用。

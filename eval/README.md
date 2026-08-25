# Harbor Pi TUI adapter

本目录是独立的 Python 评测夹具，不是 Pi extension，也不加入 npm workspaces。它提供一个可配置的 Harbor Installed Agent：每次 trial 用真实 Pi TUI 跑一条 Terminal-Bench 指令。

状态：`experimental`。不要使用 Harbor 内置的 `harbor.agents.installed.pi:Pi`（旧 package scope，且走 `--print`）。

## 实验因子与夹具

在 Harbor job 里配置实验因子：

```yaml
agents:
  - import_path: pi_eval_harness.agent:PiTuiAgent
    model_name: deepseek/deepseek-v4-flash
    kwargs:
      thinking: high
      context_trace: true
      context_trace_strict: false
      context_scenario_tools: false
      eval_variant: null
      extensions:
        - context-management
        - todo
        - sub-agent
```

- `model_name`：`provider/id`。provider 决定容器内导出哪一个 Pi 文档中的 key 环境变量。
- `thinking`：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。
- `context_trace`：可选，默认 `false`。加载最后一个 eval-only probe，把最终 `context`、provider payload shape、tool result 尺寸、usage/cache 和 compaction lifecycle 写成不含正文的 NDJSON。
- `context_trace_strict`：可选，默认 `false`，且要求 `context_trace: true`。开启后 deterministic trace invariant failure 会使 post-run 失败；只观察不 gate 的 job 保持关闭。
- `context_scenario_tools`：可选，默认 `false`。加载 eval-only `context_burst` 工具，为本地 Context Lab 生成指定字节数和 canary 的确定性纯文本结果；不属于生产 extension。
- `eval_variant`：可选 kebab-case 标签。只改变 Harbor `AgentInfo.name` 和 post-run metadata，用于把同模型 A/B 两臂分开聚合；不改变 prompt、工具或运行时行为。
- `extensions`：本仓库 `extensions/` 下的 kebab-case 目录名，顺序即 `pi install` 与 `--extension` 顺序。空列表或不写该字段 = 原生 Pi。
- `append_system_prompt`：可选；默认不加。four-ext job 不再额外 steer；goal / sub-agent 的调用政策由 extension 自带的 `promptGuidelines` 进入 Pi system prompt。native 不加。

以下内容是夹具，不是 job 旋钮：

| 夹具 | 值 |
| --- | --- |
| Pi | `@earendil-works/pi-coding-agent` `0.84.2` |
| Node | `22.23.2` |
| nvm | `v0.40.2` |
| Harbor | `0.20.0` |
| Python | `>=3.12,<3.13` |
| 启动开关 | `--offline --approve --no-extensions --no-skills --no-prompt-templates --no-themes` |
| 环境 | `PI_OFFLINE=1` `PI_TELEMETRY=0` 独立 `PI_CODING_AGENT_DIR` |
| 指令投递 | 真实 TUI + bracketed paste；不用 `--print` |
| TUI 收工 | 每次提交前记录 assistant `stop` 数量；只有本次提交产生新的 `stop` 才可能 `/quit`，历史 step 的 stop 不参与结算。`Working...` 或 `Compacting conversation…` 都算已确认提交。最新 `goal:change` 仍为 `active` 时，等到新 stop 之后出现 `goal:round` 再继续等下一轮；15s 内没有续跑则收工。`complete` / `blocked` / `paused` / 无 goal 在新 stop 后立即收工。续跑仍在走但未标 complete 时，等 Harbor agent timeout |
| 流中断 | driver 在同一 session 里最多 continue 3 次，不把单次 `Stream ended without finish_reason` 记成 exit 74；第 4 次以 exit 75 失败，401/402 仍 fail-closed |
| 任务镜像 | runtime job 启动前按 YAML 题单 `docker pull` 预拉 Harbor 将启动的 image |
| 容器清理 | job 结束后拆掉本 job 以及已结束 sibling job 的 Harbor trial 容器和 compose 网络；不删镜像 |
| 密钥 | 只读 bind-mount 到 `/run/secrets/…`；Harbor `agent.env` 不得带 API key |

不加 `--no-context-files`，任务仓里的 `AGENTS.md` / `CLAUDE.md` 仍按 Pi 默认加载。adapter **不写、不覆盖** 任何 extension 的 `config.json`，也不检查 sidecar / guardian / worker。sub-agent v2 首次加载会自建 inherit 默认配置。

## 安装与启用

本机需要 [uv](https://docs.astral.sh/uv/) 和 Docker（Harbor trial 用）。在 `eval/` 下：

```bash
uv sync --group dev
```

配置模型 provider 的密钥（写入被 git 忽略的 `eval/.secrets/model_api_key`，权限 `600`）：

```bash
./scripts/configure-model-key.sh
```

只有 job 的 `extensions` 含 `tavily-web-search` 时才需要第二把 key：

```bash
./scripts/configure-tavily-key.sh
```

不要把 key 放进 Harbor `env` / `extra_env`。install-only job 不挂密钥。

## 示例作业

数据集和题单属于 job，不属于 adapter。示例引用 Terminal-Bench 2.1 的一题 smoke，方便第一次接入。`dev16` 是从该 digest 的 59 题 development split 里去掉棋盘图 / 代码截图 / 视频抽帧 / 参考 PPM 四道视觉输入题后，按类别 Hamilton 配额抽出的 16 道非视觉题。`dev12` 从同一非视觉 development 池按难度抽 4 易 / 4 中 / 4 难；池里官方 easy 只有两道，另外两道 easy 用最短 expert/junior 工时的 medium 补齐。`med16` 从同一非视觉 development 池取 author-labeled medium，丢掉 `agent.timeout_sec >= 1800` 的题后再按 hash 抽 16 道。`med16` native 与 four-ext 共用 `opencode-go/deepseek-v4-flash`、thinking `max`；差别只在四个 extension。抽样细节见 `configs/tb21-dev12.json` 和 `configs/tb21-med16.json`。Harbor 每个 trial 默认把 Pi session jsonl、TUI typescript 和 trial.log 留在 `eval/runs/`，容器删掉后轨迹仍在。

```bash
./scripts/run-install-only.sh
./scripts/run-runtime-smoke.sh
./scripts/run-install-only-extensions.sh
./scripts/run-runtime-smoke-extensions.sh
./scripts/run-runtime-smoke-tavily.sh
./scripts/run-runtime-smoke-four-ext.sh
./scripts/run-dev12.sh
./scripts/run-dev12-four-ext.sh
./scripts/run-dev16.sh
./scripts/run-dev16-four-ext.sh
./scripts/run-dev16-retry-fail6.sh
./scripts/run-med16.sh
./scripts/run-med16-four-ext.sh
./scripts/run-context-lab.sh
```

脚本会校验扩展源和密钥、预拉题单 Docker 镜像、导出 mount 变量，并调用 `uv run harbor run --config … --job-name pi-tui-<timestamp> --yes`。自定义 job：

```bash
./scripts/run-harbor-job.sh --config path/to/job.yaml
./scripts/run-harbor-job.sh --config path/to/job.yaml --install-only
./scripts/prefetch-task-images.sh --config configs/harbor/dev16.yaml
./scripts/cleanup-job-docker.sh --config configs/harbor/dev16.yaml --job-name pi-tui-native-dev16-mimo-20260819
```

已缓存的镜像会跳过 pull。跳过预拉：`PI_EVAL_SKIP_IMAGE_PREFETCH=1`。跳过收尾拆容器：`PI_EVAL_SKIP_DOCKER_CLEANUP=1`。

## Context Evaluation Lab

`tasks/context-lab/` 是本地可控 Harbor task，不修改 Terminal-Bench：

- `basic-tools`：使用 `read` / `write` / `edit` / `bash` 完成一个带 canary 的小变更。
- `large-tool-output`：调用 `context_burst` 返回恰好 70,000 字节，观察 native 与 context-management 的最终 tool-result/context 差异。
- `large-tool-output-250k`：调用同一工具返回恰好 250,000 字节，用独立双臂 job 测量固定 50,000 字节 spill cap 的实际收益。
- `repeated-spill-prune`：在一个 managed turn 中请求 17 个 250,000 字节结果，验证 17 次 spill 累积到压力后由机械 prune 把后续模型 surface 限制到单字符串 8,192 字节以内，并避免安装 Compaction Checkpoint。
- `checkpoint-continuity`：两步 managed task；第一步结算后由 eval-only `context_seed_history` 向同一 Pi session 追加 9 个各 100,000 字节的 model-visible custom history messages，第二步恢复 session 并验证一次 Rolling Checkpoint、early persistent canary、recent protected-tail canary 和无外部读取的连续性。该任务跨 Pi 进程恢复，内存 candidate 不延续，因此固定作为同步 checkpoint baseline。
- `prepared-checkpoint-continuity`：单进程 managed task；初始 turn 结算后先等待后台 candidate lifecycle 到 `ready`，再由 driver 投递 continuity follow-up，验证 `started → ready → installed`、同一 checkpoint/tail 契约及 pressure follow-up 延迟低于同步 baseline 的 10%。
- `rolling-checkpoint-continuity`：单进程三 turn managed task；连续注入两轮 history，分别等待 candidate ready 后再投递 pressure follow-up，验证两次 `started → ready → installed`、上一轮 persistent canary 被滚入下一份 checkpoint、两轮 protected tail 都可用，以及两次前台阻塞都低于同步 baseline 的 10%。
- `resume-canary`：两步 task；第二步要求日志目录中恰好存在一个 session，并通过 Pi `--session <exact path>` 恢复它，再回忆第一步未写入文件的 persistent canary。

`configs/harbor/context-lab.yaml` 在相同 `opencode-go/ox-alpha-free`、thinking、task、timeout 和 probe 下运行两臂，唯一产品因子是 `extensions: []` 与 `extensions: [context-management]`。context lab 的 smoke、A/B 和后续压力实验都固定使用该模型；默认 `n_attempts: 1` 只用于基础设施 smoke，正式模型比较至少覆盖三次 attempt，并交替运行两臂以降低 provider 时间段偏差。

正式重复基线不复制 smoke config；通过 Harbor CLI 覆盖 attempt 数并保持串行。agent setup 上限放宽到两倍，只避免容器安装阶段的网络抖动，不改变 agent/task timeout：

```bash
PI_EVAL_SKIP_IMAGE_PREFETCH=1 ./scripts/run-harbor-job.sh \
  --config configs/harbor/context-large-output-smoke.yaml \
  --job-name context-spill-baseline-n3-YYYYMMDD -- \
  --n-attempts 3 --n-concurrent 1 --agent-setup-timeout-multiplier 2
```

跨 attempt 汇总会从原始 probe 重新执行当前 invariants，并要求每个 `eval_variant` 恰好有 3 个非基础设施样本：

```bash
uv run python scripts/summarize-context-job.py \
  --expect-attempts 3 --expect-model opencode-go/ox-alpha-free \
  runs/context-large-output-smoke/context-spill-baseline-n3-YYYYMMDD
```

多个 job 目录可以放在同一命令中，用后续 replacement trial 补齐有效样本。已识别的 provider 503/stream recovery exhaustion 和 agent setup timeout 计入 `infrastructure_failures`，不会污染产品 pass rate、latency 或 usage 分布；但有效样本不足时 `valid_attempt_count` 仍使命令退出非零。未知异常和 trace/verifier 失败仍作为产品失败，不会被自动豁免。

managed 臂启用 `context_trace_expect_spill`；它只在任务 prompt 含 `CTX_CANARY_EXPECT_SPILL_BYTES_<n>` 时生效，自动要求 context-management 已初始化、恰好写出一个 `<n>` 字节 spill、模型可见结果不超过 50,000 字节，且后续 context/provider surface 不再出现超过该上限的单字符串。其他 context-lab 任务和 native 臂不执行这条 invariant。

压力 job 启用 `context_trace_expect_prune`；它从 `CTX_CANARY_EXPECT_PRUNE_SPILLS_<count>_BYTES_<n>` 读取期望，要求全部原文安全 spill、每个即时结果不超过 50,000 字节、最后一次 burst 后的 context/provider surface 不超过 8,192 字节，并拒绝已安装的 compaction。

checkpoint job 启用 `context_trace_expect_checkpoint`；它从 `CTX_CANARY_EXPECT_CHECKPOINT_CHUNKS_<count>_BYTES_<n>` 读取期望，检查 pre-compaction Session Context、一个 `from_extension` checkpoint、checkpoint summary 中的 early canary、summary 之外仍可见的 recent-tail canary，并禁止 recall step 使用 `write` 之外的工具。

prepared job 额外启用 `context_trace_expect_prepared_checkpoint`；它从 `CTX_CANARY_EXPECT_PREPARED_CHECKPOINT_BASELINE_MS_<n>` 读取同步 baseline，要求 lifecycle 按 `started → ready → installed`，`ready` 早于 follow-up，`installed` 位于 follow-up start 与首个 context 之间，且阻塞时间低于 `<n> / 10`。

rolling job 启用 `context_trace_expect_rolling_checkpoint`；它要求两个完整且顺序一致的 candidate lifecycle，逐轮检查 ready-before-follow-up、install-at-pressure 和 `<baseline> / 10` 延迟上限，并验证 checkpoint 2 同时保留第一轮与第二轮 persistent canary、第二轮 protected-tail canary 位于 summary 之外。

```bash
./scripts/run-context-lab.sh
```

第一次真实调用只跑 70,000 字节工具结果的双臂 smoke：

```bash
PI_EVAL_SKIP_IMAGE_PREFETCH=1 ./scripts/run-harbor-job.sh \
  --config configs/harbor/context-large-output-smoke.yaml
```

250,000 字节收益 A/B：

```bash
PI_EVAL_SKIP_IMAGE_PREFETCH=1 ./scripts/run-harbor-job.sh \
  --config configs/harbor/context-large-output-250k-smoke.yaml
```

重复 spill → pressure prune：

```bash
PI_EVAL_SKIP_IMAGE_PREFETCH=1 ./scripts/run-harbor-job.sh \
  --config configs/harbor/context-prune-pressure-smoke.yaml
```

同步 Rolling Checkpoint continuity：

```bash
PI_EVAL_SKIP_IMAGE_PREFETCH=1 ./scripts/run-harbor-job.sh \
  --config configs/harbor/context-checkpoint-smoke.yaml
```

后台 Prepared Checkpoint continuity：

```bash
PI_EVAL_SKIP_IMAGE_PREFETCH=1 ./scripts/run-harbor-job.sh \
  --config configs/harbor/context-prepared-checkpoint-smoke.yaml
```

两轮 Rolling Prepared Checkpoint continuity：

```bash
PI_EVAL_SKIP_IMAGE_PREFETCH=1 ./scripts/run-harbor-job.sh \
  --config configs/harbor/context-rolling-checkpoint-smoke.yaml
```

离线分析单个 trial：

```bash
uv run python scripts/analyze-context-trace.py \
  runs/context-lab/<job>/<trial>/agent
```

对 managed large-output trial 同时强制 spill contract：

```bash
uv run python scripts/analyze-context-trace.py --expect-spill \
  runs/context-lab/<job>/<trial>/agent
```

对 managed pressure trial 强制 prune contract：

```bash
uv run python scripts/analyze-context-trace.py --expect-prune \
  runs/context-lab/<job>/<trial>/agent
```

对 managed checkpoint trial 强制 continuity contract：

```bash
uv run python scripts/analyze-context-trace.py --expect-checkpoint \
  runs/context-lab/<job>/<trial>/agent
```

对同进程后台 candidate trial 强制 prepared-hit contract：

```bash
uv run python scripts/analyze-context-trace.py \
  --expect-checkpoint --expect-prepared-checkpoint \
  runs/context-lab/<job>/<trial>/agent
```

对两轮滚动 candidate trial 强制 rolling contract：

```bash
uv run python scripts/analyze-context-trace.py \
  --expect-checkpoint --expect-prepared-checkpoint --expect-rolling-checkpoint \
  runs/context-lab/<job>/<trial>/agent
```

analyzer 的 `summary.latency.first_context_ms_by_run` 记录每个 Pi process run 的首次阻塞，`context_block_ms_by_agent_start` 则覆盖同进程的每次用户提交；同步 checkpoint 的 Compactor Request 完整落在后者，prepared-hit 也用同一指标与 baseline 比较。

命令输出 JSON summary；current-input/persistent/checkpoint canary 或 tool call/result 配对 invariant 失败时退出非零。

probe trace 位于 trial artifact 的：

```text
agent/pi/context-probe/probe.ndjson
```

每条记录只含 schema、trial-local HMAC、事件类型、角色/内容类型计数、UTF-8 字节数、fingerprint、usage/cache 和显式 `CTX_CANARY_*` 命中，不含 system prompt、用户正文、tool arguments、tool output、provider payload、headers、cwd 或原始 session ID。probe 还会记录 context-management command/config 是否存在、spill 文件数量与总字节，以及 `before_agent_start` 时完整 Session Context 的安全 shape 摘要；不记录 spill 路径、文件名或内容。同一 multi-step agent 实例复用 HMAC key，因此 grader 能发现 resume 静默切换了 session；`populate_context_post_run()` 会把 aggregate summary 与 deterministic invariant violations 写入 Harbor `AgentContext.metadata.context_trace`。

已知盲区：`context-management` 当前自定义 Compactor 直接调用 provider `streamSimple()`，绕过 Pi 的 `before_provider_request` hook；它还会忽略 Pi 的 `session_before_compact.preparation` 并自行选择覆盖区。probe 能看到 native preparation、最终 `session_compact` 和被接受结果携带的 usage，但看不到自定义请求的 wire payload、真实 replacement selection、失败 transport attempts 或 validation regeneration 成本；这不是“没有 compactor request”，且 `compaction_usage` 会低估真实 overhead。修复此盲区需要未来显式的 eval instrumentation seam，不能靠 probe 猜测。

挂载约定：

| 本机路径 | 容器路径 | 何时需要 |
| --- | --- | --- |
| `eval/pi_eval_harness/runtime` | `/opt/pi-eval/runtime` | runtime |
| `eval/.secrets/model_api_key` | `/run/secrets/pi-eval-model-api-key` | runtime |
| 仓库 `extensions/` | `/opt/pi-extension-repo/extensions` | `extensions` 非空 |
| 仓库 `packages/` | `/opt/pi-extension-repo/packages` | `extensions` 非空 |
| 仓库 `scripts/` | `/opt/pi-extension-repo/scripts` | `extensions` 非空 |
| `eval/.secrets/tavily_api_key` | `/run/secrets/pi-eval-tavily-api-key` | 列表含 `tavily-web-search` |

三个仓库子树都只读挂载；adapter 在容器内调用仓库的 `install-extension.sh`，把选中 extension 及其内部 package 闭包复制到 `/tmp/harbor-pi-tui/my-extensions/` 后再加载。不会把整个仓库或 `eval/.secrets/` 暴露给 trial。常用扩展组合只需要模型 provider 那一把 key。

## 限制

- 不为 Test16、Study Manifest、attribution 或 git HEAD lock 提供战役协议。
- 不把隔离开关、Pi / Node 版本做成 job 级实验因子。
- 不预构建镜像；每个 trial 在容器里安装 nvm、Node 和 Pi。
- 有 `sub-agent` 时，Harbor usage 只覆盖主 Pi session；metadata 会声明子 session 可能未计入。
- Context probe 只记录普通 Agent SDK provider payload；extension 直接调用 provider 的 wire payload 不可见。
- 未知 kebab-case 名、缺 package 清单 / Pi 入口、缺密钥文件都会 fail closed。
- 默认自动化测试不跑真实 Harbor trial 或真实模型。

## 权限与副作用

- **本机**：读取 `eval/.secrets/` 下的密钥文件并 bind-mount；不把 key 写入进程 argv。Harbor 会在 `eval/runs/` 写 trial 产物。
- **容器 install**：`apt-get` 安装 bash/curl/git/ripgrep；从 GitHub 安装 nvm；`npm install -g`  pinned Pi；对点名的 extension 执行 `pi install`。
- **容器 run**：启动真实 Pi TUI，向模型 API 发请求；`PI_TELEMETRY=0`、`--offline`。不替 extension 访问未说明的网络。
- **不**读取用户 `~/.pi` 作为评测状态；每次 trial 使用 `/tmp/harbor-pi-tui`。

## 持久化

- `eval/.secrets/`：本机密钥，不进 git。删除该目录即可清理。
- `eval/runs/`：Harbor job 产物，不进 git。删除即可清理。
- 容器内 Pi session 写到 trial 日志目录（`agent/pi/sessions/*.jsonl`、`agent/pi-tui.typescript`、`trial.log`）；不向 `extensions/` 源码目录写运行时状态。
- adapter 不写 extension `config.json`；各包首次加载可在容器 agent dir 自建默认配置。

## 模式支持

这是 Harbor Installed Agent，只通过真实 TUI 驱动 Pi。multi-step task 可用 `resume_trajectory: true` 恢复日志目录中唯一的 Pi session；不存在或存在多份 session 时 fail closed。没有 RPC / `--print` adapter，也不实现 Harbor 预留的 `load_trajectory`。

## 开发

```bash
cd eval
uv sync --group dev
uv run ruff check .
uv run pytest
```

默认测试使用假 Harbor environment 记录 `install` / `run` 命令，并用 `JobConfig.model_validate` 解析示例 YAML。它们不访问真实 `~/.pi`、用户项目、凭据、付费 API 或不受控网络。

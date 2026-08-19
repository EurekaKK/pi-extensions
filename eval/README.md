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
      extensions:
        - context-management
        - todo
        - sub-agent
```

- `model_name`：`provider/id`。provider 决定容器内导出哪一个 Pi 文档中的 key 环境变量。
- `thinking`：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。
- `extensions`：本仓库 `extensions/` 下的 kebab-case 目录名，顺序即 `pi install` 与 `--extension` 顺序。空列表或不写该字段 = 原生 Pi。
- `append_system_prompt`：可选；默认不加。

以下内容是夹具，不是 job 旋钮：

| 夹具 | 值 |
| --- | --- |
| Pi | `@earendil-works/pi-coding-agent` `0.84.1` |
| Node | `22.23.2` |
| nvm | `v0.40.2` |
| Harbor | `0.20.0` |
| Python | `>=3.12,<3.13` |
| 启动开关 | `--offline --approve --no-extensions --no-skills --no-prompt-templates --no-themes` |
| 环境 | `PI_OFFLINE=1` `PI_TELEMETRY=0` 独立 `PI_CODING_AGENT_DIR` |
| 指令投递 | 真实 TUI + bracketed paste；不用 `--print` |
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

数据集和题单属于 job，不属于 adapter。示例引用 Terminal-Bench 2.1 的一题 smoke，方便第一次接入；正式题单请自己写 YAML。

```bash
./scripts/run-install-only.sh
./scripts/run-runtime-smoke.sh
./scripts/run-install-only-extensions.sh
./scripts/run-runtime-smoke-extensions.sh
./scripts/run-runtime-smoke-tavily.sh
```

脚本会校验扩展源和密钥、导出 mount 变量，并调用 `uv run harbor run --config … --job-name pi-tui-<timestamp> --yes`。自定义 job：

```bash
./scripts/run-harbor-job.sh --config path/to/job.yaml
./scripts/run-harbor-job.sh --config path/to/job.yaml --install-only
```

挂载约定：

| 本机路径 | 容器路径 | 何时需要 |
| --- | --- | --- |
| `eval/pi_eval_harness/runtime` | `/opt/pi-eval/runtime` | runtime |
| `eval/.secrets/model_api_key` | `/run/secrets/pi-eval-model-api-key` | runtime |
| 仓库 `extensions/` | `/opt/pi-extensions` | `extensions` 非空 |
| `eval/.secrets/tavily_api_key` | `/run/secrets/pi-eval-tavily-api-key` | 列表含 `tavily-web-search` |

常用扩展组合只需要模型 provider 那一把 key。

## 限制

- 不为 Test16、Study Manifest、attribution 或 git HEAD lock 提供战役协议。
- 不把隔离开关、Pi / Node 版本做成 job 级实验因子。
- 不预构建镜像；每个 trial 在容器里安装 nvm、Node 和 Pi。
- 有 `sub-agent` 时，Harbor usage 只覆盖主 Pi session；metadata 会声明子 session 可能未计入。
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
- 容器内 Pi session 写到 trial 日志目录；不向 `extensions/` 源码目录写运行时状态。
- adapter 不写 extension `config.json`；各包首次加载可在容器 agent dir 自建默认配置。

## 模式支持

这是 Harbor Installed Agent，只通过真实 TUI 驱动 Pi。没有 RPC / `--print` adapter。

## 开发

```bash
cd eval
uv sync --group dev
uv run ruff check .
uv run pytest
```

默认测试使用假 Harbor environment 记录 `install` / `run` 命令，并用 `JobConfig.model_validate` 解析示例 YAML。它们不访问真实 `~/.pi`、用户项目、凭据、付费 API 或不受控网络。

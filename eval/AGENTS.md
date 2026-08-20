# eval/ 约束

本目录是独立的 Python Harbor 评测夹具，不是 Pi extension，不加入 npm workspaces。

- 产品入口只有 `pi_eval_harness.agent:PiTuiAgent`。
- Harbor 与 Pi 核心包都是 peer / 夹具 pin，不要把它们打进 npm 发布物，也不要让任何 `extensions/` 包引用本目录。
- 检查与测试在本目录执行：`uv run ruff check .` 与 `uv run pytest`。不要用根目录的 `npm run check` 代替。
- 默认测试必须停留在 Harbor 可见的 trial launch plan：JobConfig YAML 与假 environment 上的 `install` / `run` / `populate_context_post_run`。不要为 bash driver 另开产品 seam，也不要在默认测试里跑 Docker、真实模型或用户密钥。从 task 目录解析 Harbor 将启动的 image、以及用假 inspect 判断该拆哪些 trial 容器，可以测解析契约，但不得 `docker pull` / `docker rm`。
- 真实 `harbor run` 只通过 `scripts/` 显式触发。
- 不要为任何 extension 写 `config.json`，不要检查 sidecar / guardian / worker。
- 普通任务不要提升任何 extension 的 SemVer、不要去掉 `private`、不要发布 npm。

# extension-name

一句话说明 extension 的用途。

## 状态

`experimental`

## 安装、启用与卸载

说明安装 package、启用 extension 和卸载的方法。

## Extension 依赖

本 extension 依赖其他 extension 时，在 package.json 中声明安装期依赖：

```json
{
	"piExtensionDependencies": ["other-extension"]
}
```

`scripts/install-extension.sh` 会先按「依赖优先」的拓扑顺序把全部依赖 extension 也镜像到
`~/.pi/agent/my-extensions/<name>/` 并分别 `pi install`，再安装本 extension。要求：只能引用
`extensions/` 下真实存在的目录名；声明必须无环；多根与菱形依赖只处理一次。该字段只表达安装期
依赖，不构成源码依赖——源码仍禁止 import 兄弟 extension，运行期共享代码使用 `packages/` 内部
共享包（以 `dependencies` 声明，安装脚本会 vendor 进副本）。没有依赖时省略该字段即可。

## 注册资源

列出工具、命令、快捷键、CLI flag、事件钩子和状态键；没有时明确说明。

## 使用示例

提供最小可运行示例。

## 限制

说明功能边界和已知限制。

## 权限与副作用

说明读取、写入、进程、网络和其他外部副作用。

## 持久化

说明是否持久化，以及存储位置、格式和清理方式。

## 模式支持

说明 interactive、RPC、JSON 和 print 模式的支持情况。

## 开发

```bash
npm run check
npm test
```

package 根目录的 `index.ts` 只负责把默认导出转发到 `src/index.ts`，使 Pi 启动页显示 package 目录名而不是
`src`；不要把实现逻辑写入根入口。

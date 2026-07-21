# extension-name

一句话说明 extension 的用途。

## 状态

`experimental`

## 安装、启用与卸载

说明安装 package、启用 extension 和卸载的方法。

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

# @kge/desktop — Electron Shell (Deferred)

Electron 桌面应用壳，当前仅为占位 scaffolding，后续阶段实现。

## 当前状态

- 仅有 `src/index.ts` 空入口文件
- `package.json` 中 typecheck 脚本为 no-op

## 规划

- 包裹 `@kge/web` 构建产物，提供原生窗口体验
- 系统集成：托盘图标、文件关联、自动更新
- 核心原则：**WebUI first**，Electron 只是壳，业务逻辑全部在 web 层
- E2E 测试直接测 web 层，Electron 壳只需测试窗口管理和系统集成

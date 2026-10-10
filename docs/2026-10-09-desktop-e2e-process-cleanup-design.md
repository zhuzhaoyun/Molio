# 桌面 E2E 进程清理与断言修复 —— 行为说明

> 对应：`fix/desktop-e2e-process-cleanup` 分支，修复桌面 E2E 在 CI 上的进程残留与断言覆盖问题。本文描述**当前行为与设计取舍**，供维护和下次改动时查阅。

## 背景

2026-10-08 桌面 E2E 接入 nightly CI（#263 合并）后，CI 上连续失败。排查发现两类问题：

1. **进程残留**：spec 文件串行运行时，前一个 spec 的 Molio.exe 进程未完全退出，持有单实例锁，导致下一个 spec 的 `requestSingleInstanceLock()` 返回 false，Electron 启动后立即退出。
2. **断言覆盖不足**：smoke.spec.ts 的 KB 页面测试只覆盖「空状态 / 文件节点 / vault 弹窗」三种状态，但 CI 干净环境下有 fixture 库时只有目录节点可见，断言失败。

## 修复内容

### 1. 进程清理（CI-only）

**位置**：`apps/desktop/e2e/helpers/electron-app.ts` 的 `closeMolioApp` 和 `apps/desktop/e2e/specs/protocol-clip-cold-start.spec.ts` 的 `afterAll`

**行为**：
- `electronApp.close()` 后，轮询检查残留 Molio.exe 进程（500ms 间隔，最多 5s）
- 超时后 `taskkill /F /IM Molio.exe` 强制清理
- **只在 CI 环境启用**（`process.env.CI === 'true'`），本地开发时不启用，避免误杀用户正在运行的 Molio 实例

**取舍**：CI 环境是干净 runner，可以放心 taskkill；本地开发时用户可能正在用 Molio，不能误杀。

### 2. 抽取 `ensureNoMolioProcesses()` helper

**位置**：`apps/desktop/e2e/helpers/electron-app.ts`

**行为**：轮询检查残留进程（500ms 间隔，最多 5s），超时后 taskkill。

**取舍**：electron-app.ts 的 `closeMolioApp` 和 protocol spec 的 `afterAll` 复用同一逻辑，消除复制粘贴。

### 3. KB 断言扩展

**位置**：`apps/desktop/e2e/specs/smoke.spec.ts`

**行为**：
- 断言状态从「空 / 文件 / 弹窗」扩展为「空 / 文件 / 目录 / 弹窗」（加 `.kb-tree-group` 目录节点检测）
- 加目录节点非空守卫：如果 treeGroup 可见，验证其 label 也可见（避免空 `<div class="kb-tree-group">` 掩盖文件树渲染失败）

**取舍**：CI 干净环境下有 fixture 库（E2E Fixture Vault + Clippings 目录），KB 页面显示目录节点而非空状态/文件树，原断言覆盖不到。扩展状态覆盖而非绕过问题（如删除 fixture 或跳过测试）。

### 4. 抽取 `expectAnyVisible()` helper

**位置**：`apps/desktop/e2e/helpers/electron-app.ts`

**行为**：消除「声明 locator → Promise.race waitFor → isVisible 断言」的重复模式。调用者传入 locator 数组，helper 处理 race 和最终断言。

**取舍**：smoke.spec.ts 的 KB 断言从 8 行代码（4 locator + 4 isVisible）简化为 1 行调用。

### 5. tasklist 输出解析改用 `/NH` 参数

**位置**：`apps/desktop/e2e/helpers/electron-app.ts` 的 `hasMolioProcess()`

**行为**：`tasklist /FI "IMAGENAME eq Molio.exe" /NH` 去掉 header，直接检查输出是否非空。

**取舍**：不依赖行数判断（中文 Windows 系统列名本地化导致格式差异），更可靠。

### 6. 反斜杠转义修复

**位置**：`apps/web/e2e/session-output.spec.ts`

**行为**：CSS 选择器 `[data-path="..."]` 里的反斜杠需双写转义（`hotAbs.replace(/\\/g, '\\\\')`），否则 locator 匹配不到元素。

**取舍**：Windows 路径含反斜杠，CSS 选择器语法要求转义。测试层修复，不改组件代码（`data-path` 保留原始路径）。

## 验证

- **Desktop E2E**：7 passed (25.4s) — smoke 5 条 + protocol 1 条 + window-title 1 条
- **Web E2E**：session-output.spec.ts:158 passed (9.9s)
- **本机 Windows 11 + GitHub Actions windows-2022 runner** 均验证通过

## 遗留问题

Web E2E 的 WebServer 中途崩溃（`ReadableStream is already closed`）是历史问题（从 9-19 开始），与本修复无关，需单独排查。

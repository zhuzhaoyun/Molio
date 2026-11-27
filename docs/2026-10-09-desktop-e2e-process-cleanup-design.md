# SSE 崩溃修复 + 桌面 E2E 与已装应用并行 —— 行为说明

> 对应：`fix/desktop-e2e-process-cleanup` 分支（PR #325）。本文描述**当前行为与设计取舍**，供维护和下次改动时查阅。

## 背景

两条独立的故障线索，根因不同：

1. **Web E2E nightly 连续 20 天失败**：daemon 的 SSE 流在客户端断开时抛 `ERR_INVALID_STATE: ReadableStream is already closed`，冒泡到 `uncaughtException` 直接杀死进程；WebServer 随即崩溃，后续所有用例级联失败。
2. **桌面 E2E 在本地跑不起来**：已安装的 Molio 会同时占用 `:3100` 和单实例锁。测试实例要么启动即退，要么它的 daemon 在端口冲突时把用户正在使用的 daemon 杀掉（daemon 的占用清理规则是「进程名含 molio 即视为可杀」）。

## 一、SSE 流生命周期

**位置**：`apps/daemon/src/routes/knowledge.ts`、`apps/daemon/src/routes/events.ts`、`apps/daemon/src/sse.ts`

**根因**：`cleanup()` 只清订阅和 ping timer，没有关闭 stream。客户端断开后 Hono 的 stream helper 关闭响应流，`s.pipe()` 仍在向已关闭的源 stream 写数据。

**当前行为**：

- `cleanup()` 显式调用 `stream.cancel()`，释放挂起的 reader。
- `s.pipe()` 外包一层 try-catch，**只吞 `ERR_INVALID_STATE`**；其他错误照常向上抛（避免把真实故障静默掉）。
- 职责归一：`cancel()`（ReadableStream 生命周期回调）统一做清理——订阅、timer；`cleanup()`（路由侧入口）只负责触发 `cancel()`。此前两者各写一份相同的清理逻辑，改一处漏一处的风险就此消除。

**取舍**：为什么不是「让 Hono 自动关流」——hono 的 `stream()` helper 只管理目标端，源 `ReadableStream` 的生命周期必须由创建方负责；`cancel()` 是它唯一的语义出口。

## 二、桌面 E2E 与已安装应用并行

**位置**：`apps/desktop/src/main.js`、`apps/desktop/e2e/helpers/electron-app.ts`

本机的已安装 Molio 可能一直在运行（用户正在写东西）。E2E 需要能和它共存，否则每次跑测试都要先关掉用户的应用。

三个隔离点：

| 维度 | 机制 | 说明 |
|---|---|---|
| 端口 | `MOLIO_PORT` → `main.js` 的 `DAEMON_PORT` | 默认 3100，真实用户零变化 |
| Electron userData | `--user-data-dir=<临时目录>` | 单实例锁、缓存、vault-recency 全部隔离 |
| daemon 数据 | `MOLIO_DATA_DIR=<临时目录>` | 不碰 `~/.molio` |

**端口选取策略**（`pickDaemonPort()`）：

- **CI 固定 3100**：runner 是干净的，固定端口让 nightly 日志和诊断跨天可比。
- **本地从 OS 动态端口段（49152–65535）随机取一个试绑**，最多试 10 次。
  - 不用固定区间 3101–3199：多个 worktree 并行跑测试时，两个进程会扫到同一个起始口并互相抢。
  - 动态端口段由操作系统保留给临时连接，日常软件不会静态占用；随机起点让并行实例天然错开。
  - 试绑 → 立即 close → 返回端口，存在一个极小的 TOCTOU 窗口；概率极低，且 daemon 自己还会走 EADDRINUSE 重试。

**第三进程**：protocol spec 会再启动一个 Molio 来模拟剪藏的 `molio://` 二次调用。这个进程必须带同样的 `--user-data-dir` 和 `MOLIO_PORT`，否则它的 URL 会交给用户已安装的实例（而不是测试窗口），测试就测错了对象。

**CI 专属的残留清理**：`ensureNoMolioProcesses()` 在 `closeMolioApp()` 之后轮询残留进程，超时后 `taskkill /F`。**只在 `CI === 'true'` 时启用**——本地若启用会杀掉用户正在运行的应用。

## 三、E2E 防腐

- **`data-view="home"` 已不存在**：#293 把应用入口改为 `/` → `/knowledge`，首页（整页对话）搬到 `/chat` 并从导航栏移除。新增 `gotoChatSpa()`（pushState + popstate，与 web 层同一约定），smoke 与 protocol spec 改用它；导航循环的「回到首页」改为回到知识库。
- **KB 页面状态断言**：干净环境只有目录节点可见。断言补 `.kb-tree-group`，并加非空守卫（目录节点可见时要求其 label 可见，避免空容器掩盖文件树渲染失败）。重复的「多状态可见」逻辑抽成 `expectAnyVisible()`。
- **`tasklist` 解析**：改用 `/NH` 去掉表头，直接判断输出是否非空，不依赖列名（中文 Windows 的列名会本地化）。

## 验证

- 桌面 E2E：**6 passed / 1 skipped**（`window-title` 需要两个知识库，干净 fixture 下跳过）。验证时**已安装的 Molio 全程在运行**，其 `:3100` 与 `~/.molio` 数据均未受影响。
- Web E2E：**471 passed / 6 failed**，SSE 崩溃日志消失；失败项为右键菜单与社区市场的独立问题。
- CI：`windows-2022` runner 上固定端口路径不变。

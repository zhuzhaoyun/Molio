# 多窗口支持设计（P2）— 定稿

- **日期**：2026-08-07
- **分支**：`feat/multi-window`
- **状态**：设计已确认，待实施
- **前置依赖**：P1（`feat/kb-chat-session-tabs`，PR #202）为**可选**——tabs 分片若 P1 已合并则直接用 `createTabsStore()`，否则本地实现同形工厂、P1 合并后 rebase 对齐
- **关联**：P3 分屏、P4 标签拖出（本设计是二者的基座）

## 一、背景：现状

### 当前架构：单窗口锁死

**桌面端（Electron 壳）** — `apps/desktop/src/main.js`：

- **单实例锁**（`requestSingleInstanceLock`，main.js:497）：第二个实例直接 `app.quit()`；`second-instance` 事件里只做「恢复已有窗口 + focus」，不新开窗口（main.js:505-508）
- **单个 `mainWindow` 全局变量**（main.js:36），`createWindow()` 只调用一次（main.js:565）
- macOS close 只隐藏（main.js:249-252），保留 renderer 状态；`window-all-closed` 直接退出 app
- 无自定义菜单；`rendererReady` / `pendingNavigation` 是模块级单窗假设

**Web 端（React）** — 全站**全局单例状态**：

- `vaultStore`（`apps/web/src/stores/vaultStore.ts`）：`activeVaultId` 是模块级变量 + localStorage 持久化（`molio.activeVaultId`），**所有窗口共享一个 active vault**；切换时还会 `syncActiveVaultToServer` 推给 daemon
- `kbTabsStore`：KB 标签页同样模块级 + localStorage 全局共享（`molio.kb.tabs`）
- `molio.lastRoute`（App.tsx:30）：上次路由全局唯一

**daemon（后端）**：`active_vault` 是 DB 里的**单一全局 key**（`getActiveVaultId/setActiveVaultId`），Web Clipper 等外部客户端依赖它。

### 核心矛盾

> 「多窗口各看各的 vault」 vs 「全局单例状态 + 单一 active_vault」——三个层面（Electron 窗口 + React 状态 + daemon 全局键）都被设计成单例。

### 探索结论（定稿前验证）

- **BrowserRouter**（非 hash）——`?vault=&file=` query 参数**已存在**（`KnowledgeBasePage.tsx:48-51`），但 KB 页处理完 URL 后 `setSearchParams({}, { replace: true })` 全清（:162），且同时 `vaultStore.setActiveVaultId()` 写全局。即当前 URL 只是「外部导航的临时通道」，不是持续性的窗口级状态。
- **关键洞察**：Electron 多窗口同进程下，每个 BrowserWindow 是独立 renderer 进程/JS 堆，**模块级变量本就不跨窗共享**；真正跨窗口共享的只有 **localStorage**（`molio.activeVaultId` / `molio.kb.tabs` / `molio.lastRoute`）+ daemon `active_vault` 键。所以「Web 全局单例」的实质 = **localStorage 共享** + **App 级 `useKbChat`/`useChat` 用全局 `activeVault`**。

## 二、分析：拆成三个问题

### 问题 A：Electron 层 — 怎么开第二个窗口？

**方案：保留单实例锁（防第二个进程起 daemon 撞 3100 端口），单进程内多开 BrowserWindow。**

> ⚠️ 最大坑 — daemon 冲突：`second-instance` 防的是「第二个 app 实例会再起一个 daemon，端口冲突」。多窗口**必须走同一个 app 进程内多开 BrowserWindow**，而非多实例。单实例锁保留。

### 问题 B：Web 层 — 每个窗口怎么有独立的 vault？

**核心机制：vault 用 URL query 参数挂在 URL 上，`?vault=` 是窗口级权威状态。**

```
/knowledge?vault=abc123     窗口 1
/knowledge?vault=def456     窗口 2
```

localStorage `molio.activeVaultId` 降级为「无 URL 参数的新窗口的默认值」。URL 与 store 双向同步，但 **URL 不被清除**。daemon `active_vault` 继续给 Clipper 用（语义=最后激活窗口）。

### 问题 C：daemon 层 — 多窗口写同一 daemon 有没有冲突？

**基本无冲突，可复用现有能力**：daemon 已支持多 vault 并存（`listVaults` 返回全部）、多 run 并发（RunManager）。`active_vault` 语义定为「最后激活窗口的 vault」，**daemon 零改动**。

## 三、已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 1. 新窗口入口 | ① 菜单栏「文件 → 新窗口」+ ⌘N/Ctrl+N 快捷键 ② **KB 标签右键「在新窗口打开」** ③ **KB 文件面板统一「＋新建」下拉**（2026-08-10 UX 迭代：新建笔记/新建文件夹/新窗口三合一；「新窗口」= **打开干净的新桌面端**，落地应用着陆视图、不强制任何知识库，用户在新窗口里自行选择）④ **macOS Dock 右键「新窗口」+「最近使用的知识库」子菜单**（vault-recency LRU，`userData/vault-recency.json` 持久化，focus 3s 节流刷新）⑤ **Windows 任务栏 Jump List「新窗口」**（`--new-window` → 单实例锁 → second-instance；机制限制无动态子菜单） |
| 2. 窗口-vault 关系 | **一窗一 vault**（语义清晰；一窗多 vault = P3 分屏，另论） |
| 3. daemon `active_vault` 语义 | **最后激活窗口的 vault**（每窗口切换时已同步；Clipper 协议零改动） |
| 4. 开工时机 | **现在开工**；tabs 分片视 P1 进度——已合并则直接用 `createTabsStore()`，否则本地同形工厂、P1 合并后 rebase 对齐 |

## 四、实施方案

### 第一步：Electron 壳多窗口（~2 天，无 P1 依赖）

`apps/desktop/src/main.js`：

1. **单实例锁保留**；`second-instance` 改为恢复+聚焦**最后聚焦的 app 窗口**（新增 `lastFocusedAppWindow`，各窗 `on('focus')` 更新），协议 URL 路由到它。
2. `mainWindow` 全局 → `appWindows: Set<BrowserWindow>`；`createWindow({ url })` 泛化。生产：首窗走现有 `loadApp()`（等 daemon 隐藏→显示）；**后续窗口 daemon 必然已就绪**，直接可见 + `loadURL('http://localhost:3100' + url)`。dev：加载 `localhost:5173` + url。
3. **per-webContents 的 renderer 状态**：`rendererReady`/`pendingNavigation` 改为 `Map<webContentsId, { ready, pending }>`——多窗口下 `molio:renderer-ready`（用 `event.sender`）与 `deliverNavigation` 各自归属，防止 A 窗的冷启动队列导航被 B 窗 flush。
4. **菜单**：`Menu.setApplicationMenu`（mac 首项 app menu；win/linux File menu）→「文件 → 新窗口 ⌘N/Ctrl+N」。⚠️ 替换默认菜单须补齐 Edit/View/Window 标准 role（复制粘贴/DevTools 依赖）。加速器直接调 createWindow。
5. **新窗口 IPC**：`ipcMain.handle('app:new-window', (_, { url }) => createWindow({ url }))`；preload 加 `openNewWindow(url)`。
6. 协议导航 `navigateFromProtocolUrl`/`deliverNavigation`/`isWaitingForApp` 全部按目标窗口（聚焦窗口）操作；`before-input-event`/`setWindowOpenHandler` 用局部 `win` 而非 `mainWindow`。
7. 收尾：`window-all-closed` 非 mac 下最后 app 窗口关闭才 quit（feishu 登录窗独立生命周期，不影响）；macOS hide-on-close 每窗保留；`before-quit`/`killDaemon` 不变（daemon 进程级单例）。updater 的 `getMainWindow` → `() => getFocusedAppWindow() ?? appWindows[0]`。

**E2E 风险低** — 桌面端只是壳，web 行为不变。

### 第二步：Web 端 URL 驱动 vault（~3 天，核心）

**机制**：`?vault=` 是窗口的权威 vault；URL 与 store 双向同步，URL 不清除。

`stores/vaultStore.ts`：
- 模块初始化：`activeVaultId = new URLSearchParams(location.search).get('vault') ?? readPersistedVaultId()`（每窗口独立 renderer，模块级读取即窗口级）。
- 切换 vault 照旧 `setActiveVaultId`（持久化 + daemon 同步），副作用不变。

`KnowledgeBasePage.tsx`：
- 改掉 :162 的 `setSearchParams({}, ...)` 全清逻辑 → 只清 `?file=`、**保留 `?vault=`**。
- 新增 **URL 镜像 effect**：`kb.activeVault?.id` 变化时 `setSearchParams({ vault: id }, { replace: true })`——所有 vault 切换入口（KbFilePanel、VaultManager、创建/导入/删除）经 store 收口后自动回写 URL，无需逐点改。
- 现有 `resolveUrlFileNavigation`（:151）保留并微调：in-app 导航到带 vault 的 URL 时同步 store，不再清 vault。

`App.tsx`：
- `lastRoute` **保持 localStorage 全局**（改动最小）：多窗口总是挂载在显式 URL 上，restore 只发生在 `pathname === '/'` 时，基本不触发；已知小 edge（新窗克隆 `/` 会 restore 全局 lastRoute），可接受。
- `defaultCwd` 同步保持现状（last-window-wins）：chat 本就显式传 `cwd=activeVault.path`，全局 `defaultCwd` 仅兜底，无功能影响。

浏览器模式天然可用：多浏览器标签/多 context 即多窗口。

### 第三步：tabs 分片 + 会话隔离（~1 天，视 P1）

`stores/kbTabsStore.ts`：
- 重构为**工厂** `createTabsStore(vaultId)`：存储键 `molio.kb.tabs.<vaultId>` / `molio.kb.activeTabId.<vaultId>`，其余逻辑照搬现有模块。**P1 `createTabsStore()` 合并后做同形对齐**（签名差异由 rebase 处理）。
- 组件消费改 `useKbTabs(vaultId)`：按 vaultId memo 一份 store 实例，vault 变化时切换。

`useKbChat.ts`（顺带修现有 bug）：`conversationIdRef` 目前跨 vault 切换不重置（App 级单实例、`vaultPath` 变但 ref 保留）→ 新增 `useEffect(() => { conversationIdRef.current = null; }, [vaultPath])`。多窗口下每窗口独立 App 实例，天然隔离。

**新窗口适配层**（WebUI-first）：Web 层只产出目标 URL（菜单克隆当前窗口 URL；标签右键 `/knowledge?vault=X&file=Y`），薄适配决定落地——`window.__electron__?.openNewWindow(url)` 存在则开 Electron 窗口，否则 `window.open(url)`。KB 标签右键「在新窗口打开」入口在 `KbTabBar`/`ContextMenu`。

### daemon：零改动

`active_vault` 即「最后激活窗口的 vault」（每个窗口切换时已同步）。窗口关闭不回滚——Clipper 只要「某个 vault」，简单优先，记为 out-of-scope。

## 五、测试计划

### 桌面测试（node:test，错误驱动）

新增/扩展 `apps/desktop/test/window-*`：
- 多窗创建（`createWindow({ url })` 生产/dev 两路径）
- `second-instance` 聚焦最后聚焦窗口
- per-webContents ready：A 窗冷启动队列导航不被 B 窗 flush
- `app:new-window` IPC 触发新窗
- macOS close 语义每窗保留

### E2E（Playwright）

新增 `apps/web/e2e/multi-window.spec.ts`（P1 级）——**两个 Playwright context 分别开 `/knowledge?vault=A`、`/knowledge?vault=B`**：
- 文件树互不串、tabs 按 vault 分片
- A 窗切 vault 不影响 B 窗
- URL 镜像回写正确（切 vault 后 URL 变为 `?vault=` 且不丢）
- `?file=` 外部导航保留 vault

触及 App.tsx / KB 组件，同步跑 `bootstrap.spec.ts` / `navigation.spec.ts` / `publish-flow.spec.ts`。

## 六、实施顺序与验收

| 步 | 内容 | 依赖 | 估时 |
|---|---|---|---|
| 1 | Electron 壳多窗口（第一步） | 无 | ~2 天 |
| 2 | Web URL 驱动 vault + tabs 分片/会话隔离 | 无 P1；tabs 工厂若 P1 已合并则直接用 | ~3 天 |
| 3 | P1 原语对齐（若已合并） | P1 #202 | ~0.5 天 |

**验收标准**：
1. 菜单/⌘N/Ctrl+N 能开第二个窗口；KB 标签右键能「在新窗口打开」
2. 两个窗口各看各的 vault（文件树/tabs 独立）；窗口内切 vault 只影响本窗，URL 正确回写
3. `?vault=` 新开窗口直接定位到该 vault；无参数窗口回退 localStorage 默认
4. Clipper 存到「最后激活窗口的 vault」；daemon 无回归
5. 单窗口默认路径（无多开）行为与现状完全一致

## 七、已知行为与边界

- `defaultCwd`：last-window-wins（chat 显式传 cwd，仅兜底场景受影响）
- `lastRoute`：保持全局，新窗克隆 `/` 的 restore edge 可接受
- 窗口关闭不回滚 `active_vault`
- P3 分屏（一窗多 vault）、P4 标签拖出在本设计基座上演进，不在本次范围

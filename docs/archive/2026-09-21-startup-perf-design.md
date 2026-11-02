# 应用启动性能优化设计（Startup Perf）

日期：2026-09-21
状态：设计稿（待评审）
分支：worktree-startup-perf-analysis

## 1. 背景与问题

用户反馈「进入应用比较缓慢」。对启动全链路（Electron 壳 → daemon → web 首屏）
的代码走查发现，慢是**多段串行阻塞叠加**的结果，其中有一个头号瓶颈和若干次要瓶颈。

### 1.1 现状启动链路（全部串行）

```
Electron main (whenReady)
 ① await initMonitoring(ARMS SDK)          ~0.2-2s（无上限保证）
 ② buildAppMenu / JumpList / vaultRecency   快
 ③ createWindow (show:false，隐藏)
 ④ setupAutoUpdater
 ⑤ await startDaemonProduction()
     ├─ startFetchServer (wiki fetcher)
     ├─ startCryptoServer (safeStorage RPC)
     └─ spawn daemon ────────────────────┐
                                          │ daemon 进程内（listen 前，同步串行）：
                                          │  a. checkAndKillPortOccupant
                                          │     execSync netstat(+tasklist)，kill 后
                                          │     最长 2s 忙等轮询          ~0.3-2.5s
                                          │  b. initSkillLibrary (SQLite seed)  快
                                          │  c. server.ts 模块副作用：
                                          │     - openDatabase()（迁移）
                                          │     - WeixinService/FeishuService 构造
                                          │       + void start()（含网络请求）
                                          │     - vaultWatcher.start()
                                          │       Windows usePolling(1s) 轮询全部 vault 文件树
                                          │     - maybeCreateDefaultVault
                                          │  d. serve() listen → 打印 "listening on"
 ⑥ loadAppWindow → 页面 did-finish-load → win.show()   ← 用户第一次看到窗口
```

窗口显示前用户面对**完全空白**（无 splash，见 main.js createWindow 注释：splash 因
ARMS autoInject 只注入一次导航而被移除）。①⑤⑥ 三段耗时直接相加。

### 1.2 web 首屏（窗口显示后仍有二次等待）

- **单 JS bundle、零代码分割**：`App.tsx` 静态 import 全部页面；
  `KnowledgeBasePage → GraphPage → pixiGraphEngine` 把 **pixi.js + d3** 拖进首屏 chunk；
  doocs-md 的 **36 个 highlight.js 语言包** eager import；vite.config 无 manualChunks。
  （PdfViewer / KbCodeMirrorViewer / mermaid 已懒加载，是正例。）
- **`App.tsx:268` `if (!configLoaded) return null`**：`GET /api/config` 没回来前整个 UI 白屏。
- **boot 请求风暴**：mount 时并发发 `getConfig`×3（mount / location effect / activeVault effect
  三处重复）、`/api/agents`、`/api/knowledge/vaults`、`/api/auth/status`、`/api/preload/status`。

### 1.3 头号瓶颈：`GET /api/agents` 同步探测 CLI

`RunManager.detectAgents()`（RunManager.ts:108）每次调用对 5 个已注册 agent
（claude/codex/gemini/qwen/hermes）**逐个同步探测版本**：

- `probeVersion` 用 **`execFileSync`**（launch.ts:343），单进程超时 5s；
- Claude CLI 冷启动 1-3s 常见，最坏 5×5s=25s；
- **同步执行冻结 daemon 整个事件循环** —— 首屏并发的 config/vaults/auth-status
  全部排队在它后面，表现为「进应用后长时间白屏/无响应」；
- 无任何缓存，settings/runtimes 页每次进入都重新探测。

调用面很小：仅 `routes/agents.ts` 3 处（GET /、POST /:id/test、POST /:id/install），
改造风险可控。

### 1.4 次要瓶颈

| # | 位置 | 问题 |
|---|---|---|
| S1 | desktop main.js ① | ARMS `initMonitoring` 被 await，排在窗口创建和 daemon 启动之前，纯串行浪费 |
| S2 | daemon index.ts:92 | `checkAndKillPortOccupant` 无条件 execSync netstat + kill 后 2s 忙等 |
| S3 | daemon server.ts:117-119 | weixin/feishu `start()`、`vaultWatcher.start()` 是模块副作用，跑在 listen 之前（feishu start 含 token 网络请求） |
| S4 | daemon index.ts:107 | `runDeferredStartupChores`（preload 探测 + prune ~4s + 技能 fan-out ~1.2s/vault）在 listen 后立即开跑，与 web 首屏请求风暴抢 CPU/IO |
| S5 | web App.tsx | config 未回来 `return null` 白屏；getConfig 三处重复调用 |
| S6 | web bundle | 无路由级 lazy、无 manualChunks，pixi/d3/highlight 全在首屏 |

## 2. 关于 ARMS 能否异步（用户问题）

**可以异步，但有一个顺序约束**：ARMS SDK `autoInject` 监听主进程
`web-contents-created` 事件注入 Browser SDK —— **init 完成之前创建的窗口会错过注入**
（monitoring.js:31-33 注释）。所以不能简单改成 fire-and-forget 后立刻 createWindow。

设计上的解法是「**并行 + 有界等待**」：

1. `whenReady` 后**同时**启动两件互不依赖的事：
   - `initMonitoring(...)`（不 await，拿到 promise）
   - `startDaemonProduction()`（不 await，拿到 promise）——它内部本来就要先起
     fetch server / crypto server 再 spawn daemon，与监控零耦合；
2. `createWindow` 前 `await Promise.race([monitoringReady, sleep(MONITOR_INIT_TIMEOUT_MS)])`
   —— 超时（建议 2000ms）就不再等，直接建窗。ARMS init 正常是本地 SDK 装配，
   几百 ms 内完成；网络差/SDK 异常时最多损失该窗口的 Browser 端注入（主进程
   collectors 不受影响），**监控降级可接受，启动卡死不可接受**；
3. daemon 启动与监控 init 并行后，① 的耗时从串行链路上消失（被 ⑤ 覆盖）。

> 备选（不采纳）：先 createWindow 再 init。会永久错过首窗注入，ARMS 的
> api/jsError/consoleError 渲染端采集全空，回归面太大。

## 3. 优化方案

分三期，每期独立可发布、可回滚。

### P0：daemon 去阻塞 + desktop 并行（收益最大，改动小）

#### P0-1 `detectAgents` 异步化 + 缓存（头号瓶颈）

- 新增 `RunManager.detectAgentsAsync(): Promise<AgentInfo[]>`：
  - `probeVersion` 改并行 `execFile`（promisify），5 个 agent **并发**探测，
    单探测超时维持 5s，总耗时 ≈ max(单个) 而非 sum；
  - **TTL 缓存**（默认 30s，`MOLIO_AGENT_CACHE_TTL_MS` 可配）+ in-flight 去重
    （并发请求共享同一个探测 promise）；
  - 缓存失效钩子：`POST /:id/install` 成功后主动 invalidate（装完立即可见）；
    `PUT /api/config`（agent env 变更）同样 invalidate。
- `routes/agents.ts` 3 处调用改 `await detectAgentsAsync()`；
  同步 `detectAgents()` 保留但内部走「纯 binary 存在性检查（stat，不 spawn）」，
  仅供不能异步的内部路径使用（当前没有，标记 deprecated）。
- **可用性判定不变**：binary 不存在 → unavailable；探测失败（spawn error/超时）→
  unavailable + probeError，与现行为一致。
- 首屏体验变化：`/api/agents` 从「阻塞全 daemon 1-25s」变为
  「首次 ≤ 最慢单探测（并行），命中缓存 <5ms，且不再冻结事件循环」。

#### P0-2 端口占用检查改为「先 listen，冲突才清场」

- 删除 index.ts 顶层无条件 `checkAndKillPortOccupant(port)`；
- 复用已有的 `server.on('error')` EADDRINUSE 分支（现在就有 kill+500ms 重试逻辑），
  把忙等 2s 的 `while` 循环换成异步 setTimeout 轮询；
- 正常路径（端口空闲）省下 netstat/tasklist execSync ~0.3-1s；
  冲突路径行为不变。
- 注意：`checkAndKillPortOccupant` 现有单测（test/compat/port-check）不动，
  只改调用时机。

#### P0-3 listen 前置：服务 start 移出模块副作用

- server.ts 里 `void weixinService.start(); void feishuService.start(); void vaultWatcher.start();`
  与 `maybeCreateDefaultVault` 移到 index.ts 的 listen 回调内（与 restoreSession 同层），
  保证「模块 import 完即可 listen」；
- `vaultWatcher.start()` 进一步延后到 `runDeferredStartupChores`（见 P0-4）——
  文件监听不影响首屏 API，Windows 轮询模式开销大，没必要抢在启动窗口期。
- 迁移时保持既有测试语义（shutdown.test 等对 start/stop 生命周期的断言）。

#### P0-4 deferred chores 让路首屏

- `runDeferredStartupChores` 从「listen 后 setImmediate」改为
  「listen 后延迟 `MOLIO_CHORES_DELAY_MS`（默认 3000ms）」；
- 顺序调整：vaultWatcher.start() → preload checkSkills → prune → 技能 fan-out →
  legacy cleanup（preload 状态是首屏会查的，仍排最前；watcher 插入其后）；
- 各 chore 依旧 ISOLATED（一个失败不影响其余），保持现有注释里的回归约束。

#### P0-5 desktop 主进程并行化（含 ARMS 异步，见 §2）

- `whenReady` 内：`initMonitoring` 与 `startDaemonProduction` 并行发起；
  createWindow 前对 monitoring 做 2s 有界等待；
- `startFetchServer` / `startCryptoServer` 已是 async，可与 spawn 前的准备并行
  （Promise.all 后再组装 daemonEnv）；
- 失败语义不变：daemon 起不来 → showDaemonErrorPage；monitoring 起不来 → log 后继续。

#### P0-6 web：首屏不白屏 + config 去重

- 去掉 `if (!configLoaded) return null`：壳（NavRail + 路由骨架）立即渲染，
  `configLoaded` 只用于 gate「agent 选择生效」（本来就有 selectedAgent 解析逻辑，
  不会闪错误状态；`hasNoUsableAgent` 空态卡片需等 agents 加载完再显示——已有
  `agentsReady` prop，沿用）；
- 新增 `stores/configStore.ts`（模式照抄 authStore：useSyncExternalStore + refresh
  永不抛错 + in-flight 去重），三处 getConfig 收敛为一次拉取 + 订阅；
- locale 初值：configStore 未就绪时用 `localStorage` 缓存的上次 locale 兜底，
  避免中文用户闪英文。

### P1：web bundle 分割（首屏 JS 体积）

#### P1-1 路由级 React.lazy

- `KnowledgeBasePage`（连带 GraphPage/pixi/d3）、`SettingsPage`、`HistoryPage`、
  `ResourcesPage`、`ResourceDetailPage`、`AccountPage` 改 `lazy()` + 顶层
  `<Suspense fallback={路由级骨架}>`；
- `HomePage` 保持 eager（默认落地页）；
- `KbChatSessionsPanel` 随 KB 懒加载评估：它 App 层常驻挂载但只在 /knowledge
  唤起 —— 改为 lazy 挂载（首次进 KB 才加载），ref 转发保持可用（handle 为 null
  时 KB 页入口按现有空值守卫降级）。

#### P1-2 vite manualChunks

```
vendor-react    react/react-dom/react-router-dom
vendor-pixi     pixi.js + d3-*（随 GraphPage lazy chunk 亦可，二选一，优先 lazy 自然分割）
vendor-md       doocs-md vendor + marked + highlight.js + dompurify
```

- highlight.js 36 语言包：评估 doocs-md 是否支持按需注册，若改造成本高则接受
  留在 vendor-md chunk（懒路由已隔离出首屏）。

#### P1-3 E2E 同步（强制）

- `App.tsx` 属 E2E 核心保护清单 → 全量 Playwright 必须全绿；
- lazy 化改变元素出现时机：`navigation.spec.ts`、`bootstrap.spec.ts`、
  `kb-*.spec.ts` 里直接 click 的地方补 auto-wait/显式等待；
- 遵守既有经验：KB 模态框 E2E 用硬导航（feedback_kb_e2e_hardnav）。

### P2：观测与长尾

- **启动打点**：daemon 各阶段（module-eval / db-open / listen / chores 各项）
  `console.log('[startup] phase=xxx ms=N')`，desktop main.js 已有 log() 体系补
  里程碑（whenReady → monitoring ready → daemon ready → did-finish-load → show），
  web 端 `performance.mark` 记 boot 请求耗时并经 ARMS api collector 上报；
- **基线测量**：打包版冷启动（安装后首启）+ 热启动各 5 次取中位数，优化前后对比，
  记录进本文档附录；
- **vaultWatcher Windows 轮询**（S3 长尾）：评估 chokidar `depth` 限制或
  仅监听一层 + 手动深层刷新的可行性；短期不动（有 libuv crash 前科，注释勿删）；
- daemon 模块 eval 耗时若打点显示占比高，再评估 better-sqlite3 原生模块加载、
  contracts dist 体积等（当前不预设）。

## 4. 不做的事

- **不恢复 splash.html**：与 ARMS 单次注入约束冲突（main.js 注释有完整 rationale）；
- **不砍 probeVersion 的可用性语义**：「存在但跑不起来 = 不可用」是修过的 bug
  （stale binary），异步化后判定逻辑原样保留；
- **不在 P0 动 bundle**：P0 全部是 daemon/desktop/web 行为层改动，可单独回归；
- **不改 vaultWatcher 的 Windows polling 方案**（P2 再评估）：libuv assertion
  crash 是真实回归风险。

## 5. 风险与回归清单

| 风险 | 缓解 |
|---|---|
| detectAgents 缓存导致「刚装完 agent 看不到」 | install/config 写路径主动 invalidate；TTL 仅 30s |
| 并行探测改变 stderr 噪音时序 | probeVersion 错误处理原样保留（返回 probeError，不抛） |
| 端口检查后置导致双 daemon 短暂并存 | EADDRINUSE 分支已有 kill+重试；仅正常路径省检查 |
| chores 延迟 3s 导致 preload toast 窗口错过 | preload checkSkills 仍是 chores 第一项，3s 延迟 + web 端本就有 3s 重试，覆盖；打点验证 |
| 去掉 configLoaded 白屏 gate 闪错误 UI | agent 空态用 agentsReady gate；locale localStorage 兜底 |
| lazy 路由改变 E2E 时序 | P1 单独 PR，全量 E2E 门禁（核心文件清单） |
| ARMS 2s 超时窗口错过注入 | 仅弱网触发；主进程 collectors 不受影响；打点记录 race 结果 |

## 6. 交付拆分（单 PR，按 commit 分层）

按用户决定：**一个 PR 交付全部优化**（`feat/startup-perf`），内部按 commit 分层，
便于 review 时按层看 diff、出问题时按层 revert。

1. **commit-1（P0 daemon）**：detectAgentsAsync + TTL 缓存 + 端口检查后置 + start
   移出模块副作用 + chores 延迟；单测 `test/core/run-manager-detect-cache.test.ts`
   （TTL / 并发去重 / invalidate）+ `test/compat/daemon-startup-order.test.ts` 更新。
2. **commit-2（P0 desktop）**：main.js 并行化 + ARMS 有界等待；
   单测 `test/daemon-startup.test.js` 扩展（monitoring 超时仍建窗）。
3. **commit-3（P0 web）**：configStore（含 `test/configStore.test.ts`）+ 去首屏白屏
   gate + locale 早读。
4. **commit-4（P1 web）**：路由级 React.lazy + vite manualChunks + E2E 等待修补。
5. **commit-5（回归修复）**：commit-3/4 把「首屏可交互」提前后暴露的三处**既有异步
   竞态**（都在「UI 已可交互但异步状态未落定」的窗口里）——
   - `KnowledgeBasePage`：tabs store 与发布门禁改按同步的 `activeVaultId` 判定
     （原按 `kb.activeVault`，要等 vault 列表异步拉回，窗口内 openTab 全是空操作）；
   - `MdTypesetEditor`：晚到的文件内容不再覆盖用户已敲下的未保存编辑（dirtyRef）；
   - `ProviderConfig`：挂载期的配置加载不再覆盖用户已改动的表单（touchedRef），
     并把发布门禁渲染成 `data-publish-gate` 供 E2E 等待「状态已提交到 UI」。

依赖关系：1/2/3 相互独立；4 依赖 3（configStore 落地后再动 App 结构）；5 依赖 3+4。
P2（启动打点 + 基线回填）不在本 PR，后续单独提。

## 7. 验收标准

- 打包版冷启动（daemon spawn → win.show）中位数 ≤ 现状 60%；
- 首屏可交互（config+agents+vaults 齐）≤ 现状 50%，其中 `/api/agents`
  命中缓存 <50ms、冷探测不阻塞其他 API（事件循环冻结消除，可用打点证明）；
- 首屏 JS（gzip）体积下降 ≥ 30%（P1 后）；
- 全量测试 + E2E 绿；ARMS 上报链路（PV/api/jsError）在正常网络下无回归。

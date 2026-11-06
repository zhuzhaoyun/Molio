# 预下载 Windows 健壮性修复复盘（2026-07-29 ~ 07-30）

> ⚠️ **2026-08 更新**：remotion 已不再是内置技能，其预下载连同 npm 注册表回退那一整套（`runWithRegistryFallback` / `remotionScaffoldCmd` 等）**已全部移除**，视频创作改由技能商店 `am-will/remotion` 按需安装、首次使用现装依赖。预下载现在只剩 **docling**。本文作为历史复盘保留——其中 remotion / npm 侧的结论只反映当时实现，docling / pip / Windows 进程侧的经验仍然有效。

> 分支：`feat/dependency-preload`（已推送 `origin`，未开 PR）
> 配对文档：操作/清理侧见 [`preload-cleanup.md`](./preload-cleanup.md)；本文是**调试与修复复盘**侧。
> 涉及 commit：`67a9638` → `9a2b5c8` → `36cdeac` → `450ac7c`（基于 `8504b4f`）。

## TL;DR

本轮在 **Windows** 上把预下载（docling / remotion）从「跑不通 / 弹窗 / 卡死」修到「全程可用」，共 **4 个真问题**，其中 **2 个是「第一版修法不够、用户复测后深挖第二轮」才根治**（黑窗、停止后不重显）。真正耗时间的往往不是 commit 里的代码，而是 commit 之外的**环境 / 状态 / 缓存**岔路——这些最后沉淀进了项目记忆与本文。

预下载功能简介：daemon 的 `PreloadManager` 在后台提前装好重型工具——**docling**（PDF/Office→Markdown，含 PyTorch + AI 模型，隔离 venv 在 `~/.molio/venv`）、**remotion**（React 视频，把整棵依赖树暖进 npm 缓存，标记在 `~/.molio/.remotion-preloaded`）。Web 右下角 `PreloadToast` 在工具 `missing` 时提示「后台下载」。

为什么 Windows 是重灾区：macOS/Linux 没有「每个进程一个控制台窗口」的概念，且二进制无扩展名；而 Windows 的 console 子系统、`.exe` launcher、`.cmd` shim、`DETACHED_PROCESS` 语义、npm 的 spawn 行为，叠加出一连串平台专属坑。

---

## 一、主线 4 个问题

### 问题 1 — remotion 预下载失败（ETARGET）｜`67a9638`

- **现象**：toast 报 `Remotion 预下载失败：进程退出码 1:`（冒号后空白）。
- **根因（带证据）**：remotion 每次**联动发布约 20 个包**，`create-video` 脚手架把它们全部**严格钉死**到同一版本。npmmirror 对这些包是**逐包独立、按需同步**的——发版后窗口期内主包 `@remotion/cli` 已同步、传递依赖 `@remotion/player` 还没同步。实测：npm debug log 明确 `No matching version found for @remotion/player@4.0.501`；同一时刻逐源查询 npmmirror 的 `@remotion/player` 最新只有 `4.0.500`，官方源 npmjs 已有 `4.0.501`。旧代码只在**同一源**重试一次（镜像滞后以分钟/小时计，重试必然再败）；且 `npm install --prefer-offline` 让 npm 跳过缓存元数据过期检查，会把「同步完成前缓存的陈旧 packument」变成**永久** ETARGET。
- **修法**（`apps/daemon/src/core/preload-manager.ts`）：
  - npm 源**降级链** `NPM_REGISTRY_FALLBACKS`：默认源（重试 2 次）→ 官方源 `registry.npmjs.org`（同步源头，版本永远齐全）→ npmmirror 兜底；脚手架与安装两步都走。
  - 删 `--prefer-offline`（在线模式仍按 integrity 复用已缓存 tarball，暖缓存不受影响）。
  - 失败消息带**步骤名** + `runSpawned` 改用 **stdout+stderr 合并尾部**（根治冒号后空白——很多 CLI 把错误打 stdout）。
  - remotion 步骤超时 `600_000 → 900_000`（实测官方源光解析元数据就 240s+）。
- **验证**：remotion E2E `downloaded`；单测覆盖降级/同源瞬态重试/abort/错误信息/命令构造。

### 问题 2 — docling「未生成可执行文件」假失败（仅 Windows）｜`9a2b5c8`

- **现象**：`docling 安装失败（未生成 docling 可执行文件）`，但 venv 里 `docling.exe` 其实**装好了**（假阴性）。
- **根因**：安装后校验写死 `path.join(venvBin, 'docling')`（**无扩展名**），在 Windows 上 `existsSync('Scripts/docling')` 恒 false（pip 生成的是 `Scripts/docling.exe`）；macOS 二进制本就无扩展名，故不受影响——这正解释了「macOS 正常、Windows 必败」。同文件的检测路径用的是带 `.exe` 的 `doclingBinaryPath()`，唯独这条校验不一致。
- **修法**：新增 `doclingVenvBinaryPresent()`（用平台正确名），**安装后校验与检测共用**，杜绝两者不一致。

### 问题 3 — Windows 预下载弹黑窗｜`36cdeac`（**修了两轮**）

- **现象**：下载时弹出若干黑色 cmd 窗口（macOS 无此现象）。
- **第一轮（失败）**：只加 `windowsHide: true`。用户复测**仍弹**。
- **第二轮根因（两层）**：
  1. libuv 在 Windows 把 `detached: true` 映射成 `DETACHED_PROCESS`，**顶掉** `windowsHide` 的隐藏标志 → 直接子进程就弹窗。
  2. 即便补了 `windowsHide`，`cmd /c` 与 `pip.exe`/`docling.exe` 等 launcher 还会再 spawn python/node **孙进程**；而 npm 内部的 `@npmcli/promise-spawn` **不设** `windowsHide`（翻了该 npm 版本源码确认全文无此字样）→ spawn 选项**压不住整棵树**。
- **修法**：
  - `preloadSpawnOpts` 的 `detached` 改为**仅 POSIX**（Windows tree-kill 走 `taskkill /T`，本就不需要 detached）。
  - 长任务改**解释器直跑、进程内执行**，消灭孙进程：docling 用 `python -m pip install` + `python -c <shim>` 调 `docling.cli.main:app`（绕开 `docling.exe` launcher）；remotion 的 `npm install` 用 `node` 直跑 `npm-cli.js`、脚手架用 `node` 直跑 `npx-cli.js`（npm 入口按 PATH 上的 `npm`/`npx` 解析，dev 成立；解析不到则回退 shell 形式）。
  - 所有 python 探测 `execSync`/`execFileSync` 补 `windowsHide`（消除启动/探测期闪现）。
- **验证**：用户真机复测「**没有黑窗**」（连 `create-video` 脚手架那一下都没闪）。
- **残留**：理论上 `create-video` 作为 npx 子进程可能闪几秒；实测未观察到。

### 问题 4 — 暂停→停止后无法重新下载｜`450ac7c`（**含一次诊断绕路**）

- **现象**：下载中点「暂停」再点「停止」后，toast 消失且**无法重新下载**（只能刷新页面）。
- **根因（web）**：`handleStop` 把 `visible=false` 后**没有任何重显机制**——`check()` 只在组件**挂载**时跑一次（+3s 重试），没有状态订阅/轮询在「变回 missing」时把卡片重新弹出。注释里以为的「下次 check 会重显」并不存在。
- **潜伏根因（daemon）**：`stop` 只清 `stopRequested`，`pauseRequested` **残留** → 下一次 `startPreload` 的 `onProgress` 守卫被触发（进度静音）、失败被错标 `paused`。
- **修法**：
  - web：新增 `refreshFromStatus()`（重拉状态，若 `missing` 则重显 prompt）；`handleStop` 改 `await stop + refresh`；SSE `stopped` 事件**不再就地隐藏**；post-await 区分 `stop`（重显）/`pause`（保持 paused）。
  - daemon：`stop` 作为「完全重置」连 pause 意图一起清——`stopPreload` 两分支 + `catch` 的 stop 分支 + `startPreload` 入口兜底；并加 `_testHasPauseIntent` 测试钩子钉住不变量。
- **诊断绕路**：用户首次反馈「停止后没回来，刷新才出现」→ 一度怀疑逻辑错 → `curl 5173` 证实 vite **已含**新代码（`refreshFromStatus` 5 处），却又发现存在**旧的 `apps/web/dist`** → 一度怀疑用户在桌面端 → 问清是**浏览器** → 定位到 **HMR 没热替换事件闭包 / 页面停在旧闭包**，那次「停止」点在了旧代码上；硬刷新（Ctrl+Shift+R）后在新代码上复测，卡片**立即重现**。

---

## 二、过程中走弯路的 3 处（教训）

1. **黑窗两轮**：第一轮 `windowsHide` 不够 → 复测后才挖出 `detached` + 孙进程两层。**教训**：Windows 控制台窗口不能只看直接子进程，要看整棵 console 子进程树；`detached` 在 Windows 是有害默认值。
2. **重显「修了没生效」**：HMR 不一定热替换闭包 + 旧 `apps/web/dist` 干扰判断。**教训**：验证 web 修复前先确认运行端加载的是新代码（`curl 5173/src/...` 看关键符号；区分浏览器 vs 桌面端 dist）；给用户**精确的硬刷新/重启指令**。
3. **清理后 toast 不弹**：`/status` 返回 daemon **内存**状态，光删文件它仍记 `installed`。**教训**：运行中 daemon 的复测清理，删完要 `POST /api/preload/undismiss`（或重启）触发 `detectInstalled` 重探测。

---

## 三、顺手清掉的 6 个「非 bug 但挡路」状况

1. **分支分叉同步**：本地 9 vs 远程 14；判定远程是 rebase + 新增、本地为其子集（`git cherry` + 整树 diff 证实）→ reset 到 origin（先建备份分支、收尾删除）。
2. **首次 toast 不弹**：`preload.dismissed = [docling, remotion]`（早前点过「不再提示」）→ `undismiss`。
3. **同步后 contracts 未构建** → `transcript-watcher.test.ts` 类型错 → `pnpm build` contracts。
4. **web 类型错**：`refreshFromStatus` 漏 `SkillInfo` 标注（`getPreloadStatus` 返回类型不含 `path`）→ 补标注。
5. **git 提交 cwd 坑**：在 `apps/daemon` 下用根相对路径 `git add` 报 pathspec 不匹配 → 回仓库根用显式路径。
6. **daemon 内存状态 vs 文件**（同弯路 3）→ `undismiss` 技巧。

---

## 四、测试与验证总账

| 项 | 结果 |
|---|---|
| preload 单测 | **20/20**（新增：源降级→改 `exec` 模型 + argv/`npmCliJsFromDir`、`.exe` 校验、`windowsHide`+detached 仅 POSIX、`python -c` warmup、pause→stop 清意图） |
| 全量 daemon 套件 | **813 通过 / 4 失败**——4 个**全是既有**失败（`weixin`×2、`env`×1、`windows-cmd`×1），基线对比**零新增回归** |
| web typecheck | 通过 |
| web toast E2E | **故意不加**——该组件被 `navigator.webdriver` 闸门主动屏蔽、且不在 `apps/web/CLAUDE.md` 的 e2e 同步表，仓库本就把它排除在自动化外，由手动复测覆盖（不违反错误驱动规则：更具体的闸门+同步表覆盖通用规则） |
| 真机 E2E | remotion、docling 均 `downloaded`（`python -m pip` / `python -c` / `node` argv 全跑通）；黑窗=无；停止重显=回来 |

---

## 五、关键决策与依据

- **registry 降级顺序「默认→官方→npmmirror」**：官方源是同步源头、版本永远齐全，专治镜像滞后；npmmirror 兜底照顾默认源是慢官方源的用户。
- **Windows 关 `detached`**：tree-kill 用 `taskkill /T` 走父子关系，不依赖进程组；`detached` 在 Windows 只带来 `DETACHED_PROCESS` 副作用。
- **解释器直跑而非 shell**：唯一能压住整棵 console 子进程树窗口的办法（spawn 选项管不到第三方 spawn 的孙进程）。
- **toast 不加 E2E**：尊重仓库既有设计（自动化闸门 + 同步表缺席）；如确需，要用 `window.__MOLIO_TEST_FORCE_PRELOAD_TOAST__` 逃逸口 + 一个**保持打开**的 mock `/api/preload/start` SSE（`route.fulfill` 有限 body 会自动关流，破坏 downloading/paused 态）。
- **模型预热未修（遗留）**：见下。

---

## 六、开放遗留

1. **模型预热其实没真正下模型**：warmup 用空输入 `NUL`/`/dev/null` 跑 no-op 转换，但 docling 在**格式识别阶段**就拒绝了空输入（早于模型加载），所以 `~/.cache/huggingface` 一直是空、首次真正转换才下 ~500MB。要真预热需喂一个 docling 能接受的空 md / 小 pdf 触发模型加载。属既有行为，未在本轮修。
2. **是否开 PR 合并**：4 个 commit 已推 `origin/feat/dependency-preload`，未开 PR。

---

## 七、代码索引（按符号，行号会变，以符号为准）

- 源降级 / 命令构造：`NPM_REGISTRY_FALLBACKS`、`runWithRegistryFallback`、`remotionScaffoldCmd/InstallCmd`、`remotionScaffoldArgv/InstallArgv`、`npmCliJsFromDir`、`resolveNpmEntry`
- spawn 选项：`preloadSpawnOpts`（`detached` 仅 POSIX + `windowsHide`）、`runProcess`/`runArgv`/`runSpawned`（合并 stdout/stderr 尾部）
- docling 校验 / warmup：`doclingVenvBinaryPresent`、`doclingWarmupArgv`、`DOCLING_CLI_SHIM`
- 状态机意图清理：`startPreload` 入口 / `stopPreload` 两分支 / `catch` stop 分支清 `pauseRequested`；测试钩子 `_testHasPauseIntent`
- web 重显：`PreloadToast.tsx` 的 `refreshFromStatus`、`handleStop`、SSE `stopped` 处理、post-await 分支

---

## 八、沉淀（项目记忆）

- **协作偏好**：review-before-push（CLAUDE.md 要求 PR，但用户更保守，常选「先不提交/不推送」）；非平凡修复先规划；terse 手动复测环（daemon=tsx 需重启、web=vite HMR 但闭包常需硬刷新）。
- **toast 不进 E2E** 的设计约定。
- **复测清理要重探测**：删产物后对运行中 daemon 调 `undismiss`（或重启），并核对 `/status` 为 `missing`。

# Wiki 入库状态追踪 + 文件落地实时感知

知识库的两大体验缺口及其实现方案：

1. **不知道源文件进没进 wiki**：clipping / raw/wechat 等源文件落地后，用户无法直观看到哪些已入库、哪些没入库、哪些入库后又被改过。
2. **文件刚落地无感知**：外部写入文件（Chrome 扩展剪藏、微信通道、手动拷贝）后，UI 只在窗口重新获得焦点时刷新文件树。

本文档说明如何在不依赖 git、不污染用户版本控制的前提下，从 wiki 本身派生入库状态，并用 chokidar + SSE 实现实时刷新。

---

## 设计决策：为什么不用 git

最初考虑过在 vault 目录初始化 git（isomorphic-git），以「ingest 成功 = 一次 commit」的纪律让 `git status` 编码入库状态。验证后发现两个致命问题，**已弃用**：

1. **老库无法恢复真值**：对一个已有 wiki 但从没 git 跟踪过的 vault，补一个基线 commit 会把**所有**文件都标成「已入库」，无法区分哪些真进过 wiki、哪些没进过。git 只能从「开始跟踪那一刻」往后记录。
2. **和用户自己的 git 冲突**：用户的 vault（如 `wiki-vault`）可能已有自己的 `.git`（Obsidian + git）。Molio auto-commit 会污染用户的提交历史，且读用户 git 得到的状态与「wiki 入库」无关。

**真值在 wiki 本身**：`wiki/log.md`（Agent 维护的入库日志）、`wiki/sources/*.md`（源摘要页）记录了入库情况。Molio 直接读这些，runtime（Agent CLI）也能直接读。不碰 git、不另存状态文件、老库零迁移。

---

## 三层入库信号（任一命中即「已入库」）

核心模块：`apps/daemon/src/core/wiki-status.ts`，导出 `annotateTreeStatus(vaultPath, nodes)`。

### 信号 1：`wiki/sources/*.md` 的 frontmatter `sources:` 字段

每个源摘要页在 frontmatter 里记录它由哪些源文件生成：

```yaml
---
type: source
title: "把才华变成钱"
sources:
  - "Clippings/把才华变成钱.pdf"
  - "[[raw/wechat/2026-06-18/note]]"
---
```

`sources:` 条目形式多样：完整相对路径、wiki 链接 `[[...]]`、纯文件名。解析时：

- `cleanEntry()`：剥 `[[ ]]`、外层引号，并反转义 YAML 转义（`\"` → `"`、`\\` → `\`）——文件名含引号时 Agent 会用转义引号，不反转义会留下反斜杠导致匹配失败。
- `entryKeys()`：为每个条目生成多个索引键——全路径、basename、各自去掉 `.md`、各自 **normalize**（见下），用 `Set` 去重。这样无论 Agent 写成路径、纯名、wiki 链接（常省略 `.md`）还是带不同空格，都能匹配上。
- 入库时间 = 该摘要页的文件 mtime（`parseSourcesPages` 用 `fs.statSync`）。

### 信号 2：`wiki/log.md` 的 ingest/build 条目

```
## 2026-06-25 15:30 | ingest | 拆解-x-为何被...Pi.md
## 2026-06-19 22:00 | build | 新源文件编译入库
```

- `| ingest | <文件名>` → 该文件入库 @ 该日期（`parseLogContent`）。文件名可能带路径前缀，取 basename 索引。
- `| build |` → 一次 build 把当时所有源文件都入库了。记 `latestBuildAt`（多次 build 取最新）。
- 其它 op（create / split / maintain / lint / save）不枚举源文件，忽略。
- 日期格式兼容 `YYYY-MM-DD HH:MM` 和 `YYYY-MM-DD`（无时间）。

> **注意**：有些 vault 的 log.md ingest 标题是**描述性文字**而非文件名（如「OpenAI Codex-maxxing 白皮书」），信号 2 对这些无效——这正是需要信号 1 和信号 3 的原因。

### 信号 3（回退）：源文件名出现在 wiki 全文里

有些 vault（典型如 `wiki-vault`）的 Agent 把源文件**织进了 concept/entity 页**，没给每个源建摘要页，log.md 标题又是描述——信号 1、2 都认不出。回退信号解决这个：

- `buildWikiBlob()`：递归读取 `wiki/**/*.md`，拼接成一个大字符串并 normalize。
- 对未被信号 1、2 命中的源文件，用其 normalize 后的 basename（去 `.md`、去空格、去引号）在 blob 里做 `includes` 子串搜索；命中 → 已入库（入库时间取 `wikiActivityAt` ≈ log.md mtime，即最近一次 wiki 活动）。
- **最小长度守卫**（`MIN_NORMALIZED_LEN = 8`）：normalize 后短于 8 字符的名字不参与匹配，避免 `Agent.md` 这类通用名误判（"agent" 在 wiki 里到处都是）。

实测 `wiki-vault`（69 源文件）：仅信号 1+2 只认出 13 个已入库；加上信号 3 认出 41 个已入库 / 2 待更新 / 26 待入库——26 个里如「远离社会底层」经核实 wiki 中 0 提及，确实从没入库。

### normalize 规则

`normalize(s) = 小写 + 去所有空白 + 去引号（直引号 `"` `'` 与弯引号/全角引号 `“ ” ‘ ’ 「 」 『 』`）+ 去尾部 .md`

兼容 Agent 记录源文件时的常见差异：空格不一致（「深度解析LLM Wiki」vs「深度解析 LLM Wiki」）、引号风格不一致（直引号 vs 全角弯引号）、`.md` 后缀有无。

---

## 三态判定

`statusForFile(node, parsed)` 对每个源文件节点计算：

```
ingestedAt = max(信号1[该文件各 key] , 信号2[该文件各 key])
buildAt     = (latestBuildAt > 0 且 文件 mtime ≤ latestBuildAt) ? latestBuildAt : 0
effectiveAt = max(ingestedAt, buildAt)

若 effectiveAt == 0 且 信号3 命中 → effectiveAt = wikiActivityAt

effectiveAt == 0            → pending（待入库）
mtime > effectiveAt         → tracked-modified（已入库·源已更新，建议重新 ingest）
否则                         → tracked-clean（已入库）
```

**用 mtime 判定「源已更新」**：任何写入都更新 mtime，所以同字节长度的内容修改（改错别字、等长换词）也能被抓到——这恰好是 isomorphic-git `statusMatrix` 的盲点（它用文件大小做快速判断，同长度修改会漏报）。

**build 覆盖用 mtime 判断**：`mtime ≤ buildAt` 表示 build 之后没改过 → 被 build 覆盖。代价是「build 后改过、且之后没单独 ingest」的文件会显示 `pending`（而非 `stale`）——两者都提示「该重新入库」，只是标签略偏，可接受；换来零额外 I/O + 跨平台一致（不用 birthtime，后者在 Linux ext4 常返回 0）。

**目录节点 rollup**：子树取最严重状态（pending > tracked-modified > tracked-clean）。

**wiki/ 子树跳过**：wiki/ 下的页面是产物不是源文件，不注状态。

---

## 缓存与性能

`parseCached()` 按缓存 token 缓存解析结果（`ingestedAt` map + `latestBuildAt` + `wikiBlob`）：

- token = `${log.md mtime}:${wiki/sources dir mtime}`。ingest/build 都会写 log.md → token 变 → 缓存失效重解析。
- 源文件被编辑（非 wiki 操作）时，log.md 不变 → 缓存命中 → 复用解析结果，只用文件新 mtime 重算状态。正确且快。

**10000 文件量级开销**（实测）：

| 环节 | 10000 文件 | 说明 |
|---|---|---|
| `scanTree`（既有，O(N) stat 每个文件）| ~119 ms | 主要开销，**与本功能无关** |
| 严格信号（1+2，O(N) Map 查找）| ~2 ms | 零额外 I/O |
| 信号 3 mention（每个未匹配文件一次 `blob.includes`）| 小 vault ~4ms | 见下门控 |
| blob 构建（读全部 wiki/*.md）| ~26ms（381KB wiki）| 仅缓存失效时一次 |

**mention 门控**（`MENTION_CAP = 2000`）：源文件数 > 2000 时跳过信号 3（仅用严格信号 1+2），保证超大 vault 刷新不卡。代价是 >2000 源文件的 vault 若 Agent 没建摘要页会欠报（严格信号仍跑，准确无虚报）。

到 10 万级别，`scanTree` 的 ~1.2s 才是瓶颈（既有问题，解法是缓存文件树本身，和本功能无关，需要时单独做）。

---

## 契约与前端

### 契约（`packages/contracts/src/knowledge.ts`）

```ts
export type IngestStatus = 'pending' | 'tracked-clean' | 'tracked-modified';

export interface TreeNode {
  // ... 原有字段
  ingestStatus?: IngestStatus;
}
```

`index.ts` re-export `IngestStatus`。

### 后端路由（`apps/daemon/src/routes/knowledge.ts`）

`GET /api/knowledge/vaults/:id/tree` 改为 async，`scanTree` 后 `await annotateTreeStatus(vault.path, tree)` 注入状态。无 wiki/log.md 时不注（懒初始化，徽标不显示）。

### 前端

- `apps/web/src/components/kb/KbFileTree.tsx`：`IngestBadge` 组件（三色圆点 + tooltip + `data-testid`），用 `.kb-tree-trailing` 包裹徽标和「+加入Wiki」按钮推到右侧；仅非 wiki/ 节点显示。
  - 🟠 `pending` 待入库 ｜ 🟢 `tracked-clean` 已入库 ｜ 🟡 `tracked-modified` 已入库·源已更新
- `apps/web/src/components/kb/KbFilePanel.tsx`：顶部统计条「待入库 N · 已入库 M · 待更新 K」，由 `countIngestStatus(tree)` 递归派生（排除 wiki/ 子树），无 `ingestStatus` 时隐藏。
- `apps/web/src/styles/knowledge.css`：`.kb-ingest-badge` 三色 / `.kb-ingest-stats` 样式。

---

## 文件落地实时感知（chokidar + SSE）

### 后端

- `apps/daemon/src/core/vault-watcher.ts`：`VaultWatcher extends EventEmitter`，仿 `WeixinService` 生命周期。
  - `start()` 枚举 `listVaults(db)` 逐个 watch；`watch(vaultId, path)` idempotent；`unwatch` / `stop()` 关闭。
  - chokidar `await chokidar.watch(...)`（兼容 v3/v4）；`ignored` 只忽略 dotfile **basename**（`.git`/`.claude`/`.gitignore`）但**永不忽略 vault root**——避免 root 名带点（如 `.tmp-x`）或祖先带点时整树被忽略。
  - `add/change/unlink/addDir/unlinkDir` → per-vault 300ms debounce → `emit('tree-changed', vaultId)`；定时器 `unref()`。
  - `watch()` await chokidar `ready`（2s 兜底）后才 resolve，便于测试可靠写文件。
- `apps/daemon/src/server.ts`：实例化 `vaultWatcher`，注入 `knowledgeRoutes`，`void vaultWatcher.start()`，三处 shutdown（`/api/shutdown`、SIGINT、SIGTERM）调 `stop()`。
- `apps/daemon/src/index.ts`：`shutdown()` 调 `vaultWatcher.stop()`。
- `apps/daemon/src/routes/knowledge.ts`：建 vault 时 `void vaultWatcher.watch(...)`、删 vault 时 `unwatch`；新增 `GET /vaults/:id/events` SSE 路由（`createVaultSSEStream` 仿 `sse.ts`：长连接 ReadableStream + 15s ping + abort 清理订阅，防泄漏）。

### 前端（`apps/web/src/hooks/useKnowledge.ts`）

新增 useEffect（定义在 `refreshTree` 之后避免 TDZ），mount 时开 `EventSource('/api/knowledge/vaults/:id/events')`，收到 `tree-changed` 调 `refreshTree()`；unmount/vault 切换 `es.close()`。EventSource 自动重连。

这样「文件刚落地」即时反映到文件树，不再依赖 window focus。

---

## 测试

- `apps/daemon/test/core/wiki-status.test.ts`（16 用例）：无 wiki 时不注；三层信号各路径；多 ingest 取最新；date-only 解析；build 覆盖与边界；目录 rollup；缓存按 mtime 失效；sources frontmatter 的 path/basename/wiki-link/无 log.md/转义引号等匹配；mention 回退。
- `apps/daemon/test/core/vault-watcher.test.ts`（5 用例）：写文件→debounce 后 emit；多次写聚合；`.git`/dotfile 忽略；`stop()` 后不再 emit；单 vault 失败不阻塞另一个。
- `apps/daemon/test/routes/knowledge.test.ts`：补 `VaultWatcher` 参数。

遵循 CLAUDE.md 错误驱动 + 集成测试要求（状态机/生命周期服务用集成测试驱动状态转换，不只测初始化）。

---

## 已知局限

- log.md / sources frontmatter 是 Agent 自由文本，格式偶尔跑偏（标题写成描述、空格/引号不一致）→ 可能误显 pending。三层信号 + normalize 容错覆盖了大部分；漏判的重新 ingest 一次即自愈（Agent 会写入正确条目）。
- 短/通用名（normalize 后 <8 字符）不触发 mention 回退，避免误判——这些可能仍显 pending。
- mention 是「名字出现在 wiki 里」，是「进没进 wiki」的合理代理，不等于「全文被消化」。
- >2000 源文件的 vault 跳过 mention 回退（严格信号仍跑，可能欠报但不会虚报）。
- 用户要看徽标需跑 dev 构建（关掉装好的 `Molio.exe` 腾出 3100 端口，`pnpm dev`）；装好的 `Molio.exe` 是旧代码无此功能。

---

## 验证（端到端）

1. `pnpm dev`（daemon :3100 + web :5173）。
2. 打开一个已有 wiki 的老 vault（如 `D:\work\test-wiki`）→ 文件树左侧源文件带状态徽标，顶部统计条显示计数。
3. 外部写一个新 .md 到 vault → **不切窗口**即看到文件树刷新、新文件显示 pending（里程碑 B 生效）。
4. `cd apps/daemon && pnpm test`、`cd apps/web && npx playwright test`、`pnpm typecheck`。

# 图谱交互交接：feat/graph-polish → PixiJS 引擎

> 日期：2026-08-20（**2026-08-25 修订**：交互基准从「位移场」改为「**阶段 A 全流动流体**」）
> 状态：**交接指导文档**（本地未提交，不参与 #226 合 main）
> 背景：两条分支技术路线分叉——
> - `feat/graph-polish`：Sigma.js + graphology + d3-force，**交互手段积累多**（拖拽全流动/位移场、相机惯性、位置持久化），但布局缺防叠团标定、Sigma 归一化坐标制约交互
> - `feat/graph-quartz-engine`（PR #226）：PixiJS 8 + d3-force/d3-zoom/d3-drag（quartz-4 渲染模型），**布局与标签质量成熟**（力模型 v6 防叠团、恒定尺寸标签），但交互为 Quartz 原版、手感粗糙
>
> ## 决策（2026-08-25 修订）
> **交互基准 = 阶段 A「全流动流体」**——最接近 Obsidian 原生拖拽手感（拖拽时整图如液体填补空白、整体维持圆形、松手物理回弹）。
>
> 此前把「位移场」（阶段 B）定为 P0 是基于 Sigma 的**权宜之计**：位移场是为根治 Sigma 下全流动的力模型漂移（绕质心旋转 / 整簇漂移）才诞生的，并非最终想要的效果。PR #226 落地后，阶段 A 的两个前置障碍**均已消除**：
>
> | 阶段 A 的 Sigma 时代障碍 | PR #226（Pixi）下的状态 |
> |---|---|
> | **布局质量差**：密集库 spacingRatio 1.23，放大即叠团，流体填补无良好布局基础 | ✅ **已解决**：力模型 v6 标定 spacingRatio→~5，布局均布、节点分离 → 流体有健康底座 |
> | **归一化相机漂移**：Sigma 用归一化坐标，拖拽期相机逐帧漂移，靠 `setCustomBBox` 冻结硬扛 | ✅ **已消除**：Pixi 用原始坐标，无归一化 → 无需 setCustomBBox 那套相机冻结 hack |
> | 全流动下整簇滑出视野（力模拟净动量） | ⚠️ **需重新解决**：Pixi 下仍会漂，用**质心锚定**（forceCenter / 位移场）在物理层钉住，**无需叠加相机冻结** |
>
> **交接原则**：交互核心大多是**渲染无关的纯算法**，可直接平移；落点从「graphology + Sigma」换成「engine 节点数组 + d3-drag/d3-zoom」。Pixi 用原始坐标系，**Sigma 特有的归一化漂移整类问题消失**。

---

## 一、交接总表

| # | 特性 | 解决的用户痛点 | 优先级 | 当前分支参考 | Pixi 引擎落点 | 状态 |
|---|---|---|---|---|---|---|
| 1 | **拖拽全流动流体（阶段 A）** | 拖拽像 Obsidian 一样液体填补，而非只动被拖节点 | **P0** | `GraphPage` 全流动解锁 + `e98ce569/a05274d3` 力模拟流体 + `useSimulation.computeDragWeights`(锚定用) | d3-drag start/drag/end + engine 节点数组 + **质心锚定** | ⏳ 待移植 |
| 2 | **拖拽降质** | 大图拖拽掉帧 | **P0** | `setMotionMode`（藏标签 + collide 迭代 3→1）+ minimap 跳过 | drag 期间简化 `syncLabels` + collide iterations 1 | ⏳ 待移植 |
| 3 | **相机惯性 + 缩放标定** | 缩放步长不合理（太肉/太跳）、无惯性 | **P0** | `useCameraInertia.ts`（累积 velocity + 自适应 gain） | 替换 d3-zoom 默认 wheel，驱动 `currentTransform` | ⏳ 待移植 |
| 4 | **单击不装流体（过阈值）** | 单击选中时图谱「呼吸」抖动 | **P0** | `GraphPage` DRAG_THRESHOLD=4px，mousedown 不装流体 | d3-drag 位移超阈值才装流体 | ⏳ 待移植 |
| 5 | **位置持久化 + 冷热加载** | 整理过的布局刷新/切走就丢 | **P0** | `readPositionsCache/writePositionsCache`（模块 + sessionStorage） | engine 已有 `getSnapshot`，补 restore API | ⏳ 待移植 |
| 6 | **力参数：度梯度向心 + 叶子边增强** | 布局杂乱（hub 不居中 / 叶子离 hub 远），兼影响拖拽手感 | **P1** | `centerStrengthForDegree` + `linkStrengthFor` | engine 的 forceX/Y strength + forceLink strength | ⏳ 待移植 |
| 7 | **hover 细化（两档淡化 + 迟滞）** | hover 高亮生硬、邻接边被遮挡 | **P1** | GraphPage `nodeReducer/edgeReducer` + hover linger 150ms | engine 已有 alpha tween，补尺寸/颜色细化 | ⏳ 待移植 |
| 8 | **孤立节点平铺 + 松手重铺归位** | degree0 节点随机散布；全流动解锁后飞散、松手不回圆环 | **P1** | `tileIsolatedNodes`（黄金角螺旋 + fx/fy 固定）+ 松手重铺 | engine 内实现（节点坐标 + degree）；与 #1 全流动强联动 | ⏳ 待移植 |
| 9 | **多层级布局 + 大图几何降级** | ≥50 节点收敛慢 / ≥2500 节点卡顿 | **P2** | `simulation.worker.ts`（Walshaw，graphology-free）+ `layoutLargeGraphGeometric` | worker 原样搬，收集/写回两端换 engine 节点 | ⏳ 待移植 |
| 10 | **入场 bloom / 暖加载** | 冷加载无「生长感」、直接铺开 | **P2** | GraphPage `reveal`（聚团→绽放 + 径向错峰） | engine 加位置 morph API（`animateToViewport` 已有） | ⏳ 待移植 |
| 11 | **daemon mtime 缓存** | 大库每次请求全量重扫重解析 | **P2** | `apps/daemon/src/routes/graph.ts` 文件级签名缓存 | 与 PR 的 index/log 剔除**正交可共存** | ⏳ 待移植 |

> **PR #226 已具备且优于当前分支、无需移植**：标签系统（恒定 12px 屏幕尺寸 + 贪心碰撞 + 渐进显隐）、顶栏 `GraphSearchBox`、**可交互** Minimap、力模型 v6（spacingRatio 1.23→5 防叠团）。移植时不要用当前分支的 Sigma 标签方案覆盖掉这些。
>
> **校正（原文档的 2 处错误结论）**：① 原「质心锁/相机冻结无需移植」只对 SIGMA 成立，阶段 A 下仍需**质心锚定**（但只用物理层 forceCenter/位移场，无需 setCustomBBox 相机冻结）；② 原「拖拽位移场=护城河」降级——位移场只是阶段 A 的**防漂移锚定工具**，不是交互形态本身。

---

## 一·五、阶段 A 演进与根因 × Pixi 解法（本次修订核心）

### 阶段流（拖拽交互演进，旧→新）

| 阶段 | 关键 commit | 拖拽模型 | 手感 | 定位 |
|---|---|---|---|---|
| **A. 全流动流体** | `c1c363f3`→`e98ce569` 全流动→`4485aa31`→`817b2cc8`→`eda947df`→`a05274d3` | 拖拽解锁全部 fx/fy（含孤立），整图 force 物理持续 + 实时重绘；磁铁/拴绳/**质心锁** + 松手物理回弹 | 整图如液体动态填补空白、维持圆形——**最像 Obsidian** | ✅ **目标基准** |
| **B. 位移场·根治漂移** | `ec1a6654`→`92fc640c` | 位移场直接写位置 = 锚点 + 位移 × 空间衰减权重，不写 vx/vy、不装 forceCenter；松手物理回弹 | 近邻让位、远处锚定、**无漂移**，但流体感弱于 A | 备选（锚定工具） |
| **C. 双档·引入 logseq** | `5f2fe5b3` | A/B 双档，**默认=logseq**（BFS 4跳衰减 + 松手定格） | 一拉全图平移、松手不动（用户不想要） | ❌ 弃用 |

> 用户确认：**阶段 A 才是想要的效果**；阶段 B 只是在 Sigma 下「全流动会漂」的妥协，阶段 C 的 logseq 档直接否定。

### 阶段 A 在 Sigma 失败的三大根因 × Pixi 对应解法

| # | Sigma 时代根因 | 现象 | Pixi（PR #226）下解法 |
|---|---|---|---|
| 1 | **力模型净动量**：磁铁直接写 `vx/vy`，拖拽注入动量 + 质心锁 forceCenter 全局刚性约束 → 力矩 | **绕质心旋转 + 整簇漂移** | **质心锚定**：按下瞬间在全图质心装 `forceCenter(target)` 钉住；位移场只对「远处」锚定（见 #3）。Pixi 下纯物理层，无需相机冻结 |
| 2 | **归一化相机漂移**：Sigma 归一化坐标，拖拽期映射基准漂移 | 拖拽时视角逐帧「滑」，需 `setCustomBBox` 冻结 | ✅ **已消除**：Pixi 原始坐标，无归一化 → 整类问题消失，无需 setCustomBBox |
| 3 | **拓扑 BFS 权重覆盖整图** | 拖一个节点 = 全图跟随平移 | **空间距离衰减权重**（阶段 B 已实现）：近邻让位、远处权重→0 锚定。若追求 A 的「全图液体」，改用**力模拟 + 质心锁**，权重衰减仅作补强 |

**关键判断**：阶段 A 在 Pixi 的核心工作是「**全流动 force 流体 + 质心锚定**」。质心锁（forceCenter）在 Sigma 时是和磁铁一起失败的原因，但 Pixi 下**不需要磁铁**（可改由位移场只在近邻放流体）、**不需要相机冻结**，只剩「质心锚定」一个净挑战。建议先实现「解锁全部 fx + 全图力模拟 + 质心 forceCenter + 松手回弹」，实机验证是否仍有漂移；若有，再用位移场的「远处锚定」兜底。

### ⚠️ Pixi 引擎适配点 —— 「照搬 Sigma drag 代码」的 3 个坑

> 下列是基于 `pixiGraphEngine.ts` 实际代码读出来的**语义差异**。阶段 A 在 Pixi 能管用，但**不是把 Sigma 的 drag 逻辑搬过去就行**——必须顺着 Pixi 模型改造这三处，否则「解锁全部 fx/fy」这类 Sigma 操作在 Pixi 下会失效。

| # | 差异点 | Sigma 版行为 | Pixi 引擎（PR #226）实际 | 阶段 A 需改造 |
|---|---|---|---|---|
| 1 | **forceX/Y 语义（最关键）** | `forceX((d) => d.fx != null ? d.fx : 0)` —— **读 fx 当向心目标**，所以「解锁/锁定全部 fx/fy」才有指挥意义 | `forceX(0).strength(0.06)`（`pixiGraphEngine.ts:527`）—— **钉原点、不读 fx** | 阶段 A 的「解锁全部 fx/fy 让孤立也流动」在 Pixi 语义失效；且「整簇不会被拉往被拖节点」是红利。需改 forceX/Y 或改用其他锚定机制 |
| 2 | **松手回弹** | `velocityDecay(0.3)+alphaDecay(0.018)+alpha(0.3).restart()` 慢放回弹 | drag end 是 `alphaTarget(0)`（`pixiGraphEngine.ts:874`）—— **自然沉降、重新布局**，非「回弹」 | 阶段 A 的「物理回弹归位」需自己接回弹参数，PR 未做 |
| 3 | **孤立节点** | `tileIsolatedNodes` 平铺外围圆环 + fx/fy 固定；拖拽解锁→松手重铺 | **无任何孤立处理**（`radiusOf` 里 dead 节点单独设色，其余一视同仁）；无 tile | 阶段 A 的「孤立节点流动 + 松手回圆环」需补 tile 逻辑 + degree 判别 |

**结论**：阶段 A 的核心直觉（`alphaTarget(1).restart()` 重启整图 sim）在 Pixi 天然就有、方向一致，加上无归一化漂移，整体**比 Sigma 更简单**；但上述三处是**必须适配**的硬点，工作量在「改造」，不在「照抄」。这也印证了 §二 #1 和 M1 把「质心锚定 + 回弹 + 孤立 tile」列为重点/风险是对的。

---

## 二、P0 项详述（决定「交互效果还行不行」）

### 1. 拖拽全流动流体（阶段 A）—— 交互手感的护城河，最高优先

**目标手感（Obsidian 原生）**：拖拽时**整张图**像液体一样动态填补拖拽产生的空白、整体始终维持圆形；松手后**物理回弹**归位。

**PR #226 现状（Quartz 原版，差距所在）**：d3-drag 只把被拖节点 `fx/fy` 钉光标 + `alphaTarget(1).restart()` 重新加热整图 → 邻居不随动、松手后整套图继续沉降重新布局。等于「只动被拖节点 + 松开后重排」，**没有液体填补感**。

**阶段 A 在 Pixi 的实现骨架**：
```
d3-drag start  : 解锁全部节点 fx/fy（含孤立）+ 被拖节点钉光标 + 全图质心装 forceCenter(target) + sim.restart()
d3-drag drag   : 被拖节点 fx/fy 跟鼠标；其余节点由 force 物理自由流动（不写位置，靠力模型）；实时重绘让联动可见
d3-drag end    : 撤 forceCenter + 孤立节点 tile 重铺归位 + 物理回弹（velocityDecay 0.3 + alphaDecay 0.018 + alpha(0.3).restart()）
```

**三个待实机验证的关键点**：
1. **质心锚定的强度**：`forceCenter(target=按下瞬间全图质心)` 是否足够钉住整簇防滑出视野？若仍漂，叠加位移场的「远处锚定」（`computeDragWeights`，权重远处→0）作为补强。
2. **流体感的取舍**：「全图流动」vs「近邻让位+远处锚定」哪个观感更接近 Obsidian——建议保留 `window.__setGraphDragMode` 双档实机 A/B，但**默认档设为 obsidian（全流动）**，而非 logseq。
3. **孤立节点在拖拽期的去向**：阶段 A 解锁孤立节点 fx 让它们也流动；松手需 tile 重铺回外围圆环（P1 #8）。若拖拽中外围「空了/乱了」观感差，可调 isolated 的向心强度或改为不流动。

**验收**：拖拽中被拖节点精确跟手、**近邻 + 全图流体式让位**、整体维持圆形、无漂移/旋转；松手一两秒内物理回弹归位、孤立节点回外围圆环。实机用史记库（704 节点）验证，重点确认「流体感是否像 Obsidian」。

### 2. 拖拽降质（motion degradation）

**痛点**：PR 拖拽期间全量标签渲染 + collide 3 迭代 + 物理全速 → 704 节点慢机掉帧。

**当前分支做法**（`GraphPage` + `setMotionMode`）：拖拽期 `renderLabels=false` + collide 迭代 3→1 + minimap 跳过重绘；松手恢复。

**移植落点**：drag 期间跳过/简化 `syncLabels`（PR 每帧跑全量标签碰撞）+ collide `.iterations(1)` + 通知 Minimap 暂停。

### 3. 相机惯性 + 缩放步长标定

**痛点**：PR 用 d3-zoom 默认滚轮步长（未对标 Obsidian），无惯性 → 缩放步长与观感不可控。

**当前分支做法**（`useCameraInertia.ts`，可直接平移）：
- **累积 velocity 缩放**：wheel 事件累计 `deltaY → velocity`，RAF 每帧应用 `newRatio = ratio × exp(-velocity)` 并衰减 → 连续运动 + 松手惯性滑行
- **自适应 gain**：`gain = BASE + AMP × exp(-ratio × DECAY)`；标定点 ratio=1 一格 ≈ **11%**。参数：`ZOOM_VEL_DAMPING 0.86` / `ZOOM_GAIN_BASE 0.006` / `ZOOM_GAIN_AMP 0.014` / `ZOOM_GAIN_DECAY 0.5`
- **平移惯性**：拖空白 pan，释放后 `PAN_DAMPING 0.88` 滑行衰减
- zoom-to-cursor 保证鼠标下图坐标不动

**移植落点**：d3-zoom 的 transform 是纯对象，每帧 RAF 里 `zoomBehavior.transform` 即可（PR 已有 `setTransform/syncD3Transform` 管道）。wheel 处 `preventDefault` 接管，空白的 d3-drag 处接管平移惯性。

### 4. 点击判定：过阈值才装流体

**痛点**：当前分支修过「单击选中时图抖一下/呼吸」。

**做法**：mousedown 只做「解锁全部 + 锁被拖节点 + 质心锚定」，**不装流体、不 wake**；`handleMouseMove` 位移超过 `DRAG_THRESHOLD=4px` 才真正启动流体。单击路径零力、零运动。

**移植落点**：d3-drag 的 start 里只记录起点，位移超阈值才启动流体。PR 现用 `<500ms && ≤4px` 判单击跳转，保留即可。

### 5. 位置持久化 + 冷热加载

**痛点**：PR 每次进图重跑仿真 + re-fit，用户整理过的布局刷新/切走就丢。

**当前分支做法**（`GraphPage` 模块级 + sessionStorage，key `molio.graphPositions.<vaultId>`）：
- 模块缓存（跨导航复用）+ sessionStorage（跨刷新恢复），只复用仍存在的节点
- 只读位置，**布局算法让位**：暖加载 = 缓存终态直接铺开；冷加载 = 重算布局
- 缓存写入时机：`__graphIntroDone` 之后（防把入场聚团误存为终态）

**移植落点**：engine 已有 `getSnapshot()`，补 `restorePositions(map)`（写入 `this.nodes[i].x/y` + 重建 sim 时尊重 `fx/fy`）；沿用同一 sessionStorage key 则历史布局无缝过渡。

---

## 三、P1 项详述（进一步对齐手感与布局细节）

### 6. 力参数：度梯度向心强度 + 叶子边增强

纯 d3-force 参数，两边引擎同构，**移植成本最低**：

- `centerStrengthForDegree(degree, base)` = `base × min(3, 0.25·deg^0.6)`；degree0 → `0.3×base`（拖拽解锁后防孤立飞散）。作用：hub 强向心留中心、低度弱向心外溢 → 度→半径梯度（对齐 Obsidian 分层）
- `linkStrengthFor(link, base)`：任一端 degree≤1 视为叶子边，strength `×3` clamp 1（防叶子被排斥推离 hub、边被拉长）

**落点**：engine 的 forceX/Y `strength((d) => centerStrengthForDegree(d.degree, centerStrength))`；forceLink `strength((l) => linkStrengthFor(l, linkStrength))`。注意与 PR「linkStrength=0 走 d3 默认 1/min(deg)」的关系——建议保留当前分支显式公式（已针对叶子边标定过）。

### 7. hover 细化（两档淡化 + 迟滞）

**当前分支**：hover 与选中**两档**淡化（hover 保留 75% 尺寸/40% 淡色；选中保留 60%），关联边 `zIndex:1` 置顶不被淡化边遮挡，smoothstep RAF 动画，hover 离开 150ms linger 防闪。

**落点**：engine 已有 hover alpha tween（Quartz 原版），补尺寸/颜色细化 + linger 迟滞即可。对齐目标是「hover 有呼吸感、不闪、高亮边不被遮挡」。

### 8. 孤立节点平铺 + 松手重铺归位

`tileIsolatedNodes`（graph-utils）：对 degree0 可见节点，以连接节点质心为中心、**90 分位半径**稳健估计包围半径（防离群点撑大），黄金角螺旋固定间距平铺成外围圆环，写 `fx/fy` 固定不被后续力模拟拉回。`spacing = max(8, 0.15×maxR)`、内缘 `rIn = 1.3×maxR`。

**落点**：engine 内实现（节点坐标 + degree 都有）。**与 #1 全流动强联动**：阶段 A 拖拽解锁孤立节点（让它们也流动）→ 松手需 tile 重铺回外围圆环并同步钉进 sim（`fx/fy`）。

---

## 四、P2 项详述（大图能力 + 入场体验）

### 9. 多层级布局 + 大图几何降级

- **Multi-level**（`simulation.worker.ts`，**graphology-free**，纯 `{id,x,y,radius,degree}` + 坐标消息协议）：Walshaw 粗化 → 粗层同步布局（`coarseLayoutSync`）→ 反投精化（`prolongateAndRefine`，refineTicks 250）。触发：≥50 节点 且 `edgeRatio = size/order ≥ 0.2`。**worker 可原样搬，只改主线程收集/写回两端**。
- **几何快速布局**（`layoutLargeGraphGeometric`）：≥2500 节点（对齐 fast-layout-threshold）走确定性 O(n) 黄金角螺旋（度降序 hub 居中）+ 孤立平铺，秒出终态、无迭代。
- 冷加载大图流程：占位包围盒 fit → worker ML → 完成事件触发 bloom/fit。

**落点**：engine 补 `applyPositions(map)` 写坐标；ML 完成后再建 force sim 使拖拽从终态流动。

### 10. 入场 bloom / 暖加载

`GraphPage.reveal`：冷加载 = 聚团（黄金角螺旋）→ 800ms 绽放（easeOutCubic + 径向错峰 `INTRO_STAGGER 0.6` 由中心向外涟漪）+ 画布去模糊 + 淡入；暖加载 = 快速淡入不重 bloom。冷小图（<50）先 `preSettle(300)` 同步预结算拿终态，消除「圆形中间态」。

**落点**：engine 加 `reveal(mode, from, to, bounds)`（位置 morph 动画 + `animateToViewport` fit），配套 `.graph-intro*` CSS 类。可与位置持久化一起做（暖/冷由有无缓存决定）。

### 11. daemon mtime 缓存（正交项）

`graph.ts` 文件级签名缓存：`signature = Map<relPath, "size:mtime">`，未变化直接回缓存，跳过 `readFileSync` + wikilink 正则解析（大库最大成本）。FIFO 上限 50。与 PR 的 index/log 剔除**可同时保留**（一个省 CPU、一个提数据质量）。

---

## 五、已做优化清单（2026-07 → 2026-08，feat/graph-polish 及前置分支）

> 当前分支 59 个领先 commit 中有 52 个图谱相关。以下是历次优化按主题概括，**每项都是移植到 Pixi 引擎时「证明过有价值」的点**。commit 缩写为 8 位，完整信息 `git log --oneline main..HEAD --grep=graph -i`。

### 5.1 布局：对齐 Obsidian 分层

| 优化点 | 内容 / 根因 | 关键 commit | 交接映射 |
|---|---|---|---|
| 度→半径梯度 | 力导向默认 hub 和低度节点一起挤中心、外围空。按 degree 调向心强度 → hub 居中、低度外溢 | `af440295` 按 degree 向心力；`74440462` 低度向心平台消除叶子外溢长边；`5177aa7b` 叶子按所连 hub degree 算向心；`11ddb311` 恢复「叶子边强」消除叶子长边 | §三 #6 |
| 孤立节点外围圆环 | degree0 无约束随机散布。封顶环形带 → 黄金角螺旋固定间距平铺成外围圆环并 `fx/fy` 固定；90 分位半径稳健（防离群点撑大包围盒） | `de83e114` 封顶环形带；`d02e42dd` 修退化成两条直线；`44a83bf5` 黄金角螺旋去放射辐条；`0aaf8d95` 固定间距对齐密度 | §三 #8 |
| 连接距离 + 设置迁移 | 缩短 linkDistance 对齐 Obsidian，并 bump 设置版本号强制新默认覆盖旧持久化缓存 | `b66d7ec7` | §三 #6 |

### 5.2 布局：大图 Multi-Level + 两段式降级

| 优化点 | 内容 / 根因 | 关键 commit | 交接映射 |
|---|---|---|---|
| Walshaw 多层级 | ≥50 节点自动粗化→粗层布局→反投精化，worker 内跑不卡主线程；三阶段力参数一致、粗层用质心做初值、精化 250 tick 充分收敛 | `11c294b5` 粗化 → `49558724` 粗层+反投 → `dc88baf6` Map key 一致 → `96533156` 质心初值/平衡力 → `39830dd0` 平衡 ML 力 → `a412a979` 三阶段同参数减抖动 → `3750ea4a` post-ML 切主线程保拖拽 | §四 #9 |
| ML 生命周期 | 自动触发、进度面板、完成后停 worker 防卡、相机脉冲 | `e78e8d15` 首载自动 ML；`8f47a7fc`/`8affb3b4` 重布局按钮+进度；`f7c8add0` post-ML 停 worker；`f207ced8` ML 完成相机脉冲 | §四 #9 |
| 大图两段式降级 | ≥2500 节点不再跑 force/ML，走确定性 O(n) 几何布局秒出终态（对齐 fast-layout-threshold） | `a75293c1` | §四 #9 |
| daemon mtime 缓存 | 大库每次请求全量重读+正则解析。文件级 `size:mtime` 签名缓存，改一块只重解析一块 | `a75293c1` | §四 #11 |

### 5.3 拖拽交互（演进主线，阶段 A/B/C）

| 优化点 | 内容 / 根因 | 关键 commit | 交接映射 |
|---|---|---|---|
| 拖拽锁相机 + 活跃模拟 | 拖拽期锁相机防归一化漂移、活跃模拟贴近 Obsidian 流体；on tick 接 refresh 让其他节点联动可见 | `c1c363f3` 锁相机（贴近 Obsidian 流体行为）；`4485aa31` on tick refresh；`e98ce569` 全流动（解锁全部含外围、松手重铺） | §二 #1（阶段 A） |
| degree0 兜底钉住 | 拖拽时孤立节点累积漂移。sim 创建时 degree0 无 fx 则钉当前位置 | `c636c66f` | §二 #1 |
| **阶段 A：全流动 + 磁铁/拴绳/质心锁** | 全图流体，但磁铁写 vx/vy 注净动量 + 质心锁全局刚性约束 → 绕质心旋转 / 整簇漂移（P0-1 要根治的） | `eda947df` 质心锁 + 流体延后安装；`817b2cc8` halt 修二次拖拽 + 回弹慢放 + 相机全程冻结守护；`a05274d3` 相机冻结 + 局部流体（磁铁/拴绳）+ 松手定格 | §一·五 阶段 A / §二 #1 |
| **阶段 B：位移场重写（根治漂移）** | 磁铁/拴绳/质心锁迭代 8 轮边际收益递减。改为**直接写位置**（锚点+位移×空间衰减权重，不写 vx/vy、不装 forceCenter）从源头消除净动量 | `ec1a6654` 位移场重写治绕质心旋转/整簇漂移；`92fc640c` 权重改空间距离衰减治整图平移 | §一·五 阶段 B（备选锚定工具） |
| **阶段 C：双档 A/B（默认 logseq）** | 运行时 `__setGraphDragMode`，logseq(BFS+定格) 设默认、obsidian 降对比档 | `5f2fe5b3` | ❌ 弃用（用户确认要 obsidian 档） |
| 相机冻结不重捕获 | 松手后 customBBox 持久保留，按下瞬间不重捕获基准（否则二次拖拽必跳帧）——Sigma 特有 | `a05274d3` | Pixi 无需（无归一化） |
| 单击不装流体 | mousedown 不装位移场/不 wake，过 DRAG_THRESHOLD=4px 才装 → 单击零力零抖动 | `a05274d3` 阶段定型 | §二 #4 |

### 5.4 相机 / 缩放

| 优化点 | 内容 / 根因 | 关键 commit | 交接映射 |
|---|---|---|---|
| 缩放步长标定 | Sigma 默认一格仅 2.8%（太肉）。改累积 velocity 模型 + 自适应 gain，ratio=1 一格 ≈ 11% 对齐（远景 ~14% / 近景 ~5%） | `3b02b943` | §二 #3 |
| 相机惯性 | 平移惯性（`PAN_DAMPING 0.88`）+ 缩放累积 velocity 惯性滑行 | `useCameraInertia.ts` | §二 #3 |

### 5.5 搜索 / Minimap

| 优化点 | 内容 / 根因 | 关键 commit | 交接映射 |
|---|---|---|---|
| 搜索已在视口内只高亮不飞相机 | 避免搜索同屏节点时视角晃动 | `6af30c1c` | PR 已自带顶栏搜索，无需移植 |
| 搜索相机空白修复 | 相机飞到归一化空间外致图谱空白卡死 | `42d5b93e` | 同上 |
| Minimap 启用 + 视口框坐标系 | 视口矩形坐标系混淆导致小地图视口框错位 | `329982c5` | PR 已自带交互式 minimap，无需移植 |

### 5.6 代码质量 / 基线

| 优化点 | 内容 | 关键 commit |
|---|---|---|
| 图谱整体对齐 Obsidian 重构 | 性能与体验对齐 Obsidian 的基线重构（颜色/尺寸/交互） | `65763a2d` |
| 抽 graph-utils.ts | 纯函数抽出（node:test 可测、引擎无关），位移场权重/平铺/几何布局/力参数都在此 | `51a08c01` |
| 清理死代码 | 局部图预备死代码 `MAX_LOCAL_NODES` | `4cec2430` |

> **小结**：交互侧最值钱的是「**全流动流体（阶段 A）+ 质心锚定 + 单击判定 + 相机惯性 + 位置持久化**」（§一·五 / §二）；布局侧最值钱的是「度梯度 + 孤立平铺 + 多层级」（§三/§四）。这两组共同构成移植的优先序。

---

## 六、移植顺序（里程碑）

| 里程碑 | 内容 | 目标（验收以真实 vault + 实机手感为准） |
|---|---|---|
| **M0** | PR #226 合 main | 布局/标签/搜索/minimap 就位（阶段 A 的布局前提） |
| **M1（P0 手感）** | ①全流动流体 + **质心锚定** + ②拖拽降质 + ③相机惯性/缩放标定 + ④单击判定 | 拖拽整图液体填补、整体维持圆形、**无漂移/旋转**、缩放 ~11%/格有惯性、单击不抖 |
| **M2（P0 连续性）** | ⑤位置持久化 + 冷热加载 | 切走/刷新布局不重排 |
| **M3（P1 细节）** | ⑥力参数 + ⑦hover 细化 + ⑧孤立平铺（与全流动联动）+ 单击/双击语义定案 | 布局分层、hover 不闪、孤立成环、拖拽中外围观感可接受 |
| **M4（P2 规模）** | ⑨多层级 + 几何降级 + ⑩入场 bloom + ⑪daemon mtime | ≥50 收敛快、≥2500 秒出、冷加载有生长感 |

> **M1 是重点也是风险**：全流动在 Pixi 的「质心锚定」效果需实机反复调（forceCenter 强度 / 是否叠加位移场远处锚定）。验收时用 `__setGraphDragMode` 对比 obsidian(全流动) vs 锚定补强档，选一个最像 Obsidian 的。
>
> 每完成一项即回归 e2e（`apps/web/e2e/graph*.spec.ts`）+ 史记库实机；交互手感类必须有用户实机确认才算「done」。

---

## 七、验收与回归策略

- **实机手感（M1）**：用史记库（704 节点 / 3318 边）验证拖拽液体填补、整体维持圆形、无漂移、缩放惯性、刷新持久化。**重点反复对比「全流动」与「锚定补强」两种方案谁更接近 Obsidian**。
- **E2E 断言**（可继承当前分支）：`window.__graphIntroDone` 入场完成标记；位置持久化断言（拖拽后 sessionStorage 有值、刷新后位置一致）；缩放后包围盒不爆炸；**拖拽质心锁断言**（拖拽中整体包围盒不显著外扩）。
- **开发对比开关**：保留 `window.__setGraphDragMode('logseq'|'obsidian')`，移植时让 obsidian 档代表阶段 A「全流动」，新增一档做「锚定补强」，不改代码不刷新即可 A/B 手感。

---

## 附：当前分支实现地图（移植时的参考索引）

| 文件 | 关键符号 | 作用 |
|---|---|---|
| `apps/web/src/components/graph/useSimulation.ts` | `beginDrag`(L629) `applyDrag`(L660) `endDrag`(L690) `setDragMode`(L714) `setMotionMode`(L592) `setCentroidLock`(L609) `multiLevel`(L720) `preSettle`(L806) `syncToGraph`(L825) | 仿真主控：全流动/位移场、质心锁、降质、ML、预结算 |
| `apps/web/src/components/graph/graph-utils.ts` | `computeTopoDragWeights`(L211) `computeDragWeights`(L255) `tileIsolatedNodes`(L82) `layoutLargeGraphGeometric`(L173) `centerStrengthForDegree`(L294) `linkStrengthFor`(L309) `LARGE_GEOMETRIC_THRESHOLD`(L161) | 纯函数（位移场权重/平铺/几何布局/力参数），已 node:test 覆盖 |
| `apps/web/src/components/graph/GraphPage.tsx` | `DRAG_RADIUS_PX`(L49) `read/writePositionsCache`(L107-128) `handleMouseDown`(L766) `handleMouseMove`(L853) `handleMouseUp`(L925) `freezeAllNow`(L909) `reveal`(L556) | DOM 事件编排、位置持久化、入场动画 |
| `apps/web/src/components/graph/useCameraInertia.ts` | `setupCameraInertia` + `zoomGain`/`ZOOM_*` | 相机惯性 + 缩放标定（整文件可平移） |
| `apps/web/src/components/graph/simulation.worker.ts` | `handleMultiLevelInit`(L593) `handleBeginDrag`(L261) `handleApplyDrag`(L271) `handleEndDrag`(L294) | Worker：多层级（graphology-free）+ 位移场镜像 |
| `apps/daemon/src/routes/graph.ts` | `buildMdSignature`/`signatureEquals`/`graphCache` | mtime 缓存（正交项） |

> 行号为 2026-08-20 `feat/graph-polish` 快照，移植时以实际代码为准。

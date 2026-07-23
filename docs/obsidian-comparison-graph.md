# 知识图谱深度对比：Molio vs Obsidian

> 对比日期：2026-07-18（初始基线）｜修订：2026-07-20
>
> **修订说明（2026-07-20）**：初始基线中标注为 ❌ 的若干项已在本轮重构中实现
> （hover/选中过渡动画、标签缩放渐隐、camera inertia、velocity 缩放、比例碰撞、
> Web Worker 自适应、节点搜索、数据缓存）。最新状态见文末「十一、当前实现状态」，
> 与各章节结论冲突处以「十一」为准。
>
> **渲染细化（2026-07-20）**：hover/选中视觉进一步对齐 Obsidian——
> 淡化强度收敛（非关联节点不再缩成隐形点）、高亮边 z-index 分层置顶（不被淡化边遮挡）、
> hover/选中互斥（选中态下 hover 不抢焦）。详见 11.4。
>
> **重要说明**：Obsidian 是闭源软件，本对比基于公开技术资料分析：
> - CoSE-Bilkent 论文（Bilkent 大学 i-Vis 实验室）
> - Cytoscape.js cose-bilkent 开源库文档
> - Obsidian 官方 changelog（v0.0.2 ~ v0.15.7+）
> - Obsidian 社区论坛讨论
>
> 本文是 [总体对比文档](./obsidian-comparison.md) 的知识图谱专项展开

---

## 一、图谱定位差异

| 维度 | Obsidian | Molio |
|------|----------|-------|
| **定位** | 核心插件，知识回顾与发现的标配工具 | 补充功能，服务于知识库可视化 |
| **入口** | 侧边栏图标，一键打开 | `/graph` 路由，导航栏入口 |
| **在知识管理中的角色** | **探索工具** — 通过图谱发现之前没意识到的关联 | **验证工具** — 验证 Wiki 构建质量和链接完整性 |
| **用户使用频率** | 高频（许多人随时打开当背景） | 查看/验证时使用 |
| **渲染引擎** | 自研 Canvas 2D | Sigma.js v3（WebGL） |
| **布局算法** | CoSE-Bilkent（Compound Spring Embedder） | d3-force（通用力导向引擎） |

---

## 二、布局算法：CoSE vs d3-force（最大的根本差距）

### 2.1 算法本体对比

| 维度 | Obsidian (CoSE-Bilkent) | Molio (d3-force) |
|------|------------------------|-----------------|
| **本体** | 专为图谱可视化设计的工业级布局算法 | 通用物理引擎 |
| **初始布局** | 随机分布 + 多层级缩放 | 圆周均匀分布 |
| **多层级 (Multi-Level)** | **✅ 有** — Walshaw 聚类粗化 → 逐层精化 | **✅ 初步实现** — Walshaw 随机匹配粗化 + 逐层反投微调（参数调优中） |
| **默认迭代** | 2500 次（quality='proof'） | 无限（alpha decay 自动收敛） |
| **节点排斥** | 节点**边界间**最短欧氏距离 | `forceManyBody` 中心间距离 |
| **运行线程** | **✅ Web Worker**（v0.15.7+） | **✅ Web Worker（自适应）** — <1000 主线程 / ≥1000 Worker；ML 期间全量在 Worker |
| **渲染帧优先级** | **✅ 有** — 优先保证渲染帧，物理计算退让 | **❌** 物理 tick 和渲染在同线程争抢 |

### 2.2 Multi-Level Scaling 详解

这是 CoSE 最核心的技术优势，也是 Obsidian 图谱"均匀合理"的根本原因。

当图超过 100 个节点时，CoSE 执行三阶段：

```
1️⃣ 粗化阶段（Coarsening）
   G₀（原始，500 节点）
      ↓  聚类合并相邻节点
   G₁（300 节点）
      ↓  再次聚类
   G₂（100 节点）
      ↓  再次聚类
   G₃（30 节点）← 最粗层级

2️⃣ 布局阶段（Layout）
   从 G₃ 开始布局 → 收敛（仅 30 节点，秒出全局最优）
   布局结果插值回 G₂ → 作为初始位置 → 精化布局
   布局结果插值回 G₁ → 精化
   布局结果插值回 G₀ → 精化

3️⃣ 精化阶段（Refinement）
   最终收敛到均衡态
```

**效果**：
- 边交叉数大幅减少
- 节点分布极其均匀
- 避免陷入局部最优解

Molio 现已实现 Walshaw 多层级策略（随机匹配粗化 → 粗化图布局 → 反投精化），见 `feat/multi-level-layout` 分支。当前 ML 参数与主线程力参数保持一致，布局质量接近 CoSE 水平但仍需持续调优。

### 2.3 Molio 向心力的具体问题

Molio 使用了每个节点独立的 initX/initY 回弹力：

```typescript
// useSimulation.ts:113-114
.force('x', forceX<D3Node>((d) => (d.fx != null ? d.fx : d.initX)).strength(0.004))
.force('y', forceY<D3Node>((d) => (d.fy != null ? d.fy : d.initY)).strength(0.004))
```

这里的 `initX`/`initY` 来自**圆周初始布局**：

```typescript
// GraphPage.tsx:145-161
for (let i = 0; i < count; i++) {
  const n = graphData.nodes[i];
  const angle = (2 * Math.PI * i) / count;
  // ...
  x: saved?.x ?? Math.cos(angle) * radius,
  y: saved?.y ?? Math.sin(angle) * radius,
}
```

这产生一个副作用：**布局被初始圆周分布强烈引导**——每个节点倾向于回到圆周上的位置，而不是自然扩散到整个画布。对比 CoSE 的全局重力（把所有节点拉向共同中心 barycenter）：

```
CoSE:   gravity → pull toward graph barycenter（共同中心）
Molio:  forceX/Y → pull toward initX/initY（各自初始位置，在圆周上）
```

后者导致：
- 外围节点被"钉"在圆周轨道附近
- 中心区域节点的分布也受初始角度牵制
- **整体布局看起来像径向扩散，而非自然力导向**

CoSE 的全局重力配合 multi-level，天然形成中心枢纽密集、外围均匀散开的自然结构。

### 2.4 参数可调性

**CoSE-Bilkent 提供了 15+ 可调参数**（来自 Cytoscape.js 开源库）：

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `nodeRepulsion` | 4500 | 节点排斥力倍数 |
| `idealEdgeLength` | 50 | 理想边长度 |
| `edgeElasticity` | 0.45 | 边弹性/刚度 |
| `gravity` | 0.25 | 全局向心力 |
| `numIter` | 2500 | 最大迭代次数 |
| `tile` | true | 是否平铺孤立节点 |
| `quality` | 'default' | draft / default / proof 三档 |
| `nestingFactor` | 0.1 | 嵌套边长度因子 |
| `gravityRange` | 3.8 | 重力作用范围 |

**Molio d3-force 可调参数**（当前实现）：

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `repelStrength` | -60 | forceManyBody 强度 |
| `centerStrength` | 0.004 | forceX/Y 回弹强度 |
| `linkStrength` | 0.15 | 边弹簧强度 |
| `linkDistance` | 100 | 边弹簧自然长度 |

CoSE 的参数更丰富细腻（三档 quality、tiling、nesting），Molio 只有 4 个粗粒度参数。

---

## 三、渲染与缩放体验

### 3.1 线程模型（影响流畅度的根本原因）

```
Obsidian (v0.15.7+, 2022-07):
  ┌─────────────────┐     ┌──────────────────────┐
  │  主线程          │     │  Web Worker           │
  │  Canvas 绘制     │     │  CoSE 物理计算        │
  │  事件处理        │     │  布局迭代             │
  │  Camera 动画     │     │  收敛检测             │
  │  UI 交互         │     │                      │
  └─────────────────┘     └──────────────────────┘
      ← 60fps 渲染优先 →      ← 后台计算，渲染退让 →

Molio (当前)：
  ┌─────────────────────────────────────┐
  │  主线程                              │
  │  Sigma WebGL 绘制                    │
  │  d3-force 物理 tick（forceManyBody）  │
  │  事件处理                            │
  │  RAF 循环（Minimap 用）               │
  └─────────────────────────────────────┘
      ← 2000+ 节点时 d3 tick 会阻塞主线程 →
```

Obsidian 从 v0.15.7（2022-07）开始把图模拟移到 Web Worker。Changelog 明确记载："graph simulation is now done in a worker thread" + "prioritize rendering frames over physics"。

Molio 的 `useSimulation.ts` 里 d3-force 的 tick 回调在主线程执行。`forceManyBody` 即使有 `distanceMax(250)` 优化，在数千节点时依然会产生明显的帧率抖动。

### 3.2 缩放体验

| 特性 | Obsidian | Molio |
|------|----------|-------|
| **Zoom 平滑度** | 重做过（v0.15.7），带**惯性**（inertia） | Sigma 默认响应，无惯性 |
| **Pan 惯性** | ✅ 有 | ❌ 无 |
| **缩放过渡** | 操作释放后平滑减速 | 立即停止 |
| **渲染优先级** | 渲染帧 > 物理帧 | 同线程无优先级 |
| **大图 (5000+)** | 物理降频 + 渲染保持 60fps | d3 tick 卡主线程 |

惯性是 Obsidian 缩放"丝滑"的主要原因：滚轮抬起后，camera 继续运动并逐渐减速，而不是立即停止。

### 3.3 字体渲染和信息密度

| 特性 | Obsidian | Molio |
|------|----------|-------|
| **标签字体** | 系统界面字体（加载后再渲染） | Sigma WebGL 纹理字体 |
| **缩放时标签行为** | **逐步淡入淡出** — 核心节点保留更久 | **硬阈值** — labelRenderedSizeThreshold=5 |
| **密度控制** | 基于节点重要性组合策略 | labelDensity=0.25 单一阈值 |
| **字体清晰度** | Canvas 2D fillText（原生抗锯齿） | WebGL 纹理（缩放时锯齿） |
| **自定义字体** | 支持 CSS 自定义 | 固定字体（Inter, PingFang SC） |

Molio 的标签显隐是硬阈值：

```typescript
labelRenderedSizeThreshold: 5,  // 低于 5px 不渲染
labelDensity: 0.25,             // 标签密度
```

zoom out 时所有标签几乎同时消失。Obsidian 会按节点重要性逐步淡出一核心枢纽节点标签保留更久，外围孤立节点先消失。这需要**判断节点重要性（degree）+ 混合阈值**的组合策略。

---

## 四、碰撞检测

### 4.1 实现对比

| 维度 | Obsidian (CoSE) | Molio (d3-force) |
|------|----------------|-----------------|
| **碰撞检测** | ✅ CoSE 内置（v0.0.2 起） | ✅ forceCollide 独立力 |
| **检测方式** | **节点边界间最短欧氏距离** | **中心点距离 + 固定 radius** |
| **处理方式** | 排斥力遵循物理公式 d²/k（平滑推开） | **硬约束直接位移**（暴力推开） |
| **不均匀节点** | ✅ 原生支持（边界距离感知） | ⚠️ radius 统一 +6px padding |
| **布局集成** | 碰撞是布局算法原生组成部分 | 碰撞是独立力，可能和弹簧力振荡 |

### 4.2 为什么 Obsidian 的碰撞效果更好

```
Obsidian (CoSE):
  大节点 (r=30) ←──────────→ 小节点 (r=6)
  │                             │
  └── 检测：节点边界距离 < 0       └── 排斥力：d²/k（连续、平滑）
      ↓
  大节点轻微后退，小节点后退更多（物理正确）
  整个布局系统协同调整

Molio (d3-forceCollide):
  大节点 (r=30) ←──────────→ 小节点 (r=6)
  │                             │
  └── 检测：中心距离 < (30+6)+(6+6)  └── 硬推力，目标距离 = r_a + r_b + 12
      ↓
  ✗ 统一 padding（大节点 6px padding 过少，小节点 6px padding 过多）
  ✗ 硬约束和弹簧力拉扯 → 可能振荡
  ✗ 独立力不参与全局优化
```

### 4.3 但 Obsidian 也不是完美的

论坛上 silver（Obsidian 开发者）明确承认：**"text label 重叠是已知问题，无计划修复，因为技术上不简单"**。在节点密集区域，Obsidian 的标签依然会互相遮盖。Molio 也有同样的问题。

---

## 五、过渡和动画效果

| 效果 | Obsidian | Molio | 差距 |
|------|----------|-------|------|
| **Hover 高亮** | 150-200ms 渐变过渡 | **即时切换**（nodeReducer 立即 return） | ❌ |
| **选中聚焦** | 邻居淡出 ~300ms 动画 | **即时切换** | ❌ |
| **碰撞弹开** | 物理弹簧自然过渡 | 下一帧直接到新位置 | ❌ |
| **标签缩放过渡** | 逐步淡入淡出 | 阈值硬切换（<5px 消失） | ❌ |
| **布局收敛** | 2500 次迭代逐步收敛 | alpha 从 1→0 无呈现 | ⚠️ 虽持续但无动画 |

Molio 完全没有过渡动画。这是因为 Sigma.js 的 `nodeReducer`/`edgeReducer` 每次 `refresh()` 都立即应用新状态：

```typescript
// GraphPage.tsx — 即时切换
renderer.on('leaveNode', () => {
  hoveredNodeRef.current = null;
  renderer.refresh();  // 立即生效，无过渡
});
```

要添加过渡，需要 Sigma 的 `scheduleAt` 或自定义补间调度，目前没有实现。

---

## 六、完整功能矩阵

### 6.1 图谱基础能力

| 能力 | Molio | Obsidian |
|------|-------|----------|
| **全局图** | ✅ 完整 vault 级 | ✅ |
| **局部图 (Local Graph)** | ⚠️ 聚焦模式（overlay 淡出非关联节点） | ✅ 独立面板 + 级数控制（1-3 级） |
| **Minimap** | ✅ Canvas/按需重绘/160×110（2026-07-22 正式挂载启用） | ❌ 无 |
| **节点搜索** | ✅ Ctrl/Cmd+F 浮层 + zoomToNode（2026-07-22 修复归一化坐标系 bug + 视口内只高亮不飞相机） | ✅ Ctrl+Shift+F 搜索定位 |
| **框选** | ❌ 无 | ✅ Shift+drag |
| **右键菜单** | ❌ 无 | ✅ 星标/隐藏/打开 |
| **类型着色** | ✅ 三组颜色（文档/概念/对比） | ❌ 默认统一（需社区插件） |
| **力参数调节** | ✅ 4 sliders 实时生效 | ✅ 内置 sliders |
| **死链接可视化** | ✅ `__dead__` 灰色点 + 计数 | ❌ 无正式死链接概念 |
| **增量更新** | ⚠️ 模块级数据缓存（SWR，进页面静默刷新），非文件级实时监听 | ✅ 实时文件监听 |

### 6.2 渲染与视觉

| 方面 | Molio | Obsidian |
|------|-------|----------|
| **布局均匀度** | 圆周向心力牵制，局部最优 | Walshaw Multi-level 全局优化，簇分离清晰 |
| **碰撞检测** | forceCollide 固定半径+中心 | CoSE 边界距离感知，更平滑 |
| **缩放流畅度** | 无 inertia，主线程阻塞 | Web Worker + inertia，60fps |
| **标签显隐** | 硬阈值 labelSize=5 | 逐步淡出，核心优先 |
| **Hover 过渡** | 即时切换 | 150-200ms 渐变 |
| **选中效果** | 紫色 #8B5CF6 + 1.4× | 白色 + 紫色光晕 + 阴影 |
| **边默认样式** | #D4D4D4, 0.8px 明显可见 | rgba(255,255,255,0.08) 极淡 |
| **暗色/浅色** | ✅ light/dark/system | ✅ 跟随 app |

### 6.3 交互

| 交互 | Molio | Obsidian |
|------|-------|----------|
| 画布平移 | Sigma 内置 | 自研 + inertia |
| 缩放 | Sigma 内置（无惯性） | 自研（有惯性） |
| Hover | 高亮邻居 | 高亮邻居 + 过渡 |
| 单击 | 选中（紫色 focus 模式） | 选中 + 详情面板 |
| 双击 | **导航到 /knowledge 打开文件** | 打开文件 |
| 拖拽 | 实时 fx/fy 锁定 | fx/fy 锁定 |
| 空白点击 | **取消选中 + 清所有 fx/fy** | 取消选中（fx/fy 保留，需手动解锁） |

---

## 七、Molio 的真正独有优势（修正版）

| 优势 | 评价 |
|------|------|
| **Minimap** | 🏆 Obsidian 确实没有，160×110 Canvas 实时绘制 |
| **死链接可视化** | 🏆 Obsidian 无正式死链接概念 |
| **类型着色** | 🏆 Obsidian 需要社区插件，Molio 内置三组颜色 |
| **双击导航到文件** | ✅ 体验便捷（Ob 需要多点击一次详情面板） |
| **取消选中清 fx/fy** | ✅ 自动解锁被固定节点（Ob 需要右键菜单操作） |

需要撤回的前期结论：

| 之前误判 | 修正 |
|----------|------|
| "碰撞检测是 Molio 独有优势" | ❌ Obsidian 有且更好（CoSE 边界距离 vs center+radius） |
| "布局基本接近 Obsidian" | ✅ 初步实现 Walshaw multi-level（参数调优中，仍需与本机 CoSE 对齐） |
| "Molio 图谱 78-82% 功能完整度" | ❌ 实际约 50-55%（考虑布局质量、流畅度、动画等因素） |

---

## 八、综合评分（2026-07-18）

```
Molio 知识图谱 vs Obsidian（100% = Obsidian，基于公开技术信息）

布局均匀度       ████████████████░░░░ 75%  ✅ Walshaw multi-level 初步实现（参数调优中）
缩放流畅度       ████████████████░░░░ 70%  ⚠️ 已有 Worker（≥1000） + inertia 惯性缩放/平移，但默认缩放无 inertia（worker 下为主线程）
碰撞检测         █████████████░░░░░░░ 65%  ⚠️ 比例 padding（0.35）+ 3 次迭代，已接近 CoSE 边界距离
字体信息密度     ████████████░░░░░░░░ 40%  ❌ 硬阈值 vs 渐变淡出（未改）
过渡动画         ██████████░░░░░░░░░░ 50%  ⚠️ 已添加 smoothstep（200ms hover/选中同步淡化），仍不及 Ob 丝滑

Minimap          ██████████████████████████ 120%  🏆 独有
死链接可视化     ██████████████████████████ 120%  🏆 独有
类型着色         ██████████████████████████ 120%  🏆 独有（Obsidian 需插件）
力参数调节       ████████████████████░░ 85%  ⚠️ 参数更少但够用
双击导航         ✅                                🏆 独有
全局图           ████████████████████░░ 85%  ⚠️ 功能接近但渲染质量有差距
局部图/聚焦      ██████████████░░░░░░ 60%  ❌ 独立面板 + 邻居级数控制缺失
增量更新         ██░░░░░░░░░░░░░░░░░░ 10%  ❌ 全量重建
节点搜索         ████████████░░░░░░░░ 60%  ✅ 已实现（2026-07-22 修复相机坐标系 bug + 视口内只高亮不飞）
右键菜单         ██░░░░░░░░░░░░░░░░░░ 10%  ❌ 未实现

总体：Molio 图谱约达到 Obsidian 的 65-70% 功能完整度（ML 布局从 0%→✅ 初步实现，提升约 10%）
      （2026-07-22 修正：缩放/碰撞/过渡/搜索均有提升，局部图方向修正重做中，布局/增量更新/右键仍是主要缺口）
```

---

## 九、改进优先级

### 性价比最高的改进

| 优先级 | 改进项 | 难度 | 代码量 | 效果 | 状态 |
|--------|--------|------|--------|------|------|
| **P0** | **替换 initX/initY 向心力为全局重力** | 🟢 低 | 2 行 | ⭐⭐⭐⭐ 布局均匀度大幅提升 | ✅ 已完成 |
| **P0** | **d3-force 移到 Web Worker** | 🔴 高 | 中 | ⭐⭐⭐ 释放主线程，缩放流畅 | ✅ 已完成（≥1000 节点自适应） |
| **P1** | **添加 camera inertia** | 🟡 中 | 少 | ⭐⭐⭐ 缩放拖拽丝滑 | ✅ 已完成（velocity 缩放 + 平移惯性） |
| **P1** | **nodeReducer 添加过渡动画** | 🟢 低 | 少 | ⭐⭐⭐ hover/选中从"生硬"变"自然" | ✅ 已完成（smoothstep + 节点/边同步） |
| **P1** | **标签阈值渐变淡出** | 🟡 中 | 中 | ⭐⭐ 缩放体验提升 | ✅ 已完成（itemSizesReference + threshold） |
| **P1** | **碰撞检测改用边界距离** | 🟡 中 | 中 | ⭐⭐ 碰撞更自然 | ✅ 已完成（比例 padding + 3 次迭代） |
| **P2** | **节点搜索** | 🟡 中 | 中 | ⭐⭐⭐ 定位节点 | ✅ 已完成（Ctrl/Cmd+F） |
| **P2** | **数据内存缓存** | 🟢 低 | 少 | ⭐⭐ 切页面不重 fetch | ✅ 已完成（SWR） |
| **P2** | **右键菜单（星标/隐藏）** | 🟡 中 | 中 | ⭐⭐ 节点级操作 | ⏸️ 延后（详见 11.5） |
| **P2** | **局部图（文档驱动 + kb Tab + 分屏）** | 🟡 中 | 中 | ⭐⭐⭐ 邻居级数控制 | 🔄 方向修正（2026-07-22）：改为对齐 Obsidian，文档驱动、kb 页 Tab、分屏前置，另起分支重做（见 `docs/2026-07-22-local-graph-redesign.md`） |
| **P2** | **Multi-Level 布局** | 🔴 高 | 多 | ⭐⭐⭐ 布局质量飞跃 | ✅ 已完成（初次实现，详见 `feat/multi-level-layout`） |

### "2 行代码"的改动细节

`useSimulation.ts:113-114` 改向心力：

```typescript
// 当前（圆周回弹 — 布局被初始位置牵制）：
.force('x', forceX<D3Node>((d) => (d.fx != null ? d.fx : d.initX)).strength(0.004))
.force('y', forceY<D3Node>((d) => (d.fy != null ? d.fy : d.initY)).strength(0.004))

// 改为（全局向心 — 所有节点拉向原点，更接近 CoSE 的 gravity）：
.force('x', forceX<D3Node>((d) => (d.fx != null ? d.fx : 0)).strength(0.004))
.force('y', forceY<D3Node>((d) => (d.fy != null ? d.fy : 0)).strength(0.004))
```

这样节点不再被初始圆周位置牵制，而是自然向中心收敛——外围节点均匀散开，中心枢纽汇聚，布局立刻更像 Obsidian。

---

## 十、总结

```
Molio 图谱当前状态（2026-07-22 修订）：
  ✅ Minimap（独有）
  ✅ 死链接可视化（独有）
  ✅ 类型着色（独有）
  ✅ 双击导航到文件（独有）
  ✅ 取消选中清 fx/fy（独有）
  ✅ 全局图基础功能（focus/hover/click/drag）
  ✅ 力参数实时调节
  ✅ 暗色/浅色主题
  ✅ 设置面板 4 Tab（筛选/外观/力度/图例）

  ✅ 布局均匀度（圆周向心力 → 全局重力，本轮已改）
  ✅ 缩放流畅度（velocity 缩放 + 平移惯性 + 自适应 Worker，本轮已改）
  ✅ 过渡动画（hover/选中 smoothstep + 节点/边同步淡入淡出，本轮已改）
  ✅ 标签缩放渐隐（itemSizesReference + threshold，本轮已改）
  ✅ 碰撞检测（比例 padding + 多次迭代，本轮已改）
  ✅ 节点搜索（Ctrl/Cmd+F 浮层 + zoomToNode，2026-07-22 修复归一化坐标系 bug + 视口内只高亮不飞）
  ✅ Minimap（2026-07-22 正式挂载启用、修复视口框坐标系混淆）
  ✅ 数据缓存（SWR，进页面不重 fetch，本轮已改）

  ✅ Multi-Level 布局（Walshaw 粗化，初步实现）
  ⏸️ 右键菜单（星标/隐藏节点）— 延后（优先级不高，设计稿见 11.5）
  ❌ 独立局部图面板 + 邻居级数控制
  ⚠️ 实时性：图谱页停留期间无文件级实时更新（多 Tab 场景待解，见十一）

  与 Obsidian 的核心差距已从"算法本体"收窄到"实时性 +
  ML 参数调优"。本轮填补了最大的算法差距。
```

---

## 十一、当前实现状态与实时性缺口（2026-07-20）

### 11.1 本轮重构已落地（对照基线结论的修正）

| 基线结论（第八节） | 当前状态 |
|---|---|
| 缩放流畅度 55%（主线程物理 + 无 inertia） | ✅ velocity 累积模型 + 平移惯性 + 自适应 Worker（≥1000 节点），流畅度接近 Obsidian |
| 过渡动画 15%（即时切换） | ✅ hover/选中 smoothstep 动画，节点+边同步淡入淡出 |
| 字体信息密度 40%（硬阈值） | ✅ `itemSizesReference: 'positions'` + `labelRenderedSizeThreshold`，全景隐藏标签，放大渐显 |
| 碰撞检测 55%（固定 radius+中心） | ✅ 比例 padding（`radius×0.35`）+ 3 次迭代，主线程/Worker 一致 |
| 节点搜索 15% | ✅ Ctrl/Cmd+F 浮层 + label/path 过滤 + `camera.animate` 飞行定位 |
| 增量更新 10% | ⚠️ 模块级数据缓存（SWR），进页面静默刷新，非文件级实时监听 |

布局均匀度（75%）✅ Walshaw multi-level 已实现（`feat/multi-level-layout` 分支），随机匹配粗化 + 粗化图布局 + 反投微调，力参数与主线程保持一致，ML 完成后切回主线程模拟保证拖拽流畅。仍在参数调优中。

**Obsidian 布局对齐（2026-07-23，对照 Obsidian 截图补的两处结构性差距）：**

1. **度→半径梯度**：Obsidian 把高连接度节点放在中心、低连接度推向外围，Molio 之前所有连接节点挤成一团、连线糊成"毛线团"。根因是 `forceManyBody.distanceMax(250)` 截断了远距排斥——低度节点被推出 250 后就失去中心累积推力、被向心力拉回，度梯度无法延伸到外围。**移除全部 `distanceMax`**（d3-force 仍走 Barnes-Hut，O(n log n)，无性能退化），让径向度梯度自然涌现。

2. **孤立节点外围圆环（tile）**：Obsidian 的 CoSE 用 `tile` 把孤立节点平铺成规整的外围结构，Molio 之前孤立节点随机散布。新增 `tileIsolatedNodes()`：以连接节点质心为中心、在包围半径之外把 `degree=0` 节点按角度排成同心圆环，并用 `fx/fy` 固定，使其不被后续力模拟拉回中心；`savedPositions` 同步持久化 `fx/fy`，重建后恢复圆环；拖拽/取消选中孤立节点时保持固定，防止交互破坏圆环。圆环一旦建立，Sigma 的 `autoRescale` 把整图 fit 进视口，中心簇在画面中占比缩小，进一步缓解差异 1 的"糊"感。

   配套：碰撞 padding `0.35→0.5`（相邻节点留约一个半径空隙）、ML 精化 `refineTicks 80→250`（80 tick 在 `alphaDecay 0.03` 下未收敛）、ML 后切回的主线程模拟立即 `stop()` 避免连接节点重跑抖动。

### 11.2 数据缓存策略（P2.2）

`GraphPage.tsx` 模块级缓存 `graphDataCache: Map<vaultId, { data, ts }>`，进程内有效：

- **进入图谱页** → 先秒显缓存数据（`useState` 懒初始化从缓存读），同时后台 `api.getGraph` 静默拉新，成功覆盖缓存
- **后台失败但有缓存** → 保留 stale 数据、不报错（用户无感）；无缓存才报错
- **vault 404** → 清缓存 + 切 vault
- **切出/切回** → 组件重新挂载触发 SWR，无 loading 闪烁

### 11.3 已知缺口：多 Tab / 实时性（需后续解决）

**问题**：当前缓存只在「进入图谱页」时后台刷新。图谱页**停留期间**，知识库内容若发生变化（其他窗口/Tab 编辑文档、新建文件、wikilink 变更），图谱不会自动更新。

**当前为何可接受**：Molio 是单页应用，用户要改知识库必先离开 `/graph` 去操作，回来时 SWR 已覆盖。单窗口下「进入页面即刷新」等价于实时。

**为何需要解决**：**后续规划会把图谱作为独立 Tab 与文档 Tab 并列显示**（不再是独占路由）。届时用户在文档 Tab 编辑、图谱 Tab 同屏可见——单窗口 SWR 模型失效，需要真正的实时推送：

- 候选方案：daemon 在文档/wiki 变更时发 SSE `graph-changed` 事件，图谱 Tab 监听后增量或全量刷新缓存
- 前置依赖：daemon 需要文件监听 + 事件总线（当前 `RunManager` SSE 是 run 级，非 graph 级）
- 与局部图（P2.4）的关系（2026-07-22 修正）：原计划局部图挂在图谱页、与 Tab 化耦合、实时性为其前置。**方向已修正**：局部图改为文档驱动 + kb Tab（对齐 Obsidian），**不依赖实时通道**。实时通道现在仅是「图谱 Tab 化」的前置，与局部图解耦。重做方案见 `docs/2026-07-22-local-graph-redesign.md`

**记录待办**：在图谱 Tab 化推进时，必须同步实现 graph-level 实时更新通道，否则多 Tab 并列会出现「图谱显示陈旧数据」的体验问题。局部图（P2.4，文档驱动）本身不依赖此通道。

### 11.4 渲染细化：hover/选中视觉（2026-07-20）

对照 Obsidian 校准 hover/选中态的视觉强度与分层，修复三个体验问题：

**① 淡化强度收敛**（`nodeReducer` + `types.ts`）

基线问题：选中/hover 时非关联节点尺寸收缩到 15%（`1 - dimT×0.85`）、颜色全褪到 `dimmed: #F0F0F0`（在浅色背景 `#FAFAFA` 上几乎不可见）。Obsidian 是「降饱和灰但保持可读」。

- `dimmed` 改为可见中灰：浅色 `#C8C8C8`、暗色 `#3A3F4D`
- 尺寸收缩：选中 `0.85→0.4`（保留 60%）、hover `0.4→0.25`（保留 75%）
- hover 颜色不褪到底（`hoverT×0.6`），hover 意图比选中更轻
- 非关联边向**背景色**褪色（深度 0.85，留淡痕），避免中灰 `dimmed` 让淡化边反而更醒目

**② 高亮边 z-index 分层**（`edgeReducer` + Sigma `zIndex: true`）

基线问题：选中节点的关联边虽高亮，但被后添加的淡化边遮挡——Sigma v3 默认按图中边添加顺序绘制，`edgeReducer` 只改外观不改绘制顺序。

- 开启 `settings.zIndex: true`（Sigma v3 支持 edge `zIndex` 排序，需显式开启）
- 关联边 `zIndex: 1`、非关联边 `zIndex: 0`，高亮边绘制在顶层
- 节点未设 zIndex（全 0），不触发节点重排，无副作用

**③ hover/选中互斥**（`enterNode`/`leaveNode` 守卫）

基线问题：选中节点后移到其他节点仍触发 hover 切换，hover 高亮与点击聚焦并存抢占。

- `enterNode`/`leaveNode` 开头加 `if (selectedNodeRef.current) return;`
- 选中期间 `hoveredNodeRef` 始终为 null，reducer 的 `focusNode = hovered ?? selected` 稳定走 selected 分支
- 点空白取消选中后，hover 自动恢复

### 11.5 P2.3 右键菜单：延后决策与设计稿（2026-07-21）

**决策**：P2.3 右键菜单**延后**。用户判断优先级不高（节点级操作非急需），当前聚焦实时性前置 + 布局本体。但设计稿留存，后续捡起不用重设计。

**菜单设计**（基于节点属性 `key/label/path/linkCount/nodeType/deadLink` + 已有交互复用 `kb/ContextMenu.tsx`）：

分 MVP / 进阶两档：

- 🟢 **MVP**（纯前端、复用 `ContextMenu`、星标/隐藏用模块级 `Map<vaultId, Set<nodeKey>>`，跨 rebuild 保留、跨会话丢失）：

  | 分组 | 项 | 实现 |
  |---|---|---|
  | 导航 | 打开文件 | 复用双击逻辑跳 `/knowledge?openFile=path` |
  | 导航 | 复制路径 / 复制 wikilink `[[label]]` | `navigator.clipboard` |
  | 聚焦 | 聚焦此节点 | 复用 `selectedNodeRef` |
  | 聚焦 | 隐藏此节点 / 隐藏同类型 | `graph.setNodeAttribute(key,'hidden',true)` + 模块级 Set 记录，rebuild 后重新 apply |
  | 星标 | 星标/取消星标 | nodeReducer 加 pinned 分支：forceLabel:true + 强调色 |
  | 信息 | 节点信息 | 浮层显示 label/path/linkCount/nodeType/deadLink |

  死链节点（无 `path`）菜单收敛为「查找同名文件」「新建文件 `targetName`」。

- 🟡 **进阶**（留到后续）：
  - 隔离（只看此节点+邻居）、显示局部图（打开该节点对应文档的 kb 局部图 Tab，方向见 `docs/2026-07-22-local-graph-redesign.md`）、星标/隐藏持久化（localStorage per vault）、重命名文件（需 daemon 改名+重写 wikilink，危险操作）

**关键实现点**：
- 星标/隐藏状态存哪：模块级 `Map<vaultId, Set<nodeKey>>`（推荐 MVP），和 `graphDataCache` 一套模式；持久化留进阶
- 死链节点 key 形如 `__dead__xxx`，无 path，菜单按 `deadLink` flag 分支
- 复用 `kb/ContextMenu.tsx` 的 `MenuItem` 接口（label/divider/onClick/danger/disabled/title）+ 边缘检测/Esc/点击外部关闭，触发源从文件树换成画布 `contextmenu` 事件

### 11.6 P2.1 节点搜索相机修复 + P2.4 Minimap 启用（2026-07-22）

本会话完成：

**① 节点搜索 zoomToNode 归一化坐标系 bug 修复（搜索→空白卡死）**

根因：Sigma 相机工作在归一化（framed）坐标空间（归一化到以 0.5 为中心、跨度约 1 的区间），而 zoomToNode 把节点原始图坐标 attrs.x/y 直接喂给 camera.animate，相机飞到 extent×ratio（约 38 万）远处 → 视图空白、交互失效。

修复：`sigma.viewportToFramedGraph(sigma.graphToViewport({x,y}))` 先把原始图坐标转成归一化坐标再喂相机。Playwright 实测验证：坏时节点映射到屏幕外（-82879,-39307）、inView=0；修后映射到视口中心（672,426）。

**② 节点搜索：视口内只高亮不飞相机**

之前搜索总是 camera.animate 飞相机（拉远到 ratio 2.5），即使节点已在视口内也晃动视角。改为先判断节点是否在「舒适可视区」（视口内缩 8%∋）：在其中则只高亮不动相机；在视口外/贴边才飞。

**③ Minimap 正式挂载启用**

Minimap.tsx 此前是未挂载的死代码（main 起就未在 GraphPage 渲染，也无样式）。本次：
- 修复视口框坐标系混淆（同 zoomToNode 根因）：原算法混用归一化 camera.x 与原始图坐标，改用 viewportToGraph 求四角可视区域
- 新增 `.graph-minimap` 样式（右下角悬浮，pointer-events:none 不挡交互）
- 通过 sigmaInstance state 挂载到 GraphPage（sigma 在 effect 创建，ref 不触发重渲染）

**E2E 覆盖**：
- `graph-search.spec.ts`（2 用例）：搜索后节点在视口内 + 视口内搜索不动相机
- `graph-minimap.spec.ts`（1 用例）：挂载可见 + 默认看全图视口框盖满 minimap
- 全部 10/10 graph E2E 通过

**受影响文件**：GraphPage.tsx（zoomToNode 修复 + 优化 + __sigma 暴露）、Minimap.tsx（坐标修复）、graph.css（minimap 样式）、graph-search.spec.ts（新增）、graph-minimap.spec.ts（新增）

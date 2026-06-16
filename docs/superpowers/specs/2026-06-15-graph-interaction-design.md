# Molio 知识图谱交互与渲染改造方案

> 日期：2026-06-15
> 
> 状态：**已完成一期、二期开发，三期待定**
> 
> 相关文档：[Molio vs Obsidian 知识库全面对比](../obsidian-comparison.md)、[知识图谱深度对比](../obsidian-comparison-graph.md)
> 
> **更新记录：**
>
> - 2026-06-16：完成第一期（引擎替换 + 拖拽改造）和第二期（节点着色 + 死链接 + 局部图）开发
> - 布局优化标记为待优化项（d3-force 参数需进一步调优以改善线条交叉）

---

## 一、目标

改造 Molio 知识图谱的交互与渲染体验，解决当前两个核心问题：

1. **布局"死"了** — ForceAtlas2 跑 300 次迭代就停止，拖拽节点时周围无响应，无碰撞效果
2. **功能缺口** — 无节点类型着色、死链接不可见、无局部图、无深色主题、无过渡动画

目标效果：交互流畅度达 Obsidian 的 80%，功能完整度从当前 55% 提升到 80%。

不自研引擎。在 Sigma.js 框架下替换布局引擎（ForceAtlas2 → d3-force），实现持续物理仿真 + 碰撞检测 + 局部图等功能。

---

## 二、架构变化

### 当前架构

```
用户事件 (DOM) → 设置 fx/fy → sigma.refresh() → WebGL 渲染
                                           ↑
                                 ForceAtlas2 (已停止)
```

### 目标架构

```
用户事件 (DOM) → 更新 d3 节点属性 → simulation.alpha(0.3).restart()
                                    ↓
              d3-force 持续循环 (tick 事件)
              ├ 弹簧力 (link) → 沿边拉近
              ├ 排斥力 (charge) → 所有节点互斥
              ├ 碰撞约束 (collide) → 节点不重叠
              └ 向心力 (center) → 保持紧凑
                                    ↓
              tick 回调 → 写入 graphology → sigma.refresh()
```

### 变化对照

| 维度 | 当前 | 目标 |
|------|------|------|
| **布局引擎** | ForceAtlas2（一次性计算） | d3-force（持续仿真） |
| **力模型** | 弹簧力 + 排斥力 | 弹簧力 + 排斥力 + **碰撞约束** + 向心力 |
| **拖拽行为** | 单独设 fx/fy，邻居不动 | 唤醒引擎，力自动传导到邻居 |
| **生命周期** | 初始化跑 300 次 → 结束 | 初始化收敛 → 交互时 `.restart()` → 重新收敛 |
| **碰撞效果** | 无 | `forceCollide()` 运行时始终生效 |
| **渲染层** | Sigma.js WebGL | **不变** |

---

## 三、分步实施

### 第一期：引擎焕新（核心改造）

**目标**：替换布局引擎，实现持续物理仿真 + 碰撞效果，让图谱"活"起来。

#### 3.1 新增 useSimulation hook

新建 `apps/web/src/components/graph/useSimulation.ts`，封装 d3-force 物理引擎。

**核心职责**：
- 将 graphology 的 nodes/edges 映射为 d3 的内部数据格式
- 创建 `forceSimulation` 实例，配置 4 个力：
  - `forceLink` — 弹簧力（边两端互相吸引），`distance: 120`, `strength: 0.3`
  - `forceManyBody` — 库仑斥力（所有节点互斥），`strength: -100`, `distanceMax: 500`
  - `forceCollide` — 碰撞检测（节点不重叠），`radius: node.radius + 6`
  - `forceCenter` — 向心力（防止飞散），`strength: 0.05`
- 监听 `tick` 事件，将 d3 计算的坐标写回 graphology
- 对外暴露 `simulation` 引用，供拖拽交互调用 `.alpha().restart()`

**参数调优关键**：
- `alphaDecay: 0.02` — 缓慢衰减，引擎"活"得足够久
- `velocityDecay: 0.3` — 阻尼适中，收敛时自然平滑

#### 3.2 改造拖拽交互

**当前行为**（`GraphPage.tsx` 中 `handleMouseDown/Move/Up`）：
- mousedown → 记录 draggedNode
- mousemove → 设置 fx/fy，`renderer.refresh()`
- mouseup → 保持 fx/fy 锁定

**改造后行为**：
- mousedown → 记录 draggedNode，设 d3 node 的 `fx/fy` 为当前位置
- mousemove → 更新 d3 node 的 `fx/fy`，调用 `simulation.alpha(0.5).restart()` 唤醒引擎
  - 引擎被唤醒 → 下一帧 tick 计算所有节点位置
  - 被拖节点的力通过弹簧传导到邻居 → 邻居被拉动
  - 碰撞约束防止节点重叠 → 推开效果
- mouseup → 清除 d3 node 的 `fx/fy`（设为 null），调用 `simulation.alpha(0.1).restart()` 让节点自然回弹收敛

**代码变更**：约 30 行改写，集中在 `GraphPage.tsx` 的鼠标事件处理函数。

#### 3.3 文件变更清单（第一期）

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/web/package.json` | 修改 | 移除 `graphology-layout-forceatlas2`，新增 `d3-force` |
| `apps/web/src/components/graph/useSimulation.ts` | **新增** | 物理引擎 hook |
| `apps/web/src/components/graph/GraphPage.tsx` | 修改 | 替换 forceAtlas2 初始化约 30 行、改造拖拽逻辑约 30 行 |
| `apps/web/src/components/graph/Minimap.tsx` | 不改 | 兼容（读 graph 坐标方式不变） |

#### 3.4 交付标准

- 拖拽一个节点，周围节点联动拉开，有碰撞推开效果
- 释放节点后，周围节点在阻尼作用下自然收敛
- 初始布局均匀散开，节点不重叠
- 5000 节点以内保持 60fps

---

### 第二期：功能补齐

**目标**：启用节点类型着色 + 死链接可视化 + 局部图，让图谱"有用"。

#### 4.1 后端数据增强

修改 `apps/daemon/src/routes/graph.ts` 中 `buildGraph()`：

**新增返回字段**：
- `nodeType` — 从 frontmatter 或目录路径推断节点类型
- `deadLinks` — 死链接列表（`{ sourceFile, targetName }[]`）

**nodeType 推导规则**：
1. 优先读文件 frontmatter 的 `type` 字段
2. 回退到目录推断：`wiki/sources/` → `source`，`wiki/entities/` → `entity`，`wiki/concepts/` → `concept`，`wiki/comparisons/` → `comparison`，`wiki/questions/` → `question`，`wiki/` → `wiki`
3. 默认 `document`

**deadLinks**：`buildGraph()` 内部已有 `deadLinks` Set，当前只记录不返回。改造为收集完整信息返回前端。

#### 4.2 前端节点着色

启用 `NODE_TYPE_COLORS` 映射（已在 `GraphPage.tsx` 中定义但未启用）：

```typescript
const NODE_TYPE_COLORS = {
  document:   '#94A3B8',  // 灰蓝
  source:     '#3B82F6',  // 蓝
  entity:     '#22C55E',  // 绿
  concept:    '#8B5CF6',  // 紫
  comparison: '#F59E0B',  // 橙
  question:   '#EF4444',  // 红
  wiki:       '#6B7280',  // 灰
};
```

死链接节点用半透明 + 虚线描边渲染，和正常节点明显区分。

#### 4.3 局部图（Local Graph）

**实现方式**：利用现有的 `nodeReducer` + `edgeReducer`，在选中节点时，将非关联节点的透明度降至接近透明（`opacity: 0.05`），但保留 1 像素极淡显示维持布局感知。

**行为**：
- 单击选中节点 → 削弱非关联节点（当前已做，只是效果不够彻底）
- 取消选中 → 恢复全量显示
- 后续可加 UI 开关进入"局部模式"，第一期不做

#### 4.4 文件变更清单（第二期）

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/daemon/src/routes/graph.ts` | 修改 | 新增 nodeType 推导 + deadLinks 返回 |
| `packages/contracts/src/knowledge.ts` | 修改 | GraphNode 增加 nodeType/deadLink 字段 |
| `apps/web/src/api/client.ts` | 不改 | getGraph 自动接收新字段 |
| `apps/web/src/components/graph/GraphPage.tsx` | 修改 | 启用类型颜色 + deadLink 渲染 + 局部图 reducer |

---

### 第三期：视觉打磨

**目标**：深色主题 + 过渡动画 + 搜索筛选，提升"质感"。

#### 5.1 深色主题

定义深色/浅色两套配色常量，跟随系统主题切换：

```typescript
const themes = {
  light: {
    bg: '#FAFAFA',  node: '#5C5C5C',  isolated: '#999999',
    hover: '#333333', selected: '#8B5CF6',
    edge: '#D4D4D4', edgeHover: '#C4B5FD', edgeSel: '#8B5CF6',
  },
  dark: {
    bg: '#0F1117',  node: '#9CA3AF',  isolated: '#4A5360',
    hover: '#D1D5DB', selected: '#8B5CF6',
    edge: 'rgba(255,255,255,0.08)', edgeHover: 'rgba(139,92,246,0.6)', edgeSel: '#8B5CF6',
  },
};
```

在 `GraphPage.tsx` 中读取当前主题（通过 props 或 CSS 变量检测），Sigma 实例化时使用对应配色。主题切换时销毁并重建 Sigma 实例。

#### 5.2 过渡动画

当前所有状态切换（hover/选中/淡化）都是瞬时的。改造为 `requestAnimationFrame` 驱动的缓动插值。

**实现方式**：在 `nodeReducer` 中读取渐变动画状态。使用 `animateValue(from, to, 200ms, easeOutCubic)` 工具函数，在 tick 循环中更新节点透明度/颜色，驱动平滑过渡。

**不做**：弹性动画、物理过渡。这些对"丝滑感"提升有限且实现复杂。

#### 5.3 节点搜索与筛选

- **搜索**：顶部搜索框输入 → `graph.forEachNode` 匹配 key → 定位并高亮匹配节点
- **筛选**：按 nodeType 切换显示/隐藏（checkbox 列表），利用 Sigma 的 `nodeReducer` 控制显隐

#### 5.4 文件变更清单（第三期）

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/web/src/components/graph/GraphPage.tsx` | 修改 | 新增深色主题逻辑、搜索 UI、动画插值 |
| `apps/web/src/components/graph/types.ts` | **新增** | 主题类型定义 |
| `apps/web/src/styles/graph.css` | 修改 | 深色主题 CSS 变量、搜索框样式 |

---

## 四、不做事项（YAGNI）

| 功能 | 理由 |
|------|------|
| Web Worker 布局计算 | 万节点以下 d3-force 主线程足够，加 Worker 增加复杂度；超过 8000 节点时再考虑 |
| ForceAtlas2 保留选项 | 用户不会切换布局算法，且 d3-force 效果已覆盖 |
| 边权重可视化 | 当前无权重数据，Obsidian 也不支持 |
| 时间维度滑块 | 需要知识库版本历史支持，当前无此能力 |
| 社区聚类光晕 | 渲染复杂度高，对知识图谱这种规模（<1 万节点）帮助不大 |
| 自研 Canvas 2D 引擎 | 成本过高（15-20 天），Sigma.js WebGL 在交互改造后足够满足需求 |

---

## 五、依赖变更

### 新增依赖

```
d3-force                    ~15KB gzip   布局引擎
@types/d3-force  (devDep)                TypeScript 类型
```

### 移除依赖

```
graphology-layout-forceatlas2            由 d3-force 替代
```

---

## 六、测试策略

| 测试类型 | 覆盖范围 | 方法 |
|----------|----------|------|
| **手动测试** | 各种大小的图拖拽碰撞效果 | 手动拖拽、缩放、双击导航 |
| **回归验证** | hover/选中/双击导航不受影响 | 逐项验证当前交互全部正常 |
| **边界情况** | 空 vault、单节点、只有孤立节点 | 分别验证图谱渲染和交互 |
| **性能验证** | 5000 节点的帧率 | Chrome DevTools Performance 面板 |

---

## 七、实施进度

| 分期 | 内容 | 工时预估 | 实际进度 |
|------|------|----------|----------|
| **第一期** | d3-force 引擎替换 + 拖拽改造 + 碰撞效果 | 7-10 天 | ✅ **已完成** (11 commits) |
| **第二期** | 节点类型着色 + 死链接 + 局部图 | 5-6 天 | ✅ **已完成** (3 commits) |
| **第三期** | 深色主题 + 过渡动画 + 搜索筛选 | 2-3 天 | ⏳ 待定 |

### 已上线功能

- ForceAtlas2 → d3-force 引擎替换，持续物理仿真
- 拖拽节点时邻居联动 + 碰撞推开效果
- 节点按类型着色（source/entity/concept/comparison/question/document）
- 死链接可视化（灰色小点 + 统计计数）
- 局部图模式（选中节点后非关联节点大幅淡出）
- 交互提示条（拖拽/单击/双击操作说明）

### 待优化项

- 布局线条交叉较多 — d3-force 参数需进一步调优

---

## 附录：关键代码参考

### A. d3-force 初始化解构对比 ForceAtlas2

```typescript
// 当前：ForceAtlas2 — 一次性
forceAtlas2.assign(graph, {
  iterations: 300,
  settings: {
    linLogMode: true,
    outboundAttractionDistribution: true,
    barnesHutOptimize: true,
    barnesHutTheta: 0.5,
    edgeWeightInfluence: 0,
    scalingRatio: 8,
    strongGravityMode: false,
    gravity: 0.5,
    slowDown: 1 + Math.log(1 + graph.order),
  },
});

// 目标：d3-force — 持续
const simulation = forceSimulation(nodes)
  .force('link', forceLink(edges).id(d => d.id).distance(120).strength(0.3))
  .force('charge', forceManyBody().strength(-100).distanceMax(500))
  .force('collide', forceCollide().radius(d => d.radius + 6))
  .force('center', forceCenter().strength(0.05))
  .alphaDecay(0.02)
  .velocityDecay(0.3)
  .on('tick', syncToGraphology);
```

### B. 拖拽交互核心变化

```typescript
// 当前 — mousemove:
graph.setNodeAttribute(node, 'fx', x);
graph.setNodeAttribute(node, 'fy', y);
renderer.refresh();

// 目标 — mousemove:
d3Node.fx = x;
d3Node.fy = y;
simulation.alpha(0.5).restart();
// 引擎在下一帧 tick 中自动计算所有节点的位置
// 碰撞约束自动防止重叠
```

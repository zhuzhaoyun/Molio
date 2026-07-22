# Multi-Level 图谱布局设计

> **实现对象**: Molio 知识图谱 (`apps/web/src/components/graph/`)
> **当前算法**: d3-force 单层力导向（主线程 <1000 / Web Worker ≥1000 自适应）
> **目标算法**: Walshaw 聚类粗化 Multi-Level 布局
> **日期**: 2026-07-22

---

## 一、动机

### 1.1 当前问题

d3-force 单层力导向的三个核心缺陷：

1. **簇混合**：不同概念簇之间没有天然的分割机制，排斥力在全局范围统一作用，导致大图上"一锅粥"。
2. **长距离力噪声**：`forceManyBody` 即使有 `distanceMax(250)` 限制，中等图上仍有大量无效计算贡献给局部最优而非全局结构。
3. **局部最优**：力导向是贪心的——每次按当前受力最小步长移动，节点卡在"还行"的位置就不动了。CoSE 的 multi-level 能 dramatic reduce edge crossings。

### 1.2 方案讨论：为什么不走「聚类感知力导向」

另一个思路是在现有 d3-force 上加两层社区力（方案 B）：

1. 用 Louvain 算法跑社区检测（现成库，~5 行）
2. 同一社区节点 → 额外弱引力（社区向心力）
3. 不同社区节点 → 额外弱斥力（社区间排斥）

**优点**：~100 行改动，快速出效果。不出几个月就能体验。

**不推荐理由**：
- 没有三阶段 coarse→layout→refine 的全局最优。社区力仍然在单层贪心框架内优化，大图下簇分离提升有限。
- Obsidian 的 CoSE 引擎走的是 Full Walshaw，这是经过工业验证的路线。
- 做了 B 最终还是要做 A —— 不走弯路。

**结论**：直接 Full Walshaw，不走方案 B。

### 1.3 预期效果

| 指标 | 当前 | 目标 |
|------|------|------|
| 簇分离度 | 粘连/混合 | 清晰分离 |
| 边交叉数 | 高 | 显著减少 |
| 节点分布均匀度 | 局部扎堆 | 全局均匀 |
| 初始布局质量 | 圆周→局部最优 | 近全局最优 |

---

## 二、算法总览

三阶段管道，完全在 Web Worker 中执行：

```
输入: 原始图 G₀ (N 节点, E 边)
  │
  ▼
┌─────────────────────────────────────┐
│ 阶段 1: 图粗化 (Coarsening)         │
│                                      │
│  G₀ → 随机匹配 → G₁ → 随机匹配 → G₂  │
│  → ... → Gₖ (k=3~5, |Gₖ| ≈ 5%|G₀|) │
│                                      │
│  合并紧密关联的节点为超节点           │
│  超节点间加权边保留簇间连接           │
│  同超节点内部边丢弃                   │
└──────────────────┬──────────────────┘
                   ▼
┌─────────────────────────────────────┐
│ 阶段 2: 粗化图布局                   │
│                                      │
│  在 Gₖ (最粗层) 上跑 d3-force        │
│  alphaDecay 慢 (0.02), 充分收敛      │
│  弱向心力, 簇自然分离                │
└──────────────────┬──────────────────┘
                   ▼
┌─────────────────────────────────────┐
│ 阶段 3: 反投 + 微调 (Refinement)    │
│                                      │
│  从 Gₖ→Gₖ₋₁→...→G₀                 │
│  每层: 超节点位置 → 子节点 (小扰动)  │
│  G₀ 层: 短程 d3-force (50 tick)     │
│         弱排斥 + 碰撞, 仅排开簇内    │
└──────────────────┬──────────────────┘
                   ▼
输出: 所有节点的最终 x/y 坐标
```

---

## 三、第一阶段：Walshaw 粗化

### 3.1 随机匹配算法

```
function coarsen(Gₖ₋₁) → Gₖ:
  nodes = 随机排列 Gₖ₋₁ 所有节点
  matched = Set()
  superNodeId = 0

  for each v in nodes:
    if v ∈ matched: continue
    u = v 的第一个度未匹配邻居（遍历 neighbors 按 degree 排序）
    if u exists:
      # 创建超节点
      Gₖ.addNode(superNodeId, {
        members: [...v.members, ...u.members],  // 原始节点列表
        radius: sqrt(v.radius² + u.radius²),
        degree: v.degree + u.degree,
      })
      matched.add(v); matched.add(u)
    else:
      # 单例超节点（孤立节点保留）
      Gₖ.addNode(superNodeId, { members: v.members, radius: v.radius, degree: v.degree })
      matched.add(v)
    superNodeId++

  # 合并边：建逆向表 memberId → superNodeId
  superMap = Map<originalNodeId, superNodeId>
  for each edge (a, b) in Gₖ₋₁.edges:
    sa = superMap.get(a); sb = superMap.get(b)
    if sa == sb: continue  # 簇内边丢弃
    edgeKey = composeKey(sa, sb)
    Gₖ.addOrUpdateEdge(sa, sb): weight++

  return Gₖ
```

### 3.2 粗化轮次控制

```
k = 0
while |Gₖ| > |G₀| × 0.05 and k < 5:
  k++
  Gₖ = coarsen(Gₖ₋₁)
levels = [G₀, G₁, ..., Gₖ]
```

**终止条件**（任一满足即停）：
- 图缩小到原始 5% 以下
- 达到 5 轮（再粗化收益递减）
- 图已小于 30 个超节点（最粗层足够小）

### 3.3 超节点数据

```typescript
interface CoarseNode {
  id: number;
  members: string[];       // 原始图节点 ID 列表
  radius: number;          // 合并半径 √(Σrᵢ²)
  edgeWeightSum: number;   // 所有边权重和（用于后续布局）
}

interface CoarseEdge {
  source: number;
  target: number;
  weight: number;          // 多重边合并权重
}
```

### 3.4 跳过条件

- 节点数 < 50：跳过粗化，直接跑单层 d3-force
- 图已几乎完全孤立（边数 < 节点数 20%）：跳过粗化，单层处理

---

## 四、第二阶段：粗化图布局

### 4.1 布局配置

在最粗层 Gₖ 上运行 d3-force，参数调硬：

```typescript
const coarseLayout = (coarseNodes, coarseEdges, params) => {
  return forceSimulation(coarseNodes)
    .force('link', forceLink(coarseEdges)
      .id(d => d.id)
      .distance(params.linkDistance * 2)   // 超节点间距放大
      .strength(d => params.linkStrength * d.weight / maxWeight))  // 加权
    .force('charge', forceManyBody()
      .strength(params.repelStrength * 3)  // 增强排斥，簇分离更远
      .distanceMax(1000))                   // 粗化图范围大，扩大
    .force('collide', forceCollide()
      .radius(d => d.radius * 1.35)
      .iterations(3))
    .force('x', forceX(() => 0).strength(0.0005))   // 极弱向心
    .force('y', forceY(() => 0).strength(0.0005))
    .alphaDecay(0.015)     // 慢衰减，充分收敛
    .velocityDecay(0.4)
    .on('tick', sendCoarseTick)
}
```

### 4.2 收敛检测

```
alpha < 0.001  # d3-force 自带冷却
OR
tick > 1000    # 最大迭代兜底（CoSE 默认 2500，1000 足够因图小）
```

### 4.3 加权边处理

d3-force 的 `forceLink` 原生支持 strength 为函数：

```
// 边强度与权重成正比
linkStrength(edge => params.linkStrength * edge.weight / maxWeight)
```

这样高权重边（即原始图中紧密连接的两个簇）弹簧更强，在粗化图上确保它们自然拉近。

---

## 五、第三阶段：反投 + 微调

### 5.1 反投算法

```
for level = k-1 down to 0:
  for each originalNode in Gₗ:
    superId = superMapAtLevel[level + 1].get(originalNode.id)
    superPos = coarsePositions[level + 1].get(superId)
    // 微扰动，避免完全重叠
    originalNode.x = superPos.x + random(-scale, scale)
    originalNode.y = superPos.y + random(-scale, scale)
    scale = Math.max(2, radius * 0.5)
```

### 5.2 微调配置

只在原始层 G₀ 上做短程微调：

```typescript
const refineLayout = (nodes, edges, params) => {
  const sim = forceSimulation(nodes)
    .force('link', forceLink(edges)
      .id(d => d.id)
      .distance(params.linkDistance)
      .strength(params.linkStrength))
    .force('charge', forceManyBody()
      .strength(params.repelStrength * 0.3)   // 弱排斥
      .distanceMax(150))                        // 短程
    .force('collide', forceCollide()
      .radius(d => d.radius * 1.35)
      .iterations(3))
    .alphaDecay(0.1)    // 快速衰减
    .velocityDecay(0.5) // 高阻尼

  // 手动跑 N tick 然后停
  for (let i = 0; i < 80; i++) {
    sim.tick()
  }
  sim.stop()
  return nodes
}
```

**微调目标**：仅排开同一簇内的重叠节点，不改变簇间相对位置。弱排斥 + 碰撞 + 高阻尼确保簇结构不被破坏。

### 5.3 中间层是否需要精化？

不。中间层 G₁~Gₖ₋₁ 只做位置传递（反投），不单独跑布局——因为：
- 位置传递仅改变坐标比例（从粗节点位置插值到细节点）
- 在原始层一次性微调即可，中间层额外布局浪费时间

---

## 六、Web Worker 集成

### 6.1 消息协议扩展

新增到 `simulation.worker.ts`：

```
类型                      流向          数据
────────────────────────────────────────────────────────
multi-level-init         Main→Worker   { nodes, links, params, coarseningConfig }
multi-level-progress     Worker→Main   { phase: 'coarsen'|'coarse-layout'|'refine', progress: 0-1 }
coarse-tick              Worker→Main   { coarse: true, positions: Record<nodeId, {x,y}> }
multi-level-done         Worker→Main   { positions: Record<nodeId, {x,y}> }
```

### 6.2 Worker 内执行顺序

```
onmessage('multi-level-init'):
  1. coarsen()           → postMessage('multi-level-progress', phase:'coarsen', progress:0.3)
  2. coarseLayout()      → 每 tick postMessage('coarse-tick', ...)
                           postMessage('multi-level-progress', phase:'coarse-layout', progress:0.6)
  3. prolongate()        → (无消息，纯内部)
  4. refine()            → postMessage('multi-level-progress', phase:'refine', progress:0.9)
  5. postMessage('multi-level-done', positions)
```

### 6.3 主线程处理

```typescript
// useSimulation.ts
worker.onmessage = (e) => {
  const { type } = e.data;

  if (type === 'multi-level-progress') {
    // 可选：显示进度条
  }

  if (type === 'coarse-tick' && e.data.positions) {
    // 渐进式渲染粗化过程（让用户看到图在改善而非空白）
    const superPositions = e.data.positions;
    // 把超节点位置分发给所有 member 节点
    for (const [superId, pos] of superPositions) {
      for (const memberId of superMap.get(superId)) {
        if (graph.hasNode(memberId)) {
          graph.setNodeAttribute(memberId, 'x', pos.x);
          graph.setNodeAttribute(memberId, 'y', pos.y);
        }
      }
    }
  }

  if (type === 'multi-level-done') {
    // 一次性写入最终位置
    for (const [id, pos] of e.data.positions) {
      if (graph.hasNode(id)) {
        graph.setNodeAttribute(id, 'x', pos.x);
        graph.setNodeAttribute(id, 'y', pos.y);
      }
    }
    // 保存位置供后续 keep
    // 关闭 multi-level 状态标记
  }
};
```

### 6.4 平滑过渡选项（可选）

ML 完成后，从旧布局（粗轮廓）到新布局（细节位置）的跳变可以通过 Sigma camera 动画平滑过渡：

```typescript
if (type === 'multi-level-done') {
  const positions = e.data.positions;
  // 先行写入位置
  for (const [id, pos] of positions) {
    if (graph.hasNode(id)) {
      graph.setNodeAttribute(id, 'x', pos.x);
      graph.setNodeAttribute(id, 'y', pos.y);
    }
  }

  // 过渡动画：让 camera 从当前视角缩放/平移适应新布局
  // 计算新布局的 bbox，设置 camera 到合适比例
  const sigma = sigmaRef.current;
  if (sigma) {
    const camera = sigma.getCamera();
    // 短时动画，让用户感知布局已"定型"
    camera.animate({ ratio: camera.ratio * 1.05 }, { duration: 300 });
  }

  sigma?.refresh();
}
```

**启用条件**：默认关闭（视觉跳跃不大时不做），设置面板「布局过渡动画」开关用户可开启。

### 6.5 Worker 生命周期

```
  初始图加载
     │
     ├─ savedPositions 已存在 → 跳过 ML，常规 init
     └─ savedPositions 不存在
          │
          ├─ |G| < 50 → 常规 init（单层 d3-force 足够）
          └─ |G| ≥ 50 → multi-level-init
                          │
                          在现有 worker 线程内同步执行
                          （粗化和布局期间不响应其他消息）
                          │
                          done → postMessage → 切回常规 wake/drag
```

**粗化期间阻塞 drag**：合理的设计决策——用户通常不会在初始布局阶段拖拽节点。如果用户尝试拖拽，drag 消息排队等待 ML 完成后处理。

---

## 七、入口与触发逻辑

### 7.1 API 扩展

```typescript
// useSimulation.ts
export interface SimulationAPI {
  // 现有 (不变)
  init: (graph: Graph, sigma: Sigma, _onTick?: () => void) => void;
  wake: (alpha?: number) => void;
  stop: () => void;
  getNode: (id: string) => NodeHandle | undefined;
  setForceParam: (name: string, value: number) => void;
  // 新增
  multiLevel: (params?: MultiLevelParams) => void;  // 手动触发重新布局
}

interface MultiLevelParams {
  onProgress?: (phase: string, progress: number) => void;
}
```

### 7.2 触发条件

| 事件 | 是否走 ML | 原因 |
|------|-----------|------|
| 首次加载图（data 变化，graphData 新数据） | ✅ 走 ML | 没有历史位置，需要高质量初始布局 |
| 主题/节点大小变化重建 | ❌ 跳过 | `savedPositions` 已有，重建使用已有位置 |
| 设置面板「重新布局」按钮 | ✅ 走 ML | 用户主动要求重新布局 |
| vault 切换 | ⚠️ 新 vault 首次加载 | 取决于缓存数据是否存在 |

### 7.3 「重新布局」按钮

```tsx
// GraphSettingsPanel.tsx 新增 —— Forces Tab 底部
<button
  className="graph-re-layout-btn"
  onClick={() => simulation.multiLevel({ onProgress: setMLProgress })}
  disabled={mlRunning}
>
  {mlRunning ? `布局中 ${mlProgress}%` : '重新布局'}
</button>
```

---

## 八、文件变更清单

| 文件 | 变更 |
|------|------|
| `simulation.worker.ts` | 新增 coarsen()、coarseLayout()、refine() 函数 + multi-level-init 消息处理 |
| `useSimulation.ts` | 新增 multiLevel() API + multi-level 消息处理 + 渐进式粗tick渲染 |
| `types.ts` | 新增 MultiLevelParams 接口 |
| `GraphPage.tsx` | init 逻辑调整（auto ML on first load）+ savedPositions 判断跳过 ML |
| `GraphSettingsPanel.tsx` | Forces tab 底部新增「重新布局」按钮 + 进度显示 |
| `graph.css` | 重新布局按钮样式 |

### 新增文件

无。所有逻辑在现有文件中内聚。

---

## 九、性能预期

| 指标 | 预期 |
|------|------|
| 粗化阶段耗时 | N=1000: <5ms / N=5000: <30ms / N=10000: <100ms |
| 粗化图布局 tick 次 | 100~200 tick（最粗层超节点数 < 50）|
| 反投 + 微调耗时 | 每个节点 O(1) 反投 + 80 tick d3-force |
| 总 Worker 耗时 | N=1000: <200ms / N=5000: <800ms / N=10000: <2s |
| 主线程阻塞 | **零**（所有计算在 Worker）|

粗化是 O(N·deg) 的轻量操作（N=节点数, deg=平均度），不涉及矩阵运算，单次随机匹配只需遍历邻居列表。这才是比 spectral clustering 或 Louvain 更轻量的原因。

### 9.1 内存

Worker 内需保存每层的超节点表。每层大小减半，总内存 ≈ 2× G₀ 的数据（原始图 + 当前粗化层 + 粗化层布局中）。对于 N=10000 的图，约 < 5MB。

---

## 十、边界情况与错误处理

| 场景 | 处理 |
|------|------|
| 图 < 50 节点 | 跳过 ML，常规 init |
| 孤岛图（边数极少） | 跳过 ML，常规 init |
| 完全图（每对节点都有边） | ML 仍有效——粗化配对后仍有大量簇间边，但超节点布局会自然散开成均匀分布|
| 粗化时 Worker 抛异常 | catch → postMessage error → 主线程降级为常规 init |
| 用户拖拽 ML 运行中 | drag 消息排队，ML 完成后处理（postMessage 有顺序保证）|
| 用户切换 vault ML 运行中 | terminate Worker，旧计算丢弃，新 vault 从头开始 |

---

## 十一、测试计划

### 11.1 单元测试

- `coarsen()` 正确合并节点/边
- 粗化轮数控制（终止条件）
- 反投后节点数不变且位置合理
- 微调 80 tick 后 alpha < 0.001

### 11.2 E2E 测试

```
graph-multilevel.spec.ts:
  - 首次加载图（>50 节点）自动触发 ML → 验证节点位置非初始圆形
  - 主题切换重建 → 验证跳过 ML（使用已有位置）
  - 「重新布局」按钮 → 验证触发 ML
  - 小图（<50 节点）→ 验证跳过 ML
  - ML 进行中切 vault → 验证旧 Worker 终止
```

### 11.3 视觉回归

- 同一张图分别在 ML 和单层 d3-force 下对比：簇分离度、边交叉数、分布均匀度
- 截图保存在 `test-results/graph-ml-comparison/`

---

## 十二、成本估算

| 阶段 | 难度 | 代码量 | 说明 |
|---|---|---|---|
| 粗化算法（Matching-based） | 🟡 中 | ~150 行 | 图论经典算法，数据结构清晰 |
| 粗化图布局（复用 d3-force） | 🟢 低 | ~20 行 | 跑现有 Worker，只是输入图变小 |
| 反投 + 微调 | 🟡 中 | ~80 行 | 映射回原始节点 + 短微调 |
| Worker 集成 | 🟡 中 | ~50 行 | 在当前 Worker 通信协议上加阶段消息 |
| 平滑过渡（可选） | 🟢 低 | ~30 行 | Sigma camera.animate 到新位置 |
| **合计** | **中** | **~330 行** | |

---

## 十三、验收标准

| 维度 | 当前（单层力导向） | 目标（Multi-Level） |
|---|---|---|
| 簇分离 | 模糊粘连 | 清晰可辨 |
| 布局均匀度 | 局部最优 | 全局均匀 |
| 缩放/平移体验 | 各簇边界模糊，难聚焦 | 簇清晰，用户可缩放聚焦某社区 |
| 大图（1000+ 节点） | 力导向卡、噪点多 | 粗化后图小，布局流畅 |

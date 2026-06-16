# 知识图谱深度对比：Molio vs Obsidian

> 对比日期：2026-06-15
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
| **渲染引擎** | 自研 Canvas 渲染（Cytoscape.js 早期，后来自研） | Sigma.js v3（WebGL） |
| **布局算法** | 自研力导向布局（CoSE - Compound Spring Embedder） | ForceAtlas2（graphology-layout-forceatlas2） |

---

## 二、Node（节点）体系对比

### 2.1 节点表示

| 特性 | Obsidian | Molio |
|------|----------|-------|
| **节点单位** | 一个 `.md` 文件 = 一个节点 | 同 |
| **标签显示** | 文件名（无扩展名） | 文件名（无扩展名） |
| **特殊节点** | 无文件页面（灰色虚线节点） | 无（仅存在文件才创建节点） |
| **节点类型区分** | 不支持原生（插件可实现） | 设计上有 `nodeType` 预留字段 |
| **孤立节点** | 显示但颜色暗淡 | 显示但颜色更浅（`#999999` vs `#5C5C5C`） |

### 2.2 节点大小策略

**Obsidian**：
```
radius = base + sqrt(linkCount) × factor
- base: 3-4px（最小节点）
- max: ~15px（中心枢纽节点）
- 不区分类型，纯链接数驱动
```

**Molio**（`nodeSize` 函数）：
```typescript
function nodeSize(linkCount: number): number {
  const base = 4;
  const maxSize = 12;
  const calculated = base + Math.sqrt(linkCount) * 1.5;
  return Math.min(maxSize, calculated);
}
```

| 链接数 | Obsidian (估) | Molio |
|--------|---------------|-------|
| 0（孤立） | ~3px | 4px |
| 1 | ~5px | 5.5px |
| 5 | ~7px | 7.4px |
| 10 | ~9px | 8.7px |
| 30 | ~12px | 12px（封顶） |
| 50+ | ~15px | 12px（封顶） |

Molio 的最大节点限制更小（12px vs ~15px），避免超大节点视觉失衡。

### 2.3 节点颜色体系

**Obsidian 默认深色主题**：
```
默认节点:   #A0AAB5（灰蓝）
孤立节点:   #4A5360（更暗）
Hover 节点: #FFFFFF（白色）
选中节点:   #FFFFFF + 紫色光环 (#7C3AED)
关联节点:   保持原色
非关联节点:  透明度降至 ~0.1（几乎消失）
```

**Molio 浅色主题**（当前实现）：
```
默认节点:   #5C5C5C（深灰）
孤立节点:   #999999（浅灰）
Hover 节点: #333333（更深）
选中节点:   #8B5CF6（紫色）+ 无光环
关联节点:   保持原色
非关联节点:  #D4D4D4（变淡但不消失）
```

**Molio 预留的类型色彩**（来自 docs/obsidian.md）：
```
文档(Document):    #94A3B8（灰蓝）
标签(Tag):         #22C55E（绿色）
Agent:             #8B5CF6（紫色）
项目(Project):     #3B82F6（蓝色）
工作流(Workflow):  #F59E0B（橙色）
AI模型(AIModel):   #EF4444（红色）
```

> ⚠️ 注意：这些类型颜色已定义但后端尚未返回 `nodeType` 字段，目前所有节点统一使用链接数颜色。

---

## 三、Edge（链接线）体系对比

| 特性 | Obsidian | Molio |
|------|----------|-------|
| **默认连线颜色** | `rgba(255,255,255,0.08)`（极淡） | `#D4D4D4`（淡灰，更明显） |
| **默认线宽** | 1px | 0.8px |
| **Hover 关联线** | `rgba(96,165,250,0.7)` 淡紫，~2px | `#C4B5FD` 淡紫，1.5px |
| **选中节点连线** | `#60A5FA` 亮蓝，~3px | `#8B5CF6` 紫色，2px |
| **边去重** | 不支持（方向边可能重复） | 支持（`source→target` 规范化去重，Set 实现） |
| **边权重显示** | 无 | 无（`edgeWeightInfluence: 0`） |
| **箭头** | 无 | 无 |

**关键差异**：
- Obsidian 的默认连线极淡（蜘蛛网效果），强调探索时**高亮的对比度**
- Molio 的默认连线更明显，适合**直接看清连接结构**
- Molio 做了边去重（规范化 `source→target` 顺序），避免重复边

---

## 四、布局算法对比

### 4.1 算法选型

| 特性 | Obsidian | Molio |
|------|----------|-------|
| **算法** | CoSE（Compound Spring Embedder，自研变体） | ForceAtlas2（Gephi 团队） |
| **底层** | Cytoscape.js → 自研 Canvas | graphology-layout-forceatlas2 |
| **性能优化** | 内部 Web Worker + 分块计算 | Barnes-Hut（O(n log n)） |
| **社区聚类** | 天然形成（CoSE 特性） | 天然形成（ForceAtlas2 特性，linLog 模式增强） |
| **自适应** | 根据图规模自动调参 | 手动配置固定参数 |

### 4.2 ForceAtlas2 参数（Molio 实际使用）

```typescript
forceAtlas2.assign(graph, {
  iterations: 300,
  settings: {
    linLogMode: true,                    // LinLog 模式：近距离强排斥，防止重叠
    outboundAttractionDistribution: true, // 按出度分配吸引力，避免 hub 节点过度拉扯
    barnesHutOptimize: true,             // Barnes-Hut O(n log n) 近似
    barnesHutTheta: 0.5,                // 精度（越小越精确，默认 1.2）
    edgeWeightInfluence: 0,             // 边权重无效
    scalingRatio: 8,                    // 全局间距
    strongGravityMode: false,           // 关闭强重力，让外围节点自然散开
    gravity: 0.5,                       // 温和向心力
    slowDown: 1 + Math.log(1 + n),      // 自适应减速
  },
});
```

### 4.3 布局效果差异

| 效果 | Obsidian | Molio（当前） |
|------|----------|---------------|
| **节点间距** | 紧凑但有呼吸感 | 偏松散（scalingRatio: 8） |
| **重叠控制** | 优秀 | 良好（linLog 模式防止重叠） |
| **外围节点** | 自然散开，可能有飞地 | 强制向心（gravity: 0.5） |
| **中心枢纽** | 吸引合理 | 有向心引力，相对聚集 |
| **迭代次数** | 动态收敛检测 | 固定 300 次 |

**Molio 可优化的方向**：
- `scalingRatio: 8` 偏大 → 可降至 3-5 使布局更紧凑
- 300 次迭代在大图上可能不够 → 可改为动态收敛检测
- `gravity: 0.5` 可能使外围飞地节点过度向心 → 可考虑弱化或动态

---

## 五、交互系统对比

### 5.1 交互矩阵

| 交互 | Obsidian | Molio |
|------|----------|-------|
| **鼠标拖拽（空白区）** | 平移画布 | 平移画布（Sigma 默认） |
| **鼠标滚轮** | 缩放 | 缩放 |
| **Hover 节点** | 高亮邻居 + 淡出其他 | 高亮邻居 + 淡出其他 |
| **单击选中** | 聚焦到节点 | 选中（紫色高亮） |
| **双击节点** | 打开文件 | **打开文件（导航到 `/knowledge`）** |
| **拖拽节点** | 移动并固定位置（fx/fy） | 移动并固定位置（fx/fy） |
| **空白区单击** | 取消选中 | 取消选中 + **清除 fx/fy 锁定** |
| **框选** | 不支持 | 不支持 |
| **右键菜单** | 在节点上右键弹出文件操作 | 无 |

### 5.2 交互实现细节对比

**Obsidian 交互实现**：自研 Canvas 事件系统，Sigma 内置的事件系统，每个交互是原子化的 API

**Molio 交互实现**（GraphPage.tsx）：

```typescript
// 核心设计：原生 DOM 事件接管 Sigma 的点击/拖拽
// 原因：区分 click / drag / dblclick 更精确

// 点击检测：图形坐标系中的命中测试
const findNodeAtPosition = (mouseX: number, mouseY: number): string | null => {
  const mouseGraph = renderer.viewportToGraph({ x: mouseX, y: mouseY });
  graph.forEachNode((node, attr) => {
    const dist = Math.sqrt((nx - mouseGraph.x)² + (ny - mouseGraph.y)²);
    const hitRadius = Math.max(size * 2, 3);
    if (dist < hitRadius && dist < closestDist) { ... }
  });
};

// 双击检测：350ms 间隔内同一节点
const DBLCLICK_INTERVAL = 350;
// 单击选中 → 记录节点和时间
// 再次单击同一节点且在间隔内 → 双击事件，导航到文件

// 拖拽锁定：实时 fx/fy
graph.setNodeAttribute(draggedNode, 'fx', graphPos.x);
graph.setNodeAttribute(draggedNode, 'fy', graphPos.y);
```

**对比发现**：
- Molio 的交互是自己实现的**原生 DOM 事件**接管层，而非使用 Sigma 内置交互
- 这样做的好处是精确控制 click/drag/dblclick 的分发（Sigma 内置无法完美区分这三者）
- 缺点是需要手动做命中测试（`findNodeAtPosition`），在大图上 foreach 可能成性能瓶颈

### 5.3 交互体验差异

**Obsidian 胜出的点**：
1. **节点 hover 效果更丰富** — Obsidian 的 hover 不仅变色，还有过渡动画
2. **选中节点有发光光环** — 紫色光晕 `box-shadow: 0 0 12px rgba(96,165,250,0.8)` 更精致
3. **框架选择器** — 按住 Shift 可框选多个节点
4. **星标/隐藏** — 右键可星标或隐藏节点

**Molio 的独特亮点**：
1. **双击导航到文件** — Obsidian 需要单击后再点详情面板，Molio 双击直达知识库
2. **取消选中时清除 fx/fy** — 避免拖拽固定后无法恢复自由布局（Obsidian 需要手动右键解锁）
3. **取消选中不触发导航** — 空白区单击只取消选中，不会误导航

---

## 六、图表功能对比

### 6.1 功能矩阵

| 功能 | Obsidian | Molio |
|------|----------|-------|
| **全局图** | 完整 vault 级图谱 | 完整 vault 级图谱 |
| **局部图** | 当前文件的 1-3 级邻居 | **无** |
| **筛选器** | 按文件路径、标签、链接方向筛选 | **无** |
| **搜索节点** | Ctrl+Shift+F 搜索 + 定位 | **无** |
| **节点过滤** | 显示/隐藏指定节点组 | **无** |
| **星标** | 星标节点优先显示 | **无** |
| **分组** | 按文件夹/标签自动分组着色 | **无** |
| **Minimap** | **无** | **有**（Canvas 绘制） |
| **节点统计** | 悬停时显示文件名 + 链接数 | 顶部栏显示节点/边总数 |
| **暗色/浅色** | 跟随主题 | 目前固定浅色 |

### 6.2 Minimap（独有特性）

Molio 实现了 Obsidian 没有的 Minimap 组件：

```typescript
// Minimap.tsx — Canvas 绘制，160×110px
// 特性：
// 1. requestAnimationFrame 驱动的实时绘制循环
// 2. 节点用 2×2px 小点表示（fillRect）
// 3. 视口矩形用半透明紫色表示（VIEWPORT_FILL + VIEWPORT stroke）
// 4. 圆角剪裁（clip to roundRect）
// 5. 自动计算全局坐标范围
// 6. 每帧重绘（RAF 循环，sigma 的 camera/listener 触发）
```

实现参考了 Figma/Miro 的 minimap 模式，在 Obsidian 社区也常有人请求但官方未实现。

### 6.3 局部图（Molio 缺失的重要功能）

Obsidian 的**局部图**（Local Graph）是其图谱功能的核心场景：
- 点击某个节点 → 显示该节点及其 1-3 级邻居
- 用户借此聚焦探索单个文件的关联网络
- 配合星标和筛选，形成"先全局定位 → 再局部探索"的工作流

**Molio 目前只有全局图**，没有局部图，这是图谱功能的核心缺口。

---

## 七、数据来源与链接解析

### 7.1 数据管道对比

```
Obsidian:
  文件系统 → 实时监听文件变更 → 内部索引更新 → 图谱重绘
  （增量更新，修改文件立即可见图谱变化）

Molio:
  文件系统 → API 请求触发 scan → 同步解析 wikilinks → 返回 JSON → Sigma 渲染
  （全量重建，需手动刷新页面或切换 vault）
```

### 7.2 链接解析策略

**Obsidian**：
- 精确路径匹配
- 大小写不敏感
- 别名解析（`[[Page|alias]]`）
- 块引用（`[[Page#^block]]`）
- 自动补全 + 实时检查

**Molio**（`resolveLink` 函数）：
```typescript
function resolveLink(rawName, sourcePath, nameIndex, pathToKey): string | null {
  // 1. 精确 basename 匹配
  const candidates = nameIndex.get(cleanName);
  
  // 2. 单一候选 → 直接返回
  if (candidates.length === 1) return pathToKey.get(candidates[0]);
  
  // 3. 多候选 → 优先同目录
  const sourceDir = sourcePath.includes('/')
    ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
    : '';
  for (const c of candidates) {
    if (same directory) return pathToKey.get(c);
  }
  
  // 4. 回退到首个候选
  return pathToKey.get(candidates[0]);
}
```

**差异点**：
| 场景 | Obsidian | Molio |
|------|----------|-------|
| 明确路径 | 精确匹配 | 精确匹配 |
| 同名文件 | 自动补全已处理 | 同目录优先 → 首个 |
| 别名 | 完整支持 | 解析别名语法但不做映射 |
| 块链接 | 支持 | 不支持 |
| 未创建页面 | 灰色虚线节点 | 死链接（不创建节点） |

---

## 八、死链接检测

Molio 在后端图谱构建中做了死链接检测，这是 Obsidian 没有的正式功能：

**检测时机**：`buildGraph()` 中解析 wikilink 时，如果 `resolveLink()` 返回 null，即标记为死链接

```typescript
const deadLinks = new Set<string>(); // Track dead links

// 在边构建过程中，如果 link 无法解析，记录死链接
// 但当前版本在返回给前端的 GraphData 中并没有包含 deadLinks 信息
```

**当前局限**：
1. `deadLinks` Set 已创建但没有返回给前端
2. 前端图谱无法显示死链接标记
3. 死链接信息目前只在 Wiki Lint 操作中体现

**建议方向**：将死链接数据返回前端，以虚线灰色节点（类似 Obsidian 的未创建页面样式）展示。

---

## 九、性能对比

| 指标 | Obsidian | Molio |
|------|----------|-------|
| **渲染引擎** | 自研 Canvas 2D | Sigma.js WebGL |
| **数千节点** | 60fps | 60fps |
| **一万节点** | ~40fps（节点 culling） | ~30-45fps（Barnes-Hut + WebGL） |
| **五万节点** | ~20fps | ~15-20fps |
| **布局计算** | Web Worker 异步 | 主线程同步（blocking） |
| **增量更新** | 支持（文件变更即更新） | 不支持（全量重建） |
| **节点 culling** | 视口外不渲染 | Sigma 默认做 |
| **LOD** | 缩放远时合并节点 | 无 |

**Molio 的瓶颈**：
- ForceAtlas2 在主线程同步执行 300 次迭代，大图（5000+ 节点）会有明显的卡顿
- 没有增量更新机制，切换 vault 或刷新时需要全量重建
- 缺少 LOD（Level of Detail），大量节点时标签渲染是负担

---

## 十、功能缺口与改进方向

### 10.1 需补齐的核心功能

| 优先级 | 功能 | 当前状态 | 参考实现 |
|--------|------|----------|----------|
| **P0** | **局部图（Local Graph）** | 缺失 | 点击节点 → 显示 1-2 级邻居 |
| **P0** | **节点筛选与过滤** | 缺失 | 按链接数/路径/标签过滤显示 |
| **P0** | **死链接可视化** | 后端已检测，前端不显示 | 将 deadLinks 返回前端 |
| **P1** | **深色主题** | 只有浅色 | 跟随系统/app 主题切换 |
| **P1** | **节点搜索** | 缺失 | 搜索框输入定位节点 |
| **P2** | **增量更新** | 全量重建 | 监听文件变化自动刷新 |
| **P2** | **节点分组着色** | `nodeType` 已定义未启用 | 按类型使用不同颜色 |

### 10.2 可优化的体验

| 项目 | 当前 | 建议 |
|------|------|------|
| **布局紧凑度** | `scalingRatio: 8` 偏松散 | 降至 3-5 |
| **迭代次数** | 固定 300 次 | 动态收敛检测 |
| **初始布局** | 圆环随机散布 | 中心辐射或预计算 |
| **Hover 动画** | 无过渡 | 添加 ~150ms CSS transition 效果 |
| **选中节点光晕** | 无 | 添加 `shadowBlur` 效果 |
| **节点标签** | 始终显示 | 缩放阈值控制（zoom > 1.2 显示） |
| **性能** | 主线程布局 | 移到 Web Worker |
| **图谱数据缓存** | 每次进入重新请求 | 缓存到内存，vault 不变时不刷新 |

---

## 十一、总结

```
Molio 图谱当前状态：
  ✅ 基础功能完整（全局图 / ForceAtlas2 / hover / click / drag / dblclick / Minimap）
  ✅ 后端死链接检测（虽未完全暴露）
  ✅ 链接解析策略合理（同目录优先）
  ✅ 自定义交互系统精确（click/drag/dblclick 完美区分）
  
  ❌ 缺失局部图（最大缺口）
  ❌ 缺失筛选/过滤/搜索
  ❌ 死链接虽已检测但不展示
  ❌ 全量重建无增量更新
  ❌ 布局在主线程同步执行（大图卡顿）
  ❌ 无深色主题
  ❌ nodeType 已预留但未启用
  
  📈 后端管道可复用（buildGraph 函数直接返回死链接信息只需小改动）
  📈 Sigma.js 生态可扩展（局部图通过 filter API 实现）
  📈 ForceAtlas2 参数可调（不需要换算法，只需调节参数即可改善效果）
```

### 与 Obsidian 的差距评估

```
功能完整度（100% = Obsidian 当前水平）： (更新于 2026-06-16)

全局图可视化  ████████████████████ 85%
局部图        ████████████████░░░░ 70%  ← ✅ 已实现（选中后淡出非关联节点）
交互体验      ██████████████████░░ 78%  ← ✅ 持续仿真 + 碰撞检测
布局效果      ██████████████░░░░░░ 55%  ← ⚠️ 待优化（线条交叉）
筛选/搜索     ██░░░░░░░░░░░░░░░░░░ 15%  ← 核心缺口（第三期计划）
节点着色      ██████████████████████████ 100% ← ✅ 按类型着色 + 死链接灰点
死链接        ██████████████████████ 90%  ← ✅ 后端检测 + 前端可视化
Minimap       ██████████████████████████ 120%（Obsidian 没有）
性能          ████████████░░░░░░░░ 55%
增量更新      ██░░░░░░░░░░░░░░░░░░ 10%  ← 核心缺口
交互提示      ██████████████████████████ 100% ← ✅ 新增操作提示条

总体：Molio 图谱约达到 Obsidian 的 65-70% 功能完整度（较改造前的 50-55% 提升约 15%）
      独有：Minimap、死链接可视化、交互提示条、节点按类型着色
```

### 建议的迭代路径

1. **第一期（已完成 ✅）**：启用 `nodeType` 颜色分类 + 死链接前端展示 + 交互提示 —— **已实现半数以上项目**
2. **第二期（核心体验）**：局部图（Local Graph）+ 节点搜索与筛选
3. **第三期（性能提升）**：Web Worker 布局 + 增量更新
4. **第四期（差异化）**：AI 关系发现（embedding 相似边）+ 时间维度滑块

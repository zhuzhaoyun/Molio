# 图谱移动时自动降质设计

> **实现对象**: Molio 知识图谱 (`apps/web/src/components/graph/`)
> **关联反馈**: 测试同事在 Windows 笔记本上用「资治通鉴」知识库（692 节点 / ~11k wikilink）测 `refactor/knowledge-graph-performance` 分支，拖拽节点时明显卡顿；M5 Pro 本机无法复现
> **日期**: 2026-07-25

---

## 一、动机

### 1.1 问题根因（已排查确认）

692 < `WORKER_THRESHOLD`（1000），图谱走**主线程** d3-force 模拟。拖拽时**每一帧**主线程需同步完成：

| 每帧开销项 | M5 Pro 实测/估算 | 中端 Windows 笔记本估算 |
|---|---|---|
| d3 tick（Barnes-Hut 排斥 + **collide×3 迭代** + link + 向心力） | **3.1ms（实测）** | ~8–12ms |
| graphology 位置同步（`setNodeAttribute` ×1384 + 事件派发） | ~0.3ms | ~1ms |
| Sigma WebGL 全量重绘（692 节点 + ~3000 边 + ~170 标签；**标签的文字测量 + 纹理上传是渲染大头**） | ~2–5ms | ~8–20ms |
| Minimap 重绘（每次 render 后遍历全图 2 遍） | ~0.5ms | ~2ms |
| **合计** | **~6–9ms → 60fps 流畅** | **~20–35ms → 30–45fps + 帧时抖动 → 明显卡顿** |

成本分属两个域，互相独立：

- **CPU 域（物理模拟）**：d3 tick，无法通过任何渲染参数降级——collide 迭代次数是唯一的运行时旋钮；
- **渲染域**：标签是最大头。TU Dresden 的图渲染性能对比研究已证实 WebGL 在**文字渲染**上有性能回退（即使交给 GPU，标签栅格化/atlas 仍是瓶颈），与 sigma 实测一致。

M5 Pro 单核约是中端 Windows 笔记本（11–13 代 Intel U 系列）的 3–4 倍，GPU 差距更大；Windows 常见的 125–200% DPI 缩放还会放大 framebuffer 填充压力。692 节点的图正好落在"快机器无感、慢机器超 16.7ms 帧预算"的区间。

### 1.2 方案对比：为什么不做「按设备分档的三档画质设置」

曾考虑在设置面板提供 高画质 / 平衡 / 流畅 三档，**否决理由**：

1. **不解决已报告的问题**：默认档必须是高画质（否则高配机体验回退），测试同事不会主动改档，bug 原样存在；
2. **把硬件诊断推给用户**：用户无法感知"高画质"与"平衡"的边界，误选产生双向抱怨；
3. **此场景没有档位梯度**：真正可降级的旋钮只有粗粒度的二元开关（标签开/关、collide 3/1、pixelRatio 封顶），不存在三档的渐进空间。

**行业参照（Obsidian）**：同为 WebGL 渲染（Pixi.js），但 Obsidian **没有**设备画质分档——其成本管理是「Text fade threshold」缩放级标签 LOD + WebGL 故障时 Canvas 兼容回退；且其力模拟同样在主线程，大图（25k+）一样卡。本方案"移动时隐藏标签"与 Obsidian 的标签条件显示是同一哲学，只是触发条件从*缩放*换成*移动*。

**结论**：做常开的「移动时自动降质」行为（无 UI、无设置项），所有设备受益；若后续仍不够，再考虑二元"性能模式"开关（封顶 pixelRatio、降标签密度），而非三档。

### 1.3 预期效果

| 指标 | 当前 | 目标 |
|---|---|---|
| 拖拽帧时（Windows 中端机，692 节点图） | ~20–35ms | 显著下降（去掉标签渲染 + collide 减 2/3 迭代） |
| 拖拽帧时（M5 Pro） | ~6–9ms | 基本不变 |
| 视觉影响 | — | 拖拽中标签隐藏，松手立即恢复（对齐 Obsidian 移动时行为） |
| 用户操作成本 | — | 零（自动、无设置项） |

---

## 二、行为规格

### 2.1 「移动」的定义

两类触发源：

1. **节点拖拽**：mousedown 命中节点后，鼠标位移超过 `DRAG_THRESHOLD`（4px，已有常量）才视为拖拽开始。**阈值前不降质**——避免单击选中时标签闪烁；
2. **相机移动**：平移 / 缩放 / 相机动画——由 sigma 内置 `hideLabelsOnMove` 原生覆盖，零代码。

**不算移动**：松手后的沉降动画（`wake(0.3)`，约 1 秒）——标签在松手瞬间即恢复，与 Obsidian 手感一致，且保持恢复逻辑简单。

### 2.2 降质矩阵

| 项目 | 移动期间 | 停止后 |
|---|---|---|
| 节点标签 | 隐藏：`setSetting('renderLabels', false)`（sigma 3.0.3 已验证存在该设置） | 恢复 `true` + `renderer.refresh()` |
| collide 迭代 | 3 → 1 | 恢复 3 |
| 边线 | **保留**（边是图谱核心信息，隐藏后画面只剩孤点） | — |
| 相机移动时的标签 | sigma 原生 `hideLabelsOnMove: true` 自动处理 | 自动恢复 |
| Minimap | 拖拽期间跳过重绘（省慢机 ~2ms/帧） | 恢复 |

---

## 三、实现设计

改动三个文件，全部在 `apps/web/src/components/graph/`：

### 3.1 `useSimulation.ts` — 新增 `setMotionMode`

`SimulationAPI` 增加 `setMotionMode(active: boolean)`：

- **主线程模式**：`sim.force<ForceCollide<D3Node>>('collide')?.iterations(active ? 1 : COLLIDE_ITERATIONS)`；
- **Worker 模式**：`postMessage({ type: 'setCollideIterations', value: n })`；`simulation.worker.ts` 的 `onmessage` 增加对应 case，内部 `sim.force('collide').iterations(n)`。

collide 降到 1 的副作用（拖拽中邻居节点可能短暂轻微重叠）在松手后由 `wake(0.3)` 的恢复性 tick 解析，符合"移动中容忍近似、停止后收敛"的原则。

### 3.2 `GraphPage.tsx` — 拖拽起止接线

- Sigma 初始化 settings 增加 `hideLabelsOnMove: true`（覆盖相机平移/缩放）；
- `handleMouseMove` 中 `isDragging` 首次置 true 处（超过 `DRAG_THRESHOLD`）：
  ```
  renderer.setSetting('renderLabels', false);
  simulation.setMotionMode(true);
  ```
- `handleMouseUp`（仅当发生过拖拽）：
  ```
  renderer.setSetting('renderLabels', true);
  simulation.setMotionMode(false);
  renderer.refresh();
  ```
- 新增 `interactingRef`（拖拽期间为 true），传给 Minimap。

### 3.3 `Minimap.tsx` — 交互时跳过重绘

新增可选 prop `isInteracting?: () => boolean`；`scheduleDraw` 内为 true 时直接 return（已有的 `scheduled` 防抖逻辑不变）。

### 3.4 数据流

```
用户按住节点移动 > 4px
  → GraphPage: renderLabels=false, setMotionMode(true)
  → 每帧: d3 tick (collide×1，省 ~2/3 collide 开销)
         + sigma 渲染 (无标签，省渲染大头)
         + Minimap 跳过
  → 松手 (document mouseup)
  → GraphPage: renderLabels=true, setMotionMode(false), refresh()
  → 标签恢复，collide×3 继续解析重叠
```

---

## 四、边界情况

| 场景 | 处理 |
|---|---|
| 拖拽中鼠标移出窗口后松手 | mouseup 监听在 `document` 上，已覆盖 |
| 单击节点（未达拖拽阈值） | 阈值前不降质，标签无闪烁 |
| 拖拽中的 hover 动画 | 现有代码 `if (draggedNode) return` 已互斥，无需改 |
| 拖拽中组件销毁（主题切换等触发重建） | sigma / sim 随 teardown 销毁，设置随之消失，无残留状态 |
| Worker 模式（≥1000 节点图） | `setCollideIterations` 消息路径同样生效，行为对齐主线程模式 |
| sigma 设置可用性 | `renderLabels`、`hideLabelsOnMove` 已确认存在于 sigma@3.0.3，无需 fallback |

---

## 五、测试

### 5.1 E2E（强制规则：UI 改动必须同步测试）

在 `apps/web/e2e/graph.spec.ts`（@area graph / P1，已在 area-map 中映射，无需新增 area 注册）新增用例：

- **构造数据**：沿用 `graph-search.spec.ts` 的模式——`beforeAll` 经 daemon API 建临时 vault（写 3 个含 wikilink 的 md），`afterAll` 清理；
- **断言**：
  1. 拖拽前 `window.__sigma.getSetting('renderLabels') === true`；
  2. 用 `__graph` 取节点坐标 + `__sigma.graphToViewport` 换算屏幕坐标，`page.mouse` 模拟按住拖动超过 4px 后，`renderLabels === false`；
  3. 松手后 `renderLabels` 恢复 `true`。

### 5.2 手工验证

1. M5 Pro 本机：拖拽节点，标签随拖拽消失、松手即恢复，无闪烁；相机平移/缩放时标签同样隐藏（`hideLabelsOnMove`）；
2. 请测试同事在 Windows 机器上复测 692 节点库的拖拽帧率是否改善；如需量化，临时插入 rAF 帧时统计打点后移除。

---

### 5.3 入场 blur 在低档机的代价（2026-08-03 补充）

入场过渡（`graph.css` `.graph-intro*`）对 WebGL 画布施加 `filter: blur(5px)` + `opacity` + `transform`。
blur 虽走 GPU 合成层，但**对实时重绘的 WebGL canvas 而言，低档机（弱核显 + 高 DPI）上 blur 仍可能掉帧**——
这正是 §1.1 里"标签渲染是渲染域大头"之外的第二个渲染域成本。入场仅持续 ~360–800ms 且只触发一次
（冷加载 bloom / 暖加载淡入），故不列入拖拽降质矩阵；但**若后续在低档机上观察到入场卡顿**，候选措施：
- 入场时临时 `pixelRatio` 封顶（合成层面积随 DPR 平方增长）；
- 低档机降级：检测到 `devicePixelRatio ≥ 2` 且 GPU 弱时跳过 blur（仅保留 opacity+transform）；
- 暖加载 soft 分支本就不带 blur（仅淡入+极轻缩放），代价集中在冷加载 bloom 一次。

拖拽降质矩阵本身不受入场影响（入场在可交互前完成；`mousedown` 命中节点时会取消未完成的 bloom 并同步坐标，见 `GraphPage.tsx` `introRafRef` 分支）。

> **2026-08-03 补充 2（后续）**：入场收尾与「入场刚结束的首次拖拽」撞车（bloom 结束 `renderLabels=true`
> + 全量 `refresh()`，首次拖拽又关/开标签）曾怀疑是卡顿来源——**终端机复测卡顿已不明显**，此修复降级为可选
> （若要根治仍可做：bloom 结束延迟恢复标签到首次空闲 / `will-change` 收敛到入场期间）。
> 根因追踪：`docs/superpowers/specs/2026-07-28-graph-drag-camera-stability.md` §12.2。

---

## 六、不做的事（YAGNI）

- **三档画质设置 / 二元性能模式**：本次不做；若 Windows 复测仍卡，单独立项（候选旋钮：pixelRatio 封顶、标签密度、minimap 常关）；
- **调低 `WORKER_THRESHOLD` 让 692 节点走 Worker**：Worker 拖拽有 postMessage 往返 + 每 3 tick 同步一次的位置节流，手感需另行调校，风险大于收益；
- **tick 位置同步改批量直写 sigma**：架构改动大，待性能矛盾升级后再议；
- **沉降期间（松手后 ~1s）也降质**：恢复逻辑复杂化，收益小。

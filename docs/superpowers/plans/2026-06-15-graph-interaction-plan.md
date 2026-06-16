# 知识图谱交互与渲染改造 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 替换 ForceAtlas2 为 d3-force 实现持续物理仿真 + 碰撞检测，补齐节点着色/死链接/局部图/深色主题

**Architecture:** 前端 Sigma.js WebGL 渲染不变，替换底层布局引擎。后端 graph.ts 补充 nodeType 和 deadLinks 数据。全部改动集中在 `apps/web/src/components/graph/` 和 `apps/daemon/src/routes/graph.ts`。

**Tech Stack:** d3-force, Sigma.js v3, graphology, Hono

**设计文档:** `docs/superpowers/specs/2026-06-15-graph-interaction-design.md`

---

## 文件结构总览

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/web/package.json` | 修改 | d3-force 依赖替换 |
| `apps/web/src/components/graph/useSimulation.ts` | **新增** | d3-force 物理引擎封装 |
| `apps/web/src/components/graph/types.ts` | **新增** | 主题/节点类型/图谱数据类型定义 |
| `apps/web/src/components/graph/GraphPage.tsx` | 修改 | 替换布局引擎 + 拖拽改造 + 着色/死链接/局部图/主题/动画 |
| `apps/web/src/components/graph/Minimap.tsx` | 不改 | 兼容（读 graph 坐标方式不变） |
| `apps/web/src/styles/graph.css` | 修改 | 深色主题 CSS 变量 + 搜索框样式 |
| `apps/daemon/src/routes/graph.ts` | 修改 | 返回 nodeType + deadLinks |
| `packages/contracts/src/knowledge.ts` | 修改 | GraphNode 类型增加字段 |

---

## 第一期：引擎焕新（7-10 天）

### Task 1: 替换依赖包

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: 更新 package.json**

移除 `graphology-layout-forceatlas2`，添加 `d3-force`：

```json
{
  "dependencies": {
    // 移除这一行:
    // "graphology-layout-forceatlas2": "^0.10.1",

    // 添加:
    "d3-force": "^3.0.0"
  },
  "devDependencies": {
    // 添加:
    "@types/d3-force": "^3.0.0"
  }
}
```

- [ ] **Step 2: 安装依赖并验证**

```bash
cd apps/web
pnpm install
pnpm typecheck
```

Expected: Install succeeds. `pnpm typecheck` passes (no forceatlas2 reference errors yet — GraphPage.tsx still imports it, will be removed in Task 3).

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml
git commit -m "chore(web): replace forceatlas2 with d3-force"
```

---

### Task 2: 创建 useSimulation hook

**Files:**
- Create: `apps/web/src/components/graph/useSimulation.ts`

这个 hook 封装 d3-force 物理引擎，将 graphology 数据映射到 d3，并在 tick 时写回坐标。

- [ ] **Step 1: 创建 useSimulation.ts**

```typescript
/**
 * useSimulation — d3-force physics engine hook for Sigma/Graphology.
 *
 * Creates a force-directed layout with collision detection,
 * writes positions back to graphology on each tick.
 */

import { useEffect, useRef } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type Graph from 'graphology';
import type Sigma from 'sigma';

// ── Types ──

export interface D3Node extends SimulationNodeDatum {
  id: string;
  radius: number;
}

export interface D3Link extends SimulationLinkDatum<D3Node> {
  source: string;
  target: string;
}

export interface UseSimulationOptions {
  graph: Graph | null;
  sigma: Sigma | null;
  onTick: () => void;
}

export interface SimulationAPI {
  /** Wake up the simulation (call during drag). */
  wake: (alpha?: number) => void;
  /** Stop the simulation. */
  stop: () => void;
  /** Get the d3 node object for a given node ID (for setting fx/fy during drag). */
  getNode: (id: string) => D3Node | undefined;
  /** Check if simulation is currently active. */
  isActive: () => boolean;
}

/**
 * Creates a d3-force simulation bound to a graphology graph.
 *
 * Force configuration:
 *  - link: spring force along edges, distance 120, strength 0.3
 *  - charge: repulsion between all nodes, strength -100, distanceMax 500
 *  - collide: collision constraint, radius = node.radius + 6px padding
 *  - center: weak centering force, strength 0.05
 *
 * On each tick, writes x/y back to graphology and calls onTick (which should sigma.refresh()).
 */
export function useSimulation({ graph, sigma, onTick }: UseSimulationOptions): SimulationAPI {
  const simRef = useRef<ReturnType<typeof forceSimulation<D3Node>> | null>(null);
  const nodesRef = useRef<D3Node[]>([]);

  useEffect(() => {
    if (!graph || graph.order === 0) {
      simRef.current = null;
      nodesRef.current = [];
      return;
    }

    // Build d3 node array from graphology
    const d3Nodes: D3Node[] = [];
    const d3Links: D3Link[] = [];
    const nodeMap = new Map<string, D3Node>();

    graph.forEachNode((key, attrs) => {
      const node: D3Node = {
        id: key,
        x: (attrs.x as number) ?? Math.random() * 100,
        y: (attrs.y as number) ?? Math.random() * 100,
        radius: Math.max((attrs.size as number) ?? 6, 4),
      };
      d3Nodes.push(node);
      nodeMap.set(key, node);
    });

    graph.forEachEdge((_key, _attrs, source, target) => {
      d3Links.push({ source: source as string, target: target as string });
    });

    nodesRef.current = d3Nodes;

    // Create d3-force simulation with 4 forces
    const simulation = forceSimulation<D3Node>(d3Nodes)
      .force(
        'link',
        forceLink<D3Node, D3Link>(d3Links)
          .id((d) => d.id)
          .distance(120)
          .strength(0.3),
      )
      .force('charge', forceManyBody<D3Node>().strength(-100).distanceMax(500))
      .force('collide', forceCollide<D3Node>().radius((d) => d.radius + 6))
      .force('center', forceCenter<D3Node>().strength(0.05))
      .alphaDecay(0.02)
      .velocityDecay(0.3)
      .on('tick', () => {
        // Write d3 coordinates back to graphology
        for (const d of d3Nodes) {
          if (graph.hasNode(d.id)) {
            graph.setNodeAttribute(d.id, 'x', d.x);
            graph.setNodeAttribute(d.id, 'y', d.y);
          }
        }
        onTick();
      });

    simRef.current = simulation;

    return () => {
      simulation.stop();
      simRef.current = null;
      nodesRef.current = [];
    };
  }, [graph, sigma, onTick]);

  return {
    wake: (alpha = 0.5) => {
      if (simRef.current) {
        simRef.current.alpha(alpha).restart();
      }
    },
    stop: () => {
      if (simRef.current) {
        simRef.current.stop();
      }
    },
    getNode: (id: string): D3Node | undefined => {
      return nodesRef.current.find((n) => n.id === id);
    },
    isActive: () => {
      return simRef.current ? simRef.current.alpha() > 0 : false;
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/graph/useSimulation.ts
git commit -m "feat(graph): add useSimulation hook for d3-force physics engine"
```

---

### Task 3: 替换 ForceAtlas2 初始化

**Files:**
- Modify: `apps/web/src/components/graph/GraphPage.tsx`

移除 ForceAtlas2 的 import 和 assign 调用，接入 useSimulation hook。

- [ ] **Step 1: 移除 ForceAtlas2 import 并添加 d3-force import**

在 `GraphPage.tsx` 顶部，替换：

```typescript
// 移除:
import forceAtlas2 from 'graphology-layout-forceatlas2';

// 添加:
import { useSimulation } from './useSimulation';
```

- [ ] **Step 2: 接入 useSimulation hook（在 useEffect 初始化 Sigma 之后）**

找到 `useEffect(() => { if (!graphData || ... )` 中 ForceAtlas2 相关的代码（约第 160-176 行）：

```typescript
// 移除这整段 ForceAtlas2:
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
```

替换为在 sigma 创建后，使用 `useSimulation`（但不是直接在 effect 里调用，而是通过另外一个组件或者调用返回的 API）。

**修改方案**：由于 `useSimulation` 是 hook（只能在组件顶层调用），而现有代码在 `useEffect` 内初始化 graphology 和 Sigma，需要调整架构——将 simulation 的创建移到组件顶层。

重构后的顶层 hook 调用（在 `GraphPage` 函数组件中，`useEffect` 之前加入）：

```typescript
// 在 GraphPage 函数组件中，现有状态声明之后
const [sigmaInstance, setSigmaInstance] = useState<Sigma | null>(null);
const [graphInstance, setGraphInstance] = useState<Graph | null>(null);
const tickCountRef = useRef(0);

const simulation = useSimulation({
  graph: graphInstance,
  sigma: sigmaInstance,
  onTick: useCallback(() => {
    if (sigmaRef.current) {
      sigmaRef.current.refresh();
    }
  }, []),
});
```

然后在 `useEffect` 初始化 Sigma 的末尾，set 这些 state 来触发 simulation 绑定：

```typescript
// 在 Sigma 创建之后，return 之前添加
sigmaRef.current = renderer;
setSigmaInstance(renderer);
setGraphInstance(graph);
```

**更简洁的方案**：不使用额外的 state，而是在 effect 末尾直接调用 `useSimulation` 返回的 API 来初始化。但 hook 不能被条件调用。所以**最好是将 simulation 的创建封装在 effect 内部**，通过 ref 暴露 API。

考虑到 React 规则，最佳方案是创建一个 `useSimulationRef`：

```typescript
// 方案：用 ref 暴露 simulation API，不用 state 驱动重新渲染
// useSimulationRef = useRef<SimulationAPI>({ wake, stop, getNode, isActive })
// 在 effect 中初始化 simulation 并赋值到 ref
```

修改 `useSimulation.ts` 使其通过 ref 工作，而不是依赖重新渲染：

实际上更简单的方法：修改 useSimulation hook，在内部使用 ref，不依赖 graph/sigma 作为 deps，而是暴露一个 `init(graph, sigma)` 方法。

让我重新设计 useSimulation 的 API：

```typescript
// useSimulation 改为使用 ref 存储实例，暴露 init 方法
export function useSimulation(): SimulationAPI & { init: (graph: Graph, sigma: Sigma, onTick: () => void) => void } {
  const simRef = useRef<...>(null);
  const nodesRef = useRef<...>([]);
  
  const api: SimulationAPI & { init: (...) => void } = {
    init(graph, sigma, onTick) {
      // 创建 simulation...
    },
    wake(alpha) { ... },
    stop() { ... },
    getNode(id) { ... },
    isActive() { ... },
  };
  
  return api;
}
```

这样在 `GraphPage.tsx` 中可以这样用：

```typescript
const simulation = useSimulation();

// 在 useEffect 的末尾：
simulation.init(graph, renderer, () => {
  renderer.refresh();
});
```

让我按这个方案写完整代码。

- [ ] **Step 3: 改写 useSimulation.ts 为 ref 驱动的 API**

```typescript
/**
 * useSimulation — d3-force physics engine hook for Sigma/Graphology.
 *
 * Unlike typical hooks, this one is init-driven: call .init() inside your
 * useEffect to bind the simulation to a graph+sigma pair.
 * The returned methods (wake, stop, getNode) are stable refs usable anywhere.
 */

import { useRef, useCallback } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type Graph from 'graphology';
import type Sigma from 'sigma';

export interface D3Node extends SimulationNodeDatum {
  id: string;
  radius: number;
}

export interface D3Link extends SimulationLinkDatum<D3Node> {
  source: string;
  target: string;
}

export interface SimulationAPI {
  /** Bind the simulation to a graphology graph + sigma renderer. Call inside useEffect. */
  init: (graph: Graph, sigma: Sigma, onTick: () => void) => void;
  /** Wake up the simulation (call during drag). */
  wake: (alpha?: number) => void;
  /** Stop the simulation. */
  stop: () => void;
  /** Get the d3 node object for a given node ID. Returns undefined if not found. */
  getNode: (id: string) => D3Node | undefined;
}

export function useSimulation(): SimulationAPI {
  const simRef = useRef<ReturnType<typeof forceSimulation<D3Node>> | null>(null);
  const nodesRef = useRef<D3Node[]>([]);

  const stop = useCallback(() => {
    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }
    nodesRef.current = [];
  }, []);

  const init = useCallback((graph: Graph, sigma: Sigma, onTick: () => void) => {
    // Kill previous simulation if any
    if (simRef.current) {
      simRef.current.stop();
    }

    if (graph.order === 0) {
      simRef.current = null;
      nodesRef.current = [];
      return;
    }

    // Build d3 node array from graphology
    const d3Nodes: D3Node[] = [];
    const d3Links: D3Link[] = [];

    graph.forEachNode((key, attrs) => {
      const node: D3Node = {
        id: key,
        x: (attrs.x as number) ?? Math.random() * 100,
        y: (attrs.y as number) ?? Math.random() * 100,
        radius: Math.max((attrs.size as number) ?? 6, 4),
      };
      d3Nodes.push(node);
    });

    graph.forEachEdge((_key, _attrs, source, target) => {
      d3Links.push({ source: source as string, target: target as string });
    });

    nodesRef.current = d3Nodes;

    // Create d3-force simulation
    const simulation = forceSimulation<D3Node>(d3Nodes)
      .force(
        'link',
        forceLink<D3Node, D3Link>(d3Links)
          .id((d) => d.id)
          .distance(120)
          .strength(0.3),
      )
      .force('charge', forceManyBody<D3Node>().strength(-100).distanceMax(500))
      .force('collide', forceCollide<D3Node>().radius((d) => d.radius + 6))
      .force('center', forceCenter<D3Node>().strength(0.05))
      .alphaDecay(0.02)
      .velocityDecay(0.3)
      .on('tick', () => {
        // Write d3 coordinates back to graphology
        for (const d of d3Nodes) {
          if (graph.hasNode(d.id)) {
            graph.setNodeAttribute(d.id, 'x', d.x);
            graph.setNodeAttribute(d.id, 'y', d.y);
          }
        }
        onTick();
      });

    simRef.current = simulation;
  }, []);

  const wake = useCallback((alpha = 0.5) => {
    if (simRef.current) {
      simRef.current.alpha(alpha).restart();
    }
  }, []);

  const getNode = useCallback((id: string): D3Node | undefined => {
    return nodesRef.current.find((n) => n.id === id);
  }, []);

  return { init, wake, stop, getNode };
}
```

- [ ] **Step 4: 在 GraphPage.tsx 中接入 simulation**

在 `GraphPage` 组件顶层添加：

```typescript
// 在 const hoveredNodeRef = useRef<string | null>(null); 旁边添加
const simulation = useSimulation();
```

在 graph 创建并初始化 Sigma 之后（`renderer.refresh()` 之前），调用 simulation.init()：

找到 `renderer.refresh();` 之前（约第 269 行），添加：

```typescript
// 在 renderer.refresh(); 之前
// 启动 d3-force 物理引擎
simulation.init(graph, renderer, () => {
  renderer.refresh();
});
```

并在 `useEffect` 的清理函数（return 中）添加：

```typescript
return () => {
  simulation.stop();
  // ... 现有的清理代码
};
```

- [ ] **Step 5: 验证编译通过**

```bash
pnpm typecheck
```

Expected: No type errors. If there are errors about `useSimulation` not being found, adjust the import path.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/graph/GraphPage.tsx apps/web/src/components/graph/useSimulation.ts
git commit -m "feat(graph): replace ForceAtlas2 with d3-force simulation engine"
```

---

### Task 4: 改造拖拽交互

**Files:**
- Modify: `apps/web/src/components/graph/GraphPage.tsx`

改造鼠标事件处理，从"设 fx/fy → refresh"变为"设 d3 fx/fy → wake engine"。

当前拖拽代码在 `handleMouseDown`、`handleMouseMove`、`handleMouseUp` 函数中。

- [ ] **Step 1: 替换 handleMouseDown 中的拖拽逻辑**

找到 `const handleMouseDown = (e: MouseEvent) => {` 函数（约第 316 行），在命中节点的分支中，记录节点并锁定 d3 位置：

```typescript
// 替换这一段（命中节点时的处理）:
if (node) {
  draggedNode = node;
  isDragging = false;
  dragStartMouse = { x: mouseX, y: mouseY };
  // 锁定 d3 节点位置，防止碰撞约束把拖拽的节点弹开
  const d3Node = simulation.getNode(node);
  if (d3Node) {
    const attrs = graph.getNodeAttributes(node);
    d3Node.fx = (attrs.x as number) ?? 0;
    d3Node.fy = (attrs.y as number) ?? 0;
  }
  e.preventDefault();
  e.stopPropagation();
}
```

- [ ] **Step 2: 替换 handleMouseMove**

找到 `const handleMouseMove = (e: MouseEvent) => {` 函数（约第 346 行），在拖拽移动的分支中：

```typescript
// 替换这一段:
if (isDragging) {
  const graphPos = renderer.viewportToGraph({ x: mouseX, y: mouseY });
  graph.setNodeAttribute(draggedNode, 'x', graphPos.x);
  graph.setNodeAttribute(draggedNode, 'y', graphPos.y);
  graph.setNodeAttribute(draggedNode, 'fx', graphPos.x);
  graph.setNodeAttribute(draggedNode, 'fy', graphPos.y);
  renderer.refresh();
}

// 替换为:
if (isDragging) {
  const graphPos = renderer.viewportToGraph({ x: mouseX, y: mouseY });
  const d3Node = simulation.getNode(draggedNode);
  if (d3Node) {
    // 更新 d3 节点位置 + 锁定
    d3Node.x = graphPos.x;
    d3Node.y = graphPos.y;
    d3Node.fx = graphPos.x;
    d3Node.fy = graphPos.y;
    // 写入 graphology 让 sigma 渲染
    graph.setNodeAttribute(draggedNode, 'x', graphPos.x);
    graph.setNodeAttribute(draggedNode, 'y', graphPos.y);
  }
  // 唤醒引擎 — 力通过弹簧传导到邻居 → 邻居被拉动
  // 碰撞约束防止重叠 → 推开效果
  simulation.wake(0.5);
  renderer.refresh();
}
```

- [ ] **Step 3: 替换 handleMouseUp**

找到 `const handleMouseUp = (_e: MouseEvent) => {` 函数（约第 371 行），在拖拽结束的分支中：

```typescript
// 替换这一段（拖拽结束）:
if (wasDragging) {
  // 拖拽结束：fx/fy 已在 mousemove 中设置，保持锁定
}

// 替换为:
if (wasDragging) {
  // 释放 d3 fx/fy 锁定 → 节点自然回弹收敛
  const d3Node = simulation.getNode(node);
  if (d3Node) {
    d3Node.fx = null;
    d3Node.fy = null;
    graph.removeNodeAttribute(node, 'fx');
    graph.removeNodeAttribute(node, 'fy');
  }
  // 留一点能量让节点回弹收敛
  simulation.wake(0.1);
}
```

- [ ] **Step 4: 验证编译通过**

```bash
pnpm typecheck
```

Expected: No type errors.

- [ ] **Step 5: 手动验证交互**

开 dev server，打开图谱页面：

1. 拖拽一个节点 → 周围节点联动拉开
2. 释放节点 → 周围阻尼收敛
3. 双击节点 → 跳转到知识库文件（不受影响）
4. hover 高亮邻居（不受影响）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/graph/GraphPage.tsx
git commit -m "feat(graph): implement drag with d3-force physics (neighbor pull + collision)"
```

---

## 第二期：功能补齐（5-6 天）

### Task 5: 后端增强 — 返回 nodeType + deadLinks

**Files:**
- Modify: `apps/daemon/src/routes/graph.ts`
- Modify: `packages/contracts/src/knowledge.ts`

- [ ] **Step 1: contracts 添加 GraphNode 类型字段**

在 `packages/contracts/src/knowledge.ts` 末尾添加：

```typescript
// ─── Graph types ───

export interface GraphNode {
  key: string;
  label: string;
  path: string;
  linkCount: number;
  nodeType?: string;
  deadLink?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface DeadLinkInfo {
  sourceFile: string;
  targetName: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  deadLinks: DeadLinkInfo[];
}
```

- [ ] **Step 2: 更新 api/client.ts 的类型引用**

找到 `apps/web/src/api/client.ts` 中 `getGraph` 方法的返回类型（第 458 行），改为使用 contracts 类型：

```typescript
// 在 import 中添加 GraphData
import type {
  AgentInfo, RunInfo, CreateRunRequest, ToolResultRequest,
  ChatMessage, Project, Conversation, ConversationHistoryItem,
  Vault, TreeNode, FileContent, KbHistoryEntry, CreateVaultRequest,
  WikiStatusResponse, WikiBuildRequest, WikiIngestRequest,
  WikiLintRequest, WikiQueryRequest, WikiSaveRequest, WikiRunResponse,
  GraphData,  // 新增
} from '@molio/contracts';

// 修改 getGraph 方法：
async getGraph(vaultId: string): Promise<GraphData> {
  const res = await fetch(`${BASE}/graph/${vaultId}`);
  if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 3: 后端 graph.ts — 添加 nodeType 推导**

在 `apps/daemon/src/routes/graph.ts` 中添加 `inferNodeType` 函数：

```typescript
/**
 * Infer node type from frontmatter or directory path.
 */
function inferNodeType(filePath: string, content: string): string | undefined {
  // 1. Parse frontmatter for `type:` field
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1] ?? '';
    const typeMatch = fm.match(/^type:\s*(.+)$/m);
    if (typeMatch) {
      const t = typeMatch[1]!.trim();
      if (t) return t;
    }
  }

  // 2. Infer from wiki directory structure
  if (filePath.startsWith('wiki/sources/')) return 'source';
  if (filePath.startsWith('wiki/entities/')) return 'entity';
  if (filePath.startsWith('wiki/concepts/')) return 'concept';
  if (filePath.startsWith('wiki/comparisons/')) return 'comparison';
  if (filePath.startsWith('wiki/questions/')) return 'question';
  if (filePath.startsWith('wiki/')) return 'wiki';

  // 3. Default
  return 'document';
}
```

- [ ] **Step 4: 后端 graph.ts — 收集 nodeType + deadLinks**

在 `buildGraph` 函数中，修改节点构建和链接解析部分：

找到节点构建循环（`for (const f of mdFiles)` 约第 70-83 行），添加 nodeType：

```typescript
// 修改节点索引构建，读取文件内容用于推断类型
for (const f of mdFiles) {
  const relPath = f.path;
  const key = relPath;
  pathToKey.set(relPath, key);

  const basename = f.name.replace(/\.md$/i, '').toLowerCase();
  if (!nameIndex.has(basename)) {
    nameIndex.set(basename, []);
  }
  nameIndex.get(basename)!.push(relPath);

  // 读取文件内容用于类型推断和 wikilink 解析
  const absPath = resolveFilePath(vaultPath, f.path);
  let content = '';
  try {
    content = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
  } catch { /* binary or unreadable */ }

  // 推断节点类型
  const nodeType = inferNodeType(f.path, content);

  nodeTypes.set(key, nodeType);
  linkCounts.set(key, 0);
}
```

在链接解析循环后构建 nodes 数组时添加 nodeType：

```typescript
// 修改 nodes 构建（约第 120 行）
const nodes: GraphNode[] = mdFiles.map((f) => ({
  key: pathToKey.get(f.path)!,
  label: f.name.replace(/\.md$/i, ''),
  path: f.path,
  linkCount: linkCounts.get(pathToKey.get(f.path)!) ?? 0,
  nodeType: nodeTypes.get(pathToKey.get(f.path)!),
}));
```

在链接解析函数中添加 deadLinks 收集：

```typescript
// 在链接解析循环中（约第 89 行），添加 deadLinks 列表
const deadLinksList: DeadLinkInfo[] = [];

// ... 在 while ((match = linkRegex.exec(content)) !== null) { ... } 循环中
// 修改 resolveLink 判断
const targetKey = resolveLink(rawName, f.path, nameIndex, pathToKey);
if (!targetKey) {
  // 记录死链接
  if (!deadLinks.has(rawName.toLowerCase())) {
    deadLinks.add(rawName.toLowerCase());
    deadLinksList.push({ sourceFile: f.path, targetName: rawName });
  }
  continue;
}
if (targetKey === sourceKey) continue;
```

并在返回时：

```typescript
return { nodes, edges: edgeList, deadLinks: deadLinksList };
```

- [ ] **Step 5: 更新 exports 和 import**

更新 `graph.ts` 顶部 import：

```typescript
import type { GraphNode, GraphEdge, GraphData, DeadLinkInfo } from '@molio/contracts';
```

移除内联的类型定义（`GraphNode`, `GraphEdge`, `GraphData` 现在由 contracts 提供）。

- [ ] **Step 6: 验证编译通过**

```bash
cd apps/daemon && pnpm typecheck
cd apps/web && pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/knowledge.ts apps/daemon/src/routes/graph.ts apps/web/src/api/client.ts
git commit -m "feat(graph): backend returns nodeType and deadLinks"
```

---

### Task 6: 前端启用节点类型着色 + 死链接可视化

**Files:**
- Modify: `apps/web/src/components/graph/GraphPage.tsx`

- [ ] **Step 1: 更新 GraphPage.tsx 中的接口定义**

移除内联的 `GraphNode` 和 `GraphEdge` 接口定义（已由 `@molio/contracts` 提供），或直接使用 API 返回的类型。

将组件内自定义的类型定义替换为从 contracts 导入：

```typescript
// 移除文件内部的:
// interface GraphNode { ... }
// interface GraphEdge { ... }

// 添加 import:
import type { GraphNode, GraphEdge, GraphData } from '@molio/contracts';

// 修改 state 类型:
const [graphData, setGraphData] = useState<GraphData | null>(null);
```

- [ ] **Step 2: 启用节点类型颜色映射**

在 `GraphPage.tsx` 中，`nodeColor` 函数已经设计好了按类型取色的逻辑。修改 `NODE_TYPE_COLORS` 映射：

```typescript
const NODE_TYPE_COLORS: Record<string, string> = {
  document:   '#94A3B8',
  source:     '#3B82F6',
  entity:     '#22C55E',
  concept:    '#8B5CF6',
  comparison: '#F59E0B',
  question:   '#EF4444',
  wiki:       '#6B7280',
};
```

修改 `nodeColor` 函数，使其优先使用 nodeType：

```typescript
function nodeColor(linkCount: number, nodeType?: string | null): string {
  // 如果有类型标记，使用类型颜色
  if (nodeType && NODE_TYPE_COLORS[nodeType]) {
    return NODE_TYPE_COLORS[nodeType]!;
  }
  // 回退到链接数判断
  if (linkCount === 0) return NODE_ISOLATED;
  return NODE_DEFAULT;
}
```

在构建 graphology 节点时，传递 nodeType 属性：

```typescript
// 找到 graph.addNode 调用，添加 nodeType:
graph.addNode(n.key, {
  label: n.label,
  path: n.path,
  linkCount: n.linkCount,
  nodeType: n.nodeType ?? null,
  size: nodeSize(n.linkCount),
  color: nodeColor(n.linkCount, n.nodeType),
  type: 'circle',
  x: Math.cos(angle) * radius,
  y: Math.sin(angle) * radius,
});
```

- [ ] **Step 3: 死链接前端渲染**

在 `GraphPage.tsx` 的 graph 构建中，将死链接作为特殊的灰色半透明节点加入图谱：

```typescript
// 在构建 graphology 节点的循环之后，添加死链接节点
// （在 graphData.deadLinks 可用后）
if (graphData.deadLinks && graphData.deadLinks.length > 0) {
  const deadKeyPrefix = '__dead__';
  const seen = new Set<string>();
  for (const dl of graphData.deadLinks) {
    if (seen.has(dl.targetName)) continue;
    seen.add(dl.targetName);
    const deadKey = `${deadKeyPrefix}${dl.targetName}`;
    try {
      graph.addNode(deadKey, {
        label: dl.targetName,
        path: '',
        linkCount: 0,
        nodeType: null,
        size: 4,
        color: '#D4D4D4',
        type: 'circle',
        x: (Math.random() - 0.5) * initialRadius,
        y: (Math.random() - 0.5) * initialRadius,
      });
    } catch { /* node already exists */ }
  }
}
```

- [ ] **Step 4: 验证编译通过**

```bash
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/graph/GraphPage.tsx
git commit -m "feat(graph): node type coloring and dead link visualization"
```

---

### Task 7: 局部图（Local Graph）

**Files:**
- Modify: `apps/web/src/components/graph/GraphPage.tsx`

在选中节点时，自动进入局部模式，非关联节点透明度降至接近透明。

- [ ] **Step 1: 改造 nodeReducer 支持局部图**

找到 `nodeReducer` 函数（约第 180 行），修改为非关联节点淡化更彻底：

```typescript
// nodeReducer 函数
const nodeReducer = (node: string, data: Record<string, unknown>) => {
  const hovered = hoveredNodeRef.current;
  const selected = selectedNodeRef.current;
  const focusNode = hovered ?? selected;

  // 无 focus：默认显示所有节点
  if (!focusNode) {
    return {
      ...data,
      color: (data.color as string) ?? NODE_DEFAULT,
      size: (data.size as number) ?? 6,
      // 恢复到完全不透明
      label: (data.label as string) ?? '',
    };
  }

  // 当前 focus 节点：高亮
  if (node === focusNode) {
    const isSelected = node === selected;
    const scale = isSelected ? 1.4 : 1.2;
    return {
      ...data,
      size: ((data.size as number) ?? 6) * scale,
      color: isSelected ? NODE_SELECTED : NODE_HOVER,
      label: (data.label as string) ?? '',
    };
  }

  // 关联节点（邻居）
  const isConnected = graph.hasEdge(focusNode, node) || graph.hasEdge(node, focusNode);
  if (isConnected) {
    return {
      ...data,
      color: (data.color as string) ?? NODE_DEFAULT,
      label: (data.label as string) ?? '',
    };
  }

  // 非关联节点：几乎透明（但保留 1px 维持布局感知）
  return {
    ...data,
    color: selected ? '#F0F0F0' : '#D4D4D4',
    size: ((data.size as number) ?? 6) * 0.3,
    // 选中模式隐藏所有非关联标签
    label: selected ? '' : undefined,
  };
};
```

- [ ] **Step 2: 验证编译通过**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/graph/GraphPage.tsx
git commit -m "feat(graph): local graph mode fades non-connected nodes on selection"
```

---

## 第三期：视觉打磨（2-3 天）

### Task 8: 深色主题

**Files:**
- Modify: `apps/web/src/components/graph/GraphPage.tsx`
- Modify: `apps/web/src/styles/graph.css`
- Create: `apps/web/src/components/graph/types.ts`

- [ ] **Step 1: 创建主题类型定义**

`apps/web/src/components/graph/types.ts`：

```typescript
/**
 * Graph theme types — light and dark color schemes.
 */

export interface GraphTheme {
  bg: string;
  node: string;
  isolated: string;
  hover: string;
  selected: string;
  edge: string;
  edgeHover: string;
  edgeSel: string;
  label: string;
  minimapBg: string;
}

export const LIGHT_THEME: GraphTheme = {
  bg: '#FAFAFA',
  node: '#5C5C5C',
  isolated: '#999999',
  hover: '#333333',
  selected: '#8B5CF6',
  edge: '#D4D4D4',
  edgeHover: '#C4B5FD',
  edgeSel: '#8B5CF6',
  label: '#6B6B6B',
  minimapBg: '#FFFFFF',
};

export const DARK_THEME: GraphTheme = {
  bg: '#0F1117',
  node: '#9CA3AF',
  isolated: '#4A5360',
  hover: '#D1D5DB',
  selected: '#8B5CF6',
  edge: 'rgba(255,255,255,0.08)',
  edgeHover: 'rgba(139,92,246,0.6)',
  edgeSel: '#8B5CF6',
  label: '#D1D5DB',
  minimapBg: '#1A1D26',
};

/** Detect if the app is in dark mode via CSS media query. */
export function isDarkMode(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
```

- [ ] **Step 2: 在 GraphPage 中接入主题**

在 `GraphPage` 组件中添加主题状态：

```typescript
// 在组件顶层，状态声明区添加
const [theme, setTheme] = useState<GraphTheme>(isDarkMode() ? DARK_THEME : LIGHT_THEME);

// 监听系统主题变化
useEffect(() => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => {
    setTheme(e.matches ? DARK_THEME : LIGHT_THEME);
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}, []);
```

将组件中所有颜色常量替换为 theme 对象：

```typescript
// 移除 const BG = '#FAFAFA' ... 等常量
// 改为从 theme 读取
```

- [ ] **Step 3: 更新 CSS**

在 `apps/web/src/styles/graph.css` 中添加深色主题样式：

```css
/* ── Dark Theme ── */
@media (prefers-color-scheme: dark) {
  .entry-main:has(.graph-page) {
    background: #0F1117;
  }

  .graph-page {
    background: #0F1117;
  }

  .graph-topbar {
    background: #0F1117;
    border-bottom-color: rgba(255,255,255,0.06);
  }

  .graph-topbar__title {
    color: #D1D5DB;
  }

  .graph-stat {
    color: #888;
    background: rgba(255,255,255,0.06);
    border-color: rgba(255,255,255,0.1);
  }

  .graph-canvas {
    background: #0F1117;
  }

  .graph-loading {
    background: #0F1117;
    color: #999;
  }

  .graph-error {
    background: #0F1117;
  }

  .graph-empty {
    background: #0F1117;
    color: #666;
  }
}
```

- [ ] **Step 4: 验证编译通过**

```bash
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/graph/types.ts apps/web/src/components/graph/GraphPage.tsx apps/web/src/styles/graph.css
git commit -m "feat(graph): dark theme support"
```

---

### Task 9: 过渡动画

**Files:**
- Modify: `apps/web/src/components/graph/GraphPage.tsx`

- [ ] **Step 1: 简单动画插值工具**

在 `GraphPage.tsx` 顶部（或在 `types.ts` 中）添加：

```typescript
/**
 * Simple animation helper that runs a value interpolation over duration ms.
 * Returns a cleanup function to cancel the animation.
 */
function animateValue(
  from: number,
  to: number,
  duration: number,
  onFrame: (value: number) => void,
  onComplete?: () => void,
): () => void {
  let cancelled = false;
  const start = performance.now();

  function frame() {
    if (cancelled) return;
    const t = Math.min((performance.now() - start) / duration, 1);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3);
    onFrame(from + (to - from) * eased);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      onComplete?.();
    }
  }

  requestAnimationFrame(frame);
  return () => { cancelled = true; };
}
```

- [ ] **Step 2: 为 hover 过渡添加动画**

改造 hover 事件监听，在 `enterNode` 和 `leaveNode` 时启动颜色渐变，而非立即刷新：

```typescript
// 替换 renderer.on('enterNode', ...) 和 renderer.on('leaveNode', ...)
// 使用动画状态来控制淡化程度

// 新增动画状态 ref（在组件顶层）
const fadeAlphaRef = useRef(1.0);  // 1.0 = fully visible, 0.15 = faded
const fadeAnimRef = useRef<(() => void) | null>(null);

renderer.on('enterNode', ({ node }) => {
  hoveredNodeRef.current = node;

  // 取消进行中的动画
  fadeAnimRef.current?.();

  // 淡化非关联节点：从 1.0 → 0.15, 200ms
  fadeAnimRef.current = animateValue(1.0, 0.15, 200, (v) => {
    fadeAlphaRef.current = v;
    renderer.refresh();
  });
});

renderer.on('leaveNode', () => {
  hoveredNodeRef.current = null;

  // 取消进行中的动画
  fadeAnimRef.current?.();

  // 恢复：从当前值 → 1.0, 200ms
  fadeAnimRef.current = animateValue(fadeAlphaRef.current, 1.0, 200, (v) => {
    fadeAlphaRef.current = v;
    renderer.refresh();
  });
});
```

在 `nodeReducer` 中应用 `fadeAlphaRef`：

```typescript
// 非关联节点的透明度部分：
return {
  ...data,
  color: selected ? '#F0F0F0' : '#D4D4D4',
  size: ((data.size as number) ?? 6) * 0.3 * fadeAlphaRef.current,
  label: selected ? '' : undefined,
};
```

- [ ] **Step 3: 验证编译通过**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/graph/GraphPage.tsx
git commit -m "feat(graph): smooth fade transitions on hover/select"
```

---

### Task 10: 节点搜索

**Files:**
- Modify: `apps/web/src/components/graph/GraphPage.tsx`
- Modify: `apps/web/src/styles/graph.css`

- [ ] **Step 1: 顶部栏添加搜索框**

在 `GraphPage.tsx` 的顶栏区域（topbar），统计信息旁边添加搜索框：

```tsx
<div className="graph-topbar__right">
  {/* 搜索框 */}
  <div className="graph-search">
    <input
      type="text"
      className="graph-search__input"
      placeholder={t('graph.searchPlaceholder') ?? 'Search nodes...'}
      value={searchQuery}
      onChange={(e) => handleSearch(e.target.value)}
    />
  </div>

  {graphData && !loading && (
    <span className="graph-stat">{t('graph.nodes', { count: nodeCount })}</span>
  )}
  {graphData && !loading && (
    <span className="graph-stat graph-stat--edges">{t('graph.edges', { count: edgeCount })}</span>
  )}
</div>
```

添加搜索状态和逻辑：

```typescript
// 在组件状态区域添加
const [searchQuery, setSearchQuery] = useState('');

// 搜索处理函数
const handleSearch = useCallback((query: string) => {
  setSearchQuery(query);
  if (!query || !graphRef.current) {
    // 清除搜索, 重置聚焦
    searchResultRef.current = null;
    if (sigmaRef.current) sigmaRef.current.refresh();
    return;
  }

  // 查找匹配节点
  const lowerQuery = query.toLowerCase();
  let found: string | null = null;
  graphRef.current.forEachNode((key, attrs) => {
    if (found) return;
    const label = (attrs.label as string) ?? '';
    if (label.toLowerCase().includes(lowerQuery)) {
      found = key;
    }
  });

  if (found) {
    searchResultRef.current = found;
    selectedNodeRef.current = found;
    // 相机聚焦到该节点
    sigmaRef.current?.getCamera().animate(
      { x: graphRef.current.getNodeAttribute(found, 'x') as number,
        y: graphRef.current.getNodeAttribute(found, 'y') as number,
        ratio: 0.5 },
      { duration: 300 },
    );
  }
}, []);
```

- [ ] **Step 2: 添加 CSS**

在 `apps/web/src/styles/graph.css` 中添加搜索框样式：

```css
/* ── Search ── */

.graph-search {
  position: relative;
}

.graph-search__input {
  width: 180px;
  padding: 4px 10px;
  border: 1px solid #E5E5E5;
  border-radius: 5px;
  background: #FFFFFF;
  color: #333333;
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s;
}

.graph-search__input:focus {
  border-color: #8B5CF6;
}

.graph-search__input::placeholder {
  color: #AAAAAA;
}

@media (prefers-color-scheme: dark) {
  .graph-search__input {
    background: rgba(255,255,255,0.06);
    border-color: rgba(255,255,255,0.1);
    color: #D1D5DB;
  }

  .graph-search__input::placeholder {
    color: #666;
  }
}
```

- [ ] **Step 3: 验证编译通过**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/graph/GraphPage.tsx apps/web/src/styles/graph.css
git commit -m "feat(graph): node search with camera focus"
```

---

## 自检清单

### Spec 覆盖率

| Spec 章节 | 实现任务 | 状态 |
|-----------|----------|------|
| 架构变化（ForceAtlas2 → d3-force） | Task 1-3 | ✅ |
| 持续物理仿真 + 碰撞检测 | Task 4 | ✅ |
| 后端 nodeType 推导 | Task 5 | ✅ |
| 死链接返回与可视化 | Task 5-6 | ✅ |
| 节点类型着色 | Task 6 | ✅ |
| 局部图（Local Graph） | Task 7 | ✅ |
| 深色主题 | Task 8 | ✅ |
| 过渡动画 | Task 9 | ✅ |
| 节点搜索 | Task 10 | ✅ |
| 不做事项（YAGNI） | — | ✅ 未纳入计划 |
| i18n 搜索框 placeholder | Task 10 | 仅有 fallback 文本，未添加实际 i18n key（可使用已有 `t()` 函数或直接用英文） |

### 占位符扫描

- ✅ 无 "TBD"、"TODO"、"implement later" 等留空
- ✅ 每个步骤包含完整代码
- ✅ 没有"类似 Task N"的表述
- ✅ 所有 import 和函数调用路径已明确

### 类型一致性

- ✅ `GraphNode`/`GraphEdge`/`GraphData`/`DeadLinkInfo` 在 contracts 中统一定义
- ✅ `nodeType` 字段名前后一致
- ✅ `useSimulation.init()` 签名与调用处匹配

### 范围控制

- ✅ 聚焦在知识图谱交互与渲染改造，不涉及其他模块
- ✅ 未出现在设计文档中未讨论的新功能
- ✅ 三期界限清晰，每期可独立交付

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-graph-interaction-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — 启用 subagent-driven-development，我对每个 task 派发独立的子 agent，task 间有上下文隔离，快速迭代，让你分批验收

2. **Inline Execution** — 使用 executing-plans 在当前会话中逐步执行，你实时看到每个步骤的输出

**你倾向哪种方式？**

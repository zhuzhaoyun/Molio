# 图谱移动时自动降质 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拖拽节点 / 相机移动时自动降级渲染与物理成本（隐藏标签、collide 迭代 3→1、跳过 Minimap 重绘），停止后立即恢复，修复低端 Windows 机器上 692 节点图的拖拽卡顿。

**Architecture:** 纯行为优化，无 UI 设置项。标签降级走 sigma 原生开关（`renderLabels` / `hideLabelsOnMove`）；物理降级给 `SimulationAPI` 增加 `setMotionMode()`，主线程直接改 d3 `forceCollide.iterations()`、Worker 模式走新消息 `setCollideIterations`；Minimap 通过 `isInteracting` 回调在拖拽期间跳过重绘。降质时机统一为「拖拽超过 4px 阈值时开启、mouseup 时恢复」。

**Tech Stack:** React 19 + TypeScript、Sigma.js 3.0.3（`renderLabels` / `hideLabelsOnMove` 已验证存在）、d3-force 3、graphology、Playwright（E2E）

## Global Constraints

- **分支**：当前在 `feat/multi-level-layout` 特性分支，所有提交落在此分支；禁止直接 push main（团队规则走 PR）。
- **Commit 规范**：Conventional Commits，scope 用 `web`，如 `feat(web): xxx` / `perf(web): xxx`。
- **测试同步**：UI 改动必须与对应测试同一个 commit 提交（CLAUDE.md 强制规则）。
- **E2E 前置**：`pnpm dev`（daemon :3100 + web :5173）必须先运行；命令在 `apps/web` 下执行 `npx playwright test`。
- **E2E 定位**：图谱是 WebGL canvas 无 DOM，沿用现有 `window.__sigma` / `window.__graph` 探针方式（先例见 `graph-search.spec.ts`）。
- **设计文档**：`docs/superpowers/specs/2026-07-25-graph-motion-quality-design.md` 为唯一行为依据。
- **不做的事（YAGNI）**：三档画质设置、二元性能模式、调低 `WORKER_THRESHOLD`、批量直写 sigma 位置、沉降期间降质——均不在本计划内。

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|---|---|---|
| `apps/web/e2e/graph.spec.ts` | 新增拖拽降质 E2E（含临时 vault fixture） | Modify |
| `apps/web/src/components/graph/GraphPage.tsx` | 拖拽起止接线：`renderLabels` 切换、`setMotionMode` 调用、`interactingRef`；sigma 配置加 `hideLabelsOnMove` | Modify |
| `apps/web/src/components/graph/useSimulation.ts` | `SimulationAPI` 增加 `setMotionMode(active)`：主线程改 collide 迭代 / Worker 发消息 | Modify |
| `apps/web/src/components/graph/simulation.worker.ts` | 处理 `setCollideIterations` 消息 | Modify |
| `apps/web/src/components/graph/Minimap.tsx` | 新增可选 `isInteracting` prop，为 true 时跳过重绘 | Modify |

---

### Task 1: 拖拽时隐藏标签（E2E 先行 + GraphPage 接线）

**Files:**
- Modify: `apps/web/e2e/graph.spec.ts`（追加 imports、DAEMON 辅助函数、新 describe 块）
- Modify: `apps/web/src/components/graph/GraphPage.tsx:377`（sigma 配置）、`:608-610`（拖拽阈值块）、`:654-658`（mouseup 恢复分支）

**Interfaces:**
- Consumes: sigma 的 `setSetting('renderLabels', boolean)` / `getSetting('renderLabels')`（3.0.3 已验证）；GraphPage 已暴露的 `window.__sigma` / `window.__graph`
- Produces: 拖拽超过 `DRAG_THRESHOLD` 时 `renderLabels` 变为 `false`，mouseup 后恢复 `true`——Task 2/3 的恢复逻辑叠加在 Task 1 建立的同一对代码块上

- [ ] **Step 1: 编写失败的 E2E 测试**

修改 `apps/web/e2e/graph.spec.ts` 顶部 imports 为：

```ts
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON_API = 'http://localhost:3100/api';

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
```

在文件末尾（现有 `test.describe('Graph', ...)` 之后）追加：

```ts
test.describe('Graph drag auto-quality (移动时自动降质)', () => {
  let testVaultPath: string;
  let vaultId: string;
  const vaultName = `e2e-graph-drag-quality-${Date.now()}`;

  test.beforeAll(async () => {
    // 清理上次崩溃遗留的同名 vault
    try {
      const list = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`);
      const { vaults } = await list.json();
      for (const v of vaults as { id: string; name: string }[]) {
        if (v.name.startsWith('e2e-graph-drag-quality-')) {
          await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' }).catch(() => {});
        }
      }
    } catch { /* daemon 可能没起 */ }

    // 3 节点 < ML 触发阈值(50)，不会触发 multi-level 布局，测试稳定
    testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-graph-drag-quality-'));
    writeFileSync(join(testVaultPath, 'alpha.md'), '# Alpha\n\n[[beta]] [[gamma]]\n');
    writeFileSync(join(testVaultPath, 'beta.md'), '# Beta\n\n[[gamma]]\n');
    writeFileSync(join(testVaultPath, 'gamma.md'), '# Gamma\n\n(no links)\n');

    const res = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: vaultName, path: testVaultPath }),
    });
    const vault = await res.json();
    vaultId = vault.id;
  });

  test.afterAll(async () => {
    if (vaultId) {
      await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
    }
    if (testVaultPath) {
      rmSync(testVaultPath, { recursive: true, force: true });
    }
  });

  test('dragging a node hides labels and restores them on release', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
    await gotoHome(page);
    await clickNav(page, 'graph');
    await page.waitForSelector('.graph-sigma canvas', { timeout: 15_000 });
    await page.waitForTimeout(2000); // 等模拟沉降

    // 基准：拖拽前标签开启
    const before = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      return s ? s.getSetting('renderLabels') : null;
    });
    expect(before).toBe(true);

    // 取任一节点的 viewport 坐标
    const pos = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any; __graph?: any }).__sigma;
      const g = (window as unknown as { __sigma?: any; __graph?: any }).__graph;
      if (!s || !g) return null;
      let found: { x: number; y: number } | null = null;
      g.forEachNode((_k: string, a: { x: number; y: number }) => {
        if (found) return;
        found = s.graphToViewport({ x: a.x, y: a.y });
      });
      return found;
    });
    expect(pos).not.toBeNull();

    const canvas = page.locator('.graph-sigma canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + pos!.x;
    const startY = box!.y + pos!.y;

    // 按住 → 移动 30px（超过 DRAG_THRESHOLD=4）→ 标签应关闭
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 30, startY + 30, { steps: 6 });

    const during = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      return s ? s.getSetting('renderLabels') : null;
    });
    expect(during).toBe(false);

    // 松手 → 标签恢复
    await page.mouse.up();
    const after = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      return s ? s.getSetting('renderLabels') : null;
    });
    expect(after).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

前置：`pnpm dev` 已在运行。

Run: `cd apps/web && npx playwright test graph.spec.ts -g "hides labels"`
Expected: FAIL —— `expect(during).toBe(false)` 处 received `true`（当前代码拖拽时不改 `renderLabels`）。

- [ ] **Step 3: GraphPage 加入相机移动降质配置**

修改 `apps/web/src/components/graph/GraphPage.tsx` 的 sigma 配置块，将：

```ts
      renderEdgeLabels: false,
      autoRescale: true,
```

替换为：

```ts
      renderEdgeLabels: false,
      // 相机移动（平移/缩放）时标签自动隐藏、静止后恢复——sigma 原生支持，
      // 避免移动中全量重测标签文字 + 纹理上传（低端设备渲染大头）。
      // 节点拖拽的标签降级在 handleMouseMove/handleMouseUp 中手动切换（拖拽锁相机，此开关不触发）。
      hideLabelsOnMove: true,
      autoRescale: true,
```

- [ ] **Step 4: 拖拽开始时降质（renderLabels=false）**

修改 `handleMouseMove` 中的阈值块，将：

```ts
      if (!isDragging && moveDist > DRAG_THRESHOLD) {
        isDragging = true;
      }
```

替换为：

```ts
      if (!isDragging && moveDist > DRAG_THRESHOLD) {
        isDragging = true;
        // 移动时降质（见 docs/superpowers/specs/2026-07-25-graph-motion-quality-design.md）：
        // 隐藏标签——每帧渲染大头（文字测量 + 纹理上传），松手立即恢复。
        // 超过阈值才降质，避免单击选中时标签闪烁。
        renderer.setSetting('renderLabels', false);
      }
```

- [ ] **Step 5: 松手时恢复（renderLabels=true）**

修改 `handleMouseUp` 的 `if (wasDragging)` 分支，将：

```ts
        tileIsolatedNodes(graph);
        simulation.wake(0.3);
        renderer.refresh();
```

替换为：

```ts
        tileIsolatedNodes(graph);
        simulation.wake(0.3);
        // 恢复移动时降质：先开标签，下面的 refresh() 让标签立即渲染回来
        renderer.setSetting('renderLabels', true);
        renderer.refresh();
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `cd apps/web && npx playwright test graph.spec.ts -g "hides labels"`
Expected: PASS（1 passed）

- [ ] **Step 7: 类型检查**

Run: `cd /Users/albert/workspace/Molio-refactor-knowledge-graph-performance-multi-level && pnpm typecheck`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add apps/web/e2e/graph.spec.ts apps/web/src/components/graph/GraphPage.tsx
git commit -m "feat(web): 图谱拖拽/相机移动时隐藏标签，降每帧渲染成本

拖拽超过 4px 阈值时 renderLabels=false，松手恢复；
相机平移/缩放走 sigma 原生 hideLabelsOnMove。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: collide 迭代降质（setMotionMode：useSimulation + worker + 接线）

**Files:**
- Modify: `apps/web/src/components/graph/useSimulation.ts`（import 区、`SimulationAPI` 接口、`setForceParam` 之后新增实现、return 语句）
- Modify: `apps/web/src/components/graph/simulation.worker.ts`（d3-force 类型导入、`onmessage` switch、新增 handler）
- Modify: `apps/web/src/components/graph/GraphPage.tsx`（拖拽阈值块、mouseup 恢复分支）

**Interfaces:**
- Consumes: Task 1 建立的拖拽阈值块与恢复分支（其中已有 `renderLabels` 切换）
- Produces: `SimulationAPI.setMotionMode(active: boolean)` —— `true` 时 collide 迭代降为 1，`false` 恢复 `COLLIDE_ITERATIONS`（=3）；Worker 消息类型 `setCollideIterations`（载荷 `{ value: number }`）

说明：web 包没有组件级单测框架（仅 Playwright），collide 迭代数无法从 E2E 外部观测（d3 内部状态）。本任务以「E2E 回归不红 + typecheck」为自动化验证门槛，行为正确性由 Task 4 手工验证覆盖。

- [ ] **Step 1: useSimulation.ts 增加类型导入**

在 `useSimulation.ts` 顶部的 d3-force import 类型列表中增加 `ForceCollide`，即将：

```ts
  type ForceX,
  type ForceY,
  type ForceManyBody,
  type ForceLink,
```

替换为：

```ts
  type ForceX,
  type ForceY,
  type ForceManyBody,
  type ForceLink,
  type ForceCollide,
```

- [ ] **Step 2: SimulationAPI 接口增加 setMotionMode**

将：

```ts
export interface SimulationAPI {
  init: (graph: Graph, sigma: Sigma, _onTick?: () => void) => void;
  wake: (alpha?: number) => void;
  stop: () => void;
  getNode: (id: string) => NodeHandle | undefined;
  setForceParam: (name: string, value: number) => void;
  multiLevel: (params?: MultiLevelParams) => void;
}
```

替换为：

```ts
export interface SimulationAPI {
  init: (graph: Graph, sigma: Sigma, _onTick?: () => void) => void;
  wake: (alpha?: number) => void;
  stop: () => void;
  getNode: (id: string) => NodeHandle | undefined;
  setForceParam: (name: string, value: number) => void;
  multiLevel: (params?: MultiLevelParams) => void;
  /** 移动时降质：拖拽期间 collide 迭代 3→1（每 tick 最大 CPU 成本），松手恢复 */
  setMotionMode: (active: boolean) => void;
}
```

- [ ] **Step 3: 实现 setMotionMode**

在 `setForceParam` 的 useCallback 定义之后、`// ── Multi-Level Layout ──` 注释之前插入：

```ts
  // ── Motion Mode ──
  // 移动时降质：拖拽期间把 collide 迭代从 COLLIDE_ITERATIONS(3) 降到 1。
  // collide 是每 tick 的最大 CPU 成本（四叉树 ×迭代数）；移动中允许近似解析，
  // 松手后 wake(0.3) 的 tick 会以 3 次迭代解析残留重叠。

  const setMotionMode = useCallback((active: boolean) => {
    const iterations = active ? 1 : COLLIDE_ITERATIONS;

    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'setCollideIterations', value: iterations });
      return;
    }

    simRef.current?.force<ForceCollide<D3Node>>('collide')?.iterations(iterations);
  }, []);
```

- [ ] **Step 4: 更新 return 语句**

将：

```ts
  return { init, wake, stop, getNode, setForceParam, multiLevel };
```

替换为：

```ts
  return { init, wake, stop, getNode, setForceParam, multiLevel, setMotionMode };
```

- [ ] **Step 5: worker 增加类型导入**

在 `simulation.worker.ts` 顶部 d3-force import 的类型导入中增加 `ForceCollide`，即将：

```ts
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
```

替换为：

```ts
  type SimulationNodeDatum,
  type SimulationLinkDatum,
  type ForceCollide,
} from 'd3-force';
```

- [ ] **Step 6: worker 消息分发增加 case**

在 `self.onmessage` 的 switch 中，将：

```ts
    case 'multi-level-init':
      handleMultiLevelInit(e.data);
      break;
  }
```

替换为：

```ts
    case 'multi-level-init':
      handleMultiLevelInit(e.data);
      break;
    case 'setCollideIterations':
      handleSetCollideIterations(e.data);
      break;
  }
```

- [ ] **Step 7: worker 实现 handler**

在 `handleSetForce` 函数定义之后插入：

```ts
// ── Set Collide Iterations（移动时降质）──

function handleSetCollideIterations(msg: { value: number }) {
  // 仅作用于拖拽阶段的 sim；ML 阶段的各层模拟是独立变量，不受影响
  (sim?.force('collide') as ForceCollide<WorkerNode> | undefined)?.iterations(msg.value);
}
```

- [ ] **Step 8: GraphPage 拖拽开始时调用 setMotionMode(true)**

修改 `handleMouseMove` 阈值块（Task 1 已改过），将：

```ts
      if (!isDragging && moveDist > DRAG_THRESHOLD) {
        isDragging = true;
        // 移动时降质（见 docs/superpowers/specs/2026-07-25-graph-motion-quality-design.md）：
        // 隐藏标签——每帧渲染大头（文字测量 + 纹理上传），松手立即恢复。
        // 超过阈值才降质，避免单击选中时标签闪烁。
        renderer.setSetting('renderLabels', false);
      }
```

替换为：

```ts
      if (!isDragging && moveDist > DRAG_THRESHOLD) {
        isDragging = true;
        // 移动时降质（见 docs/superpowers/specs/2026-07-25-graph-motion-quality-design.md）：
        // 1) 隐藏标签——每帧渲染大头（文字测量 + 纹理上传）；
        // 2) collide 迭代 3→1——每 tick 最大 CPU 成本。
        // 松手立即恢复。超过阈值才降质，避免单击选中时标签闪烁。
        renderer.setSetting('renderLabels', false);
        simulation.setMotionMode(true);
      }
```

- [ ] **Step 9: GraphPage 松手时调用 setMotionMode(false)**

修改 `handleMouseUp` 的恢复块（Task 1 已改过），将：

```ts
        tileIsolatedNodes(graph);
        simulation.wake(0.3);
        // 恢复移动时降质：先开标签，下面的 refresh() 让标签立即渲染回来
        renderer.setSetting('renderLabels', true);
        renderer.refresh();
```

替换为：

```ts
        tileIsolatedNodes(graph);
        simulation.wake(0.3);
        // 恢复移动时降质：标签回来 + collide 迭代回到 3；
        // 先恢复再 refresh()，让标签立即渲染回来
        renderer.setSetting('renderLabels', true);
        simulation.setMotionMode(false);
        renderer.refresh();
```

- [ ] **Step 10: 类型检查**

Run: `cd /Users/albert/workspace/Molio-refactor-knowledge-graph-performance-multi-level && pnpm typecheck`
Expected: 无错误

- [ ] **Step 11: E2E 回归**

Run: `cd apps/web && npx playwright test graph.spec.ts`
Expected: 全部通过（含 Task 1 的降质测试与原有 3 个结构测试）

- [ ] **Step 12: 提交**

```bash
git add apps/web/src/components/graph/useSimulation.ts apps/web/src/components/graph/simulation.worker.ts apps/web/src/components/graph/GraphPage.tsx
git commit -m "perf(web): 拖拽时 collide 迭代 3→1，降主线程 tick 成本

SimulationAPI 新增 setMotionMode：主线程直改 forceCollide.iterations，
Worker 模式走 setCollideIterations 消息，行为对齐。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Minimap 拖拽期间跳过重绘

**Files:**
- Modify: `apps/web/src/components/graph/Minimap.tsx`（`Props` 接口、组件签名、`scheduleDraw`）
- Modify: `apps/web/src/components/graph/GraphPage.tsx`（refs 区新增 `interactingRef`、拖拽阈值块、mouseup 恢复块、Minimap JSX）

**Interfaces:**
- Consumes: Task 1/2 的拖拽阈值块与恢复块
- Produces: `Minimap` 新增可选 prop `isInteracting?: () => boolean`，为 `true` 时 `scheduleDraw` 直接跳过；拖拽结束后的首次 `afterRender`（恢复时的 `refresh()` 触发）正常重绘

- [ ] **Step 1: Minimap 增加 isInteracting prop**

修改 `Minimap.tsx`，将：

```ts
interface Props {
  sigma: Sigma | null;
}

export function Minimap({ sigma }: Props) {
```

替换为：

```ts
interface Props {
  sigma: Sigma | null;
  /** 节点拖拽中：跳过重绘，省每帧 ~1-2ms 主线程开销（慢机）；
   *  松手后恢复时的 sigma afterRender 会触发正常重绘 */
  isInteracting?: () => boolean;
}

export function Minimap({ sigma, isInteracting }: Props) {
```

- [ ] **Step 2: scheduleDraw 增加跳过判断**

将：

```ts
    function scheduleDraw() {
      if (scheduled) return;
```

替换为：

```ts
    function scheduleDraw() {
      if (isInteracting?.()) return; // 节点拖拽期间跳过（松手后的 afterRender 恢复重绘）
      if (scheduled) return;
```

- [ ] **Step 3: GraphPage 增加 interactingRef**

修改 `GraphPage.tsx` refs 区，将：

```ts
  const hoveredNodeRef = useRef<string | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
```

替换为：

```ts
  const hoveredNodeRef = useRef<string | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  // 移动时降质标记：节点拖拽期间为 true，传给 Minimap 跳过重绘
  const interactingRef = useRef(false);
```

- [ ] **Step 4: 拖拽开始时置 interactingRef=true**

修改 `handleMouseMove` 阈值块（Task 2 已改过），将：

```ts
        renderer.setSetting('renderLabels', false);
        simulation.setMotionMode(true);
      }
```

替换为：

```ts
        renderer.setSetting('renderLabels', false);
        simulation.setMotionMode(true);
        interactingRef.current = true;
      }
```

- [ ] **Step 5: 松手时置 interactingRef=false**

修改 `handleMouseUp` 恢复块（Task 2 已改过），将：

```ts
        renderer.setSetting('renderLabels', true);
        simulation.setMotionMode(false);
        renderer.refresh();
```

替换为：

```ts
        renderer.setSetting('renderLabels', true);
        simulation.setMotionMode(false);
        interactingRef.current = false; // 先于 refresh()：随后的 afterRender 能正常重绘 minimap
        renderer.refresh();
```

- [ ] **Step 6: Minimap JSX 传入 isInteracting**

将：

```tsx
        {sigmaInstance && <Minimap sigma={sigmaInstance} />}
```

替换为：

```tsx
        {sigmaInstance && <Minimap sigma={sigmaInstance} isInteracting={() => interactingRef.current} />}
```

- [ ] **Step 7: 类型检查**

Run: `cd /Users/albert/workspace/Molio-refactor-knowledge-graph-performance-multi-level && pnpm typecheck`
Expected: 无错误

- [ ] **Step 8: E2E 回归（含 minimap 专项）**

Run: `cd apps/web && npx playwright test graph.spec.ts graph-minimap.spec.ts`
Expected: 全部通过

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/components/graph/Minimap.tsx apps/web/src/components/graph/GraphPage.tsx
git commit -m "perf(web): 拖拽期间跳过 Minimap 重绘

Minimap 新增 isInteracting prop，节点拖拽中 scheduleDraw 直接跳过，
松手后 afterRender 恢复重绘。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 全量回归 + 手工验证 + 文档入库

**Files:**
- Create（入库已有文件）: `docs/superpowers/specs/2026-07-25-graph-motion-quality-design.md`、`docs/superpowers/plans/2026-07-25-graph-motion-quality.md`

- [ ] **Step 1: 全量跑 graph 区域 E2E**

Run: `cd apps/web && npx playwright test graph.spec.ts graph-minimap.spec.ts graph-search.spec.ts graph-settings.spec.ts`
Expected: 全部通过（无回归）

- [ ] **Step 2: 本机手工验证（M5 Pro）**

前置：`pnpm dev` 运行中，浏览器打开 http://localhost:5173/graph，选中含「资治通鉴」或任意有数据的 vault。

验证项：
1. 拖拽节点：拖动瞬间标签消失，松手标签立即恢复，无闪烁；
2. 单击节点（不拖动）：标签无闪烁，选中聚焦动画正常；
3. 平移/缩放画布：移动中标签隐藏（`hideLabelsOnMove`），停止后恢复；
4. 拖拽期间右下角 Minimap 冻结，松手后恢复更新；
5. 拖拽手感与之前一致（全流动、松手收敛、孤立节点重铺圆环均不受影响）。

- [ ] **Step 3: 设计文档与计划入库**

```bash
git add docs/superpowers/specs/2026-07-25-graph-motion-quality-design.md docs/superpowers/plans/2026-07-25-graph-motion-quality.md
git commit -m "docs(web): 图谱移动时自动降质设计文档与实现计划

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: 通知测试同事复测（可选）**

请测试同事在同一台 Windows 机器上拉取本分支，打开 692 节点的「资治通鉴」库拖拽验证卡顿是否缓解。若需量化数据，可临时在 `handleMouseMove` 的 `isDragging` 分支插入 rAF 帧时统计（`performance.now()` 差值）打印到 console，收集后移除——不入库。

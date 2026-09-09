# Manual Scenario: Clicking a Node in the Graph (三处图谱统一交互)

> Non-automatable interaction for all three graph hosts. The graph is rendered by a PixiJS
> (WebGL) canvas, so node hit-testing cannot be asserted via Playwright. This documents the
> ONE such behavior.

## Why this is not auto-tested

The graph canvas is a WebGL render target, not a DOM element. Playwright can query the
topbar/search/buttons (real DOM) but cannot inspect or dispatch to the canvas-drawn nodes,
so "click/double-click a canvas node" is provable only by a human/AI driving the real app.

## Behavior being verified (统一后)

The same interaction applies to **all three hosts** — 全量图 (NavRail 图谱 → main graph tab,
no scope), 局部知识图谱 (main graph tab with `graphScope`), and 对照 (split-view companion):

1. **Single-click** on a node **selects it and highlights its connections** — it **never**
   navigates away from the graph. With `centerOnSelect` (局部知识图谱 only, i.e. a scope is
   active) it additionally **centers** the node with a smooth animation; the full graph and
   the companion only select/highlight, leaving the camera untouched.
2. **Double-click** on a node **opens that node's file** in the knowledge base (main pane),
   switching away from the graph tab. Dead-link nodes create a blank file and open it.
3. **Double-click on empty canvas** fits the whole graph into view.
4. **Drag** (>4px) moves the node with fluid neighbor motion; a click is only recognized when
   press-to-release is `<500ms` and movement `≤4px`.

This matches the settings-panel legend (图例 tab): 「单击选中 · 高亮关联」/「双击节点 · 打开文章」.

## Steps

**Precondition**: `pnpm dev` running (daemon :3100, web :5173). A vault with at least two
linked files, e.g. `notes/alpha.md` (`[[beta]]`) and `notes/beta.md` (`[[alpha]] [[gamma]]`).

### A. 全量图（无 scope）

1. Open `http://localhost:5173/knowledge?vault=<id>`.
2. NavRail → 图谱 (`data-view="graph"`). No `graph-scope-back` button.
3. **Single-click** the `beta` node. Then **double-click** it.

### B. 局部知识图谱（有 scope）

4. Right-click the `notes/` folder (or `alpha.md`) in the tree → **查看局部图谱**
   (`kb-ctx-local-graph`). The main graph tab opens showing a scoped sub-graph and a
   **回到全量图** (`graph-scope-back`) button.
5. **Single-click** the `beta` node. Then **double-click** it.

### C. 对照（副视图）

6. Right-click a file tab → **图谱对照** (`tab-split-graph`). The companion pane shows the
   main doc's 1-hop neighborhood.
7. **Single-click** the `beta` node. Then **double-click** it.

## Expected result

- **Single-click** selects + highlights in every host: the clicked node stays focused, its
  neighbors stay bright and unconnected nodes dim — and **the graph tab stays put; no file
  opens**. In the 局部知识图谱 case (B) the camera additionally centers the node.
- **Double-click** opens `notes/beta.md` in the main pane (active tab becomes `beta.md`),
  switching away from the graph tab. In the companion case (C) the file opens in the **main**
  pane, not inside the companion.
- The `graph-scope-back` button remains present while a scope is active (it is a scope
  affordance, unaffected by node clicking); clicking it clears the scope and returns to the
  full graph.

## Pass criteria

Single-click selects/highlights without navigating in all three hosts (centering only in the
scoped 局部知识图谱); double-click opens the file everywhere; scope-back remains available.
Record any deviation.

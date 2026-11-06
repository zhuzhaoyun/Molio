# Manual Scenario: Clicking a Node in the Graph (三处图谱统一交互)

> Non-automatable interaction for all three graph hosts. The graph is rendered by a PixiJS
> (WebGL) canvas, so node hit-testing cannot be asserted via Playwright. This documents the
> ONE such behavior.

## Why this is not auto-tested

The graph canvas is a WebGL render target, not a DOM element. Playwright can query the
topbar/search/buttons (real DOM) but cannot inspect or dispatch to the canvas-drawn nodes,
so "hover/click a canvas node" is provable only by a human/AI driving the real app.

## Behavior being verified

The interaction is **identical in all three hosts** — 全量图 (NavRail 图谱 → main graph tab,
no scope), 局部知识图谱 (main graph tab with `graphScope`), and 对照 (split-view companion):

1. **Hover** a node → it and its connections **highlight** (neighbors stay bright, unconnected
   nodes dim, connected edges render on top). This is the ONLY highlight affordance — there is
   no click-to-select.
2. **Single-click** a node → **opens that node's file** in the knowledge base main pane,
   switching away from the graph tab. Dead-link nodes create a blank file and open it.
3. **Double-click on empty canvas** → fits the whole graph into view.
4. **Drag** (>4px) moves the node with fluid neighbor motion; a click is only recognized when
   press-to-release is `<500ms` and movement `≤4px`.

Rationale: this matches the settings-panel legend (图例 tab) 「悬停节点 · 高亮关联」/「单击节点 ·
打开文章」 and the native Obsidian graph model (hover highlights, click opens). Click-to-select
is deliberately NOT offered — it duplicates hover highlighting, and "look at a node's
neighborhood" is already served by the dedicated 局部知识图谱 view.

## Steps

**Precondition**: `pnpm dev` running (daemon :3100, web :5173). A vault with at least two
linked files, e.g. `notes/alpha.md` (`[[beta]]`) and `notes/beta.md` (`[[alpha]] [[gamma]]`).

### A. 全量图（无 scope）

1. Open `http://localhost:5173/knowledge?vault=<id>`.
2. NavRail → 图谱 (`data-view="graph"`). No `graph-scope-back` button.
3. **Hover** the `beta` node, then **single-click** it.

### B. 局部知识图谱（有 scope）

4. Right-click the `notes/` folder (or `alpha.md`) in the tree → **查看局部图谱**
   (`kb-ctx-local-graph`). The main graph tab opens showing a scoped sub-graph and a
   **回到全量图** (`graph-scope-back`) button.
5. **Hover** the `beta` node, then **single-click** it.
6. After the file opens, click the graph tab again, then click **回到全量图** (`graph-scope-back`).

### C. 对照（副视图）

6. Right-click a file tab → **图谱对照** (`tab-split-graph`). The companion pane shows the
   main doc's 1-hop neighborhood.
7. **Hover** the `beta` node, then **single-click** it.

## Expected result

- **Hover** highlights the node + its connections in every host; moving the pointer away
  (after the ~150ms hysteresis) restores the graph.
- **Single-click** opens `notes/beta.md` in the main pane (active tab becomes `beta.md`),
  switching away from the graph tab. In the companion case (C) the file opens in the **main**
  pane, not inside the companion. No host requires a double-click to open a node.
- The `graph-scope-back` button remains present while a scope is active (it is a scope
  affordance, unaffected by node clicking); clicking it clears the scope and returns to the
  full graph.
- **进入/离开局部图都会重新取景**：切换瞬间立即落位（先给个合理视角），随后仿真收敛时**平滑过渡到
  正确取景**（进入：圆心居中/子图 fit；返回：整图 fit）—— 与「关掉图谱 tab 再打开」同一观感，
  不会停在上一张图的缩放/平移位置，也不会出现「布局还在动就取景」导致的错误视角。
  若在收敛前自己拖动/缩放了画布，自动取景让位于用户操作（不抢视口）。

## Pass criteria

Hover highlights connections in all three hosts; a single click opens the file everywhere
(no double-click needed, no click-to-select state); scope-back remains available. Record any
deviation.

# Manual Scenario: Clicking a Node in the Local Knowledge Graph (局部知识图谱)

> Non-automatable interaction for the KB main graph tab's scoped sub-graph (graphScope).
> The graph is rendered by a PixiJS (WebGL) canvas, so node hit-testing cannot be asserted
> via Playwright. This documents the ONE such behavior.

## Why this is not auto-tested

The graph canvas is a WebGL render target, not a DOM element. Playwright can query the
topbar/search/buttons (real DOM) but cannot inspect or dispatch to the canvas-drawn nodes,
so "click/double-click a canvas node" is provable only by a human/AI driving the real app.

## Behavior being verified

In the **main graph tab** (`[data-testid="kb-graph-pane"]`) when a scope is active
(`graphScope` is non-null — dir-scope or file-scope), the engine runs with `nodeClickFocus`:

1. **Single-click** on a node only **centers/focuses** it — smooth zoom-to-fit animation,
   **does not** navigate away from the graph.
2. **Double-click** on a node **opens that node's file** in the knowledge base (main pane),
   switching away from the graph tab.

Without a scope (full graph, `graphScope === null`), the engine runs with `nodeClickFocus`
disabled, so a single-click already opens the file (the legacy full-graph behavior).

The split-view **companion** pane (`[data-testid="kb-companion-pane"]`) is pure file-scope
and does **not** use the click-to-focus mode — it keeps the single-click-opens-file behavior.
It never shows a scope-back button.

## Steps

**Precondition**: `pnpm dev` running (daemon :3100, web :5173). A vault with at least two
linked files, e.g. `notes/alpha.md` (`[[beta]]`) and `notes/beta.md` (`[[alpha]] [[gamma]]`).

1. Open `http://localhost:5173/knowledge?vault=<id>`.
2. Right-click the `notes/` folder (or `alpha.md`) in the tree → **查看局部图谱**
   (`kb-ctx-local-graph`). The main graph tab opens showing a scoped sub-graph and a
   **回到全量图** (`graph-scope-back`) button.
3. On the graph canvas, **single-click** the `beta` node.
4. Then **double-click** the `beta` node.

## Expected result

- **Single-click** centers/focuses the node (smooth zoom), and the graph stays on the graph
  tab — no file is opened, no navigation happens.
- **Double-click** opens `notes/beta.md` in the main pane (active tab becomes `beta.md`),
  switching away from the graph tab.
- The `graph-scope-back` button remains present while a scope is active (it is a scope
  affordance, unaffected by node clicking); clicking it clears the scope and returns to the
  full graph.

## Pass criteria

Single-click focuses without navigating; double-click opens the file; scope-back remains
available. Record any deviation.

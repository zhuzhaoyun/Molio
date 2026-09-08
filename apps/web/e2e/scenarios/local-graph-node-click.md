# Manual Scenario: Clicking a Node in the Local-Graph Companion

> Non-automatable interaction for the KB split-view local graph (graphScope).
> The companion pane graph is rendered by a PixiJS (WebGL) canvas, so node hit-testing
> cannot be asserted via Playwright. This documents the ONE such behavior.

## Why this is not auto-tested

The graph canvas is a WebGL render target, not a DOM element. Playwright can query the
topbar/search/buttons (real DOM) but cannot inspect or dispatch to the canvas-drawn nodes,
so "click a canvas node → main pane navigates" is provable only by a human/AI driving the
real app.

## Behavior being verified

In `file-scope`, clicking a neighbor node in the companion pane:
1. Navigates the **main pane** to that node's file.
2. Re-anchors the companion to that file as its **file-scope** (the clicked node becomes the
   new focus center, 1-hop neighborhood).
3. `graph-scope-back` stays **absent** because the scope is `type: 'file'` (that button is a
   `dir`-scope-only affordance).

## Steps

**Precondition**: `pnpm dev` running (daemon :3100, web :5173). A vault with at least two
linked files, e.g. `notes/alpha.md` (`[[beta]]`) and `notes/beta.md`.

1. Open `http://localhost:5173/knowledge?vault=<id>`.
2. Open `notes/alpha.md` in the main pane (expand `notes/`, click `alpha.md`).
3. Right-click the active file tab → **图谱对照** (`tab-split-graph`). The companion pane opens
   showing alpha's 1-hop local graph (alpha + beta) as file-scope.
4. Click the **beta** node on the companion canvas.

## Expected result

- The **main pane** navigates to `notes/beta.md` (active tab becomes `beta.md`).
- The **companion** re-anchors to beta's 1-hop neighborhood (beta + alpha + gamma) as file-scope.
- **No** `graph-scope-back` button appears in the companion topbar (scope is file-type, not dir).
- Optionally click a node that connects to a dead link (e.g. `[[unknown]]`): the companion creates
  a placeholder node; clicking it opens a new file and re-anchors file-scope onto it.

## Pass criteria

Main pane shows the clicked file's tab active; companion redisplays the local graph centered on
that file; no scope-back button. Record any deviation.

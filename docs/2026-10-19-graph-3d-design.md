# 3D knowledge graph — first release

User approved the first-release scope in this chat on 2026-10-19.

## Scope and experience
Add a persisted 2D/3D switch to the existing graph tab. Keep 2D as the first-run default and preserve existing 2D behavior. 3D uses actual filtered graph nodes and wikilink edges, no invented relations. Rotate, pan, zoom and reset the camera. Clicking a node focuses its one-hop neighborhood and opens a read-only document excerpt panel with an explicit Open document action. Search selects the same node and preview. Unresolved nodes explain that no document exists; they must not create files on selection. Clusters emerge from real link forces, not claimed semantic or biological brain mapping.

## Architecture
Keep Pixi's 2D lifecycle intact; pause and hide it while 3D is selected. Lazy-load a separate ThreeGraphView backed by 3d-force-graph. Reuse engineData filters, theme colors and node type palette. Keep mutable simulation copies separate from API data. Preserve positions on ordinary data updates; clear state on vault/scope changes. Pause 3D while hidden, destroy GPU resources/listeners on unmount. Display initialization errors without silently replacing the selected 3D preference. No new backend routes or AI extraction.

## Interaction boundaries
The existing 2D settings, minimap and export keep their semantics. In 3D, hide 2D-only minimap/export and either implement settings meaningfully or explicitly separate 2D force controls. Expose concise rotation/pan/zoom help, reset view, keyboard-accessible search and preview actions. Honor reduced motion. Use existing app theme variables; root DESIGN.md is landing-page-specific, so retain the graph's established light/dark palette.

## Verification
E2E tests must exercise mode switching/persistence, actual WebGL canvas, noncoplanar positions, search selection/neighborhood/preview, document opening, filtering or data refresh, hidden-tab pause, failure recovery and repeated switching without extra canvases. Run relevant existing graph suites, web unit tests, web typecheck and web build. Report hardware-scale performance as unmeasured unless explicitly benchmarked. Keep all work in the created worktree and route integration through PR; never push main.

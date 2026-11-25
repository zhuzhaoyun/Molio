# Public Wiki and knowledge graph

Molio can expose selected Wiki pages while keeping the management workspace and the rest of the vault private. For self-hosted use, configure the administrator and HTTPS first; see [administrator access](admin-access.md) and [server deployment](server-deployment.md).

## Publish selected pages

1. Open a knowledge base and select the **公开 Wiki** button in the file panel toolbar.
2. Select Markdown pages under `wiki/`. Use **全选** to select all listed pages, or choose pages individually.
3. Create a preview, review its warnings and confirm publication. Batch publication uses the same preview and confirmation step.
4. Enable visitor access with the site switch.
5. Open **Public Wiki** from the navigation rail, or visit `/public/wiki`. The graph is available at `/public/graph`.

The public site binds to one vault. Withdraw its published pages before switching the site to another vault. It is initially disabled and contains no published pages.

## Update or withdraw

Publishing creates a snapshot. Editing, renaming or deleting a source file does not update the public content automatically. Select and republish a page to update its snapshot. Publication uses an expected revision; if another action has changed the site, refresh the status and preview again.

Withdraw a page individually or select published pages and use batch withdrawal. Published snapshots whose source files were deleted or renamed remain listed for withdrawal; they cannot be republished until a source exists. Closing the site disables visitor access. Requests for withdrawn pages and stale revisions return an unavailable response rather than private source content. Public responses use `Cache-Control: no-store`; content already copied by a visitor cannot be recalled.

## Public content boundary

Visitors read dedicated public endpoints for site metadata, pages, graph data and copied assets. Source paths, management APIs, source-file endpoints and private event streams remain behind the administrator boundary in server mode. Anonymous access is allowed only for the explicitly listed public read routes.

Links and graph edges are projected against the published page set. Unsupported or unavailable images become placeholders. Supported image formats are PNG, JPEG, GIF and WebP; publication validates paths and image signatures. The public renderer sanitizes the generated HTML and removes active content such as scripts.

Source size is checked before reading Markdown, and the preview accounts for the complete retained and selected revision incrementally. Identical image bytes share one asset and budget entry, including when one page references multiple copies.

Default limits per publication are 1,000 pages, 20,000 graph edges, 512 KiB Markdown per page, 50 assets per page, 8 MiB per asset and 48 MiB total revision data.

## Graph interaction

The public graph uses the same rendering engine as the knowledge-base graph. Drag to pan, use the wheel or pinch gesture to zoom, or use the zoom and fit buttons. The graph contains the published page set and its public relationships.

## Hosting

These routes are served by the running Molio instance and its HTTPS proxy. Publishing a page does not upload a static site to another provider. Configure a reachable HTTPS deployment if visitors need to access it from other devices.

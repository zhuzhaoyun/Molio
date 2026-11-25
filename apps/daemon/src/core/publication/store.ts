import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { PublicAsset, PublicGraph, PublicPage, PublicSite, PublicationPreview, PublicationStatus, PublicationRevision } from '@molio/contracts';
import { DEFAULT_PUBLICATION_LIMITS, buildPublicationDraft, readPublicationSource, type PublicationDraft, type PublicationDraftAsset, type PublicationLimits, type PublicationSourcePage, type PublicationReadBudget } from './project.js';
import { migratePublication } from './migration.js';

const PREVIEW_TTL_MS = 10 * 60 * 1000;

interface PublicationStateRow { enabled: number; revision: number; vault_id: string | null }
interface InternalPageRow { page_id: string; title: string; markdown: string; source_path: string; source_markdown: string; project_markdown: string; assets: PublicationDraftAsset[] }
export interface PublicationStorePreviewRequest { vaultId: string; vaultPath: string; selectedPaths: string[] }
interface Candidate { id: string; sessionKey: string; expectedRevision: number; expiresAt: number; draft: PublicationDraft; selectedPages: PublicationDraft['pages'] }

export function createPublicationStore(
  db: Database.Database,
  options: { now?: () => number; limits?: Partial<PublicationLimits> } = {},
) {
  migratePublication(db);
  const now = options.now ?? Date.now;
  const limits = { ...DEFAULT_PUBLICATION_LIMITS, ...options.limits };
  let candidate: Candidate | null = null;

  const getState = (): PublicationStateRow => db.prepare('SELECT enabled, revision, vault_id FROM publication_state WHERE id = 1').get() as PublicationStateRow;
  const getInternalPages = (revision = getState().revision): InternalPageRow[] => {
    const pages = db.prepare(`
      SELECT p.page_id, p.title, p.markdown, a.source_path, a.source_markdown, a.project_markdown
      FROM publication_pages p JOIN publication_page_admin a USING (revision, page_id)
      WHERE p.revision = ? ORDER BY p.page_id
    `).all(revision) as Array<Omit<InternalPageRow, 'assets'>>;
    const assetsByPage = new Map<string, PublicationDraftAsset[]>();
    const assetRows = db.prepare(`
      SELECT assets.asset_id AS id, aa.source_path AS sourcePath,
        assets.content_type AS contentType, assets.body AS bytes,
        (SELECT json_group_array(pa.page_id) FROM publication_page_assets pa
          WHERE pa.revision = assets.revision AND pa.asset_id = assets.asset_id) AS pageIds
      FROM publication_assets assets
      JOIN publication_asset_admin aa USING (revision, asset_id)
      WHERE assets.revision = ? ORDER BY assets.asset_id
    `).iterate(revision) as IterableIterator<{ pageIds: string } & PublicationDraftAsset>;
    for (const row of assetRows) {
      const asset = { id: row.id, sourcePath: row.sourcePath, contentType: row.contentType, bytes: row.bytes };
      for (const pageId of JSON.parse(row.pageIds) as string[]) {
        const assets = assetsByPage.get(pageId) ?? [];
        assets.push(asset); assetsByPage.set(pageId, assets);
      }
    }
    return pages.map((page) => ({ ...page, assets: assetsByPage.get(page.page_id) ?? [] }));
  };

  function assertRevision(expectedRevision: number): PublicationStateRow {
    const state = getState();
    if (state.revision !== expectedRevision) throw new Error('Publication revision conflict');
    return state;
  }

  function safeSourcePath(vaultPath: string, requested: string): { sourcePath: string; absolutePath: string } {
    if (typeof requested !== 'string' || requested.includes('\\') || requested.includes('\0') || path.posix.isAbsolute(requested)) {
      throw new Error('Invalid Wiki source path');
    }
    const normalized = path.posix.normalize(requested);
    if (normalized !== requested || !normalized.startsWith('wiki/') || !normalized.toLowerCase().endsWith('.md')) {
      throw new Error('Publication pages must be Markdown files under wiki/');
    }
    const root = realpathSync(vaultPath);
    const lexical = path.resolve(root, ...normalized.split('/'));
    const actual = realpathSync(lexical);
    const relative = path.relative(root, actual).split(path.sep).join('/');
    if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative) || !relative.startsWith('wiki/') || !relative.toLowerCase().endsWith('.md')) {
      throw new Error('Wiki source path escapes the Wiki directory');
    }
    const stat = statSync(actual);
    if (!stat.isFile()) throw new Error('Wiki source is not a file');
    return { sourcePath: relative, absolutePath: actual };
  }

  function createDraft(request: PublicationStorePreviewRequest): { draft: PublicationDraft; selectedPages: PublicationDraft['pages'] } {
    if (!request.vaultId || request.selectedPaths.length === 0) throw new Error('Select at least one Wiki page');
    if (new Set(request.selectedPaths).size !== request.selectedPaths.length) throw new Error('Duplicate Wiki source path');
    if (request.selectedPaths.length > limits.maxPages) throw new Error(`Publication exceeds ${limits.maxPages} pages`);
    const state = getState();
    const current = getInternalPages();
    if (state.vault_id && state.vault_id !== request.vaultId && current.length) {
      throw new Error('Close and clear the current public site before changing vault');
    }
    const requestedSources = request.selectedPaths.map((requested) => safeSourcePath(request.vaultPath, requested));
    const selectedSet = new Set(requestedSources.map((source) => source.sourcePath));
    const retained: PublicationSourcePage[] = current
      .filter((page) => !(state.vault_id === request.vaultId && selectedSet.has(page.source_path)))
      .map((page) => ({
        id: page.page_id, sourcePath: page.source_path, sourceMarkdown: page.source_markdown,
        projectMarkdown: page.project_markdown, title: page.title, assets: page.assets,
      }));
    if (retained.length + requestedSources.length > limits.maxPages) throw new Error(`Publication exceeds ${limits.maxPages} pages`);
    const digests = new Map<string, string>();
    const digestFor = (asset: PublicationDraftAsset) => {
      let digest = digests.get(asset.id);
      if (!digest) { digest = createHash('sha256').update(asset.bytes).digest('hex'); digests.set(asset.id, digest); }
      return digest;
    };
    const budget: PublicationReadBudget = { remainingBytes: limits.maxRevisionBytes, assetsByDigest: new Map() };
    for (const page of retained) {
      budget.remainingBytes -= Buffer.byteLength(page.sourceMarkdown, 'utf8');
      for (const asset of page.assets ?? []) {
        const digest = digestFor(asset);
        if (!budget.assetsByDigest.has(digest)) { budget.remainingBytes -= asset.bytes.length; budget.assetsByDigest.set(digest, asset); }
      }
    }
    if (budget.remainingBytes < 0) throw new Error(`Publication exceeds ${limits.maxRevisionBytes} bytes`);
    const assetIdsByDigest = new Map<string, string>();
    for (const page of current) for (const asset of page.assets) {
      const digest = digestFor(asset);
      assetIdsByDigest.set(digest, asset.id);
    }
    const identity = db.prepare('SELECT page_id FROM publication_source_ids WHERE vault_id = ? AND source_path = ?');
    const upserted = requestedSources.map(({ sourcePath }) => {
      const existing = identity.get(request.vaultId, sourcePath) as { page_id: string } | undefined;
      const id = existing?.page_id ?? randomUUID();
      return readPublicationSource(request.vaultPath, sourcePath, id, (_assetPath, digest) => {
        const existingAssetId = assetIdsByDigest.get(digest);
        if (existingAssetId) return existingAssetId;
        const newId = randomUUID();
        assetIdsByDigest.set(digest, newId);
        return newId;
      }, limits, budget);
    });
    const draft = buildPublicationDraft(request.vaultId, [...retained, ...upserted], limits);
    return { draft, selectedPages: draft.pages.filter((page) => selectedSet.has(page.sourcePath)) };
  }

  function persistDraft(draft: PublicationDraft, expectedRevision: number, enabled?: boolean): PublicationRevision {
    return db.transaction(() => {
      const state = assertRevision(expectedRevision);
      const revision = state.revision + 1;
      const insertPage = db.prepare('INSERT INTO publication_pages (revision, page_id, title, markdown) VALUES (?, ?, ?, ?)');
      const insertAdmin = db.prepare('INSERT INTO publication_page_admin (revision, page_id, source_path, source_markdown, project_markdown) VALUES (?, ?, ?, ?, ?)');
      const insertEdge = db.prepare('INSERT INTO publication_edges (revision, source_id, target_id) VALUES (?, ?, ?)');
      const upsertIdentity = db.prepare('INSERT INTO publication_source_ids (vault_id, source_path, page_id) VALUES (?, ?, ?) ON CONFLICT(vault_id, source_path) DO UPDATE SET page_id = excluded.page_id');
      const insertAsset = db.prepare('INSERT INTO publication_assets (revision, asset_id, content_type, body) VALUES (?, ?, ?, ?)');
      const insertPageAsset = db.prepare('INSERT INTO publication_page_assets (revision, page_id, asset_id) VALUES (?, ?, ?)');
      const insertAssetAdmin = db.prepare('INSERT INTO publication_asset_admin (revision, asset_id, source_path) VALUES (?, ?, ?)');
      const insertedAssets = new Set<string>();
      for (const page of draft.pages) {
        insertPage.run(revision, page.id, page.title, page.markdown);
        insertAdmin.run(revision, page.id, page.sourcePath, page.sourceMarkdown, page.projectMarkdown);
        upsertIdentity.run(draft.vaultId, page.sourcePath, page.id);
        for (const asset of page.assets) {
          const exists = insertedAssets.has(asset.id);
          if (!exists) {
            insertedAssets.add(asset.id);
            insertAsset.run(revision, asset.id, asset.contentType, asset.bytes);
            insertAssetAdmin.run(revision, asset.id, asset.sourcePath);
          }
          insertPageAsset.run(revision, page.id, asset.id);
        }
      }
      for (const edge of draft.graph.edges) insertEdge.run(revision, edge.source, edge.target);
      db.prepare('UPDATE publication_state SET revision = ?, vault_id = ?, enabled = ? WHERE id = 1')
        .run(revision, draft.vaultId, enabled ?? state.enabled);
      db.prepare('DELETE FROM publication_pages WHERE revision = ?').run(state.revision);
      db.prepare('DELETE FROM publication_assets WHERE revision = ?').run(state.revision);
      db.prepare('DELETE FROM publication_edges WHERE revision = ?').run(state.revision);
      return { revision, enabled: enabled ?? state.enabled === 1, pageCount: draft.pages.length };
    })();
  }

  return {
    getPublicSite(): PublicSite {
      return db.transaction(() => {
        const state = getState();
        const pages = state.enabled === 1
          ? db.prepare('SELECT page_id AS id, title FROM publication_pages WHERE revision = ? ORDER BY title COLLATE NOCASE, page_id').all(state.revision) as Array<{ id: string; title: string }>
          : [];
        return { enabled: state.enabled === 1, revision: state.revision, pages };
      })();
    },
    getAdminStatus(vaultId: string): PublicationStatus {
      const state = getState();
      const rows = db.prepare(`
        SELECT page_id AS id, title, source_path AS sourcePath
        FROM publication_pages p JOIN publication_page_admin a USING (revision, page_id)
        WHERE p.revision = ?
      `).all(state.revision) as Array<{ id: string; title: string; sourcePath: string }>;
      const identities = db.prepare('SELECT source_path AS sourcePath, page_id AS id FROM publication_source_ids WHERE vault_id = ?').all(vaultId) as Array<{ sourcePath: string; id: string }>;
      const publishedByPath = new Map(rows.map((page) => [page.sourcePath, page]));
      return {
        enabled: state.enabled === 1,
        revision: state.revision,
        vaultId: state.vault_id,
        pages: identities.map((identity) => {
          const published = publishedByPath.get(identity.sourcePath);
          return { id: identity.id, title: published?.title ?? path.posix.basename(identity.sourcePath, '.md'), sourcePath: identity.sourcePath, published: !!published };
        }).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
      };
    },
    createPreview(sessionKey: string, request: PublicationStorePreviewRequest): PublicationPreview {
      if (!sessionKey) throw new Error('An authenticated session is required');
      const built = createDraft(request);
      const state = getState();
      const expiresAt = now() + PREVIEW_TTL_MS;
      const id = randomUUID();
      candidate = { id, sessionKey, expectedRevision: state.revision, expiresAt, draft: built.draft, selectedPages: built.selectedPages };
      return {
        id,
        expectedRevision: state.revision,
        expiresAt,
        pageCount: built.draft.pages.length,
        totalBytes: built.draft.totalBytes,
        pages: built.selectedPages.map((page) => ({
          id: page.id, title: page.title, sourcePath: page.sourcePath, markdown: page.markdown,
          warnings: page.warnings,
          assets: page.assets.map((asset) => ({ id: asset.id, sourcePath: asset.sourcePath, contentType: asset.contentType, size: asset.bytes.length })),
        })),
        warnings: built.draft.warnings,
      };
    },
    commitPreview(sessionKey: string, previewId: string, expectedRevision: number): PublicationRevision {
      if (!candidate || candidate.id !== previewId) throw new Error('Publication preview is unavailable');
      if (candidate.sessionKey !== sessionKey) throw new Error('Publication preview belongs to another session');
      if (now() >= candidate.expiresAt) { candidate = null; throw new Error('Publication preview expired'); }
      if (candidate.expectedRevision !== expectedRevision) throw new Error('Publication preview revision conflict');
      const committed = persistDraft(candidate.draft, expectedRevision);
      candidate = null;
      return committed;
    },
    withdrawPages(expectedRevision: number, pageIds: string[]): PublicationRevision {
      const state = assertRevision(expectedRevision);
      const current = getInternalPages(state.revision);
      const remaining = current.filter((page) => !pageIds.includes(page.page_id));
      if (remaining.length === current.length) throw new Error('No published pages selected for withdrawal');
      const sources = remaining.map((page) => ({
        id: page.page_id, sourcePath: page.source_path, sourceMarkdown: page.source_markdown,
        projectMarkdown: page.project_markdown, title: page.title, assets: page.assets,
      }));
      const draft = buildPublicationDraft(state.vault_id ?? '', sources, limits);
      candidate = null;
      return persistDraft(draft, expectedRevision);
    },
    setSiteEnabled(expectedRevision: number, enabled: boolean): PublicationRevision {
      const state = assertRevision(expectedRevision);
      db.prepare('UPDATE publication_state SET enabled = ? WHERE id = 1').run(enabled ? 1 : 0);
      return { revision: state.revision, enabled, pageCount: getInternalPages(state.revision).length };
    },
    getPublicPage(pageId: string, revision: number): PublicPage | null {
      return db.transaction(() => {
        const state = getState();
        if (state.enabled !== 1 || revision !== state.revision) return null;
        const row = db.prepare('SELECT page_id AS id, title, markdown FROM publication_pages WHERE revision = ? AND page_id = ?').get(revision, pageId) as { id: string; title: string; markdown: string } | undefined;
        if (!row) return null;
        const assets = db.prepare('SELECT asset_id FROM publication_page_assets WHERE revision = ? AND page_id = ? ORDER BY asset_id').all(revision, pageId) as Array<{ asset_id: string }>;
        return { revision, id: row.id, title: row.title, markdown: row.markdown, assetIds: assets.map((asset) => asset.asset_id) };
      })();
    },
    getPublicGraph(revision: number): PublicGraph | null {
      return db.transaction(() => {
        const state = getState();
        if (state.enabled !== 1 || revision !== state.revision) return null;
        const nodes = db.prepare('SELECT page_id AS id, title FROM publication_pages WHERE revision = ? ORDER BY page_id').all(revision) as Array<{ id: string; title: string }>;
        const edges = db.prepare('SELECT source_id AS source, target_id AS target FROM publication_edges WHERE revision = ? ORDER BY source_id, target_id').all(revision) as Array<{ source: string; target: string }>;
        return { revision, nodes, edges };
      })();
    },
    getPublicAsset(assetId: string, revision: number): PublicAsset | null {
      return db.transaction(() => {
        const state = getState();
        if (state.enabled !== 1 || revision !== state.revision) return null;
        const row = db.prepare('SELECT content_type AS contentType, body FROM publication_assets WHERE revision = ? AND asset_id = ?').get(revision, assetId) as { contentType: PublicAsset['contentType']; body: Buffer } | undefined;
        return row ? { revision, id: assetId, contentType: row.contentType, bytes: row.body } : null;
      })();
    },
  };
}

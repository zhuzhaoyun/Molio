import type { PublicGraph, PublicPage, PublicSite } from '@molio/contracts';

export interface PublicSnapshotReader {
  site(): Promise<PublicSite>;
  page(id: string, revision: number): Promise<PublicPage>;
  graph(revision: number): Promise<PublicGraph>;
}

export type PublicSnapshotTarget =
  | { kind: 'index' }
  | { kind: 'page'; pageId: string }
  | { kind: 'graph' };

export interface PublicSnapshot {
  site: PublicSite;
  page: PublicPage | null;
  graph: PublicGraph | null;
}

export class PublicSnapshotError extends Error {
  readonly kind: 'closed' | 'unavailable';

  constructor(kind: 'closed' | 'unavailable') {
    super(kind);
    this.name = 'PublicSnapshotError';
    this.kind = kind;
  }
}

class StaleSnapshotError extends Error {}

function isStaleRevision(error: unknown): boolean {
  return error instanceof StaleSnapshotError || (
    typeof error === 'object' && error !== null && 'status' in error && error.status === 404
  );
}

export async function loadPublicSnapshot(reader: PublicSnapshotReader, target: PublicSnapshotTarget): Promise<PublicSnapshot> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const site = await reader.site();
    if (!site.enabled) throw new PublicSnapshotError('closed');
    if (target.kind === 'page' && !site.pages.some((item) => item.id === target.pageId)) {
      throw new PublicSnapshotError('unavailable');
    }
    try {
      if (target.kind === 'page') {
        const page = await reader.page(target.pageId, site.revision);
        if (page.revision !== site.revision) throw new StaleSnapshotError();
        return { site, page, graph: null };
      }
      if (target.kind === 'graph') {
        const graph = await reader.graph(site.revision);
        if (graph.revision !== site.revision) throw new StaleSnapshotError();
        return { site, page: null, graph };
      }
      return { site, page: null, graph: null };
    } catch (error) {
      if (!isStaleRevision(error)) throw error;
      if (attempt === 1) throw new PublicSnapshotError('unavailable');
    }
  }
  throw new PublicSnapshotError('unavailable');
}

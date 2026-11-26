import type {
  PublicGraph, PublicPage, PublicSite, PublicationCommitRequest, PublicationPreview,
  PublicationPreviewRequest, PublicationRevision, PublicationSiteRequest,
  PublicationStatus, PublicationWithdrawRequest,
} from '@molio/contracts';
import { daemonFetch } from './http';

export class PublicationApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'PublicationApiError'; }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new PublicationApiError(response.status, body.error || `Request failed (${response.status})`);
  return body as T;
}

export const publicationApi = {
  async status(vaultId: string): Promise<PublicationStatus> {
    return readJson(await daemonFetch(`/api/publication/status?vaultId=${encodeURIComponent(vaultId)}`));
  },
  async preview(request: PublicationPreviewRequest): Promise<PublicationPreview> {
    return readJson(await daemonFetch('/api/publication/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }));
  },
  async commit(request: PublicationCommitRequest): Promise<PublicationRevision> {
    return readJson(await daemonFetch('/api/publication/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }));
  },
  async withdraw(request: PublicationWithdrawRequest): Promise<PublicationRevision> {
    return readJson(await daemonFetch('/api/publication/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }));
  },
  async setSite(request: PublicationSiteRequest): Promise<PublicationRevision> {
    return readJson(await daemonFetch('/api/publication/site', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }));
  },
};

async function publicJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
  return readJson(response);
}

export const publicApi = {
  site: () => publicJson<PublicSite>('/api/public/site'),
  page: (id: string, revision: number) => publicJson<PublicPage>(`/api/public/pages/${encodeURIComponent(id)}?revision=${revision}`),
  graph: (revision: number) => publicJson<PublicGraph>(`/api/public/graph?revision=${revision}`),
};

import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { PublicationCommitRequest, PublicationSiteRequest, PublicationWithdrawRequest, PublicationPreviewRequest } from '@molio/contracts';
import { ADMIN_COOKIE } from '../core/access/guard.js';
import type { SessionStore } from '../core/access/sessions.js';
import { createPublicationStore } from '../core/publication/store.js';

type PublicationStore = ReturnType<typeof createPublicationStore>;
type VaultPathResolver = (vaultId: string) => string | null;
type PrincipalResolver = (context: Context) => string | null;

export function createPublicationPrincipalResolver(mode: 'local' | 'server', sessions: SessionStore | null): PrincipalResolver {
  return (context) => {
    if (mode === 'local') return 'local-process';
    const token = getCookie(context, ADMIN_COOKIE);
    return token ? sessions?.verify(token)?.digest ?? null : null;
  };
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function errorResponse(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : 'Publication request failed';
  const status = /revision conflict/i.test(message) ? 409 : /unavailable|expired/i.test(message) ? 404 : /session|required/i.test(message) ? 401 : 400;
  return c.json({ error: message }, status as 400);
}

export function publicationRoutes(store: PublicationStore, resolveVaultPath: VaultPathResolver, resolvePrincipal: PrincipalResolver): Hono {
  const app = new Hono();
  app.get('/status', (c) => {
    const vaultId = c.req.query('vaultId');
    if (!vaultId) return c.json({ error: 'vaultId is required' }, 400);
    return c.json(store.getAdminStatus(vaultId));
  });
  app.post('/preview', async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.vaultId !== 'string' || !Array.isArray(body.selectedPaths) || !body.selectedPaths.every((item) => typeof item === 'string')) return c.json({ error: 'Invalid preview request' }, 400);
    const vaultPath = resolveVaultPath(body.vaultId);
    if (!vaultPath) return c.json({ error: 'Vault is unavailable' }, 404);
    try {
      const principal = resolvePrincipal(c);
      if (!principal) return c.json({ error: 'unauthorized' }, 401);
      const request: PublicationPreviewRequest = { vaultId: body.vaultId, selectedPaths: body.selectedPaths as string[] };
      return c.json(store.createPreview(principal, { ...request, vaultPath }));
    } catch (error) { return errorResponse(c, error); }
  });
  app.post('/commit', async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.previewId !== 'string' || !Number.isSafeInteger(body.expectedRevision)) return c.json({ error: 'Invalid commit request' }, 400);
    try {
      const principal = resolvePrincipal(c);
      if (!principal) return c.json({ error: 'unauthorized' }, 401);
      const request: PublicationCommitRequest = { previewId: body.previewId, expectedRevision: body.expectedRevision as number };
      return c.json(store.commitPreview(principal, request.previewId, request.expectedRevision));
    } catch (error) { return errorResponse(c, error); }
  });
  app.post('/withdraw', async (c) => {
    const body = await readJson(c);
    if (!body || !Number.isSafeInteger(body.expectedRevision) || !Array.isArray(body.pageIds) || !body.pageIds.every((item) => typeof item === 'string')) return c.json({ error: 'Invalid withdrawal request' }, 400);
    try {
      const request: PublicationWithdrawRequest = { expectedRevision: body.expectedRevision as number, pageIds: body.pageIds as string[] };
      return c.json(store.withdrawPages(request.expectedRevision, request.pageIds));
    } catch (error) { return errorResponse(c, error); }
  });
  app.post('/site', async (c) => {
    const body = await readJson(c);
    if (!body || !Number.isSafeInteger(body.expectedRevision) || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid site request' }, 400);
    try {
      const request: PublicationSiteRequest = { expectedRevision: body.expectedRevision as number, enabled: body.enabled };
      return c.json(store.setSiteEnabled(request.expectedRevision, request.enabled));
    } catch (error) { return errorResponse(c, error); }
  });
  return app;
}

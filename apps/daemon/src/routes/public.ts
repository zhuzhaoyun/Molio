import { Hono, type Context } from 'hono';
import type { PublicAsset, PublicGraph, PublicPage, PublicSite } from '@molio/contracts';
import { createPublicationStore } from '../core/publication/store.js';

type PublicationStore = ReturnType<typeof createPublicationStore>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unavailable(c: Context) {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.json({ error: 'unavailable' }, 404);
}

function revisionFrom(c: { req: { query(name: string): string | undefined } }): number | null {
  const value = c.req.query('revision');
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

export function publicRoutes(store: PublicationStore): Hono {
  const app = new Hono();
  app.get('/site', (c) => {
    const site: PublicSite = store.getPublicSite();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.json(site.enabled ? site : { ...site, pages: [] });
  });
  app.get('/pages/:id', (c) => {
    const revision = revisionFrom(c);
    const id = c.req.param('id');
    if (!UUID.test(id) || revision === null) return unavailable(c);
    const page: PublicPage | null = store.getPublicPage(id, revision);
    if (!page) return unavailable(c);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.json(page);
  });
  app.get('/graph', (c) => {
    const revision = revisionFrom(c);
    if (revision === null) return unavailable(c);
    const graph: PublicGraph | null = store.getPublicGraph(revision);
    if (!graph) return unavailable(c);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.json(graph);
  });
  app.get('/assets/:id', (c) => {
    const revision = revisionFrom(c);
    const id = c.req.param('id');
    if (!UUID.test(id) || revision === null) return unavailable(c);
    const asset: PublicAsset | null = store.getPublicAsset(id, revision);
    if (!asset) return unavailable(c);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', asset.contentType);
    return c.body(Buffer.from(asset.bytes));
  });
  return app;
}

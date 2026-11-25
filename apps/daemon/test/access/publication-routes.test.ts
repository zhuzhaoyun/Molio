import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createAccessGuard } from '../../src/core/access/guard.js';
import { ADMIN_COOKIE, csrfToken } from '../../src/core/access/guard.js';
import { createSessionStore } from '../../src/core/access/sessions.js';
import type { AccessConfig } from '../../src/core/access/config.js';
import { migratePublication } from '../../src/core/publication/migration.js';
import { createPublicationStore } from '../../src/core/publication/store.js';
import { publicRoutes } from '../../src/routes/public.js';
import { createPublicationPrincipalResolver, publicationRoutes } from '../../src/routes/publication.js';

const origin = 'https://example.test';
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const db = new Database(':memory:');
  migratePublication(db);
  const vaultPath = mkdtempSync(path.join(tmpdir(), 'molio-public-route-'));
  dirs.push(vaultPath);
  mkdirSync(path.join(vaultPath, 'wiki'));
  writeFileSync(path.join(vaultPath, 'wiki/a.md'), '# Public marker\n');
  const store = createPublicationStore(db);
  const adminConfig: AccessConfig = { mode: 'server', host: '127.0.0.1', publicOrigin: origin, username: 'admin', passwordHash: 'unused' };
  const app = new Hono();
  app.use('*', createAccessGuard(adminConfig, null));
  app.route('/api/public', publicRoutes(store));
  app.route('/api/publication', publicationRoutes(store, (vaultId) => vaultId === 'vault-a' ? vaultPath : null, () => 'local-process'));
  return { db, app, store, vaultPath };
}

test('anonymous public routes return only active snapshot data and unavailable IDs uniformly', async () => {
  const { db, app, store, vaultPath } = fixture();
  try {
    const closed = await app.request('/api/public/site');
    assert.deepEqual(await closed.json(), { enabled: false, revision: 0, pages: [] });
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    store.commitPreview('session', preview.id, preview.expectedRevision);
    store.setSiteEnabled(1, true);
    const site = await app.request('/api/public/site');
    const body = await site.json() as { enabled: boolean; revision: number; pages: Array<{ id: string }> };
    assert.equal(body.enabled, true);
    const id = body.pages[0]!.id;
    const page = await app.request(`/api/public/pages/${id}?revision=${body.revision}`);
    assert.equal(page.status, 200);
    const pageBody = await page.json() as { markdown: string; title: string };
    assert.match(pageBody.markdown, /Public marker/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const graph = await app.request(`/api/public/graph?revision=${body.revision}`);
    assert.equal(graph.status, 200);
    const graphBody = await graph.json() as { nodes: unknown[] };
    assert.deepEqual(graphBody.nodes.length, 1);
    const staleGraph = await app.request('/api/public/graph?revision=999');
    assert.equal(staleGraph.status, 404);
    assert.deepEqual(await staleGraph.json(), { error: 'unavailable' });
    const unavailable = await app.request(`/api/public/pages/123e4567-e89b-42d3-a456-426614174000?revision=${body.revision}`);
    assert.equal(unavailable.status, 404);
    assert.deepEqual(await unavailable.json(), await (await app.request(`/api/public/pages/${id}?revision=999`)).json());
    const serialized = JSON.stringify({ site: body, page: pageBody, graph: graphBody });
    assert.doesNotMatch(serialized, /vault-a|sourcePath|source_path|wiki\/a\.md/);
  } finally { db.close(); }
});

test('anonymous API cannot read a closed site and every stale revision is unavailable', async () => {
  const { db, app, store, vaultPath } = fixture();
  try {
    writeFileSync(path.join(vaultPath, 'wiki/a.md'), '# Public marker\n\n![pixel](pixel.png)\n');
    writeFileSync(path.join(vaultPath, 'wiki/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64'));
    const beforePublish = store.getPublicSite();
    assert.deepEqual(beforePublish, { enabled: false, revision: 0, pages: [] });
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    store.commitPreview('session', preview.id, preview.expectedRevision);
    const publishedWhileClosed = store.getPublicSite();
    assert.equal(publishedWhileClosed.revision, beforePublish.revision + 1);
    assert.equal(publishedWhileClosed.enabled, false, 'publishing content does not open the visitor site');

    const opened = store.setSiteEnabled(publishedWhileClosed.revision, true);
    assert.equal(opened.revision, publishedWhileClosed.revision, 'opening changes only the visitor gate');
    const site = await (await app.request('/api/public/site')).json() as { enabled: boolean; revision: number; pages: Array<{ id: string }> };
    assert.equal(site.enabled, true);
    assert.equal(site.revision, publishedWhileClosed.revision);
    const id = site.pages[0]!.id;
    const assetId = store.getPublicPage(id, site.revision)?.assetIds[0];
    assert.ok(assetId, 'fixture publication includes a public image asset');

    const closed = store.setSiteEnabled(site.revision, false);
    assert.equal(closed.revision, site.revision, 'closing changes only the visitor gate');
    const closedSite = await (await app.request('/api/public/site')).json();
    assert.deepEqual(closedSite, { enabled: false, revision: site.revision, pages: [] });
    for (const path of [
      `/api/public/pages/${id}?revision=${site.revision}`,
      `/api/public/graph?revision=${site.revision}`,
      `/api/public/assets/${assetId}?revision=${site.revision}`,
    ]) {
      const response = await app.request(path);
      assert.equal(response.status, 404, `${path} is unavailable while the site is closed`);
      assert.deepEqual(await response.json(), { error: 'unavailable' });
    }
  } finally { db.close(); }
});

test('publication write endpoints require a current admin session and Origin plus CSRF', async () => {
  const { db, app } = fixture();
  try {
    const request = (url: string, body: unknown, headers: Record<string, string> = {}) => app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const previewBody = { vaultId: 'vault-a', selectedPaths: ['wiki/a.md'] };
    assert.equal((await request('/api/publication/preview', previewBody)).status, 401);
    assert.equal((await request('/api/publication/site', { expectedRevision: 0, enabled: true })).status, 401);
    assert.equal((await request('/api/publication/preview', previewBody, { origin })).status, 401);
  } finally { db.close(); }
});

test('current admin can preview and commit only with trusted Origin and session CSRF', async () => {
  const { db, store, vaultPath } = fixture();
  try {
    const config: AccessConfig = { mode: 'server', host: '127.0.0.1', publicOrigin: origin, username: 'admin', passwordHash: 'unused' };
    const sessions = createSessionStore(db, { credential: 'admin-credential' });
    const session = sessions.create();
    const otherSession = sessions.create();
    const adminApp = new Hono();
    adminApp.use('*', createAccessGuard(config, sessions));
    adminApp.route('/api/publication', publicationRoutes(
      store,
      (vaultId) => vaultId === 'vault-a' ? vaultPath : null,
      createPublicationPrincipalResolver(config.mode, sessions),
    ));
    const post = (token: string, endpoint: string, body: unknown, headers: Record<string, string> = {}) => adminApp.request(`/api/publication/${endpoint}`, {
      method: 'POST', headers: { cookie: `${ADMIN_COOKIE}=${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const input = { vaultId: 'vault-a', selectedPaths: ['wiki/a.md'] };
    assert.equal((await post(session.token, 'preview', input, { origin })).status, 403);
    const previewResponse = await post(session.token, 'preview', input, { origin, 'x-molio-csrf': csrfToken(session.token) });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { id: string; expectedRevision: number };
    const commitBody = { previewId: preview.id, expectedRevision: preview.expectedRevision };
    assert.equal((await post(otherSession.token, 'commit', commitBody, { origin, 'x-molio-csrf': csrfToken(otherSession.token) })).status, 401);
    assert.equal((await post(session.token, 'commit', commitBody, { origin, 'x-molio-csrf': csrfToken(session.token), cookie: `${ADMIN_COOKIE}=${session.token}; unrelated=rotated` })).status, 200);
    sessions.revoke(session.token);
    assert.equal((await adminApp.request('/api/publication/status?vaultId=vault-a', { headers: { cookie: `${ADMIN_COOKIE}=${session.token}` } })).status, 401);
  } finally { db.close(); }
});

test('local mode can create and commit a preview under its process principal without cookies', async () => {
  const { db, store, vaultPath } = fixture();
  try {
    const localApp = new Hono();
    localApp.route('/api/publication', publicationRoutes(
      store,
      (vaultId) => vaultId === 'vault-a' ? vaultPath : null,
      createPublicationPrincipalResolver('local', null),
    ));
    const previewResponse = await localApp.request('/api/publication/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vaultId: 'vault-a', selectedPaths: ['wiki/a.md'] }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { id: string; expectedRevision: number };
    const commitResponse = await localApp.request('/api/publication/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewId: preview.id, expectedRevision: preview.expectedRevision }),
    });
    assert.equal(commitResponse.status, 200);
  } finally { db.close(); }
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publishRoutes, cleanupAllBridges } from '../../src/routes/publish.js';

/**
 * Tests for publish API routes.
 *
 * Regression: Issue #11 — publish button on UI was a no-op because
 * onPublish handler was not wired. These tests ensure the daemon
 * publish API contract stays intact so the frontend can rely on it.
 */

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

/** Poll until `url` refuses connection (bridge server shut down). */
async function waitForServerDown(url: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      return; // connection refused = server down
    }
  }
}

/** Helper: create a publish app and clean up all bridges after the callback. */
async function withApp<T>(fn: (app: ReturnType<typeof publishRoutes>) => Promise<T>): Promise<T> {
  const app = publishRoutes();
  try {
    return await fn(app);
  } finally {
    cleanupAllBridges();
  }
}

describe('Publish routes', () => {
  describe('POST /check-cose', () => {
    it('should return installed status as boolean', async () => {
      await withApp(async (app) => {
        const res = await app.request('/check-cose', { method: 'POST' });
        assert.equal(res.status, 200);

        const body = await jsonBody(res);
        assert.equal(typeof body['installed'], 'boolean');
      });
    });
  });

  describe('POST /start', () => {
    it('should start bridge server and return bridgeUrl for valid content', async () => {
      await withApp(async (app) => {
        const res = await app.request('/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Test Article',
            markdown: '# Hello\n\nWorld',
            html: '<h1>Hello</h1><p>World</p>',
            css: 'h1 { color: red; }',
          }),
        });
        assert.equal(res.status, 200);

        const body = await jsonBody(res);
        const bridgeUrl = body['bridgeUrl'] as string;
        assert.ok(bridgeUrl, 'bridgeUrl should be present');
        assert.ok(bridgeUrl.startsWith('http://localhost:'), 'bridgeUrl should be a localhost URL');

        // Verify bridge server is serving the page
        const bridgeRes = await fetch(bridgeUrl);
        assert.equal(bridgeRes.status, 200);
        const html = await bridgeRes.text();
        assert.ok(html.includes('Test Article'), 'bridge page should contain the title');
      });
    });

    it('should return 400 when both html and markdown are empty', async () => {
      await withApp(async (app) => {
        const res = await app.request('/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Empty',
            markdown: '',
            html: '',
            css: '',
          }),
        });
        assert.equal(res.status, 400);

        const body = await jsonBody(res);
        const error = body['error'] as Record<string, string>;
        assert.equal(error['code'], 'INVALID_REQUEST');
      });
    });

    it('should accept markdown-only content (no html)', async () => {
      await withApp(async (app) => {
        const res = await app.request('/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'MD Only',
            markdown: '# Title\n\nContent',
            html: '',
            css: '',
          }),
        });
        assert.equal(res.status, 200);

        const body = await jsonBody(res);
        assert.ok(body['bridgeUrl']);
      });
    });
  });

  describe('DELETE /bridge', () => {
    it('should clean up a bridge server by URL', async () => {
      await withApp(async (app) => {
        // Start a bridge
        const startRes = await app.request('/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Cleanup Test',
            markdown: '# Test',
            html: '<h1>Test</h1>',
            css: '',
          }),
        });
        const startBody = await jsonBody(startRes);
        const bridgeUrl = startBody['bridgeUrl'] as string;

        // Verify it's serving
        const res1 = await fetch(bridgeUrl);
        assert.equal(res1.status, 200);

        // Delete the bridge
        const delRes = await app.request(`/bridge?url=${encodeURIComponent(bridgeUrl)}`, {
          method: 'DELETE',
        });
        assert.equal(delRes.status, 200);
        const delBody = await jsonBody(delRes);
        assert.equal(delBody['ok'], true);

        // Bridge should no longer be serving (connection refused)
        await waitForServerDown(bridgeUrl);
      });
    });

    it('should handle deleting a non-existent bridge gracefully', async () => {
      await withApp(async (app) => {
        const res = await app.request('/bridge?url=http://localhost:99999', {
          method: 'DELETE',
        });
        assert.equal(res.status, 200);
      });
    });
  });
});

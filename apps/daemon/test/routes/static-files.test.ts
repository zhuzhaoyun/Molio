import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { createStaticFileMiddleware } from '../../src/static-files.js';

/**
 * Static file serving middleware tests.
 *
 * Regression coverage for the 2026-10-26 stale-chunk incident: after an app
 * update the installed web dist is replaced wholesale, so any cached index.html
 * references old hashed chunks that no longer exist → "Failed to fetch
 * dynamically imported module" dead-end. index.html must therefore always be
 * revalidated (Cache-Control: no-cache) so the SPA shell can never be served
 * from a stale cache copy.
 */

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'molio-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>index</body></html>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-AbCdEfGh.js'), 'console.log("entry")');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function appWithDownstream() {
  const app = new Hono();
  app.use('*', createStaticFileMiddleware(dir));
  app.all('*', (c) => c.text('downstream'));
  return app;
}

describe('createStaticFileMiddleware', () => {
  it('GET / 返回 index.html 且带 Cache-Control: no-cache', async () => {
    const res = await appWithDownstream().request('http://localhost/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  it('SPA 回退（无扩展名路径）同样带 no-cache', async () => {
    const res = await appWithDownstream().request('http://localhost/settings');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  it('hash 资产按原样伺服（不加 no-cache）', async () => {
    const res = await appWithDownstream().request('http://localhost/assets/index-AbCdEfGh.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/);
    assert.equal(res.headers.get('cache-control'), null);
  });

  it('目录穿越返回 404', async () => {
    const res = await appWithDownstream().request('http://localhost/..%2f..%2fetc%2fpasswd');
    assert.equal(res.status, 404);
  });

  it('不存在的带扩展名文件落到下游（404 兜底）', async () => {
    const res = await appWithDownstream().request('http://localhost/assets/missing-Bh1wXy2I.js');
    assert.equal(await res.text(), 'downstream', '应穿透到下游 handler');
  });
});

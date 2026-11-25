import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('server denies anonymous requests to every management area', () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-boundary-'));
  const script = `
    const { app } = await import('./src/server.ts');
    const paths = ['/api/agents','/api/agents/codex/install','/api/runs','/api/runs/x/tool-result','/api/config','/api/skills','/api/conversations','/api/projects','/api/knowledge/vaults','/api/knowledge/vaults/x/files/a','/api/knowledge/vaults/x/tree','/api/knowledge/vaults/x/search','/api/publish','/api/proxy/image','/api/graph/x','/api/weixin','/api/feishu','/api/preload/status','/api/preload/start','/api/maintenance','/api/quiz','/api/auth/status','/api/market','/api/runs/x/events','/api/knowledge/vaults/x/raw/file','/api/public','/api/shutdown'];
    const results = [];
    for (const path of paths) for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const status = (await app.request(path, { method })).status;
      results.push([method + ' ' + path, status]);
      if (status !== 401) { console.log('RESULT:' + JSON.stringify(results)); process.exit(0); }
    }
    results.push(['/api/config OPTIONS', (await app.request('/api/config', { method: 'OPTIONS' })).status]);
    console.log('RESULT:' + JSON.stringify(results)); process.exit(0);
  `;
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 90000,
      env: { ...process.env, MOLIO_DATA_DIR: dir, MOLIO_ACCESS_MODE: 'server', MOLIO_PUBLIC_URL: 'https://example.test', MOLIO_ADMIN_USERNAME: 'admin', MOLIO_ADMIN_PASSWORD_HASH: `scrypt$32768$8$1$${'ab'.repeat(16)}$${'cd'.repeat(64)}` },
    });
    const line = out.split('\n').find((x) => x.startsWith('RESULT:'))!;
    const results = JSON.parse(line.slice(7)) as Array<[string, number]>;
    for (const [path, status] of results) assert.equal(status, 401, path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

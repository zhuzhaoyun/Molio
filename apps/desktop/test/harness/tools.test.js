import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

test('desktop host export registers the knowledge tools and dispatches to its active vault', async t => {
  const host = new URL('../../../../.harness-build/host/', import.meta.url);
  const bundle = new URL('packages/bundle/web-app/package.json', host);
  if (!existsSync(new URL('packages/core/tools/lib/index.js', host)) || !existsSync(bundle)) {
    return t.skip('Requires the built Harness host');
  }
  const resolve = createRequire(bundle).resolve;
  const plugin = await import(pathToFileURL(resolve('@deepseek-ai/dsh-web-app/molio-kb')));
  const patch = await readFile(new URL('./cordis.patch.yml', bundle), 'utf8');
  assert.match(patch, /id: molio-kb\s+name: '@deepseek-ai\/dsh-web-app\/molio-kb'\s+disabled: !!js "ctx.get\('profileContext'\)\?\.name !== 'desktop'"/);
  const requests = [];
  const vault = { id: 'selected', name: 'Selected vault' };
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/knowledge/active-vault') return res.end(JSON.stringify({ vaultId: vault.id, vault }));
    if (req.url === '/api/health') return res.end(JSON.stringify({ status: 'ok', version: '1.0' }));
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const previous = process.env.MOLIO_DAEMON_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.MOLIO_DAEMON_URL;
    else process.env.MOLIO_DAEMON_URL = previous;
  });
  process.env.MOLIO_DAEMON_URL = 'http://127.0.0.1:' + server.address().port;
  const registered = new Map();
  assert.deepEqual(plugin.inject, ['tools']);
  await plugin.apply({ tools: { register(tool) { registered.set(tool.name, tool); } } });
  assert.deepEqual([...registered.keys()].sort(), [
    'molio_kb_read', 'molio_kb_search', 'molio_kb_tree', 'molio_kb_vaults', 'molio_status',
  ]);
  const result = await registered.get('molio_status').execute({}, { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(result.activeVault, vault);
  assert.deepEqual(requests, ['/api/health', '/api/knowledge/active-vault']);
});

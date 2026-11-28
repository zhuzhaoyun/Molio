import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fileAddress, wikiParts } from '../client/wiki.mjs';
import PluginDatabase from '../runtime/sqlite.mjs';

test('PluginDatabase caches prepared statements and handles nested + rollback transactions', () => {
  const db = new PluginDatabase(':memory:');
  try {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const s1 = db.prepare('INSERT INTO items (name) VALUES (?)');
    const s2 = db.prepare('INSERT INTO items (name) VALUES (?)');
    assert.equal(s1, s2, 'identical SQL should reuse cached StatementSync');

    const innerTx = db.transaction((name) => {
      s1.run(name);
    });
    const outerTx = db.transaction(() => {
      s1.run('outer');
      innerTx('inner');
    });
    outerTx();
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM items').get().c, 2);

    const failingTx = db.transaction(() => {
      s1.run('rolled-back');
      throw new Error('boom');
    });
    assert.throws(() => failingTx(), /boom/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM items').get().c, 2);
  } finally {
    db.close();
  }
});

test('Chinese note aliases and Windows DSH file addresses', () => {
  assert.deepEqual(wikiParts('见 [[指南|创业指南]] 和 [[曼行]]'), [
    '见 ', { page: '指南', label: '创业指南' }, ' 和 ', { page: '曼行', label: '曼行' }, '',
  ]);
  assert.equal(fileAddress('s', '/D:/资料/a b.md'), 'dsh-resource://file/session/s/D:/%E8%B5%84%E6%96%99/a%20b.md');
});

test('bundled service serves all modules, indexes a vault and resolves a wiki link', { timeout: 30000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'molio-plugin-test-'));
  const web = fileURLToPath(new URL('../dist/web', import.meta.url));
  const proc = fork(fileURLToPath(new URL('../dist/service/daemon.mjs', import.meta.url)), [], {
    execArgv: [], env: { ...process.env, MOLIO_DATA_DIR: data, MOLIO_STATIC_DIR: web, MOLIO_HARNESS_SIDECAR: '1' },
  });
  const exited = once(proc, 'exit');
  try {
    const [ready] = await Promise.race([once(proc, 'message'), exited.then(() => { throw new Error('Service did not start'); })]);
    const origin = 'http://127.0.0.1:' + ready.port;
    const rejected = await fetch(origin + '/api/knowledge/vaults', {
      method: 'POST', headers: { origin: 'https://example.org' }, body: '{}',
    });
    assert.equal(rejected.status, 403);
    for (const route of ['/knowledge', '/knowledge?panel=graph', '/resources']) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<div id="root">/);
    }
    const path = join(data, 'vault');
    await mkdir(path);
    await writeFile(join(path, '曼行.md'), '# 曼行');
    const response = await fetch(origin + '/api/knowledge/vaults', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '演示', path }),
    });
    assert.ok(response.ok, await response.text());
    const { vaults } = await (await fetch(origin + '/api/knowledge/vaults')).json();
    assert.deepEqual(await (await fetch(origin + '/api/knowledge/vaults/' + vaults[0].id + '/resolve/' + encodeURIComponent('曼行'))).json(), { path: '曼行.md' });
  } finally {
    if (proc.connected) proc.disconnect();
    await exited;
    await rm(data, { recursive: true, force: true });
  }
});

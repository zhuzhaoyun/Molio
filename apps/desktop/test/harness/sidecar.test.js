import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSidecar } from '../../../../distribution/desktop/sidecar.mjs';

async function fixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'molio-sidecar-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'daemon'));
  await copyFile(process.execPath, join(directory, process.platform === 'win32' ? 'node.exe' : 'node'));
  await writeFile(join(directory, 'daemon/daemon.mjs'), source);
  return directory;
}

test('owned child advertises its assigned loopback port and exits when the parent disconnects', async t => {
  const directory = await fixture(t, `
    import http from 'node:http';
    const server = http.createServer((req, res) => res.end(process.env.MOLIO_STATIC_DIR));
    server.listen(Number(process.env.MOLIO_PORT), '127.0.0.1', () => {
      process.send({ type: 'molio-ready', port: server.address().port });
    });
    process.once('disconnect', () => process.exit(0));
  `);
  let closed;
  const exit = new Promise(resolve => { closed = resolve; });
  const service = await startSidecar(directory, {}, closed);
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/knowledge`);
    assert.equal(await response.text(), join(directory, 'web'));
  } finally {
    service.stop();
    await exit;
  }
});

test('startup fails promptly when the daemon exits before announcing readiness', async t => {
  const directory = await fixture(t, 'process.exit(1);');
  await assert.rejects(startSidecar(directory, {}, () => {}), /daemon exited \(1\)/);
});

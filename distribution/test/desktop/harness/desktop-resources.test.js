import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyDesktopResources } from '../../../../scripts/harness-desktop.mjs';

test('cached CRLF builder configs copy the sidecar executable to exactly one destination', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'molio-resources-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scripts = join(dir, 'apps/desktop/scripts');
  await mkdir(scripts, { recursive: true });
  const file = join(scripts, 'electron-builder-config.mjs');
  const original = "    extraResources: [\r\n      { from: 'runtime', to: 'runtime' },\r\n    ],\r\n";
  await writeFile(file, original);
  applyDesktopResources(dir);
  const once = await readFile(file, 'utf8');
  const rows = once.slice(once.indexOf('\r\n') + 2, once.indexOf("      { from: 'runtime'"));
  await writeFile(file, once.replace(rows, () => rows.repeat(5)));
  applyDesktopResources(dir);
  applyDesktopResources(dir);
  assert.equal(await readFile(file, 'utf8'), once);
  assert.equal(once.match(/to: 'molio'/g).length, 1);
  assert.equal(once.match(/to: 'molio-support'/g).length, 1);
});

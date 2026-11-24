/** Run with apps/cloud/node_modules/.bin/tsx after preparing the Harness resources. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../cloud/src/app.ts';
import { loadConfig } from '../../../cloud/src/config.ts';
import { AuthService } from '../../../cloud/src/service.ts';
import { MarketService } from '../../../cloud/src/market/service.ts';
import { OssSigner } from '../../../cloud/src/market/signer.ts';
import { MemoryAuthStore } from '../../../cloud/src/store/memory.ts';
import { MemoryMarketStore } from '../../../cloud/src/store/market-memory.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const desktop = createRequire(join(root, 'apps/desktop/package.json'));
const web = createRequire(join(root, 'apps/web/package.json'));
const cloud = createRequire(join(root, 'apps/cloud/package.json'));
const { _electron } = web('@playwright/test');
const config = loadConfig({
  MOLIO_ENV: 'local', MOLIO_OSS_AK: 'fixture', MOLIO_OSS_SK: 'fixture', MOLIO_OSS_BUCKET: 'fixture',
});
const users = new MemoryAuthStore();
const now = Date.now;
const api = createApp({
  config, now, storeKind: 'memory',
  service: new AuthService({ store: users, config, now, sendMail: async () => {} }),
  market: { service: new MarketService({
    store: new MemoryMarketStore(), users, signer: new OssSigner(config.market!.oss),
    config: { market: config.market! }, now,
  }) },
});
const directory = await mkdtemp(join(tmpdir(), 'molio-desktop-smoke-'));
const resources = resolve(process.argv[2] || join(root, '.harness-build/host/apps/desktop/molio-resources'));
const server = cloud('@hono/node-server').serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => server.listening ? resolve(true) : server.once('listening', resolve));
const authUrl = 'http://127.0.0.1:' + server.address().port;
let electron;
try {
  await symlink(resources, join(directory, 'molio-resources'), 'junction');
  const support = join(directory, 'molio-support');
  await mkdir(support);
  for (const name of ['sidecar.mjs', 'preload.cjs']) {
    await copyFile(join(root, 'distribution/desktop', name), join(support, name));
  }
  await copyFile(join(root, 'apps/desktop/src/crypto-server.js'), join(support, 'crypto-server.mjs'));
  await desktop('esbuild').build({
    entryPoints: [join(root, 'distribution/desktop/molio-desktop.ts')], format: 'esm', bundle: true, external: ['electron'],
    platform: 'node', outfile: join(directory, 'integration.mjs'),
  });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'molio-test', main: 'main.mjs' }));
  await writeFile(join(directory, 'main.mjs'), `
    import {app, ipcMain} from 'electron';
    import {startMolioDesktop, bindMolioConversationWindow} from './integration.mjs';
    void app.whenReady().then(async () => {
    await startMolioDesktop();
    const sender = { mainFrame: {} };
    bindMolioConversationWindow(() => ({ webContents: sender }));
    globalThis.openModule = id => ipcMain.emit('molio:navigate', {sender, senderFrame: sender.mainFrame}, id);
    globalThis.openModule('knowledge'); }).catch(error => { console.error(error); app.exit(1); });
  `);
  electron = await _electron.launch({
    executablePath: desktop('electron'), args: [directory, '--user-data-dir=' + join(directory, 'profile')],
    env: {
      ...process.env, MOLIO_AUTH_URL: authUrl, MOLIO_DATA_DIR: join(directory, 'data'),
      MOLIO_DEBUG_LOG_DIR: join(directory, 'logs'), MOLIO_CLAUDE_HOME: join(directory, 'claude'),
      MOLIO_CODEX_HOME: join(directory, 'codex'), MOLIO_CHORES_DELAY_MS: '0',
      HOME: directory, USERPROFILE: directory,
    },
  });
  const page = await electron.firstWindow();
  await page.waitForURL('**/knowledge');
  const origin = new URL(page.url()).origin;
  const request = async (path, body?) => {
    const response = await fetch(origin + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    });
    assert.ok(response.ok, path + ' ' + response.status);
    return response.json();
  };
  assert.equal((await request('/api/health')).status, 'ok');
  const vaultPath = join(directory, 'vault');
  await mkdir(vaultPath);
  await writeFile(join(vaultPath, 'A.md'), '[[B]]');
  await writeFile(join(vaultPath, 'B.md'), '# B');
  const vault = await request('/api/knowledge/vaults', { name: 'Fixture', path: vaultPath });
  await request('/api/knowledge/active-vault', { id: vault.id });
  assert.ok((await request('/api/graph/' + vault.id)).nodes.length >= 2);
  const openModule = (id: string) => electron.evaluate((_electron, id) => globalThis.openModule(id), id);
  await assert.rejects(readFile(join(vaultPath, 'CLAUDE.md')));
  await electron.evaluate(({ dialog, shell }, vaultPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vaultPath] });
    shell.showItemInFolder = () => {};
    shell.openPath = async () => '';
    shell.openExternal = async url => { globalThis.smokeExternal = url; };
  }, vaultPath);
  assert.equal(await page.evaluate(() => window.__electron__.showDirectoryPicker()), vaultPath);
  await page.evaluate(file => window.__electron__.showItemInFolder(file), join(vaultPath, 'A.md'));
  assert.equal(await page.evaluate(file => window.__electron__.openPath(file), join(vaultPath, 'A.md')), '');
  await assert.rejects(page.evaluate(file => window.__electron__.openPath(file), join(directory, 'main.mjs')));
  await assert.rejects(page.evaluate(() => window.__electron__.openNewWindow('https://example.test/knowledge')));
  const childPage = electron.waitForEvent('window');
  await page.evaluate(() => window.__electron__.openNewWindow('/knowledge'));
  await (await childPage).close();
  await page.evaluate(() => window.open('https://example.test/download.zip'));
  assert.equal(await electron.evaluate(() => globalThis.smokeExternal), 'https://example.test/download.zip');
  await openModule('graph');
  await page.getByTestId('kb-graph-pane').waitFor({ state: 'visible' });
  await openModule('resources');
  await page.getByTestId('resources-grid').waitFor({ state: 'visible' });
  assert.equal((await request('/api/market/listings')).stale, false);
  const email = 'desktop-smoke@example.test';
  const { devCode } = await request('/api/auth/start', { email });
  assert.ok(devCode);
  assert.equal((await request('/api/auth/verify', { email, code: devCode })).loggedIn, true);
  assert.equal((await request('/api/auth/status')).loggedIn, true);
  assert.ok(JSON.parse(await readFile(join(directory, 'data/auth-tokens.json'), 'utf8')).encrypted);
  assert.deepEqual((await request('/api/market/purchases')).purchases, []);
  await electron.close();
  electron = undefined;
  await assert.rejects(fetch(origin + '/api/health'));
  console.log('Desktop bundle passed knowledge, graph, market, encrypted local sign-in, purchases and shutdown.');
} finally {
  await electron?.close();
  server.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

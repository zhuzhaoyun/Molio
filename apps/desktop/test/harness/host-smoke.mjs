/** Windows smoke against an unpacked Molio.exe, or the ordinary host app in dev mode. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const host = join(root, '.harness-build/host/apps/desktop');
const target = resolve(process.argv[2] || host);
const packaged = extname(target) === '.exe';
const { _electron } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');
const profile = await mkdtemp(join(tmpdir(), 'molio-host-smoke-'));
const vaultPath = join(profile, 'vault');
async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

// The unpackaged host exposes its own opt-in inspector. Inspect the live ToolsService
// instance so unloaded profile plugins cannot pass through a standalone import.
async function checkHostRegistry(port) {
  const [target] = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(Error('Host inspector timed out: ' + method)), 10000);
    const handle = ({ data }) => {
      const packet = JSON.parse(data);
      if (packet.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', handle);
      if (packet.error || packet.result?.exceptionDetails) reject(Error(JSON.stringify(packet.error || packet.result.exceptionDetails)));
      else resolve(packet.result);
    };
    socket.addEventListener('message', handle);
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    const toolModule = resolve(host, '../../packages/core/tools/lib/index.js');
    const proto = await send('Runtime.evaluate', { expression: 'process.getBuiltinModule("module").createRequire('
      + JSON.stringify(toolModule) + ')(' + JSON.stringify(toolModule) + ').ToolsService.prototype' });
    const live = await send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
    const checked = await send('Runtime.callFunctionOn', { objectId: live.objects.objectId, awaitPromise: true,
      returnByValue: true, functionDeclaration: `async function() {
        const names = ['molio_status','molio_kb_vaults','molio_kb_tree','molio_kb_search','molio_kb_read'];
        const found = this.find(service => names.every(name => service.get(name)));
        if (!found) throw Error('Bundled tools absent from live ToolsService (' + this.length + ' instances)');
        const args = {molio_kb_read:{path:'Probe.md'},molio_kb_search:{query:'molio-startup-smoke'}};
        const results = {};
        for (const name of names) results[name] = await found.get(name).execute(args[name] || {}, { signal:new AbortController().signal });
        return results;
      }` });
    return checked.result.value;
  } finally {
    socket.close();
  }
}

let application;
try {
  await mkdir(vaultPath);
  await writeFile(join(vaultPath, 'Probe.md'), 'molio-startup-smoke [[Evidence]]');
  await writeFile(join(vaultPath, 'Evidence.md'), '# Evidence');
  const env = { ...process.env,
    MOLIO_SKIP_PROTOCOL_REGISTRATION: '1', DSH_HOME: join(profile, 'dsh'), MOLIO_DATA_DIR: join(profile, 'molio'), USERPROFILE: profile, HOME: profile,
    DSH_DESKTOP_DIAGNOSTIC_FILE: join(profile, 'diagnostics.txt'), DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    MOLIO_CODEX_HOME: join(profile, 'codex'), MOLIO_CLAUDE_HOME: join(profile, 'claude'),
    MOLIO_DEBUG_LOG_DIR: join(profile, 'debug'), MOLIO_AUTH_URL: 'http://127.0.0.1:1',
  };
  const inspectorPort = packaged ? undefined : await freePort();
  if (inspectorPort) env.DSH_DESKTOP_HOST_INSPECT_PORT = String(inspectorPort);
  delete env.DEEPSEEK_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MOLIO_DAEMON_URL;
  const executablePath = packaged ? target : createRequire(join(host, 'package.json'))('electron');
  const launch = (protocolArgs = []) => _electron.launch({ executablePath, cwd: host, env, args: [
    '--user-data-dir=' + join(profile, 'chromium'), ...(packaged ? [] : [target]), ...protocolArgs,
  ] });
  application = await launch();
  const waitPage = async (matches, limit = 120_000) => {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      const page = application.windows().find(p => matches(p.url()));
      if (page) return page;
      await delay(250);
    }
    throw Error('Expected desktop window missing. URLs ' + application.windows().map(p => p.url()).join(', '));
  };
  const welcome = await waitPage(url => url.includes('welcome.html') || url.includes('://welcome'));
  await welcome.locator('#api-key').click();
  await welcome.locator('#skip-key').click();
  const product = await waitPage(url => url.startsWith('dsh-app://app/'));
  const button = product.locator('[data-windows-menu]').getByRole('menuitem').first();
  await button.waitFor({ state: 'visible', timeout: 90_000 });
  // Drive the actual Windows caption button. At the OS popup boundary select the item by label.
  await application.evaluate(({ Menu }) => {
    globalThis.molioSmokeMenu = [];
    Menu.prototype.popup = function(options) {
      globalThis.molioSmokeMenu = this.items.map(item => item.label);
      this.items.find(item => item.label === globalThis.molioSmokeAction)?.click();
      options?.callback?.();
    };
  });
  const choose = async label => {
    await application.evaluate((_, label) => { globalThis.molioSmokeAction = label; }, label);
    await button.click();
  };
  await choose('知识库');
  const knowledge = await waitPage(url => url.endsWith('/knowledge'));
  const labels = await application.evaluate(() => globalThis.molioSmokeMenu);
  assert.deepEqual(labels.slice(0, 3), ['知识库', '知识图谱', '资源市场']);
  const origin = new URL(knowledge.url()).origin;
  const request = async (path, body) => {
    const res = await fetch(origin + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    assert.ok(res.ok, path + ' ' + res.status);
    return res.json();
  };
  const vault = await request('/api/knowledge/vaults', { name: 'Probe', path: vaultPath });
  await request('/api/knowledge/active-vault', { id: vault.id });
  const externalPath = join(profile, 'source');
  await mkdir(externalPath);
  await writeFile(join(externalPath, 'Mounted.md'), 'Linked [[Probe]]');
  await request('/api/knowledge/vaults/' + vault.id + '/external-roots', { label: 'Sources', target: externalPath });
  const graph = await request('/api/graph/' + vault.id);
  assert.ok(graph.nodes.some(node => node.key === 'external/Sources/Mounted.md'));
  assert.ok(graph.edges.some(edge => edge.source === 'Probe.md' && edge.target === 'Evidence.md'));
  assert.ok(graph.edges.some(edge => edge.source === 'external/Sources/Mounted.md' && edge.target === 'Probe.md'));
  const tree = await request('/api/knowledge/vaults/' + vault.id + '/tree');
  assert.match(JSON.stringify(tree), /Mounted\.md/);
  await choose('知识图谱');
  await knowledge.getByTestId('kb-graph-pane').waitFor({ state: 'visible' });
  await choose('资源市场');
  await knowledge.getByTestId('resources-grid').waitFor({ state: 'visible' });
  await application.evaluate(({ app }, id) => app.emit('second-instance', {}, [
    'molio://open/vault/' + encodeURIComponent(id) + '/file/Probe.md',
  ]), vault.id);
  await knowledge.locator('.kb-wtab.is-active[title="Probe.md"]').first().waitFor({ state: 'visible' });
  for (const mode of ['ask', 'build', 'lint', 'ingest']) {
    await knowledge.evaluate(async ({ mode, vaultId, vaultPath }) => {
      await window.__electron__.openKnowledgeConversation({ mode, vaultId, vaultPath,
        filePath: 'Probe.md', selectedText: 'smoke-selection-' + mode });
    }, { mode, vaultId: vault.id, vaultPath });
    const editor = product.locator('[data-composer-input]:visible').last();
    const skill = 'wiki-' + (mode === 'ask' ? 'query' : mode);
    await editor.filter({ hasText: skill }).waitFor({ state: 'visible' });
    assert.match(await editor.innerText(), new RegExp('smoke-selection-' + mode));
  }
  const tools = inspectorPort ? await checkHostRegistry(inspectorPort) : await application.evaluate(async ({ app }, { packaged, host }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const { join, resolve } = process.getBuiltinModule('node:path');
    const from = packaged ? join(app.getAppPath(), 'dsh/package.json') : resolve(host, '../../packages/bundle/web-app/package.json');
    const loaded = createRequire(from)('@deepseek-ai/dsh-web-app/molio-kb');
    const definitions = [];
    await loaded.apply({ tools: { register: definition => definitions.push(definition) } });
    const args = { molio_kb_read: { path: 'Probe.md' }, molio_kb_search: { query: 'molio-startup-smoke' } };
    const values = {};
    for (const def of definitions) values[def.name] = await def.execute(args[def.name] || {}, { signal: new AbortController().signal });
    return values;
  }, { packaged, host });
  assert.deepEqual(Object.keys(tools).sort(), ['molio_kb_read', 'molio_kb_search', 'molio_kb_tree', 'molio_kb_vaults', 'molio_status']);
  assert.equal(tools.molio_status.activeVault.id, vault.id);
  for (const name of ['molio_kb_read', 'molio_kb_search', 'molio_kb_tree']) assert.match(JSON.stringify(tools[name]), /Probe.md/);
  await application.close();
  application = undefined;
  await assert.rejects(fetch(origin + '/api/health'));
  const projections = join(profile, 'dsh/storages/session_projcache/sessions');
  const sessions = await Promise.all((await readdir(projections)).filter(file => file.endsWith('.json'))
    .map(async file => JSON.parse(await readFile(join(projections, file), 'utf8'))));
  assert.ok(sessions.some(session => session.record.identity.cwd === vaultPath), 'Harness session cwd must equal the selected vault path');
  application = await launch(['molio://open/file/Probe.md']);
  const coldClip = await waitPage(url => url.startsWith('http://127.0.0.1:') && url.includes('/knowledge'));
  await coldClip.locator('.kb-wtab.is-active[title="Probe.md"]').waitFor({ state: 'visible' });
  await application.close();
  application = undefined;
  console.log('Harness startup, native menu, three modules, four contextual drafts and vault cwd, cold and warm clipper, five bundled tools and owned shutdown passed.');
} catch (error) {
  console.error('Smoke profile:', profile);
  throw error;
} finally {
  await application?.close();
  if (!process.env.MOLIO_KEEP_SMOKE_PROFILE) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

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
  await mkdir(join(profile, '.git')); // Nested vault must never install into its enclosing repository.
  // Cross the real daemon's community threshold so an aggregate-only canvas cannot pass.
  for (let topic = 0; topic < 6; topic++) {
    const folder = join(vaultPath, 'Topic' + topic);
    await mkdir(folder);
    const name = index => 'Topic' + topic + '-Note' + (index % 85);
    await Promise.all(Array.from({ length: 85 }, (_, index) =>
      writeFile(join(folder, name(index) + '.md'), [1, 3, 7].map(step => '[[' + name(index + step) + ']]').join(' ') + ' [[Probe]]')));
  }
  await writeFile(join(vaultPath, 'Probe.md'), 'molio-startup-smoke [[Evidence]]');
  await writeFile(join(vaultPath, 'Evidence.md'), '# Evidence');
  const env = { ...process.env,
    MOLIO_SKIP_PROTOCOL_REGISTRATION: '1', DSH_HOME: join(profile, 'dsh'), MOLIO_DATA_DIR: join(profile, 'molio'), USERPROFILE: profile, HOME: profile,
    DSH_DESKTOP_DIAGNOSTIC_FILE: join(profile, 'diagnostics.txt'), DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    MOLIO_CODEX_HOME: join(profile, 'codex'), MOLIO_CLAUDE_HOME: join(profile, 'claude'),
    MOLIO_DEBUG_LOG_DIR: join(profile, 'debug'), MOLIO_AUTH_URL: process.env.MOLIO_SMOKE_AUTH_URL || 'http://127.0.0.1:1',
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
  const sidebar = product.getByRole('navigation', { name: '知识管理' });
  const choose = label => sidebar.getByRole('button', { name: label, exact: true }).click();
  await choose('知识库');
  const panel = product.getByTestId('molio-content')
  const waitContent = async (page, selector) => {
    const view = page.getByTestId('molio-content')
    await view.waitFor({ state: 'visible' })
    const deadline = Date.now() + 30000
    while (!(await view.evaluate((guest, selector) => guest.executeJavaScript(
      'Boolean(document.querySelector(' + JSON.stringify(selector) + ')?.getClientRects().length)'), selector).catch(() => false))) {
      if (Date.now() >= deadline) throw Error('Missing module content: ' + selector)
      await delay(100)
    }
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  }
  await waitContent(product, '.harness-content')
  const origin = new URL(await panel.getAttribute('src')).origin
  const request = async (path, body) => {
    const res = await fetch(origin + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    assert.ok(res.ok, path + ' ' + res.status);
    return res.json();
  };
  for (const path of ['/api/agents', '/api/runs', '/api/conversations', '/api/weixin/status', '/api/feishu/status']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  const vault = await request('/api/knowledge/vaults', { name: 'Probe', path: vaultPath });
  const { FileSystemSkillProvider } = createRequire(join(host, '../../packages/skill/skill-filesystem/package.json'))('@deepseek-ai/dsh-skill-filesystem');
  const provider = new FileSystemSkillProvider({ get: () => undefined, logger: console }, {
    invalidate() {}, signal: new AbortController().signal,
  }, { watch: false, dshHome: join(profile, 'dsh'), agentsHome: join(profile, 'agents') });
  try {
    await assert.rejects(readdir(join(profile, '.agents')), { code: 'ENOENT' });
    const lookup = { cwd: vaultPath };
    const result = await provider.list(lookup);
    const projectSkills = (result.candidates ?? result).filter(candidate => candidate.source === 'project-agents');
    for (const name of ['wiki-build', 'wiki-query', 'wiki-ingest', 'wiki-lint', 'wiki-save']) {
      const candidate = projectSkills.find(skill => skill.name === name);
      assert.ok(candidate, 'DSH must discover ' + name);
      assert.ok((await provider.get(candidate, lookup)).content);
    }
  } finally {
    await provider.dispose();
  }
  await request('/api/knowledge/active-vault', { id: vault.id });
  const externalPath = join(profile, 'source');
  await mkdir(externalPath);
  await writeFile(join(externalPath, 'Mounted.md'), 'Linked [[Probe]]');
  await request('/api/knowledge/vaults/' + vault.id + '/external-roots', { label: 'Sources', target: externalPath });
  const graph = await request('/api/graph/' + vault.id);
  assert.ok(graph.nodes.some(node => node.key === 'external/Sources/Mounted.md'));
  const linked = (a, b) => graph.edges.some(({ source, target }) => (source === a && target === b) || (source === b && target === a));
  assert.ok(linked('Probe.md', 'Evidence.md'));
  assert.ok(linked('external/Sources/Mounted.md', 'Probe.md'));
  const tree = await request('/api/knowledge/vaults/' + vault.id + '/tree');
  assert.match(JSON.stringify(tree), /Mounted\.md/);
  await application.evaluate(({ dialog, shell }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    shell.showItemInFolder = () => {}
    shell.openPath = async () => ''
    shell.openExternal = async url => { globalThis.smokeExternal = url }
  }, vaultPath)
  const evaluateGuest = expression => panel.evaluate((view, expression) => view.executeJavaScript(expression), expression)
  assert.equal(await evaluateGuest('window.__electron__.showDirectoryPicker()'), vaultPath)
  const probe = JSON.stringify(join(vaultPath, 'Probe.md'))
  await evaluateGuest('window.__electron__.showItemInFolder(' + probe + ')')
  assert.equal(await evaluateGuest('window.__electron__.openPath(' + probe + ')'), '')
  await assert.rejects(evaluateGuest('window.__electron__.openPath(' + JSON.stringify(profile) + ')'))
  await assert.rejects(evaluateGuest('window.__electron__.openNewWindow("https://example.test/knowledge")'))
  await evaluateGuest('window.__electron__.openNewWindow("/knowledge")')
  await evaluateGuest('void window.open("https://example.test/download.zip")')
  assert.equal(await application.evaluate(() => globalThis.smokeExternal), 'https://example.test/download.zip')
  if (process.env.MOLIO_SMOKE_AUTH_URL) {
    assert.equal((await request('/api/market/listings')).stale, false)
    const email = 'desktop-smoke@example.test'
    const { devCode } = await request('/api/auth/start', { email })
    assert.ok(devCode)
    assert.equal((await request('/api/auth/verify', { email, code: devCode })).loggedIn, true)
    assert.equal((await request('/api/auth/status')).loggedIn, true)
    assert.ok(JSON.parse(await readFile(join(profile, 'molio/auth-tokens.json'), 'utf8')).encrypted)
    assert.deepEqual((await request('/api/market/purchases')).purchases, [])
  }
  // The fixture creates the vault through HTTP after the guest has mounted.
  // Reload its initial vault list just as opening an existing profile does.
  await panel.evaluate(view => view.reload());
  await product.waitForFunction(async vaultId => {
    const view = document.querySelector('[data-testid="molio-content"]');
    try { return new URL(await view.executeJavaScript('location.href')).searchParams.get('vault') === vaultId && await view.executeJavaScript('document.body.innerText.includes("Probe.md")'); }
    catch { return false; }
  }, vault.id);
  await choose('知识图谱');
  await waitContent(product, '[data-testid="graph-canvas"] canvas');
  await waitContent(product, '[data-testid="graph-view-mode-toggle"][aria-pressed="false"]');
  assert.ok(graph.nodes.length > 500);
  await evaluateGuest(`document.querySelector('[data-testid="graph-view-mode-toggle"]').click()`);
  await waitContent(product, '[data-testid="graph-trunk-indicator"]');
  await choose('知识库');
  await product.waitForFunction(async () => {
    const view = document.querySelector('[data-testid="molio-content"]')
    return await view.executeJavaScript(`!!document.querySelector('.harness-content') && !document.querySelector('[data-testid="kb-graph-pane"]:not([inert])')`)
  });
  await choose('资源市场');
  await waitContent(product, '[data-testid="resources-grid"]');
  await mkdir(join(vaultPath, 'wiki/entities'), { recursive: true });
  await writeFile(join(vaultPath, 'wiki/entities/贾后.md'), '# 贾后');
  const openWiki = page => product.evaluate(({ cwd, page }) => window.molioNavigation.openWiki(cwd, page), { cwd: vaultPath, page });
  assert.match(await openWiki('缺失页面'), /找不到/);
  assert.equal(await openWiki('贾后'), null);
  await waitContent(product, '.kb-wtab.is-active[title="wiki/entities/贾后.md"]');
  await application.evaluate(({ app }, id) => app.emit('second-instance', {}, [
    'molio://open/vault/' + encodeURIComponent(id) + '/file/Probe.md',
  ]), vault.id);
  await waitContent(product, '.kb-wtab.is-active[title="Probe.md"]')
  const guestId = await panel.evaluate(view => view.getWebContentsId())
  const timeOrigin = await evaluateGuest('performance.timeOrigin')
  for (const mode of ['ask', 'build', 'lint', 'ingest']) {
    if (mode !== 'ask') {
      await choose('知识库')
      await waitContent(product, '.harness-content')
    }
    await panel.evaluate((view, request) => view.executeJavaScript(
      'void window.__electron__.openKnowledgeConversation(' + JSON.stringify(request) + ')'
    ), { mode, vaultId: vault.id, vaultPath, filePath: 'Probe.md', selectedText: 'smoke-selection-' + mode })
    const editor = product.locator('[data-composer-input]:visible').last();
    const skill = 'wiki-' + (mode === 'ask' ? 'query' : mode);
    assert.match(await readFile(join(vaultPath, '.agents/skills', skill, 'SKILL.md'), 'utf8'), new RegExp('name: ' + skill));
    await editor.filter({ hasText: 'smoke-selection-' + mode }).waitFor({ state: 'visible' });
    assert.doesNotMatch(await editor.innerText(), /SKILL\.md/);
    assert.match(await editor.innerText(), new RegExp('smoke-selection-' + mode));
    if (mode === 'ask') {
      assert.equal(await openWiki('Evidence'), null)
      await waitContent(product, '.kb-wtab.is-active[title="Evidence.md"]')
      assert.equal(await panel.evaluate(view => view.getWebContentsId()), guestId)
      assert.equal(await evaluateGuest('performance.timeOrigin'), timeOrigin)
      await waitContent(product, '.kb-wtab[title="Probe.md"]')
    }
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
  const startup = await waitPage(url => url.includes('welcome.html') || url.includes('://welcome'))
  await startup.locator('#api-key').click()
  await startup.locator('#skip-key').click()
  const coldProduct = await waitPage(url => url.startsWith('dsh-app://app/'))
  await waitContent(coldProduct, '.kb-wtab.is-active[title="Probe.md"]')
  await coldProduct.getByTestId('molio-sidebar-graph').click();
  await waitContent(coldProduct, '[data-testid="graph-view-mode-toggle"][aria-pressed="true"]');
  await application.close();
  application = undefined;
  console.log('Harness startup, fixed sidebar, three modules, four contextual drafts and vault cwd, cold and warm clipper, five bundled tools and owned shutdown passed.');
} catch (error) {
  if (application) {
    const product = application.windows().find(page => page.url().startsWith('dsh-app://app/'));
    const state = await product?.evaluate(() => document.querySelector('webview')?.executeJavaScript(
      '({url:location.href, text:document.body.innerText.slice(-750)})')).catch(() => null);
    console.error('Module under test:', state);
  }
  console.error('Smoke profile:', profile, error);
  throw error;
} finally {
  await application?.close();
  if (!process.env.MOLIO_KEEP_SMOKE_PROFILE) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

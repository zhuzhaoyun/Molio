import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function insert(file, anchor, replacement) {
  const original = readFileSync(file, 'utf8');
  const source = original.replaceAll('\r\n', '\n');
  if (source.includes(replacement)) return;
  if (source.split(anchor).length !== 2) throw new Error(`Unexpected upstream layout in ${file}: ${anchor}`);
  const result = source.replace(anchor, () => replacement);
  writeFileSync(file, original.includes('\r\n') ? result.replaceAll('\n', '\r\n') : result);
}

// Cached Windows checkouts can contain a repeated pair from an older overlay.
// electron-builder copies extraResources concurrently, so every destination must be unique.
export function applyDesktopResources(hostRoot) {
  const file = join(hostRoot, 'apps/desktop/scripts/electron-builder-config.mjs');
  const original = readFileSync(file, 'utf8');
  const source = original.replaceAll('\r\n', '\n');
  const anchor = '    extraResources: [\n';
  const rows = [ ['molio-resources', 'molio'], ['molio-support', 'molio-support'] ].map(([from, to]) =>
    `      { from: fileURLToPath(new URL('../${from}', import.meta.url)), to: '${to}' },\n`);
  if (source.split(anchor).length !== 2) throw new Error('Unexpected extraResources in desktop packaging config');
  let clean = source;
  for (const row of rows) clean = clean.replaceAll(row, '');
  const updated = clean.replace(anchor, () => anchor + rows.join(''));
  if (source !== updated) writeFileSync(file, original.includes('\r\n') ? updated.replaceAll('\n', '\r\n') : updated);
}

export function applyDesktop(hostRoot) {
  const desktop = join(hostRoot, 'apps/desktop');
  const support = join(desktop, 'molio-support');
  mkdirSync(support, { recursive: true });
  for (const name of ['sidecar.mjs', 'preload.cjs', 'suggest.patch.yml']) {
    copyFileSync(join(root, 'distribution/desktop', name), join(support, name));
  }
  copyFileSync(join(root, 'apps/desktop/src/crypto-server.js'), join(support, 'crypto-server.mjs'));
  copyFileSync(join(root, 'distribution/desktop/molio-desktop.ts'), join(desktop, 'src/molio-desktop.ts'));
  copyFileSync(join(root, 'distribution/desktop/molio-clipper.ts'), join(desktop, 'src/molio-clipper.ts'));
  for (const name of ['molio-compose.ts', 'molio-product-preload.ts']) {
    copyFileSync(join(root, 'distribution/desktop', name), join(desktop, 'src', name));
  }
  const preload = join(desktop, 'src/preload-app.ts');
  insert(preload, "import { contextBridge, ipcRenderer, webUtils }", "import { installKnowledgeComposer } from './molio-product-preload.js'\nimport { contextBridge, ipcRenderer, webUtils }");
  insert(preload, "  contextBridge.exposeInMainWorld('dshOnboarding'", "  if (process.isMainFrame) installKnowledgeComposer()\n  contextBridge.exposeInMainWorld('dshOnboarding'");
  const workspace = join(hostRoot, 'packages/client/ui-workspace/src/client/index.ts');
  const binding = '  const browserFlowSource = flowSource';
  insert(workspace, binding, `  const molioComposer = (globalThis as {
    molioKnowledgeComposer?: { listen(callback: (draft: { path: string; prompt: string }) => Promise<void>): () => void }
  }).molioKnowledgeComposer
  if (molioComposer) ctx.effect(() => molioComposer.listen(async ({ path, prompt }) => {
    const workspace = workspaces.list.getSnapshot().items.find(item => item.path === path)
      ?? await workspaces.create({ path })
    await uiWorkspace.openWorkspace(workspace.workspaceId, id => {
      const binding = sessions.binding(id)
      const conversation = ctx.get('conversation')
      if (!binding || !conversation || conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' }) === 'blocked') {
        throw new Error('当前会话无法接收知识库草稿')
      }
    })
  }))
` + binding);
  const sidebar = join(hostRoot, 'packages/client/ui-sidebar/src/client');
  copyFileSync(join(root, 'distribution/desktop/MolioSidebar.tsx'), join(sidebar, 'MolioSidebar.tsx'));
  const sidebarRoot = join(sidebar, 'SidebarRoot.tsx');
  insert(sidebarRoot, "import css from './SidebarRoot.module.css'", "import { MolioSidebar } from './MolioSidebar.tsx'\nimport css from './SidebarRoot.module.css'");
  insert(sidebarRoot, '      <div className={css.scrollRegion}>', '      <MolioSidebar wide={wide} />\n      <div className={css.scrollRegion}>');
  const main = join(desktop, 'src/main.ts');
  // Migrate existing generated workspaces that injected the three native menu items.
  const original = readFileSync(main, 'utf8');
  const migrated = original.replace('const molioMenu = await startMolioDesktop()', 'await startMolioDesktop()')
    .replace(/^[ \t]*\.\.\.molioMenu,\r?\n/m, '');
  if (migrated !== original) writeFileSync(main, migrated);
  insert(main, 'async function main(): Promise<void> {', "import { startMolioDesktop } from './molio-desktop.js'\n\nasync function main(): Promise<void> {\n  await startMolioDesktop()");
  insert(main, "import { startMolioDesktop }", "import { installMolioProtocol } from './molio-desktop.js'\nimport { startMolioDesktop }");
  insert(main, 'if (ownsDesktopInstance) void app.whenReady()', 'if (ownsDesktopInstance) installMolioProtocol(() => focusPrimaryWindow())\n\nif (ownsDesktopInstance) void app.whenReady()');
  insert(main, "import { installMolioProtocol }", "import { bindMolioConversationWindow } from './molio-desktop.js'\nimport { installMolioProtocol }");
  const welcome = '  let openingWelcome: Promise<void> | undefined';
  insert(main, welcome, `  bindMolioConversationWindow(() => {
    if (!mainWindow || !enteredWorkspace) {
      focusPrimaryWindow()
      throw new Error('请先完成 Harness 欢迎页，再打开知识库会话')
    }
    return mainWindow
  })
` + welcome);
  const registration = "if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === '1') app.setAsDefaultProtocolClient('dsh')";
  insert(main, registration, `if (process.env.MOLIO_SKIP_PROTOCOL_REGISTRATION !== '1') {
    ${registration}
    if (app.isPackaged) app.setAsDefaultProtocolClient('molio')
  }`);
  applyDesktopResources(hostRoot);
}

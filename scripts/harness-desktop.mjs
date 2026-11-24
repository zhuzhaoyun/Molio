import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function insert(file, anchor, replacement) {
  const source = readFileSync(file, 'utf8');
  if (source.includes(replacement)) return;
  if (source.split(anchor).length !== 2) throw new Error(`Unexpected upstream layout in ${file}: ${anchor}`);
  writeFileSync(file, source.replace(anchor, replacement));
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
  const main = join(desktop, 'src/main.ts');
  insert(main, 'async function main(): Promise<void> {', "import { startMolioDesktop } from './molio-desktop.js'\n\nasync function main(): Promise<void> {\n  const molioMenu = await startMolioDesktop()");
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
  insert(main, 'const applicationItems = (): MenuItemConstructorOptions[] => [', 'const applicationItems = (): MenuItemConstructorOptions[] => [\n    ...molioMenu,');
  insert(join(desktop, 'scripts/electron-builder-config.mjs'), 'extraResources: [', `extraResources: [
      { from: fileURLToPath(new URL('../molio-resources', import.meta.url)), to: 'molio' },
      { from: fileURLToPath(new URL('../molio-support', import.meta.url)), to: 'molio-support' },`);
}

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

// DSH normally selects the enclosing Git root. Registered nested vaults also
// contribute their own project skills, without writing to a parent repository.
export function applyVaultSkillRoot(hostRoot) {
  const file = join(hostRoot, 'packages/skill/skill-filesystem/src/index.ts');
  const anchor = 'const projectRoot = await findProjectRoot(resolve(cwd), optionalFileSystem(this.ctx))';
  insert(file, anchor, anchor + `
      const vault = resolve(cwd)
      if (vault !== projectRoot && await pathExists(join(vault, '.agents/.molio-vault'), optionalFileSystem(this.ctx))) {
        roots.push({ path: join(vault, '.agents/skills'), source: 'project-agents', rank: PROJECT_AGENTS_RANK - 1, projectRoot: vault })
      }`);
}

// Cached Windows checkouts can contain a repeated pair from an older overlay.
// electron-builder copies extraResources concurrently, so every destination must be unique.
export function applyDesktopResources(hostRoot) {
  const file = join(hostRoot, 'apps/desktop/scripts/electron-builder-config.mjs');
  const original = readFileSync(file, 'utf8');
  const source = original.replaceAll('\r\n', '\n');
  const anchor = '    extraResources: [\n';
  const rows = [ ['molio-plugin-resources', 'molio'], ['molio-support', 'molio-support'] ].map(([from, to]) =>
    `      { from: fileURLToPath(new URL('../${from}', import.meta.url)), to: '${to}' },\n`);
  if (source.split(anchor).length !== 2) throw new Error('Unexpected extraResources in desktop packaging config');
  let clean = source.replaceAll(rows[0].replace('molio-plugin-resources', 'molio-resources'), '');
  for (const row of rows) clean = clean.replaceAll(row, '');
  const updated = clean.replace(anchor, () => anchor + rows.join(''));
  if (source !== updated) writeFileSync(file, original.includes('\r\n') ? updated.replaceAll('\n', '\r\n') : updated);
}

export function applyDesktop(hostRoot) {
  const frame = join(hostRoot, 'packages/client/ui-layout/src/client/AppFrame.tsx');
  const panelSelection = '  const panelId = usePanelInfo(info => info.activePanelId)';
  insert(frame, panelSelection, panelSelection + `
  const knowledgeSelected = panelId === 'molio-knowledge'
  const [knowledgeVisited, setKnowledgeVisited] = useState(false)
  useEffect(() => { if (knowledgeSelected) setKnowledgeVisited(true) }, [knowledgeSelected])`);
  insert(frame, "    {renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })}", `    {(knowledgeSelected || knowledgeVisited) && <div style={{ display: knowledgeSelected ? 'contents' : 'none' }}>
      {renderSlot('main', {}, { entryKey: 'molio-knowledge' })}
    </div>}
    {!knowledgeSelected && renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })}`);
  const markdown = join(hostRoot, 'packages/client/ui-primitives/src/markdown');
  copyFileSync(join(root, 'packages/dsh-plugin-molio/desktop/MolioWikiText.tsx'), join(markdown, 'MolioWikiText.tsx'));
  const render = join(markdown, 'render.tsx');
  copyFileSync(join(root, 'distribution/test/desktop/harness/wiki-links.client.spec.tsx'),
    join(markdown, '../../tests/wiki-links.client.spec.tsx'));
  insert(render, "import { FenceCodeBlock", "import { MolioWikiText } from './MolioWikiText.tsx'\nimport { FenceCodeBlock");
  insert(render, "case 'text':\n      return node.value", "case 'text':\n      return !context.inLink && node.value.includes('[[') ? <MolioWikiText key={key} text={node.value} /> : node.value");
  const delegate = join(markdown, 'MarkdownDelegate.tsx');
  insert(delegate, 'export interface MarkdownDelegate {', 'export interface MarkdownDelegate {\n  readonly wikiCwd?: string | undefined');
  insert(delegate, '  children,\n  openExternalLink,', '  children,\n  wikiCwd,\n  openExternalLink,');
  insert(delegate, '({ openExternalLink, openFile', '({ wikiCwd, openExternalLink, openFile');
  insert(delegate, '[openExternalLink, openFile', '[wikiCwd, openExternalLink, openFile');
  const chat = join(hostRoot, 'packages/client/ui-chat/src/client/chat/ChatView.tsx');
  insert(chat, '<MarkdownDelegateProvider\n', '<MarkdownDelegateProvider\n              wikiCwd={cwd}\n');
  const desktop = join(hostRoot, 'apps/desktop');
  const support = join(desktop, 'molio-support');
  mkdirSync(support, { recursive: true });
  for (const name of ['sidecar.mjs', 'preload.cjs', 'suggest.patch.yml']) {
    copyFileSync(join(root, 'distribution/desktop', name), join(support, name));
  }
  copyFileSync(join(root, 'distribution/desktop/crypto-server.js'), join(support, 'crypto-server.mjs'));
  copyFileSync(join(root, 'distribution/desktop/molio-desktop.ts'), join(desktop, 'src/molio-desktop.ts'));
  copyFileSync(join(root, 'packages/dsh-plugin-molio/desktop/molio-clipper.ts'), join(desktop, 'src/molio-clipper.ts'));
  copyFileSync(join(root, 'packages/dsh-plugin-molio/desktop/molio-compose.ts'), join(desktop, 'src/molio-compose.ts'));
  copyFileSync(join(root, 'distribution/desktop/molio-product-preload.ts'), join(desktop, 'src/molio-product-preload.ts'));
  const preload = join(desktop, 'src/preload-app.ts');
  insert(preload, "import { contextBridge, ipcRenderer, webUtils }", "import { installKnowledgeComposer } from './molio-product-preload.js'\nimport { contextBridge, ipcRenderer, webUtils }");
  insert(preload, "  contextBridge.exposeInMainWorld('dshOnboarding'", "  if (process.isMainFrame) installKnowledgeComposer()\n  contextBridge.exposeInMainWorld('dshOnboarding'");
  const workspace = join(hostRoot, 'packages/client/ui-workspace/src/client/index.ts');
  const binding = '  const browserFlowSource = flowSource';
  const composer = 'registerMolioComposer(ctx, workspaces, sessions, uiWorkspace)';
  const workspaceSource = readFileSync(workspace, 'utf8');
  const migratedWorkspace = workspaceSource.replace(/^  const molioComposer = \(globalThis as \{[\s\S]*?^  \}\)\)\r?\n/m, '');
  if (workspaceSource !== migratedWorkspace) writeFileSync(workspace, migratedWorkspace);
  copyFileSync(join(root, 'packages/dsh-plugin-molio/desktop/register-composer.ts'), join(workspace, '../register-composer.ts'));
  insert(workspace, "import { UiWorkspaceService }", "import { registerMolioComposer } from './register-composer.ts'\nimport { UiWorkspaceService }");
  insert(workspace, binding, '  ' + composer + '\n' + binding);
  const sidebar = join(hostRoot, 'packages/client/ui-sidebar/src/client');
  copyFileSync(join(root, 'packages/dsh-plugin-molio/desktop/MolioSidebar.tsx'), join(sidebar, 'MolioSidebar.tsx'));
  const sidebarRoot = join(sidebar, 'SidebarRoot.tsx');
  const source = readFileSync(sidebarRoot, 'utf8');
  const migratedSidebar = source.replace("import { MolioSidebar }", "import { MolioSidebar, molioPanelId }")
    .replace('<MolioSidebar wide={wide} />', '<MolioSidebar wide={wide} selected={activePanelId === molioPanelId} />');
  if (source !== migratedSidebar) writeFileSync(sidebarRoot, migratedSidebar);
  insert(sidebarRoot, "import css from './SidebarRoot.module.css'", "import { MolioSidebar, molioPanelId } from './MolioSidebar.tsx'\nimport css from './SidebarRoot.module.css'");
  insert(sidebarRoot, '      <div className={css.scrollRegion}>', '      <MolioSidebar wide={wide} selected={activePanelId === molioPanelId} />\n      <div className={css.scrollRegion}>');
  const sidebarIndex = join(sidebar, 'index.ts');
  const indexSource = readFileSync(sidebarIndex, 'utf8');
  const updatedIndex = indexSource.replace(/^import \{ bridge, molioPanelId, MolioPanel, showMolioPage \} from .*\r?\n/m, '')
    .replace(/^  const navigation = bridge\r?\n  if \(navigation\) \{[\s\S]*?^  \}\r?\n/m, '');
  if (indexSource !== updatedIndex) writeFileSync(sidebarIndex, updatedIndex);
  insert(sidebarIndex, "import { SidebarRoot }", "import { registerMolioPanel } from './MolioSidebar.tsx'\nimport { SidebarRoot }");
  insert(sidebarIndex, '  const panelPins =', '  registerMolioPanel(ctx)\n  const panelPins =');
  const browserGuests = join(desktop, 'src/browser-guests.ts');
  insert(browserGuests, "import { randomUUID }", "import { attachMolioPanel, bindMolioPanel } from './molio-desktop.js'\nimport { randomUUID }");
  insert(browserGuests, "      const id = typeof params.src", `      try {
        if (attachMolioPanel(owner, preferences, params)) return
      } catch { event.preventDefault(); return }
      const id = typeof params.src`);
  insert(browserGuests, '      let attachedLease:', '      if (bindMolioPanel(owner, guest)) return\n      let attachedLease:');
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
  const oldBinding = /  bindMolioConversationWindow\(\(\) => \{\r?\n    if \(!mainWindow \|\| !enteredWorkspace\)[\s\S]*?\r?\n  \}\)\r?\n/;
  const mainSource = readFileSync(main, 'utf8');
  const cleaned = mainSource.replace(oldBinding, '').replace(/  bindMolioConversationWindow\(\(\) => mainWindow\)\r?\n/, '');
  if (cleaned !== mainSource) writeFileSync(main, cleaned);
  insert(main, welcome, '  bindMolioConversationWindow(() => mainWindow, () => enteredWorkspace)\n' + welcome);
  insert(main, "import { bindMolioConversationWindow }", "import { flushMolioClip } from './molio-desktop.js'\nimport { bindMolioConversationWindow }");
  insert(main, '    enteredWorkspace = true', '    enteredWorkspace = true\n    flushMolioClip()');
  const registration = "if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === '1') app.setAsDefaultProtocolClient('dsh')";
  insert(main, registration, `if (process.env.MOLIO_SKIP_PROTOCOL_REGISTRATION !== '1') {
    ${registration}
    if (app.isPackaged) app.setAsDefaultProtocolClient('molio')
  }`);
  applyDesktopResources(hostRoot);
}

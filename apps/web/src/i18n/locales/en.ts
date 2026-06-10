const en: Record<string, string> = {
  // ── NavRail ──
  'nav.home': 'Home',
  'nav.knowledge': 'Knowledge Base',
  'nav.runtimes': 'Runtimes',
  'nav.graph': 'Graph',
  'nav.settings': 'Settings',

  // ── HomePage ──
  'home.newChat': 'New chat',
  'home.noAgent': 'No agent selected — set a default in Runtimes',
  'home.tagline': 'Ink stored in the library, flowing through all things',

  // ── ChatComposer ──
  'composer.noAgent': 'No agent available',
  'composer.waiting': 'Waiting for response...',
  'composer.placeholder': 'Type a message...',
  'composer.stop': 'Stop',
  'composer.send': 'Send',
  'composer.hint': 'Shift+Enter for new line',

  // ── AssistantMessage ──
  'assistant.label': 'Molio',

  // ── ThinkingBlock ──
  'thinking.title': 'Thinking',
  'thinking.streaming': 'Thinking...',

  // ── ToolCard ──
  'tool.submit': 'Submit',
  'tool.answered': 'Answered',
  'tool.awaiting': 'Awaiting input',

  // ── ToolGroup ──
  'toolGroup.fileRead': 'file reads',
  'toolGroup.fileWrite': 'file writes',
  'toolGroup.edit': 'edits',
  'toolGroup.command': 'commands',
  'toolGroup.fileSearch': 'file searches',
  'toolGroup.contentSearch': 'content searches',
  'toolGroup.agent': 'sub-agents',
  'toolGroup.webFetch': 'web fetches',
  'toolGroup.webSearch': 'web searches',
  'toolGroup.default': 'tool calls',

  // ── RuntimePage ──
  'runtimes.title': 'Runtimes',
  'runtimes.agentsTab': 'Agents',
  'runtimes.runsTab': 'Runs',
  'runtimes.agentsAvailable': '{count} agents available',
  'runtimes.running': '{count} running',
  'runtimes.installed': 'Installed',
  'runtimes.notInstalled': 'Not Installed',
  'runtimes.default': 'Default',
  'runtimes.available': 'Available',
  'runtimes.unavailable': 'Unavailable',
  'runtimes.notFound': 'Not found',
  'runtimes.test': 'Test',
  'runtimes.testing': 'Testing…',
  'runtimes.cancel': 'Cancel',
  'runtimes.rescan': 'Rescan',
  'runtimes.scanning': 'Scanning…',
  'runtimes.availableSuffix': 'available',
  'runtimes.scanFailed': 'Scan failed',
  'runtimes.retry': 'Retry',
  'runtimes.loading': 'Loading…',
  'runtimes.noAgents': 'No agents detected',
  'runtimes.installHint': 'Install a supported AI CLI to get started.',
  'runtimes.noRuns': 'No runs yet',
  'runtimes.startHint': 'Start a conversation to create a run.',
  'runtimes.active': 'Active',
  'runtimes.completed': 'Completed',
  'runtimes.pending': 'Pending',
  'runtimes.succeeded': 'Succeeded',
  'runtimes.failed': 'Failed',
  'runtimes.canceled': 'Canceled',
  'runtimes.install': 'Install →',
  'runtimes.agentHint': 'Double-click an agent to set it as the default runtime for chat.',
  'runtimes.justNow': 'just now',
  'runtimes.mAgo': '{n}m ago',
  'runtimes.hAgo': '{n}h ago',
  'runtimes.testOk': 'OK ({elapsed}ms)',
  'runtimes.testFailed': 'Test failed',

  // ── Settings ──
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.versionSection': 'Version & Updates',
  'settings.currentVersion': 'Current version',
  'settings.checkUpdate': 'Check for updates',
  'settings.checking': 'Checking…',
  'settings.isChecking': 'Checking for updates…',
  'settings.upToDate': 'Up to date',
  'settings.newVersion': 'New version v{version} available',
  'settings.downloaded': 'Update downloaded',
  'settings.downloading': 'Downloading {percent}%',
  'settings.readyText': 'v{version} downloaded, restart to apply',
  'settings.restartNow': 'Restart now',
  'settings.desktopOnly': 'Update is only available in the desktop client',

  // ── UpdateNotification ──
  'update.ready': 'Update ready',
  'update.willApply': 'v{version} will be applied after restart',
  'update.later': 'Later',
  'update.restartNow': 'Restart now',

  // ── GraphPage ──
  'graph.title': 'Graph View',
  'graph.loading': 'Loading graph data…',
  'graph.noVault': 'Create a vault first to see the graph',
  'graph.nodes': '{count} nodes',
  'graph.edges': '{count} edges',
  'graph.selectVault': 'Select vault',
  'graph.empty': 'No Markdown files in this vault',
};

export default en;

const en: Record<string, string> = {
  // ── NavRail ──
  'nav.home': 'Home',
  'nav.knowledge': 'Knowledge Base',
  'nav.runtimes': 'Runtimes',
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

  // ── Onboarding Tour ──
  'nav.guide': 'Getting Started',
  'tour.step1.title': 'Step 1: Configure Runtime',
  'tour.step1.desc': 'First, install and select an AI agent (e.g. Claude Code) as your runtime — the core engine of Molio.',
  'tour.step2.title': 'Step 2: Import Knowledge Base',
  'tour.step2.desc': 'Go to the Knowledge Base page, create a Vault and import your documents as source material for AI creation.',
  'tour.step3.title': 'Step 3: Build Knowledge Base',
  'tour.step3.desc': 'Index and build a Wiki from your imported documents so AI can understand and retrieve your knowledge.',
  'tour.step4.title': 'Step 4: Create via Chat',
  'tour.step4.desc': 'Return to the home page and chat with AI to create articles, answer questions, or generate ideas based on your knowledge base.',
  'tour.step5.title': 'Step 5: Typeset & Style',
  'tour.step5.desc': 'Switch to typeset mode and use the doocs/md engine to adjust themes, fonts, and styles for a polished look.',
  'tour.step6.title': 'Step 6: Publish Everywhere',
  'tour.step6.desc': 'Once typeset, publish your article to 30+ platforms including WeChat, Zhihu, Juejin, and more with one click.',
  'tour.skip': 'Skip',
  'tour.prev': 'Previous',
  'tour.next': 'Next',
  'tour.done': 'Get Started',

  // ── UpdateNotification ──
  'update.ready': 'Update ready',
  'update.willApply': 'v{version} will be applied after restart',
  'update.later': 'Later',
  'update.restartNow': 'Restart now',
};

export default en;

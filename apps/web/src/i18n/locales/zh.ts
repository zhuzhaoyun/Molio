const zh: Record<string, string> = {
  // ── NavRail ──
  'nav.home': '首页',
  'nav.knowledge': '知识库',
  'nav.runtimes': '运行时',
  'nav.graph': '图谱',
  'nav.settings': '设置',

  // ── HomePage ──
  'home.newChat': '新对话',
  'home.noAgent': '未选择代理 — 请在运行时页面设置默认代理',
  'home.tagline': '墨藏于库，流于万象',

  // ── ChatComposer ──
  'composer.noAgent': '没有可用的代理',
  'composer.waiting': '等待回复…',
  'composer.placeholder': '输入消息…',
  'composer.stop': '停止',
  'composer.send': '发送',
  'composer.hint': 'Shift+Enter 换行',

  // ── AssistantMessage ──
  'assistant.label': 'Molio',

  // ── ThinkingBlock ──
  'thinking.title': '思考',
  'thinking.streaming': '思考中...',

  // ── ToolCard ──
  'tool.submit': '提交',
  'tool.answered': '已回答',
  'tool.awaiting': '等待输入',

  // ── ToolGroup ──
  'toolGroup.fileRead': '个文件读取',
  'toolGroup.fileWrite': '个文件写入',
  'toolGroup.edit': '处修改',
  'toolGroup.command': '个命令',
  'toolGroup.fileSearch': '次文件搜索',
  'toolGroup.contentSearch': '次内容搜索',
  'toolGroup.agent': '个子代理',
  'toolGroup.webFetch': '次网页抓取',
  'toolGroup.webSearch': '次网页搜索',
  'toolGroup.default': '次工具调用',

  // ── RuntimePage ──
  'runtimes.title': '运行时',
  'runtimes.agentsTab': '代理',
  'runtimes.runsTab': '运行',
  'runtimes.agentsAvailable': '{count} 个代理可用',
  'runtimes.running': '{count} 个运行中',
  'runtimes.installed': '已安装',
  'runtimes.notInstalled': '未安装',
  'runtimes.default': '默认',
  'runtimes.available': '可用',
  'runtimes.unavailable': '不可用',
  'runtimes.notFound': '未找到',
  'runtimes.test': '测试',
  'runtimes.testing': '测试中…',
  'runtimes.cancel': '取消',
  'runtimes.rescan': '重新扫描',
  'runtimes.scanning': '扫描中…',
  'runtimes.availableSuffix': '个可用',
  'runtimes.scanFailed': '扫描失败',
  'runtimes.retry': '重试',
  'runtimes.loading': '加载中…',
  'runtimes.noAgents': '未检测到代理',
  'runtimes.installHint': '安装一个受支持的 AI CLI 以开始使用。',
  'runtimes.noRuns': '暂无运行记录',
  'runtimes.startHint': '开始对话以创建运行。',
  'runtimes.active': '活跃',
  'runtimes.completed': '已完成',
  'runtimes.pending': '等待中',
  'runtimes.succeeded': '成功',
  'runtimes.failed': '失败',
  'runtimes.canceled': '已取消',
  'runtimes.install': '安装 →',
  'runtimes.agentHint': '双击代理可将其设为聊天默认运行时。',
  'runtimes.justNow': '刚刚',
  'runtimes.mAgo': '{n}分钟前',
  'runtimes.hAgo': '{n}小时前',
  'runtimes.testOk': 'OK ({elapsed}ms)',
  'runtimes.testFailed': '测试失败',

  // ── Settings ──
  'settings.title': '设置',
  'settings.language': '语言',
  'settings.versionSection': '版本与更新',
  'settings.currentVersion': '当前版本',
  'settings.checkUpdate': '检查更新',
  'settings.checking': '检查中…',
  'settings.isChecking': '正在检查更新…',
  'settings.upToDate': '已是最新版本',
  'settings.newVersion': '发现新版本 v{version}',
  'settings.downloaded': '更新已下载',
  'settings.downloading': '下载中 {percent}%',
  'settings.readyText': 'v{version} 已下载，重启后应用更新',
  'settings.restartNow': '立即重启',
  'settings.desktopOnly': '更新功能仅在桌面客户端可用',

  // ── UpdateNotification ──
  'update.ready': '更新就绪',
  'update.willApply': 'v{version} 将在重启后应用',
  'update.later': '稍后',
  'update.restartNow': '立即重启',

  // ── GraphPage ──
  'graph.title': '关系图谱',
  'graph.loading': '加载图谱数据…',
  'graph.noVault': '请先创建一个知识库来查看关系图谱',
  'graph.nodes': '{count} 个节点',
  'graph.edges': '{count} 条链接',
  'graph.selectVault': '选择知识库',
  'graph.empty': '该知识库中没有 Markdown 文件',
};

export default zh;

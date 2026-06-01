// ============================================================
// editor.js — 中间 Markdown 编辑器
// ============================================================

const Editor = {
  tabs: [{ id: 'welcome', title: '🏠 欢迎', content: '', domain: '—' }],
  activeTabId: 'welcome',
  showPreview: false,

  init() {
    this.editorEl = document.getElementById('markdown-editor');
    this.previewEl = document.getElementById('preview-pane');
    this.previewContent = document.getElementById('preview-content');
    this.statusWords = document.getElementById('status-words');
    this.statusDomain = document.getElementById('status-domain');

    this.bindToolbar();
    this.bindEditorEvents();
    this.renderWelcome();
  },

  renderWelcome() {
    this.editorEl.value = '';
    this.previewContent.innerHTML = `
      <div class="markdown-body" style="text-align:center;padding:80px 40px;">
        <div style="font-size:48px;margin-bottom:20px;">🌱</div>
        <h2 style="border:none;font-size:22px;">知识增长引擎</h2>
        <p style="color:var(--text-secondary);max-width:500px;margin:16px auto;line-height:1.8;">
          从你的 <strong>llm_wiki 知识库</strong> 出发，与 <strong>AI Agent 协作</strong> 写作，
          一键适配 <strong>多平台排版</strong>，全渠道分发。
        </p>
        <div style="margin-top:32px;display:flex;flex-direction:column;gap:10px;max-width:360px;margin-left:auto;margin-right:auto;text-align:left;font-size:13px;color:var(--text-muted);">
          <div style="display:flex;align-items:center;gap:8px;"><span>📚</span> 左侧浏览 wiki 知识库，双击文件打开</div>
          <div style="display:flex;align-items:center;gap:8px;"><span>🤖</span> 右侧 AI 面板，选择方法论让 Agent 写作</div>
          <div style="display:flex;align-items:center;gap:8px;"><span>📤</span> 发布标签页，一键适配多平台格式</div>
        </div>
        <div style="margin-top:40px;">
          <button class="btn btn-ai" onclick="App.showTemplateModal()" style="font-size:15px;padding:10px 28px;">
            🤖 AI 辅助写作
          </button>
        </div>
      </div>`;
    this.updateStatus(0, '—');
  },

  // 打开新 tab
  openTab(title, content, domain = '—') {
    // 检查是否已存在
    const existing = this.tabs.find(t => t.title === title);
    if (existing) {
      this.switchTab(existing.id);
      return;
    }

    const tabId = 'tab-' + Date.now();
    this.tabs.push({ id: tabId, title, content, domain });
    this.renderTabs();
    this.switchTab(tabId);
  },

  openTabFromWiki(page, templateContent = null) {
    const title = page.title;
    let content = templateContent;

    if (!content) {
      // 基于 wiki 内容创建草稿
      const frontmatter = `---
type: draft
domain: ${page.domain}
method: AI 辅助生成
source: [[${page.path}]]
created: ${new Date().toISOString().split('T')[0]}
---

# ${page.title}

> 本文基于 wiki 概念「${page.title}」生成

`;
      const summary = page.summary ? `\n## 核心观点\n\n${page.summary}\n` : '';
      content = frontmatter + summary;
    }

    this.openTab(title, content, page.domain);
  },

  openTabWithArticle(title, content, domain) {
    this.openTab(title, content, domain);
  },

  renderTabs() {
    const tabsEl = document.getElementById('editor-tabs');
    let html = '';

    this.tabs.forEach(tab => {
      const isActive = tab.id === this.activeTabId;
      const canClose = tab.id !== 'welcome';
      html += `<div class="editor-tab${isActive ? ' active' : ''}" data-tab-id="${tab.id}">
        <span>${tab.title.length > 18 ? tab.title.slice(0, 18) + '…' : tab.title}</span>
        ${canClose ? `<span class="close-tab" data-close="${tab.id}">×</span>` : ''}
      </div>`;
    });

    tabsEl.innerHTML = html;
    this.bindTabEvents();
  },

  bindTabEvents() {
    document.querySelectorAll('.editor-tab').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('close-tab')) {
          e.stopPropagation();
          this.closeTab(e.target.dataset.close);
          return;
        }
        this.switchTab(el.dataset.tabId);
      });
    });
  },

  switchTab(tabId) {
    this.activeTabId = tabId;
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    this.editorEl.value = tab.content || '';
    this.renderTabs();
    this.updateStatusFromContent(tab.content || '');
    this.updatePreview();

    this.statusDomain.textContent = `域: ${tab.domain}`;
  },

  closeTab(tabId) {
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    this.tabs.splice(idx, 1);

    if (this.activeTabId === tabId) {
      const newActive = this.tabs[Math.min(idx, this.tabs.length - 1)];
      if (newActive) this.switchTab(newActive.id);
    }
    this.renderTabs();
  },

  // Toolbar 操作
  bindToolbar() {
    document.querySelectorAll('.toolbar-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        this.execToolbarAction(action);
      });
    });
  },

  execToolbarAction(action) {
    const el = this.editorEl;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = el.value;

    const actions = {
      bold: { prefix: '**', suffix: '**', label: '加粗文本' },
      italic: { prefix: '*', suffix: '*', label: '斜体文本' },
      strikethrough: { prefix: '~~', suffix: '~~', label: '删除文本' },
      h1: { prefix: '# ', suffix: '', label: '标题' },
      h2: { prefix: '## ', suffix: '', label: '标题' },
      h3: { prefix: '### ', suffix: '', label: '标题' },
      quote: { prefix: '> ', suffix: '', label: '引用' },
      code: { prefix: '\n```\n', suffix: '\n```\n', label: '代码' },
      list: { prefix: '- ', suffix: '', label: '列表项' },
      hr: { prefix: '\n---\n', suffix: '', label: '' },
    };

    if (action === 'toggle-preview') {
      this.togglePreview();
      return;
    }

    const cmd = actions[action];
    if (!cmd) return;

    const selected = text.substring(start, end) || cmd.label;
    const replacement = cmd.prefix + selected + cmd.suffix;

    el.setRangeText(replacement, start, end, 'select');
    el.focus();
    this.onContentChange();
  },

  togglePreview() {
    this.showPreview = !this.showPreview;
    this.previewEl.classList.toggle('visible', this.showPreview);
    if (this.showPreview) this.updatePreview();
  },

  updatePreview() {
    const md = this.editorEl.value;
    this.previewContent.innerHTML = this.renderMarkdown(md);
  },

  // 简易 Markdown 渲染器
  renderMarkdown(md) {
    let html = md
      // Escape HTML
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold & Italic
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Strikethrough
      .replace(/~~(.+?)~~/g, '<del>$1</del>')
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      // Blockquote
      .replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
      // HR
      .replace(/^---$/gm, '<hr>')
      // Lists
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      // Wiki links
      .replace(/\[\[(.+?)\]\]/g, '<span class="wiki-link" style="color:var(--accent);cursor:pointer;border-bottom:1px dashed var(--accent);">$1</span>')
      // Paragraphs (double newline)
      .replace(/\n\n/g, '</p><p>')
      // Frontmatter (hide)
      .replace(/^---[\s\S]*?---\n/, '<div class="frontmatter" style="background:var(--bg-tertiary);padding:8px 12px;border-radius:4px;font-size:12px;color:var(--text-muted);margin-bottom:16px;">📋 Frontmatter</div>');

    return '<div class="markdown-body"><p>' + html.split('\n').filter(l => l.trim()).join('\n') + '</p></div>';
  },

  // 编辑器事件
  bindEditorEvents() {
    this.editorEl.addEventListener('input', () => this.onContentChange());
    this.editorEl.addEventListener('keydown', (e) => this.onKeyDown(e));

    // 保存当前 tab 内容
    this.editorEl.addEventListener('blur', () => this.saveCurrentTab());
  },

  onContentChange() {
    const content = this.editorEl.value;
    this.updateStatusFromContent(content);
    if (this.showPreview) this.updatePreview();

    // 通知 AI 面板更新关联知识
    if (App.onEditorChange) {
      App.onEditorChange(content);
    }
  },

  onKeyDown(e) {
    // / 快捷命令
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.showQuickInsert();
    }

    // Ctrl+S 保存
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      this.showToast('已保存 ✓', 'success');
    }
  },

  showQuickInsert() {
    const actions = ['标题', '引用', '代码块', '列表', '分隔线', '图片'];
    // 简易实现：在光标处插入提示
    const el = this.editorEl;
    const pos = el.selectionStart;
    const text = el.value;
    const before = text.substring(0, pos);
    el.value = before + '\n> 💡 输入: # 标题 | > 引用 | ``` 代码块 | - 列表 | --- 分隔线\n' + text.substring(pos);
    el.focus();
  },

  saveCurrentTab() {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (tab) {
      tab.content = this.editorEl.value;
    }
  },

  // 设置编辑器内容（AI 生成的结果）
  setContent(content, domain = '—') {
    this.editorEl.value = content;
    this.saveCurrentTab();
    this.updateStatusFromContent(content);
    this.updatePreview();
    this.statusDomain.textContent = `域: ${domain}`;
  },

  // 高亮 AI diff
  applyDiff(diffContent) {
    let html = this.editorEl.value;
    // 插入 diff 标记的内容
    this.editorEl.value = html + '\n\n' + diffContent;
    this.saveCurrentTab();
    this.onContentChange();
  },

  updateStatusFromContent(content) {
    const words = content.replace(/\s/g, '').length;
    this.statusWords.textContent = `字数: ${words}`;
  },

  updateStatus(words, domain) {
    this.statusWords.textContent = `字数: ${words}`;
  },

  showToast(msg, type = '') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }
};
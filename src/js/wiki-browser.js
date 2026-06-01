// ============================================================
// wiki-browser.js — 左侧知识库浏览器
// ============================================================

const WikiBrowser = {
  currentDomain: '写作',
  selectedFile: null,

  init() {
    this.renderDomainTabs();
    this.renderFileTree();
    this.bindEvents();
  },

  // 按 page type 分组中文名
  groupLabels: {
    'concept': '📖 概念',
    'entity': '👤 案例',
    'draft': '✏️ 文章草稿',
    'article': '📰 已发布',
    'overview': '📋 概述'
  },

  renderFileTree(domain = this.currentDomain) {
    const tree = document.getElementById('file-tree');
    const filtered = wikiPages.filter(p => p.domain === domain);

    // 按 type 分组
    const groups = {};
    filtered.forEach(p => {
      const type = p.type || 'other';
      if (!groups[type]) groups[type] = [];
      groups[type].push(p);
    });

    let html = '';

    if (filtered.length === 0) {
      tree.innerHTML = '<div class="empty-state"><div class="empty-icon">📂</div><p>此域暂无内容</p></div>';
      return;
    }

    for (const [type, pages] of Object.entries(groups)) {
      const label = this.groupLabels[type] || `📄 ${type}`;
      html += `<div class="file-group">
        <div class="file-group-header">
          <span>${label}</span>
          <span class="count">${pages.length}</span>
        </div>`;

      pages.forEach(p => {
        const isActive = this.selectedFile && this.selectedFile.path === p.path;
        html += `<div class="file-item${isActive ? ' active' : ''}" data-path="${p.path}">
          <span class="file-icon">📄</span>
          <span class="file-title">${p.title}</span>
          <span class="file-type">${p.type}</span>
        </div>`;
      });

      html += '</div>';
    }

    tree.innerHTML = html;
    this.bindFileEvents();
  },

  bindFileEvents() {
    document.querySelectorAll('.file-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const path = el.dataset.path;
        this.selectFile(path);
      });

      el.addEventListener('dblclick', (e) => {
        const path = el.dataset.path;
        this.openInEditor(path);
      });
    });
  },

  selectFile(path) {
    this.selectedFile = path;
    document.querySelectorAll('.file-item').forEach(el => {
      el.classList.toggle('active', el.dataset.path === path);
    });

    // 通知右侧知识面板更新
    const page = wikiPages.find(p => p.path === path);
    if (page && App.onFileSelected) {
      App.onFileSelected(page);
    }
  },

  openInEditor(path) {
    const page = wikiPages.find(p => p.path === path);
    if (page && App.onFileDoubleClick) {
      App.onFileDoubleClick(page);
    }
  },

  renderDomainTabs() {
    const tabs = document.querySelectorAll('#domain-nav .domain-tab');
    tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.domain === this.currentDomain);
    });
  },

  bindEvents() {
    // 域导航
    document.querySelectorAll('#domain-nav .domain-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.currentDomain = tab.dataset.domain;
        this.renderDomainTabs();
        this.renderFileTree();
        this.selectedFile = null;
      });
    });

    // 搜索
    const searchInput = document.getElementById('wiki-search');
    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase().trim();
      if (!term) {
        this.renderFileTree();
        return;
      }

      const results = wikiPages.filter(p =>
        p.title.toLowerCase().includes(term) ||
        p.tags.some(t => t.toLowerCase().includes(term)) ||
        (p.summary && p.summary.toLowerCase().includes(term))
      );

      this.renderSearchResults(results);
    });
  },

  renderSearchResults(results) {
    const tree = document.getElementById('file-tree');
    if (results.length === 0) {
      tree.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>没有找到匹配的内容</p></div>';
      return;
    }

    let html = `<div class="file-group-header" style="padding:6px 14px;font-size:11px;color:var(--text-muted);">
      搜索结果 · ${results.length} 个页面
    </div>`;

    results.forEach(p => {
      html += `<div class="file-item" data-path="${p.path}">
        <span class="file-icon">📄</span>
        <span class="file-title">${p.title}</span>
        <span class="file-type">${p.domain}</span>
      </div>`;
    });

    tree.innerHTML = html;
    this.bindFileEvents();
  }
};
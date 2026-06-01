// ============================================================
// app.js — 主控制器
// 连接 Wiki Browser / Editor / AI Panel / Publish Panel
// ============================================================

const App = {
  currentTemplatePage: null,

  init() {
    WikiBrowser.init();
    Editor.init();
    AIPanel.init();
    PublishPanel.init();

    this.bindGlobalEvents();
    this.bindHeaderButtons();
  },

  // === 回调接口（供子模块调用） ===

  // 用户选中 wiki 文件
  onFileSelected(page) {
    AIPanel.onFileSelected(page);
  },

  // 用户双击 wiki 文件
  onFileDoubleClick(page) {
    Editor.openTabFromWiki(page);
    AIPanel.onFileSelected(page);
    // 切换到知识 tab
    document.querySelectorAll('#ai-panel .panel-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === 'knowledge');
    });
    document.querySelectorAll('#ai-panel .panel-content').forEach(p => {
      p.classList.toggle('active', p.id === 'tab-knowledge');
    });
  },

  // 编辑器内容变化
  onEditorChange(content) {
    // 发布 tab 激活时更新预览
    const publishContent = document.getElementById('tab-publish');
    if (publishContent.classList.contains('active')) {
      PublishPanel.updatePreview();
    }
  },

  // === AI Agent 状态 ===

  setAIStatus(state, text) {
    const dot = document.getElementById('ai-dot');
    const statusText = document.getElementById('ai-status-text');

    dot.className = 'dot ' + state;
    statusText.textContent = text;
  },

  // === 弹窗管理 ===

  showTemplateModal(page = null) {
    this.currentTemplatePage = page;
    const modal = document.getElementById('modal-template');
    const options = document.getElementById('template-options');

    let html = '';
    writingMethods.forEach(m => {
      html += `<div class="method-card" data-method="${m.id}" style="cursor:pointer;">
        <div class="method-name">${m.name}</div>
        <div class="method-desc">${m.description}</div>
        <div class="method-source">${m.source || ''} · ${m.steps}步</div>
      </div>`;
    });
    options.innerHTML = html;

    // 绑定选择
    let selectedMethod = null;
    options.querySelectorAll('.method-card').forEach(card => {
      card.addEventListener('click', () => {
        options.querySelectorAll('.method-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedMethod = card.dataset.method;
      });
    });

    // 默认选择第一个
    const firstCard = options.querySelector('.method-card');
    if (firstCard) {
      firstCard.classList.add('selected');
      selectedMethod = firstCard.dataset.method;
    }

    modal.style.display = 'flex';

    // 确认
    document.getElementById('btn-modal-confirm').onclick = () => {
      modal.style.display = 'none';
      if (!selectedMethod) return;

      // 如果未选择 wiki 概念
      if (!AIPanel.selectedConcept && !page) {
        Editor.showToast('请先在左侧知识库选择一个概念或案例', 'error');
        return;
      }

      const concept = page || AIPanel.selectedConcept;

      // 在 AI 面板设置选中的方法论
      AIPanel.selectedMethod = selectedMethod;
      AIPanel.selectedConcept = concept;
      document.querySelectorAll('.method-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.method === selectedMethod);
      });

      // 切换到 AI 写作 tab
      document.querySelectorAll('#ai-panel .panel-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === 'assist');
      });
      document.querySelectorAll('#ai-panel .panel-content').forEach(p => {
        p.classList.toggle('active', p.id === 'tab-assist');
      });

      // 打开编辑器 tab
      Editor.openTabFromWiki(concept);

      // 触发 AI 大纲生成
      AIPanel.generateOutline(concept, selectedMethod);
    };
  },

  showOutlineModal(outline) {
    const modal = document.getElementById('modal-outline');
    const content = document.getElementById('outline-content');

    let html = `<p style="color:var(--text-secondary);margin-bottom:16px;">
      方法论：<strong>${outline.method}</strong>
    </p>
    <p style="color:var(--ai-accent);font-size:13px;margin-bottom:16px;padding:8px 12px;background:var(--ai-accent-light);border-radius:4px;">
      💡 核心洞察：${outline.coreInsight}
    </p>
    <h3 style="font-size:18px;margin-bottom:16px;">${outline.title}</h3>
    <ol style="padding-left:24px;">`;

    outline.sections.forEach(s => {
      html += `<li style="margin:12px 0;">
        <strong>${s.text}</strong>
        <br><span style="color:var(--text-muted);font-size:13px;">${s.subtext}</span>
      </li>`;
    });

    html += '</ol>';

    content.innerHTML = html;
    modal.style.display = 'flex';

    // 重新生成
    document.getElementById('btn-outline-retry').onclick = () => {
      modal.style.display = 'none';
      const concept = AIPanel.selectedConcept;
      const method = AIPanel.selectedMethod;
      if (concept && method) {
        AIPanel.generateOutline(concept, method);
      }
    };

    // 确认生成全文
    document.getElementById('btn-outline-confirm').onclick = () => {
      modal.style.display = 'none';
      AIPanel.generateArticle(outline);
    };
  },

  // === Header 按钮 ===

  bindHeaderButtons() {
    // AI 写作
    document.getElementById('btn-new-ai-article').addEventListener('click', () => {
      this.showTemplateModal();
    });

    // 新建空白文章
    document.getElementById('btn-new-article').addEventListener('click', () => {
      const emptyTab = {
        title: '未命名文章',
        content: `---
type: draft
domain: 写作
created: ${new Date().toISOString().split('T')[0]}
---

# `,
        domain: '写作'
      };
      Editor.openTab(emptyTab.title, emptyTab.content, emptyTab.domain);
    });

    // 面板切换
    document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
      document.getElementById('main-content').classList.toggle('sidebar-collapsed');
    });

    document.getElementById('btn-toggle-panel').addEventListener('click', () => {
      document.getElementById('main-content').classList.toggle('panel-collapsed');
    });

    document.getElementById('btn-close-panel').addEventListener('click', () => {
      document.getElementById('main-content').classList.add('panel-collapsed');
    });

    // 刷新 wiki
    document.getElementById('btn-refresh-wiki').addEventListener('click', () => {
      WikiBrowser.renderFileTree();
      Editor.showToast('知识库已刷新', 'success');
    });

    // 复制内容
    document.getElementById('btn-copy-content').addEventListener('click', () => {
      const content = Editor.editorEl.value;
      if (!content.trim()) {
        Editor.showToast('没有内容可复制', 'error');
        return;
      }
      navigator.clipboard.writeText(content).then(() => {
        Editor.showToast('全文已复制到剪贴板！', 'success');
      });
    });

    // 样式面板
    document.getElementById('btn-style-panel').addEventListener('click', () => {
      Editor.showToast('样式面板功能将在下一步集成 doocs/md 完整主题系统', '');
    });
  },

  bindGlobalEvents() {
    // 关闭弹窗
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.style.display = 'none';
        }
      });
    });

    document.getElementById('btn-modal-cancel').addEventListener('click', () => {
      document.getElementById('modal-template').style.display = 'none';
    });

    // 大纲弹窗关闭按钮
    document.getElementById('btn-outline-retry').addEventListener('click', () => {
      document.getElementById('modal-outline').style.display = 'none';
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      // Ctrl+B 加粗
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        Editor.execToolbarAction('bold');
      }
      // Ctrl+I 斜体
      if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
        e.preventDefault();
        Editor.execToolbarAction('italic');
      }
    });
  }
};

// === 启动 ===
document.addEventListener('DOMContentLoaded', () => {
  App.init();
  console.log('🚀 知识增长引擎已启动');
  console.log('   📚 wiki 页面:', wikiPages.length, '个');
  console.log('   📝 写作方法:', writingMethods.length, '个');
  console.log('   📤 发布平台:', Object.keys(platforms).length, '个');
  console.log('   🤖 AI Agent 模拟就绪');
});
// ============================================================
// ai-panel.js — 右侧 AI 协作面板
// ============================================================

const AIPanel = {
  selectedMethod: null,
  selectedConcept: null,
  currentOutline: null,
  agentBusy: false,
  taskLog: [],

  init() {
    this.renderMethodCards();
    this.bindEvents();
    this.updateAgentStatus('idle', '空闲中 — 等待任务');
  },

  renderMethodCards() {
    const container = document.getElementById('method-cards');
    let html = '';

    writingMethods.forEach(m => {
      html += `<div class="method-card" data-method="${m.id}">
        <div class="method-name">${m.name}</div>
        <div class="method-desc">${m.description}</div>
        <div class="method-source">来源: ${m.source || '自定义模板'} · ${m.steps} 步骤</div>
      </div>`;
    });

    container.innerHTML = html;

    container.querySelectorAll('.method-card').forEach(card => {
      card.addEventListener('click', () => {
        this.selectMethod(card.dataset.method);
      });
    });
  },

  selectMethod(methodId) {
    this.selectedMethod = methodId;
    document.querySelectorAll('.method-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.method === methodId);
    });
    this.updateGenerateButton();
  },

  // 当用户选中 wiki 文件时
  onFileSelected(page) {
    this.selectedConcept = page;
    this.renderKnowledgeCards(page);
    this.updateGenerateButton();
  },

  renderKnowledgeCards(page) {
    const container = document.getElementById('knowledge-cards');
    let html = '';

    // 当前选中的页面
    html += `<div class="knowledge-card">
      <div class="card-title">📄 ${page.title}</div>
      <div class="card-meta">
        <span>${page.type}</span>
        <span>${page.domain}</span>
        ${page.tags.map(t => `<span>#${t}</span>`).join('')}
      </div>
      <div class="card-summary">${page.summary}</div>
      <div class="card-actions">
        <button class="btn btn-ai btn-xs card-action-write" data-concept="${page.path}">🤖 基于此写作</button>
        <button class="btn btn-xs card-action-insert" data-concept="${page.path}">📎 插入引用</button>
      </div>
    </div>`;

    // 关联引用的页面
    if (page.references && page.references.length > 0) {
      html += `<div style="margin-top:12px;font-size:11px;color:var(--text-muted);padding:0 4px;">
        🔗 关联页面 (${page.references.length})
      </div>`;

      page.references.forEach(ref => {
        const refName = ref.replace(/^\[\[|\]\]$/g, '');
        const refPage = wikiPages.find(p => p.path.includes(refName.split('/').pop().replace('.md', '')));
        if (refPage) {
          html += `<div class="knowledge-card" style="padding:8px 10px;margin-bottom:6px;">
            <div class="card-title" style="font-size:12px;">📄 ${refPage.title}</div>
            <div class="card-meta"><span>${refPage.type}</span><span>${refPage.domain}</span></div>
          </div>`;
        }
      });
    }

    container.innerHTML = html;

    // 绑定卡片按钮
    container.querySelectorAll('.card-action-write').forEach(btn => {
      btn.addEventListener('click', () => {
        const conceptPath = btn.dataset.concept;
        const page = wikiPages.find(p => p.path === conceptPath);
        if (page) App.showTemplateModal(page);
      });
    });

    container.querySelectorAll('.card-action-insert').forEach(btn => {
      btn.addEventListener('click', () => {
        const conceptPath = btn.dataset.concept;
        const page = wikiPages.find(p => p.path === conceptPath);
        if (page) {
          Editor.editorEl.value += `\n[[${page.title}]]`;
          Editor.onContentChange();
          Editor.showToast('引用已插入', 'success');
        }
      });
    });
  },

  // 更新 "生成" 按钮状态
  updateGenerateButton() {
    const btnOutline = document.getElementById('btn-generate-outline');
    btnOutline.disabled = !(this.selectedMethod && this.selectedConcept);

    btnOutline.style.opacity = btnOutline.disabled ? '0.5' : '1';
    btnOutline.style.cursor = btnOutline.disabled ? 'not-allowed' : 'pointer';
  },

  // 模拟 AI Agent 生成大纲
  generateOutline(concept, methodId) {
    if (this.agentBusy) return;
    this.agentBusy = true;

    this.addTaskLog('generate-outline', '生成大纲', 'running');
    this.updateAgentStatus('running', '分析知识库，生成大纲...');
    App.setAIStatus('running', 'Agent 工作中...');

    // 模拟 agent 处理延迟
    setTimeout(() => {
      let outline;
      if (methodId === 'non-consensus') {
        outline = concept.path.includes('非共识')
          ? agentResponses.outline_nonConsensus
          : agentResponses.outline_leverage;
      } else {
        outline = agentResponses.outline_nonConsensus;
      }

      this.currentOutline = outline;
      this.addTaskLog('generate-outline', '生成大纲', 'done');
      this.updateAgentStatus('completed', '大纲已生成，请审核');
      this.agentBusy = false;
      App.setAIStatus('idle', '等待用户审核大纲');

      App.showOutlineModal(outline);
    }, 2000); // 模拟 2 秒 agent 处理
  },

  // 模拟 AI Agent 生成完整文章
  generateArticle(outline) {
    if (this.agentBusy) return;
    this.agentBusy = true;

    this.addTaskLog('generate-article', '生成全文', 'running');
    this.updateAgentStatus('running', '基于大纲撰写文章...');
    App.setAIStatus('running', 'Agent 写作中...');

    // 模拟分段进度
    const stages = [
      { delay: 800, text: '构建文章结构...' },
      { delay: 1600, text: '展开核心论点...' },
      { delay: 2400, text: '补充案例和数据...' },
      { delay: 3200, text: '润色语言...' },
    ];

    stages.forEach(s => {
      setTimeout(() => {
        this.updateAgentStatus('running', s.text);
      }, s.delay);
    });

    // 最终结果
    setTimeout(() => {
      let article;
      if (this.selectedConcept && this.selectedConcept.path.includes('杠杆')) {
        article = agentResponses.article_leverage;
      } else {
        article = agentResponses.article_nonConsensus;
      }

      const domain = this.selectedConcept ? this.selectedConcept.domain : '写作';
      Editor.openTabWithArticle(outline.title, article, domain);

      this.addTaskLog('generate-article', '生成全文', 'done');
      this.updateAgentStatus('completed', '文章已生成 ✓');
      this.agentBusy = false;
      App.setAIStatus('completed', 'Agent 完成');

      // 显示 AI 对话区域
      this.showChatInput();

      // 切换到知识关联 tab 查看引用
      this.showKnowledgeTab();
    }, 4000);
  },

  // 模拟 Agent 修订
  handleRevision(userMessage) {
    if (this.agentBusy) return;
    this.agentBusy = true;

    this.addChatMessage('user', userMessage);
    this.addTaskLog('revision', `修订: ${userMessage.slice(0, 30)}...`, 'running');
    this.updateAgentStatus('running', '按指令修订文章...');
    App.setAIStatus('running', 'Agent 修订中...');

    // 查找匹配的预设修订
    const revisions = agentResponses.revision_examples;
    let response = null;
    for (const [key, value] of Object.entries(revisions)) {
      if (userMessage.includes(key) || key.includes(userMessage)) {
        response = value;
        break;
      }
    }

    setTimeout(() => {
      if (response) {
        Editor.applyDiff(response);
        this.addChatMessage('agent', '已按你的要求修订完毕！请查看编辑器中高亮的部分。');
      } else {
        // 通用响应
        const genericResponse = `好的，我来处理你的这个要求。

我已经对相关段落进行了调整，主要改动：
- 加强了论点的逻辑支撑
- 补充了更具体的案例
- 优化了表达的精炼度

请查看编辑器中标记的 AI diff 区域。如需进一步修改，请继续告诉我。`;
        Editor.applyDiff(genericResponse);
        this.addChatMessage('agent', genericResponse);
      }

      this.addTaskLog('revision', `修订: ${userMessage.slice(0, 30)}...`, 'done');
      this.updateAgentStatus('completed', '修订完成 ✓');
      this.agentBusy = false;
      App.setAIStatus('completed', 'Agent 完成');
    }, 1800);
  },

  // Chat 功能
  showChatInput() {
    document.getElementById('chat-input-area').style.display = 'flex';
    document.getElementById('chat-input').disabled = false;
    document.getElementById('btn-send-chat').disabled = false;
  },

  addChatMessage(sender, text) {
    const area = document.getElementById('chat-area');
    const div = document.createElement('div');
    div.className = `chat-message ${sender}`;
    div.textContent = text;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
  },

  showKnowledgeTab() {
    document.querySelectorAll('.panel-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === 'knowledge');
    });
    document.querySelectorAll('.panel-content').forEach(p => {
      p.classList.toggle('active', p.id === 'tab-knowledge');
    });
  },

  // Agent 状态
  updateAgentStatus(state, text) {
    const stateEl = document.getElementById('agent-state');
    stateEl.textContent = text;
    stateEl.className = 'agent-state ' + state;

    const avatar = document.getElementById('agent-avatar');
    if (state === 'running') avatar.textContent = '⏳';
    else if (state === 'completed') avatar.textContent = '✅';
    else avatar.textContent = '🤖';
  },

  // 任务日志
  addTaskLog(id, task, status) {
    // 更新已有任务
    const existing = this.taskLog.find(t => t.id === id);
    if (existing) {
      existing.status = status;
      this.renderTaskLog();
      return;
    }

    this.taskLog.unshift({ id, task, status, time: new Date() });
    if (this.taskLog.length > 10) this.taskLog.pop();
    this.renderTaskLog();
  },

  renderTaskLog() {
    const container = document.getElementById('task-history');
    let html = `<h4 style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
      📋 任务历史
    </h4>`;

    if (this.taskLog.length === 0) {
      html += '<div style="font-size:12px;color:var(--text-muted);padding:8px;">暂无任务</div>';
    } else {
      html += '<div class="task-list">';
      this.taskLog.forEach(t => {
        const icons = { running: '⏳', done: '✓', error: '✗' };
        html += `<div class="task-item">
          <span class="task-icon">${icons[t.status] || '○'}</span>
          <span class="task-text">${t.task}</span>
          <span class="task-status ${t.status === 'done' ? 'done' : t.status === 'running' ? 'running' : ''}">
            ${t.status === 'done' ? '完成' : t.status === 'running' ? '执行中' : '失败'}
          </span>
        </div>`;
      });
      html += '</div>';
    }

    container.innerHTML = html;
  },

  // 面板 tab 切换
  bindEvents() {
    document.querySelectorAll('#ai-panel .panel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;

        document.querySelectorAll('#ai-panel .panel-tab').forEach(t => {
          t.classList.toggle('active', t === tab);
        });
        document.querySelectorAll('#ai-panel .panel-content').forEach(p => {
          p.classList.toggle('active', p.id === `tab-${tabName}`);
        });
      });
    });

    // 生成大纲按钮
    document.getElementById('btn-generate-outline').addEventListener('click', () => {
      if (this.selectedMethod && this.selectedConcept) {
        this.generateOutline(this.selectedConcept, this.selectedMethod);
      }
    });

    // 生成全文按钮
    document.getElementById('btn-generate-article').addEventListener('click', () => {
      if (this.currentOutline) {
        document.getElementById('modal-outline').style.display = 'none';
        this.generateArticle(this.currentOutline);
      }
    });

    // 发送聊天
    document.getElementById('btn-send-chat').addEventListener('click', () => this.sendChat());
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.sendChat();
    });
  },

  sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    this.handleRevision(text);
  },

  // 大纲审核弹窗
  showOutlineModal(outline) {
    const modal = document.getElementById('modal-outline');
    const content = document.getElementById('outline-content');

    let html = `<p style="color:var(--text-secondary);margin-bottom:16px;">
      方法论：${outline.method} | 核心洞察：${outline.coreInsight}
    </p>
    <h3>${outline.title}</h3>
    <ol style="padding-left:24px;">`;

    outline.sections.forEach(s => {
      html += `<li style="margin:10px 0;">
        <strong>${s.text}</strong>
        <br><span style="color:var(--text-muted);font-size:13px;">${s.subtext}</span>
      </li>`;
    });

    html += '</ol>';
    content.innerHTML = html;
    modal.style.display = 'flex';

    // 显示全文生成按钮
    document.getElementById('btn-generate-article').style.display = 'inline-flex';
  }
};
// ============================================================
// publish-panel.js — 发布预览面板
// ============================================================

const PublishPanel = {
  selectedPlatforms: ['wechat'],
  currentTheme: { theme: '经典', font: '无衬线', size: '推荐', color: '经典蓝' },

  init() {
    this.renderPlatforms();
    this.bindEvents();
  },

  renderPlatforms() {
    const container = document.getElementById('platform-list');
    let html = '';

    Object.entries(platforms).forEach(([key, p]) => {
      const selected = this.selectedPlatforms.includes(key);
      html += `<div class="publish-platform${selected ? ' selected' : ''}" data-platform="${key}">
        <div class="platform-icon">${this.getPlatformEmoji(key)}</div>
        <div class="platform-info">
          <div class="platform-name">${p.name}</div>
          <div class="platform-desc">${p.description}</div>
        </div>
        <div class="platform-check"></div>
      </div>`;
    });

    container.innerHTML = html;

    container.querySelectorAll('.publish-platform').forEach(el => {
      el.addEventListener('click', () => {
        const platform = el.dataset.platform;
        this.togglePlatform(platform);
      });
    });
  },

  getPlatformEmoji(key) {
    const emojis = { wechat: '💬', zhihu: '🔷', juejin: '💎', twitter: '🐦' };
    return emojis[key] || '📝';
  },

  togglePlatform(key) {
    if (this.selectedPlatforms.includes(key)) {
      this.selectedPlatforms = this.selectedPlatforms.filter(p => p !== key);
    } else {
      this.selectedPlatforms.push(key);
    }

    // 更新主题为第一个选中平台的默认样式
    if (this.selectedPlatforms.length > 0) {
      this.currentTheme = platforms[this.selectedPlatforms[0]].styles;
    }

    this.renderPlatforms();
    this.updatePreview();
  },

  updatePreview() {
    const content = Editor.editorEl.value;
    const previewBody = document.getElementById('preview-body');
    const previewArea = document.getElementById('preview-area');

    if (!content.trim() || this.selectedPlatforms.length === 0) {
      previewArea.style.display = 'none';
      return;
    }

    previewArea.style.display = 'block';

    // 生成平台风格预览
    let html = '';
    if (this.selectedPlatforms.includes('wechat')) {
      html += '<div style="padding:10px;background:#f5f5f5;border-radius:4px;margin-bottom:8px;font-size:11px;color:#999;">📱 微信公众号预览</div>';
      html += this.renderForPlatform('wechat', content);
    }

    if (this.selectedPlatforms.includes('zhihu')) {
      html += '<div style="padding:10px;background:#f5f5f5;border-radius:4px;margin:12px 0 8px;font-size:11px;color:#999;">🔷 知乎预览</div>';
      html += this.renderForPlatform('zhihu', content);
    }

    if (this.selectedPlatforms.includes('juejin')) {
      html += '<div style="padding:10px;background:#f5f5f5;border-radius:4px;margin:12px 0 8px;font-size:11px;color:#999;">💎 掘金预览</div>';
      html += this.renderForPlatform('juejin', content);
    }

    if (this.selectedPlatforms.includes('twitter')) {
      html += '<div style="padding:10px;background:#f5f5f5;border-radius:4px;margin:12px 0 8px;font-size:11px;color:#999;">🐦 Twitter Thread 预览</div>';
      html += this.renderForPlatform('twitter', content);
    }

    previewBody.innerHTML = html;
  },

  renderForPlatform(platform, content) {
    const styles = platforms[platform].styles;
    let fontFamily = '-apple-system, sans-serif';
    if (styles.font === '衬线') fontFamily = 'Georgia, "Noto Serif SC", serif';
    if (styles.font === '等宽') fontFamily = '"JetBrains Mono", monospace';

    const sizes = { '更小': '13px', '稍小': '14px', '推荐': '15px', '稍大': '16px', '更大': '18px' };
    const fontSize = sizes[styles.size] || '15px';

    // 简易样式渲染
    let rendered = Editor.renderMarkdown(content);

    return `<div style="font-family:${fontFamily};font-size:${fontSize};">
      ${rendered}
    </div>`;
  },

  // 复制格式化 HTML
  copyFormattedHTML() {
    const content = Editor.editorEl.value;
    if (!content.trim()) {
      Editor.showToast('没有内容可复制', 'error');
      return;
    }

    // 生成微信公众号兼容的 HTML
    const rendered = Editor.renderMarkdown(content);
    const html = `<section style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans SC',sans-serif;font-size:15px;line-height:1.8;color:#333;max-width:680px;margin:0 auto;">${rendered}</section>`;

    navigator.clipboard.writeText(html).then(() => {
      Editor.showToast('HTML 已复制到剪贴板！可直接粘贴到公众号编辑器', 'success');
    }).catch(() => {
      Editor.showToast('复制失败，请重试', 'error');
    });
  },

  // 复制 Markdown
  copyMarkdown() {
    const content = Editor.editorEl.value;
    if (!content.trim()) {
      Editor.showToast('没有内容可复制', 'error');
      return;
    }

    navigator.clipboard.writeText(content).then(() => {
      Editor.showToast('Markdown 已复制到剪贴板！', 'success');
    }).catch(() => {
      Editor.showToast('复制失败，请重试', 'error');
    });
  },

  bindEvents() {
    document.getElementById('btn-copy-html').addEventListener('click', () => this.copyFormattedHTML());
    document.getElementById('btn-copy-markdown').addEventListener('click', () => this.copyMarkdown());

    // 编辑器内容变化时更新预览
    document.getElementById('markdown-editor').addEventListener('input', () => {
      // 仅在发布 tab 激活时更新
      const publishTab = document.querySelector('#ai-panel .panel-content.active');
      if (publishTab && publishTab.id === 'tab-publish') {
        this.updatePreview();
      }
    });
  }
};
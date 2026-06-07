/**
 * Bridge page HTML generator for COSE publish flow.
 *
 * Generates a self-contained HTML page that:
 * - Detects COSE Chrome extension via window.$cose
 * - Shows platform selection with login status
 * - Executes publish via $cose.addTask()
 * - Provides a hidden copy button for COSE's clipboard reading
 */

export interface BridgePageData {
  title: string;
  markdown: string;
  html: string;
  css: string;
}

export function generateBridgePage(data: BridgePageData): string {
  const escapedData = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Molio 发布</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      color: #333;
      line-height: 1.6;
    }
    .container {
      max-width: 720px;
      margin: 40px auto;
      padding: 0 20px;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 32px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .header h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .header .subtitle { font-size: 13px; color: #999; }

    /* States */
    .state { display: none; }
    .state.active { display: block; }

    /* Loading */
    .loading { text-align: center; padding: 40px 0; }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid #e5e5e5;
      border-top-color: #FE5200;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Alert */
    .alert {
      background: #fff7ed;
      border: 1px solid #fed7aa;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .alert-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; color: #c2410c; }
    .alert-desc { font-size: 13px; color: #9a3412; }
    .alert-desc a { color: #FE5200; text-decoration: underline; }

    /* Article preview */
    .article-info {
      background: #f9fafb;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #666;
    }
    .article-info strong { color: #333; }

    /* Platform list */
    .section-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .section-title .count { font-weight: 400; color: #999; font-size: 12px; }

    .platform-category {
      margin-bottom: 16px;
    }
    .category-header {
      font-size: 13px;
      font-weight: 600;
      color: #666;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .category-header .arrow { transition: transform 0.2s; font-size: 10px; }
    .category-header .arrow.collapsed { transform: rotate(-90deg); }
    .category-select-all {
      margin-left: auto;
      font-size: 12px;
      color: #999;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .category-select-all:hover { color: #FE5200; }

    .platform-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 24px;
      padding-left: 8px;
    }
    .platform-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      font-size: 13px;
    }
    .platform-item.disabled { opacity: 0.5; }
    .platform-item input[type="checkbox"] {
      accent-color: #FE5200;
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
    .platform-item input[type="checkbox"]:disabled { cursor: not-allowed; }
    .platform-icon { width: 16px; height: 16px; border-radius: 2px; flex-shrink: 0; }
    .platform-name { font-weight: 500; }
    .platform-status { font-size: 12px; }
    .platform-status.checking { color: #999; }
    .platform-status.logged-in { color: #666; }
    .platform-status.logged-in a { color: #FE5200; text-decoration: none; }
    .platform-status.logged-in a:hover { text-decoration: underline; }
    .platform-avatar {
      width: 16px; height: 16px; border-radius: 50%;
      object-fit: cover;
    }

    .check-spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid #e5e5e5;
      border-top-color: #FE5200;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    /* Actions */
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid #f0f0f0;
    }
    .btn {
      padding: 8px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid #d9d9d9;
      background: #fff;
      color: #333;
      transition: all 0.2s;
    }
    .btn:hover { border-color: #bbb; }
    .btn-primary {
      background: #FE5200;
      color: #fff;
      border-color: #e64a00;
    }
    .btn-primary:hover { background: #e64a00; }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Progress */
    .progress-list { margin-top: 16px; }
    .progress-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 0;
      border-bottom: 1px solid #f5f5f5;
      font-size: 13px;
    }
    .progress-item:last-child { border-bottom: none; }
    .progress-item img { width: 20px; height: 20px; border-radius: 2px; }
    .progress-item .platform-title { font-weight: 500; min-width: 80px; }
    .progress-item .status { margin-left: auto; font-weight: 500; }
    .status-pending { color: #999; }
    .status-uploading { color: #f59e0b; }
    .status-done { color: #10b981; }
    .status-failed { color: #ef4444; }
    .progress-spinner {
      width: 14px; height: 14px;
      border: 2px solid #fde68a;
      border-top-color: #f59e0b;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    .done-banner {
      text-align: center;
      padding: 20px;
      margin-top: 16px;
      background: #f0fdf4;
      border-radius: 8px;
      color: #166534;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <h1>Molio 发布</h1>
        <p class="subtitle">将文章同步到多个平台</p>
      </div>

      <!-- State: detecting COSE -->
      <div id="state-detecting" class="state active">
        <div class="loading">
          <div class="spinner"></div>
          <p>正在检测 COSE 扩展...</p>
        </div>
      </div>

      <!-- State: COSE not installed -->
      <div id="state-not-installed" class="state">
        <div class="alert">
          <div class="alert-title">未检测到 COSE 扩展</div>
          <div class="alert-desc">
            发布功能需要安装 <a href="https://chromewebstore.google.com/detail/ilhikcdphhpjofhlnbojifbihhfmmhfk" target="_blank">COSE 文章同步助手</a> 浏览器扩展。安装后请刷新此页面。
          </div>
        </div>
      </div>

      <!-- State: platform selection -->
      <div id="state-select" class="state">
        <div class="article-info" id="article-info"></div>
        <div class="section-title">
          <span>选择发布平台</span>
          <span class="count" id="platform-count"></span>
        </div>
        <div id="platform-list"></div>
        <div class="actions">
          <button class="btn" onclick="window.close()">取消</button>
          <button class="btn btn-primary" id="btn-publish" disabled onclick="startPublish()">确认发布</button>
        </div>
      </div>

      <!-- State: publishing -->
      <div id="state-publishing" class="state">
        <div class="article-info" id="article-info-progress"></div>
        <div class="section-title"><span>发布进度</span></div>
        <div class="progress-list" id="progress-list"></div>
        <div id="done-banner" style="display:none" class="done-banner">
          发布完成！你可以关闭此页面。
        </div>
      </div>
    </div>
  </div>

  <!-- Hidden copy button for COSE clipboard reading -->
  <button class="copy-btn" style="position:fixed;left:-9999px;top:-9999px;opacity:0" id="copy-btn">复制</button>
  <!-- Hidden styled content container -->
  <div id="output" style="position:fixed;left:-9999px;top:-9999px;opacity:0"></div>

  <script>
    // ── Article data (injected by daemon) ──
    const ARTICLE = ${escapedData};

    // ── Platform categories ──
    const CATEGORIES = [
      {
        name: '媒体平台',
        types: ['wechat','toutiao','zhihu','baijiahao','wangyihao','sohu','weibo','bilibili','sspai','twitter','douyin','xiaohongshu','douban']
      },
      {
        name: '博客平台',
        types: ['csdn','cnblogs','juejin','medium','cto51','segmentfault','oschina','infoq','jianshu']
      },
      {
        name: '云平台及开发者社区',
        types: ['tencentcloud','aliyun','huaweicloud','huaweidev','qianfan','alipayopen','modelscope','volcengine','elecfans']
      }
    ];

    // ── State ──
    let allAccounts = [];
    let collapsedCategories = new Set(['云平台及开发者社区']);

    // ── Init: prepare styled HTML and copy button ──
    function init() {
      // Inject styled HTML into #output (for COSE clipboard reading)
      const outputEl = document.getElementById('output');
      outputEl.innerHTML = '<style>' + ARTICLE.css + '</style>' + ARTICLE.html;

      // Set up copy button
      const copyBtn = document.getElementById('copy-btn');
      copyBtn.addEventListener('click', async function() {
        try {
          const styledHtml = outputEl.innerHTML;
          const blob = new Blob([styledHtml], { type: 'text/html' });
          const textBlob = new Blob([ARTICLE.markdown], { type: 'text/plain' });
          const item = new ClipboardItem({
            'text/html': blob,
            'text/plain': textBlob,
          });
          await navigator.clipboard.write([item]);
        } catch(e) {
          console.error('Copy failed:', e);
        }
      });

      // Show article info
      const infoHtml = '<strong>' + escapeHtml(ARTICLE.title || '无标题') + '</strong>'
        + '<br>' + ARTICLE.markdown.substring(0, 100).replace(/[#*\\[\\]]/g, '') + '...';
      document.getElementById('article-info').innerHTML = infoHtml;
      document.getElementById('article-info-progress').innerHTML = infoHtml;

      // Start COSE detection
      detectCose();
    }

    // ── COSE detection ──
    function detectCose() {
      const maxWait = 8000;
      const interval = 300;
      const start = Date.now();

      function check() {
        if (window.$cose) {
          showState('select');
          loadAccounts();
          return;
        }
        if (Date.now() - start > maxWait) {
          showState('not-installed');
          return;
        }
        setTimeout(check, interval);
      }
      check();
    }

    // ── Load platform accounts with login status ──
    function loadAccounts() {
      // Show initial platform list with "checking" state
      const platforms = window.$cose.getPlatforms();
      allAccounts = platforms.map(function(p) {
        return Object.assign({}, p, { checked: false, loggedIn: false, isChecking: true });
      });
      renderPlatforms();

      // Use progressive detection if available
      if (typeof window.$cose.getAccountsProgressive === 'function') {
        window.$cose.getAccountsProgressive(
          function(account) {
            var idx = allAccounts.findIndex(function(a) { return a.uid === account.uid || a.type === account.type; });
            if (idx !== -1) {
              allAccounts[idx] = Object.assign({}, allAccounts[idx], account, { checked: false, isChecking: false });
              renderPlatforms();
            }
          },
          function() {
            updatePublishButton();
          }
        );
      } else {
        // Fallback to getAccounts
        window.$cose.getAccounts(function(accounts) {
          allAccounts = accounts.map(function(a) { return Object.assign({}, a, { checked: false, isChecking: false }); });
          renderPlatforms();
          updatePublishButton();
        });
      }
    }

    // ── Render platform selection ──
    function renderPlatforms() {
      var container = document.getElementById('platform-list');
      var loggedInCount = allAccounts.filter(function(a) { return a.loggedIn; }).length;
      document.getElementById('platform-count').textContent = loggedInCount + ' 个平台已登录';

      var html = '';
      CATEGORIES.forEach(function(cat) {
        var catAccounts = cat.types
          .map(function(type) { return allAccounts.find(function(a) { return a.type === type; }); })
          .filter(Boolean);
        if (catAccounts.length === 0) return;

        var isCollapsed = collapsedCategories.has(cat.name);
        var allLoggedIn = catAccounts.filter(function(a) { return a.loggedIn; });
        var allSelected = allLoggedIn.length > 0 && allLoggedIn.every(function(a) { return a.checked; });

        html += '<div class="platform-category">';
        html += '<div class="category-header" onclick="toggleCategory(\\'' + cat.name + '\\')">';
        html += '<span class="arrow ' + (isCollapsed ? 'collapsed' : '') + '">&#9660;</span>';
        html += '<span>' + cat.name + ' (' + catAccounts.length + ')</span>';
        html += '<span class="category-select-all" onclick="event.stopPropagation(); toggleSelectAll(\\'' + cat.name + '\\')">';
        html += '<input type="checkbox" ' + (allSelected ? 'checked' : '') + ' style="accent-color:#FE5200;width:14px;height:14px;pointer-events:none">';
        html += '全选</span></div>';

        if (!isCollapsed) {
          html += '<div class="platform-grid">';
          catAccounts.forEach(function(account) {
            var uid = account.uid || account.type;
            var disabled = !account.loggedIn;
            html += '<div class="platform-item ' + (disabled ? 'disabled' : '') + '">';
            html += '<input type="checkbox" id="p_' + uid + '" ' + (account.checked ? 'checked' : '') + ' ' + (disabled ? 'disabled' : '') + ' onchange="toggleAccount(\\'' + uid + '\\')">';
            if (account.icon) {
              html += '<img class="platform-icon" src="' + escapeHtml(account.icon) + '" onerror="this.style.display=\\'none\\'">';
            }
            html += '<span class="platform-name">' + escapeHtml(account.title) + '</span>';

            if (account.isChecking) {
              html += '<span class="check-spinner"></span>';
            } else if (account.loggedIn) {
              html += '<span class="platform-status logged-in">';
              if (account.avatar) {
                html += '<img class="platform-avatar" src="' + escapeHtml(account.avatar) + '" onerror="this.style.display=\\'none\\'">';
              }
              html += '@' + escapeHtml(account.displayName || account.title);
              html += '</span>';
            } else {
              html += '<span class="platform-status logged-in"><a href="' + escapeHtml(account.home || '#') + '" target="_blank">登录</a></span>';
            }
            html += '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
      });

      container.innerHTML = html;
      updatePublishButton();
    }

    function toggleCategory(name) {
      if (collapsedCategories.has(name)) {
        collapsedCategories.delete(name);
      } else {
        collapsedCategories.add(name);
      }
      renderPlatforms();
    }

    function toggleSelectAll(catName) {
      var cat = CATEGORIES.find(function(c) { return c.name === catName; });
      if (!cat) return;
      var catAccounts = cat.types
        .map(function(type) { return allAccounts.find(function(a) { return a.type === type; }); })
        .filter(function(a) { return a && a.loggedIn; });
      var allSelected = catAccounts.every(function(a) { return a.checked; });
      catAccounts.forEach(function(a) { a.checked = !allSelected; });
      renderPlatforms();
    }

    function toggleAccount(uid) {
      var account = allAccounts.find(function(a) { return (a.uid || a.type) === uid; });
      if (account) {
        account.checked = !account.checked;
        renderPlatforms();
      }
    }

    function updatePublishButton() {
      var btn = document.getElementById('btn-publish');
      var selected = allAccounts.filter(function(a) { return a.checked && a.loggedIn; });
      btn.disabled = selected.length === 0;
      btn.textContent = selected.length > 0 ? '确认发布 (' + selected.length + ')' : '确认发布';
    }

    // ── Start publish ──
    function startPublish() {
      var selected = allAccounts.filter(function(a) { return a.checked && a.loggedIn; });
      if (selected.length === 0) return;

      showState('publishing');

      var taskData = {
        post: {
          title: ARTICLE.title,
          content: ARTICLE.html,
          markdown: ARTICLE.markdown,
          thumb: '',
          desc: ARTICLE.markdown.substring(0, 200).replace(/[#*\\[\\]]/g, '').trim()
        },
        accounts: selected
      };

      window.$cose.addTask(taskData,
        function onProgress(status) {
          renderProgress(status.accounts);
        },
        function onComplete() {
          document.getElementById('done-banner').style.display = 'block';
        }
      );
    }

    function renderProgress(accounts) {
      var container = document.getElementById('progress-list');
      var html = '';
      accounts.forEach(function(account) {
        html += '<div class="progress-item">';
        if (account.icon) {
          html += '<img src="' + escapeHtml(account.icon) + '" onerror="this.style.display=\\'none\\'">';
        }
        html += '<span class="platform-title">' + escapeHtml(account.title) + '</span>';

        if (account.status === 'pending') {
          html += '<span class="status status-pending">等待中</span>';
        } else if (account.status === 'uploading') {
          html += '<span class="progress-spinner"></span>';
          html += '<span class="status status-uploading">同步中...</span>';
        } else if (account.status === 'done') {
          html += '<span class="status status-done">✓ 同步成功</span>';
        } else if (account.status === 'failed') {
          html += '<span class="status status-failed">✗ ' + escapeHtml(account.error || '同步失败') + '</span>';
        }
        html += '</div>';
      });
      container.innerHTML = html;
    }

    // ── Helpers ──
    function showState(name) {
      document.querySelectorAll('.state').forEach(function(el) { el.classList.remove('active'); });
      var target = document.getElementById('state-' + name);
      if (target) target.classList.add('active');
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Boot ──
    document.addEventListener('DOMContentLoaded', init);
  </script>
</body>
</html>`;
}

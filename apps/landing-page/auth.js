/**
 * Molio 官网登录组件（浏览器直连云端认证服务，CORS 白名单见 apps/cloud/src/cors.ts）。
 *
 * 依赖顺序：本文件必须在 pay.js 之前加载（MolioPay.open 的登录门槛用 MolioAuth）。
 *
 * token 存 localStorage['molio.auth.v1']——跨标签页共享。云端 refresh 轮换是
 * 一次性的，重放检测会吊销该用户**全部** session（连坐同账号的桌面应用），
 * 因此本文件遵守严格的 token 读写纪律：
 *   - 每次调用前从 localStorage 现读（绝不在模块内存常驻）；
 *   - 纯按需刷新，无定时器/心跳——闲置标签页不产生轮换；
 *   - 刷新本标签页单飞；写回前复核 localStorage 未被其他标签页改写；
 *   - 401 先重读 localStorage（另一标签页可能已刷新）再判定失效；
 *   - storage 事件跨标签页同步登录/登出。
 *
 * 对外：window.MolioAuth = { isLoggedIn, getUser, requireAuth, logout, on }
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'molio.auth.v1';
  /** access 剩余寿命 <2min 先刷新（与桌面端/云端 15min 寿命配套） */
  var PROACTIVE_MS = 2 * 60 * 1000;
  /** 基础邮箱格式（与云端 AuthService.EMAIL_RE 同规则）：客户端先行拦截，
      非法输入不发起发码请求（云端 400 invalid_email 仍是兜底） */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function authBase() { return window.MOLIO_AUTH_BASE || 'https://auth.molio.cn'; }
  /** blog/ 子目录页面引用上级目录资源（同 shared.js 的 qrPrefix 模式） */
  function pagePrefix() { return location.pathname.indexOf('/blog/') !== -1 ? '../' : ''; }

  /* ---------- 存储：每次现读，不在内存常驻 ---------- */

  function readAuth() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data.accessToken !== 'string' || !data.accessToken) return null;
      if (typeof data.refreshToken !== 'string' || !data.refreshToken) return null;
      if (!data.user || typeof data.user.id !== 'string') return null;
      return data; // { accessToken, refreshToken, user, accessExpiresAt? }
    } catch (e) { return null; }
  }

  function writeAuth(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* 隐私模式等：降级为会话内有效 */ }
  }

  function clearAuth() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /** 解码 access JWT 的 exp（不验签——只作主动刷新启发式）；异常返回 undefined */
  function decodeExp(jwt) {
    try {
      var parts = String(jwt).split('.');
      if (parts.length !== 3) return undefined;
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (typeof payload.exp !== 'number' || !isFinite(payload.exp) || payload.exp <= 0) return undefined;
      return Math.floor(payload.exp * 1000);
    } catch (e) { return undefined; }
  }

  function accessFresh(data) {
    if (!data) return false;
    if (typeof data.accessExpiresAt !== 'number') return true; // 未知 exp → 原样用，401 再兜底
    return Date.now() < data.accessExpiresAt - PROACTIVE_MS;
  }

  /* ---------- 事件 ---------- */

  var handlers = { login: [], logout: [] };
  function on(name, fn) { if (handlers[name] && typeof fn === 'function') handlers[name].push(fn); }
  function emit(name) {
    var list = handlers[name].slice();
    for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) { /* 订阅方错误不影响主流程 */ } }
  }

  /* ---------- 刷新：单标签页单飞 + 写回前复核 ---------- */

  var refreshInFlight = null;

  function refresh() {
    if (!refreshInFlight) {
      refreshInFlight = doRefresh().then(
        function (r) { refreshInFlight = null; return r; },
        function (e) { refreshInFlight = null; throw e; }
      );
    }
    return refreshInFlight;
  }

  function doRefresh() {
    var cur = readAuth();
    if (!cur) return Promise.reject(new Error('no_session'));
    var usedRefresh = cur.refreshToken;
    return fetch(authBase() + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: usedRefresh }),
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error('refresh_failed_' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }).then(function (body) {
      // 写回前复核：另一标签页可能已先轮换写回。此时丢弃本次结果（丢弃的一对仍在
      // 云端替换链上，宽限窗内可达），以 localStorage 为准。
      var latest = readAuth();
      if (!latest || latest.refreshToken !== usedRefresh) return latest;
      var next = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        user: cur.user,
        accessExpiresAt: decodeExp(body.accessToken),
      };
      writeAuth(next);
      return next;
    });
  }

  /** 取可用 access token（当前官网业务暂无需鉴权调用，为将来「我的购买」等预留） */
  function getAccessToken() {
    var cur = readAuth();
    if (!cur) return Promise.reject(new Error('no_session'));
    if (accessFresh(cur)) return Promise.resolve(cur.accessToken);
    return refresh().then(function (d) {
      if (!d) throw new Error('no_session');
      return d.accessToken;
    }).catch(function (e) {
      // 刷新失败：先重读（可能别的标签页刚刷新成功），仍不行判登出
      var retry = readAuth();
      if (retry && accessFresh(retry)) return retry.accessToken;
      if (e && e.status === 401) {
        if (retry && retry.refreshToken !== cur.refreshToken) return retry.accessToken;
        clearAuth();
        emit('logout');
        renderNavAuth();
      }
      throw e;
    });
  }

  /* ---------- 登录弹窗 ---------- */

  var modal = null;
  var pendingAuth = null; // requireAuth 去重：弹窗已开时复用同一 Promise
  var countdownTimer = null;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildModal() {
    if (modal) return modal;
    var prefix = pagePrefix();
    var el = document.createElement('div');
    el.className = 'auth-modal';
    el.id = 'auth-modal';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '登录 Molio 账号');
    el.innerHTML =
      '<div class="auth-card">' +
        '<button type="button" class="pay-close" id="auth-close" aria-label="关闭">×</button>' +
        '<h3>登录 Molio 账号</h3>' +
        '<p class="auth-sub">登录后即可下载免费资源，并免费获取资源更新</p>' +
        '<div class="auth-step" id="auth-step-email">' +
          '<label class="auth-label" for="auth-email">邮箱</label>' +
          '<input id="auth-email" type="email" autocomplete="email" placeholder="请输入邮箱地址">' +
          '<label class="auth-consent">' +
            '<input type="checkbox" id="auth-agree">' +
            '<span>我已阅读并同意 <a href="' + prefix + 'terms.html" target="_blank" rel="noopener noreferrer">《用户协议》</a> 和 <a href="' + prefix + 'privacy.html" target="_blank" rel="noopener noreferrer">《隐私政策》</a></span>' +
          '</label>' +
          '<button type="button" class="btn btn-primary auth-btn" id="auth-send" disabled>发送验证码</button>' +
        '</div>' +
        '<div class="auth-step" id="auth-step-code" hidden>' +
          '<p class="auth-note" id="auth-sent-note"></p>' +
          '<label class="auth-label" for="auth-code">验证码</label>' +
          '<input id="auth-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位验证码">' +
          '<div class="auth-row">' +
            '<button type="button" class="btn btn-primary auth-btn" id="auth-verify" disabled>登录</button>' +
            '<button type="button" class="auth-link" id="auth-resend" disabled>重新发送</button>' +
            '<button type="button" class="auth-link" id="auth-change-email">返回修改邮箱</button>' +
          '</div>' +
        '</div>' +
        '<p class="auth-dev" id="auth-dev" hidden></p>' +
        '<p class="auth-error" id="auth-error" hidden></p>' +
      '</div>';
    document.body.appendChild(el);
    modal = el;

    el.addEventListener('click', function (e) { if (e.target === el) cancelLogin(); });
    el.querySelector('#auth-close').addEventListener('click', cancelLogin);

    var emailInput = el.querySelector('#auth-email');
    var agreeBox = el.querySelector('#auth-agree');
    var sendBtn = el.querySelector('#auth-send');
    var codeInput = el.querySelector('#auth-code');
    var verifyBtn = el.querySelector('#auth-verify');
    var resendBtn = el.querySelector('#auth-resend');

    function syncSendEnabled() {
      var v = emailInput.value.trim();
      sendBtn.disabled = !v || !EMAIL_RE.test(v) || !agreeBox.checked;
    }
    emailInput.addEventListener('input', syncSendEnabled);
    agreeBox.addEventListener('change', syncSendEnabled);
    emailInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !sendBtn.disabled) sendCode(); });
    codeInput.addEventListener('input', function () { verifyBtn.disabled = !codeInput.value.trim(); });
    codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !verifyBtn.disabled) verify(); });

    sendBtn.addEventListener('click', sendCode);
    verifyBtn.addEventListener('click', verify);
    resendBtn.addEventListener('click', function () { sendCode(); });
    el.querySelector('#auth-change-email').addEventListener('click', function () {
      showStep('email');
      setError(null);
    });

    return el;
  }

  function showStep(step) {
    modal.querySelector('#auth-step-email').hidden = step !== 'email';
    modal.querySelector('#auth-step-code').hidden = step !== 'code';
    if (step === 'email') modal.querySelector('#auth-email').focus();
    else modal.querySelector('#auth-code').focus();
  }

  function setError(msg) {
    var box = modal.querySelector('#auth-error');
    box.hidden = !msg;
    box.textContent = msg || '';
  }

  function startCountdown(sec) {
    var resendBtn = modal.querySelector('#auth-resend');
    var remaining = sec > 0 ? sec : 60;
    if (countdownTimer) clearInterval(countdownTimer);
    function tick() {
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        resendBtn.disabled = false;
        resendBtn.textContent = '重新发送';
      } else {
        resendBtn.disabled = true;
        resendBtn.textContent = remaining + ' 秒后可重发';
        remaining -= 1;
      }
    }
    tick();
    if (remaining > 0) countdownTimer = setInterval(tick, 1000);
  }

  function sendCode() {
    var email = modal.querySelector('#auth-email').value.trim();
    var sendBtn = modal.querySelector('#auth-send');
    sendBtn.disabled = true;
    setError(null);
    fetch(authBase() + '/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var e = new Error(body.error || ('http_' + res.status));
          e.code = body.error;
          e.resendAfterSec = typeof body.resendAfterSec === 'number' ? body.resendAfterSec : null;
          throw e;
        }
        return body;
      });
    }).then(function (body) {
      var devBox = modal.querySelector('#auth-dev');
      if (typeof body.devCode === 'string') {
        // 仅 daily/local 云端返回（prod 严格不返回）：联调提示，生产官网不可见
        devBox.hidden = false;
        devBox.textContent = '开发环境：验证码 ' + body.devCode;
      } else {
        devBox.hidden = true;
      }
      modal.querySelector('#auth-sent-note').textContent =
        '验证码已发送至 ' + email + '，请查收邮件。若未收到，请检查垃圾邮件文件夹。';
      showStep('code');
      startCountdown(typeof body.resendAfterSec === 'number' ? body.resendAfterSec : 60);
    }).catch(function (e) {
      setError(mapError(e));
    }).then(function () {
      // 按钮恢复（发送成功后焦点已转到验证码步）
      var agreeBox = modal.querySelector('#auth-agree');
      var emailInput = modal.querySelector('#auth-email');
      sendBtn.disabled = !emailInput.value.trim() || !agreeBox.checked;
    });
  }

  function verify() {
    var email = modal.querySelector('#auth-email').value.trim();
    var code = modal.querySelector('#auth-code').value.trim();
    var verifyBtn = modal.querySelector('#auth-verify');
    verifyBtn.disabled = true;
    setError(null);
    fetch(authBase() + '/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, code: code, deviceHint: 'molio.cn website' }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var e = new Error(body.error || ('http_' + res.status));
          e.code = body.error;
          throw e;
        }
        return body;
      });
    }).then(function (body) {
      writeAuth({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        user: body.user,
        accessExpiresAt: decodeExp(body.accessToken),
      });
      closeLogin(body.user);
    }).catch(function (e) {
      setError(mapError(e));
    }).then(function () {
      verifyBtn.disabled = !modal.querySelector('#auth-code').value.trim();
    });
  }

  function mapError(e) {
    switch (e && e.code) {
      case 'invalid_email': return '邮箱格式不正确';
      case 'rate_limited':
        return '发送过于频繁，请 ' + (e.resendAfterSec != null ? e.resendAfterSec : 60) + ' 秒后再试';
      case 'mail_failed': return '验证码发送失败，请稍后再试';
      case 'invalid_code': return '验证码不正确，请重试';
      case 'locked': return '错误次数过多，该验证码已锁定，请重新发送';
      default:
        if (e instanceof TypeError) return '无法连接登录服务，请检查网络后重试';
        return '操作失败，请稍后重试';
    }
  }

  function openLogin() {
    buildModal();
    setError(null);
    modal.querySelector('#auth-code').value = '';
    modal.querySelector('#auth-dev').hidden = true;
    showStep('email');
    modal.hidden = false;
  }

  function closeLogin(user) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (modal) modal.hidden = true;
    if (pendingAuth) {
      var p = pendingAuth;
      pendingAuth = null;
      emit('login');
      renderNavAuth();
      p.resolve(user);
    }
  }

  function cancelLogin() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (modal) modal.hidden = true;
    if (pendingAuth) {
      var p = pendingAuth;
      pendingAuth = null;
      p.reject(new Error('login_cancelled'));
    }
  }

  /* ---------- 对外 API ---------- */

  function isLoggedIn() { return readAuth() !== null; }

  function getUser() {
    var d = readAuth();
    return d ? d.user : null;
  }

  /** 登录门槛：已登录直接 resolve(user)；否则弹登录框，成功 resolve、取消 reject */
  function requireAuth() {
    var d = readAuth();
    if (d) return Promise.resolve(d.user);
    if (pendingAuth) return pendingAuth.promise;
    var resolveFn, rejectFn;
    var promise = new Promise(function (res, rej) { resolveFn = res; rejectFn = rej; });
    pendingAuth = { promise: promise, resolve: resolveFn, reject: rejectFn };
    openLogin();
    return promise;
  }

  /** 退出：尽力云端吊销本设备 session，无论成败清本地 */
  function logout() {
    var d = readAuth();
    clearAuth();
    renderNavAuth();
    emit('logout');
    if (!d) return Promise.resolve();
    return getAccessTokenOf(d).then(function (accessToken) {
      return fetch(authBase() + '/auth/session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({ refreshToken: d.refreshToken }),
      });
    }).catch(function () { /* 云端不可达/token 失效：本地登出仍成功 */ });
  }

  /** logout 用：不触发刷新的取 access（会话已决定要丢，不值得为它轮换一次） */
  function getAccessTokenOf(d) {
    if (accessFresh(d)) return Promise.resolve(d.accessToken);
    return refresh().then(function (fresh) {
      if (!fresh) throw new Error('no_session');
      return fresh.accessToken;
    }).catch(function () { return d.accessToken; }); // 刷新失败也用旧 access 尽力吊销
  }

  /* ---------- 导航入口 ---------- */

  function renderNavAuth() {
    var slot = document.getElementById('nav-auth');
    if (!slot) return;
    var user = getUser();
    if (!user) {
      slot.innerHTML = '<button type="button" class="nav-auth-btn" id="nav-auth-btn">登录</button>';
      slot.querySelector('#nav-auth-btn').addEventListener('click', function () {
        requireAuth().catch(function () { /* 用户取消 */ });
      });
      return;
    }
    var name = user.nickname || (user.email ? String(user.email).split('@')[0] : '用户');
    slot.innerHTML =
      '<span class="nav-user" title="' + esc(user.email || '') + '">' +
        '<span class="nav-user-name">' + esc(name) + '</span>' +
        '<button type="button" class="nav-auth-out" id="nav-auth-out">退出</button>' +
      '</span>';
    slot.querySelector('#nav-auth-out').addEventListener('click', function () { logout(); });
  }

  /* ---------- 跨标签页同步 ---------- */

  var lastLogged = isLoggedIn();
  window.addEventListener('storage', function (e) {
    if (e.key !== STORAGE_KEY) return;
    var logged = isLoggedIn();
    if (logged === lastLogged) return;
    lastLogged = logged;
    renderNavAuth();
    emit(logged ? 'login' : 'logout');
  });

  /* ---------- 初始化 ---------- */

  function init() {
    renderNavAuth();
    // 其他标签页登录/登出后本页按钮文案同步（如「登录后下载」）
    on('login', refreshLoginLabels);
    on('logout', refreshLoginLabels);
    refreshLoginLabels();
  }

  /** 未登录时给带 data-auth-gate 的按钮加「登录后…」文案提示（资源页门槛视觉） */
  function refreshLoginLabels() {
    var logged = isLoggedIn();
    var nodes = document.querySelectorAll('[data-auth-gate]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var base = n.getAttribute('data-auth-gate');
      n.textContent = logged ? base : '登录后' + base;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MolioAuth = {
    isLoggedIn: isLoggedIn,
    getUser: getUser,
    requireAuth: requireAuth,
    logout: logout,
    getAccessToken: getAccessToken,
    on: on,
    /** 卡片重渲染（如资源页 tab 切换）后重新应用「登录后…」门槛文案 */
    refreshLabels: refreshLoginLabels,
  };
})();

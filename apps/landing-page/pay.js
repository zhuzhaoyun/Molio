/**
 * 支付弹窗（商品详情页 /resource/{id}.html 与市场列表页共用）。
 *
 * 依赖：
 *   - vendor/qrcode.min.js（二维码渲染，仅桌面路径与旧后端兜底用）
 *   - window.MOLIO_PAY_BASE（resources-data.js 配置的支付后端地址）
 *   - window.MolioAuth（auth.js；**必须先于本文件加载**）——付费下载登录门槛：
 *     未登录先弹登录框，登录成功才下单（订单带买家 uid 归属）。
 *
 * 用法：MolioPay.open(resource)，resource 为 { id, price }（price 单位元）。
 *
 * 两条支付通道，按设备分流（后端 /pay?scene= 决定下单方式；订单号/查单/交付两条路完全共用）：
 *   - 桌面 → 微信 Native 支付：渲染二维码，每 3s 轮询 /order → SUCCESS 后 /deliver 拿下载链接。
 *   - 手机（微信外，含 B 站/抖音等 App 内置浏览器）→ 支付宝手机网站支付（WAP）：
 *     跳转 pay_url 打开支付宝收银台，付完回跳本页解锁。
 *     不用微信 H5 的原因：H5 支付要单独开通且 App WebView 内唤端不稳定（本项目申请未通过）；
 *     支付宝 WAP 是整页收银台，唤不起 App 时还能用账号/银行卡在网页内付完，WebView 通过率更高。
 *     跳转会**卸载本页**，故下单后先把待付订单写进 sessionStorage；回跳时
 *     （带 molio_pay_resume 参数 / sessionStorage 兜底 / bfcache 恢复）凭订单号直接查单，
 *     不重新下单也不重复弹登录框。
 *   - 微信内 → 微信屏蔽支付宝域名；H5 支付仅限微信外调起；Native 二维码的
 *     「长按识别 / 相册识别」已被微信支付封禁 —— 不创建订单，直接引导「在浏览器中打开」。
 *
 * 后端契约（wxpay-fc）：
 *   GET {PAY_BASE}/pay?id=<listingId>&uid=<uid>&scene=alipay&return_url=<encoded page url>
 *     → 200 { pay_url: string, out_trade_no: string }
 *   - pay_url 必须是可直接 GET 打开的支付宝网关地址（alipay.trade.wap.pay）；
 *   - 后端必须校验 return_url 的 origin（仅允许 https://molio.cn，防开放重定向），
 *     创建订单后把 <return_url>(&|?)molio_pay_resume=<id>~<out_trade_no> 作为支付宝
 *     return_url，同一页面（不带 resume）作为 quit_url；
 *   - 支付宝订单写入现有订单表后，/order 与 /deliver 无需区分通道。
 */
(function () {
  'use strict';

  // 脚本自身地址（求值期捕获；支付成功的异步回调里 document.currentScript 为 null）。
  // 作为群二维码的解析基准，与 shared.js 的 SCRIPT_BASE 同思路：根部署（列表页）、
  // SSR 商品页（/resource/*.html）、本地 file:// 预览，全部落到正确的 images/qrcode.png。
  var SCRIPT_BASE = document.currentScript && document.currentScript.src;

  var POLL_INTERVAL_MS = 3000;
  var PENDING_KEY = 'molio_pay_pending';        // 待付订单（sessionStorage，回跳续接兜底）
  var PENDING_TTL_MS = 2 * 60 * 60 * 1000;      // 支付宝订单 30 分钟内可付，留足余量
  var RESUME_PARAM = 'molio_pay_resume';        // 回跳参数：<商品 id>~<订单号>

  var payBase = function () { return window.MOLIO_PAY_BASE || ''; };

  /**
   * 支付环境：'desktop' 微信 Native 扫码 / 'mobile' 微信外手机浏览器（支付宝 WAP）/ 'wechat' 微信内。
   * 微信内单独返回 'wechat'：微信屏蔽支付宝，H5 支付也只能在微信外调起，只能引导到系统浏览器。
   */
  function payEnv() {
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/MicroMessenger/i.test(ua)) return 'wechat';
    if (/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  /** 当前页面 URL（去掉回跳参数与 hash）：作为支付宝 return_url 的基准，后端拼订单参数 */
  function pageUrlWithoutResume() {
    var href = location.href.split('#')[0];
    return href
      .replace(new RegExp('([?&])' + RESUME_PARAM + '=[^&#]*&?'), '$1')
      .replace(/[?&]$/, '');
  }

  /* ---------- 待付订单：跳转支付宝前落盘，回跳后据此续接（不重新下单） ---------- */

  function rememberPending(id, outTradeNo) {
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id: id, no: outTradeNo, ts: Date.now() }));
    } catch (e) { /* 隐私模式 / 存储禁用 → 只靠 return_url 参数续接 */ }
  }

  function clearPending() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* 同上，忽略 */ }
  }

  /** 取出待付订单：URL 参数优先（权威），sessionStorage 兜底；过期或未支付成功不清理 */
  function takePending() {
    var fromUrl = parseResumeParam();
    if (fromUrl) { clearPending(); return fromUrl; }
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.id || !o.no || Date.now() - o.ts > PENDING_TTL_MS) return null;
      clearPending(); // 消费即清：每次下单最多自动续接一次，不反复弹窗打扰
      return { id: o.id, no: o.no };
    } catch (e) { return null; }
  }

  /** 解析 ?molio_pay_resume=<id>~<订单号>（回跳 URL 上带的待付订单） */
  function parseResumeParam() {
    var m = new RegExp('[?&]' + RESUME_PARAM + '=([^&#]+)').exec(location.search || '');
    if (!m) return null;
    var raw;
    try { raw = decodeURIComponent(m[1]); } catch (e) { raw = m[1]; }
    var i = raw.indexOf('~');
    if (i <= 0) return null;
    return { id: raw.slice(0, i), no: raw.slice(i + 1) };
  }

  /** 续接完成后抹掉 URL 上的参数，刷新/分享不会重复触发 */
  function stripResumeParam() {
    if (!parseResumeParam()) return;
    try {
      var href = location.href.replace(new RegExp('([?&])' + RESUME_PARAM + '=[^&#]*&?'), '$1').replace(/[?&]$/, '');
      if (window.history && window.history.replaceState) window.history.replaceState(null, '', href);
    } catch (e) { /* 忽略 */ }
  }

  function buildModal() {
    if (document.getElementById('pay-modal')) return;

    var modal = document.createElement('div');
    modal.className = 'pay-modal';
    modal.id = 'pay-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '支付');
    modal.innerHTML =
      '<div class="pay-card">' +
        '<button type="button" class="pay-close" id="pay-close" aria-label="关闭">×</button>' +
        '<h3 id="pay-title">支付</h3>' +
        '<div class="pay-amount" id="pay-amount"></div>' +
        '<div class="pay-qr" id="pay-qr"></div>' +
        '<p class="pay-tip" id="pay-tip"></p>' +
        '<a class="btn btn-primary pay-dl" id="pay-dl" hidden>下载资源包</a>' +
        '<button type="button" class="btn btn-secondary pay-retry" id="pay-retry" hidden>重新支付</button>' +
        '<div class="pay-group" id="pay-group" hidden ' +
             'style="margin-top:16px;padding-top:14px;border-top:1px dashed rgba(0,0,0,0.15);text-align:center;">' +
          '<img id="pay-group-qr" alt="Molio 墨流用户交流群二维码" width="96" height="96" ' +
               'style="border-radius:2px;display:inline-block;">' +
          '<p style="font-size:12px;color:var(--ink-40,#888);line-height:1.6;margin:8px 0 0;">' +
            '扫码加入用户群，导入和使用的问题群里随时问' +
          '</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    var titleEl = document.getElementById('pay-title');
    var qrBox = document.getElementById('pay-qr');
    var tip = document.getElementById('pay-tip');
    var dl = document.getElementById('pay-dl');
    var retry = document.getElementById('pay-retry');
    var amountEl = document.getElementById('pay-amount');
    var groupBox = document.getElementById('pay-group');
    var groupQr = document.getElementById('pay-group-qr');
    var pollTimer = null;
    var pending = null;   // 当前待付订单 { r, no }：从支付宝/微信切回时补查用
    var current = null;   // 最近一次下单参数 { r, uid }：手机端「重新支付」复用（uid 不丢）

    /**
     * 群二维码路径：以 IIFE 求值期捕获的 SCRIPT_BASE 为基准解析，
     * 与 shared.js 同思路；极老浏览器无 currentScript 时按 pathname 兜底
     * （SSR 商品页在 /resource/ 子目录，回退相对上一级）。
     */
    function groupQrSrc() {
      if (SCRIPT_BASE) {
        try { return new URL('images/qrcode.png', SCRIPT_BASE).href; } catch (e) { /* 落兜底 */ }
      }
      return (location.pathname.indexOf('/resource/') === 0 ? '../' : '/') + 'images/qrcode.png';
    }

    // 群二维码是静态图（与悬浮层同一张 images/qrcode.png，已被缓存），src 不依赖订单，
    // 构建期一次性解析设好；成功态只切 hidden，回调里不再碰路径。
    groupQr.src = groupQrSrc();

    function resetView() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      pending = null;
      qrBox.innerHTML = '';
      dl.hidden = true;
      retry.hidden = true;
      groupBox.hidden = true;
    }

    function closePay() {
      modal.hidden = true;
      resetView();
    }

    document.getElementById('pay-close').addEventListener('click', closePay);
    modal.addEventListener('click', function (e) { if (e.target === modal) closePay(); });

    /** 支付成功：清轮询、解锁下载、展示加群二维码 */
    function onPaid(r, outTradeNo) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      pending = null;
      retry.hidden = true;
      clearPending();
      stripResumeParam();
      tip.textContent = '支付成功，正在解锁下载…';
      fetch(payBase() + '/deliver?id=' + encodeURIComponent(r.id) + '&out_trade_no=' + encodeURIComponent(outTradeNo))
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (d) {
          qrBox.innerHTML = '';
          dl.href = d.url;
          dl.hidden = false;
          tip.textContent = '支付成功，下载链接 1 小时内有效';
          // 交付时刻是加群转化最高点：付款完成后展示用户群二维码
          groupBox.hidden = false;
        })
        .catch(function () {
          tip.textContent = '获取下载链接失败，请凭订单号 ' + outTradeNo + ' 联系我们';
        });
    }

    /**
     * 查单一次。未 SUCCESS 且未在轮询中 → 起轮询（回跳续接场景的首次探测）；
     * fromReturn=true 表示刚从支付页切回来，未付时给出「重新支付」的提示。
     */
    function checkOrder(r, outTradeNo, fromReturn) {
      var base = payBase();
      if (!base) return;
      fetch(base + '/order?out_trade_no=' + encodeURIComponent(outTradeNo))
        .then(function (res) { return res.json(); })
        .then(function (st) {
          if (!st || st.status !== 'SUCCESS') {
            if (fromReturn) tip.textContent = '尚未完成支付，可点「重新支付」再次发起';
            if (!pollTimer) startPolling(r, outTradeNo);
            return;
          }
          onPaid(r, outTradeNo);
        })
        .catch(function () {
          // 单次查单失败忽略，继续（轮询会再试）
          if (!pollTimer) startPolling(r, outTradeNo);
        });
    }

    function startPolling(r, outTradeNo) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      pending = { r: r, no: outTradeNo };
      pollTimer = setInterval(function () { checkOrder(r, outTradeNo, false); }, POLL_INTERVAL_MS);
    }

    /* 从支付宝/微信切回浏览器（bfcache 回退 / 前后台切换）立刻补查一次，不等下一个 3s */
    function syncOnReturn() {
      if (!pending) return;
      checkOrder(pending.r, pending.no, true);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') syncOnReturn();
    });
    window.addEventListener('pageshow', syncOnReturn);

    /** 实际下单/轮询/交付。uid（买家用户 id）为空时行为与旧版完全一致 */
    function startOrder(r, uid) {
      var base = payBase();
      var env = payEnv();
      var mobile = env === 'mobile';

      modal.hidden = false;
      amountEl.textContent = '¥' + r.price;
      current = { r: r, uid: uid };
      resetView();

      // 微信内不创建订单：微信屏蔽支付宝域名；微信 H5 支付只能在微信外调起；
      // Native 二维码的「长按识别 / 相册识别」又已被微信支付封禁 —— 唯一可行是去浏览器。
      if (env === 'wechat') {
        titleEl.textContent = '请在浏览器中打开';
        tip.textContent = '微信内无法直接支付。点右上角 ⋯ 选择「在浏览器中打开」，即可用支付宝完成支付。';
        return;
      }

      titleEl.textContent = mobile ? '支付宝支付' : '微信支付';
      tip.textContent = '正在创建订单…';

      if (!base) { tip.textContent = '支付服务未开通，请直接联系购买'; return; }

      // 手机端显式声明 scene=alipay：后端据此走支付宝 WAP 下单并返回 pay_url；
      // return_url 交给后端在校验 origin 后拼上 molio_pay_resume（订单号此时才有）
      var payUrl = base + '/pay?id=' + encodeURIComponent(r.id) + (mobile ? '&scene=alipay' : '');
      if (uid) payUrl += '&uid=' + encodeURIComponent(uid);
      if (mobile) payUrl += '&return_url=' + encodeURIComponent(pageUrlWithoutResume());

      fetch(payUrl)
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (data) {
          // 手机端：跳转支付宝收银台（用 location 跳转而非 window.open——
          // 收银台要校验收起页 Referer，且弹窗在非直接手势下会被浏览器拦截）
          if (mobile && data && data.pay_url) {
            tip.textContent = '正在打开支付宝…';
            // 跳转后本页会卸载：按钮只在用户从支付宝返回（bfcache 回退）时才看得见
            retry.hidden = false;
            // 手机端不起轮询（页面即将卸载），但要登记待付订单：用户从支付宝回退到本页时
            //（bfcache 恢复，不会重新加载）靠它立刻补查一次
            pending = { r: r, no: data.out_trade_no };
            rememberPending(r.id, data.out_trade_no);
            location.href = data.pay_url;
            return;
          }

          // 手机端没拿到 pay_url（旧后端未上线支付宝通道）：降级为「另一台设备扫码」，
          // 并明确写清楚本机扫不了，别让用户对着自己的屏幕找二维码
          if (mobile) {
            if (!data || !data.code_url) {
              tip.textContent = '移动端支付暂不可用，请稍后重试或联系购买';
              return;
            }
            new QRCode(qrBox, { text: data.code_url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
            tip.textContent = '请用另一台设备扫描二维码支付 ¥' + r.price + '，支付成功后自动解锁下载';
            startPolling(r, data.out_trade_no);
            return;
          }

          // 桌面：Native 扫码（与旧版一致，一行未改）
          if (!data || !data.code_url) {
            tip.textContent = '支付服务暂不可用，请稍后重试或联系购买';
            return;
          }
          new QRCode(qrBox, { text: data.code_url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
          tip.textContent = '用微信扫码支付 ¥' + r.price + '，支付成功后自动解锁下载';
          startPolling(r, data.out_trade_no);
        })
        .catch(function (e) {
          console.error(e);
          tip.textContent = '创建订单失败，请关闭重试，或联系购买';
        });
    }

    /** 手机端支付宝回跳续接：凭订单号直接查单解锁，不重新下单、不重复弹登录框 */
    function resumeOrder(id, outTradeNo) {
      var listing = window.__LISTING__;
      var price = (listing && listing.id === id) ? listing.priceCents / 100 : '';
      var r = { id: id, price: price };

      modal.hidden = false;
      titleEl.textContent = '支付宝支付';
      resetView();
      amountEl.textContent = price === '' ? '' : '¥' + price;
      tip.textContent = '正在确认支付结果…';
      // 原 pay_url 属于已创建的那笔订单，未支付时不能复用 → 直接给重新下单入口
      retry.hidden = false;
      pending = { r: r, no: outTradeNo };
      current = { r: r };
      checkOrder(r, outTradeNo, true);
    }

    // 重新支付：原支付链接可能已过期（支付宝订单超时），重新下单拿新 pay_url。
    // 走 MolioPay.open 而不是直接 startOrder：续接后登录态可能已过期，需重新过登录门槛，
    // 同时从登录态取回 uid，避免新订单丢失买家归属。
    retry.addEventListener('click', function () {
      if (!current) return;
      window.MolioPay.open(current.r);
    });

    window.MolioPay = window.MolioPay || {};
    /** 付费下载门槛：未登录 → 弹登录框，登录成功才下单；用户取消则不创建订单 */
    window.MolioPay.open = function (r) {
      var auth = window.MolioAuth;
      if (!auth) { startOrder(r, null); return; } // auth.js 缺失时优雅降级（旧行为）
      auth.requireAuth().then(
        function (user) { startOrder(r, user && user.id); },
        function () { /* 用户取消登录 */ }
      );
    };

    // 回跳续接：从支付宝付完（或被用户带回）本页时自动续上订单
    var resumed = takePending();
    if (resumed) resumeOrder(resumed.id, resumed.no);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildModal);
  } else {
    buildModal();
  }
})();

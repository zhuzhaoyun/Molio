/**
 * 商品详情页（/resource/{id}.html，SSR）交互层 —— 渐进增强。
 *
 * 页面正文由云端 SSR 完整输出（爬虫零 JS 可读）；本脚本只负责把
 * 登录门槛 / 微信支付 / 签名下载 / 灯箱等交互绑到已存在的静态节点上。
 * 数据来源是页面内嵌的 window.__LISTING__（SSR 注入，避免二次请求）。
 *
 * 依赖（必须先于本文件加载，见 SSR 模板脚本顺序）：
 *   - window.MOLIO_PAY_BASE（SSR 内嵌）
 *   - vendor/qrcode.min.js、auth.js（window.MolioAuth）、pay.js（window.MolioPay）
 */
(function () {
  'use strict';

  var m = window.__LISTING__;
  if (!m || !m.id) return; // 无内嵌数据（异常页）→ 纯静态展示，不绑交互

  // 云端认证/市场服务地址（本地联调注入点：window.MOLIO_AUTH_BASE）
  function marketBase() { return window.MOLIO_AUTH_BASE || 'https://auth.molio.cn'; }

  /* ---------- 微信支付（扫码下单/轮询/交付统一在 pay.js） ---------- */
  var payBtn = document.getElementById('pay-btn');
  if (payBtn) {
    payBtn.addEventListener('click', function () {
      // MolioPay.open 展示用 r.price（元），市场接口给 priceCents（分）——此处换算
      if (window.MolioPay) window.MolioPay.open({ id: m.id, price: m.priceCents / 100 });
    });
  }

  /* ---------- 已购识别：买过就别再让用户重付 ----------
   * 商品页 CTA 由云端 SSR 按**商品价格**生成，不感知用户状态 —— 已购用户重新打开
   * 仍看到「微信支付 ¥49」，误点会真的再扣一次钱（后端拦不住：那是一笔合法新订单）。
   * 而那个限时下载链只在支付成功那一刻展示过一次，滚走/过期就找不回来了。
   *
   * 所以已登录时先问一次云端已购：命中且商品在架 → 主按钮换成「下载」。
   * 云端 /market/listings/:id/download 对已购放行（market/service.ts download()：
   * 付费资源仅在「未购」时 402），故无需任何后端改动，重复下载天然是最新版。
   *
   * 纪律：未登录不探测；一切失败（网络 / 云端 502 / 未命中）静默保持原按钮 ——
   * 绝不能把付费入口藏掉，否则想买的人反而买不了。
   */
  if (payBtn && window.MolioAuth && window.MolioAuth.isLoggedIn()) {
    window.MolioAuth.getAccessToken()
      .then(function (token) {
        return fetch(marketBase() + '/market/purchases', {
          headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
        });
      })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        var list = (body && body.purchases) || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === m.id && list[i].available !== false) { markPurchased(); return; }
        }
      })
      .catch(function () { /* 探测失败：保持「微信支付」，用户仍可正常购买 */ });
  }

  /** 已购态：主按钮从「微信支付」换成「下载」，侧栏说明同步改写 */
  function markPurchased() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = payBtn.className;
    btn.id = 'pay-btn';
    btn.textContent = '已购 · 下载资源包';
    btn.addEventListener('click', function () {
      if (!window.MolioAuth) return;
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '准备下载…';
      fetchDownloadUrl().then(function (url) {
        btn.disabled = false;
        btn.textContent = label;
        if (url) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
        // 已购却拿不到链接：会话过期或已购索引暂不可达 —— 给明确可重试的反馈，不静默
        btn.textContent = '下载失败，点击重试';
      });
    });
    payBtn.parentNode.replaceChild(btn, payBtn);
    // 已购用户看到「扫码支付成功后自动解锁下载」会以为还要再付一次
    var note = document.querySelector('.res-side-card .res-side-note');
    if (note) note.textContent = '已购买，重复下载即为最新版；资源更新后重新下载即可。';
  }

  /* ---------- 外链购买：登录后新标签页打开 ---------- */
  var payUrlBtn = document.getElementById('payurl-btn');
  if (payUrlBtn) {
    payUrlBtn.addEventListener('click', function () {
      var go = function () { window.open(payUrlBtn.getAttribute('data-url'), '_blank', 'noopener,noreferrer'); };
      if (window.MolioAuth) window.MolioAuth.requireAuth().then(go, function () { /* 用户取消 */ });
      else go();
    });
  }

  /* ---------- 签名下载：登录门槛后带 Bearer 换限时链接（免费商品与已购商品共用） ---------- */
  /**
   * 取签名下载链；未登录会先走登录门槛。任何失败（网络 / 401 / 未购 402）返回 null，
   * 由调用方各自决定怎么提示 —— 免费下载回登录门槛、已购下载给可重试文案。
   */
  function fetchDownloadUrl() {
    return window.MolioAuth.requireAuth()
      .then(function () { return window.MolioAuth.getAccessToken(); })
      .then(function (token) {
        return fetch(marketBase() + '/market/listings/' + encodeURIComponent(m.id) + '/download', {
          headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
        });
      })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) { return body && body.url ? body.url : null; })
      .catch(function () { return null; });
  }

  /* ---------- 免费下载：登录门槛后带 Bearer 换签名链接；401/失败 → 回登录门槛 ---------- */
  var dlBtn = document.getElementById('market-dl-btn');
  if (dlBtn) {
    dlBtn.addEventListener('click', function () {
      if (!window.MolioAuth) return;
      fetchDownloadUrl().then(function (url) {
        if (url) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
        window.MolioAuth.requireAuth().catch(function () { /* 用户取消 */ });
      });
    });
  }

  /* ---------- 灯箱：预览图点击放大，点击任意处或 Esc 关闭（JS 失效时退回新标签页） ---------- */
  var root = document.getElementById('res-detail');
  var lb = document.getElementById('res-lightbox');
  if (root && lb) {
    var lbImg = lb.querySelector('img');
    function closeLb() {
      lb.hidden = true;
      lbImg.src = '';
      document.body.style.overflow = '';
    }
    root.addEventListener('click', function (e) {
      var a = e.target.closest('.res-preview-grid a');
      if (!a) return;
      e.preventDefault();
      var thumb = a.querySelector('img');
      lbImg.src = a.getAttribute('href');
      lbImg.alt = thumb ? thumb.alt : '';
      lb.hidden = false;
      document.body.style.overflow = 'hidden';
    });
    lb.addEventListener('click', closeLb);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !lb.hidden) closeLb();
    });
  }

  /* ---------- 登录门槛文案：内容在 auth.js 加载前已存在于 DOM，兜底再刷一次 ---------- */
  if (window.MolioAuth && window.MolioAuth.refreshLabels) window.MolioAuth.refreshLabels();
})();

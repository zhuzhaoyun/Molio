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

  /* ---------- 外链购买：登录后新标签页打开 ---------- */
  var payUrlBtn = document.getElementById('payurl-btn');
  if (payUrlBtn) {
    payUrlBtn.addEventListener('click', function () {
      var go = function () { window.open(payUrlBtn.getAttribute('data-url'), '_blank', 'noopener,noreferrer'); };
      if (window.MolioAuth) window.MolioAuth.requireAuth().then(go, function () { /* 用户取消 */ });
      else go();
    });
  }

  /* ---------- 免费下载：登录门槛后带 Bearer 换签名链接；401/失败 → 回登录门槛 ---------- */
  var dlBtn = document.getElementById('market-dl-btn');
  if (dlBtn) {
    dlBtn.addEventListener('click', function () {
      if (!window.MolioAuth) return;
      window.MolioAuth.requireAuth().then(function () {
        return window.MolioAuth.getAccessToken();
      }).then(function (token) {
        return fetch(marketBase() + '/market/listings/' + encodeURIComponent(m.id) + '/download', {
          headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
        });
      }).then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) {
          if (body && body.url) { window.open(body.url, '_blank', 'noopener,noreferrer'); return; }
          throw new Error('download_failed');
        })
        .catch(function () {
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

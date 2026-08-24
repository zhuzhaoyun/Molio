/**
 * 微信支付弹窗（列表页 resources.html 与详情页 resource.html 共用）。
 *
 * 依赖：
 *   - vendor/qrcode.min.js（二维码渲染）
 *   - window.MOLIO_PAY_BASE（resources-data.js 配置的支付后端地址）
 *   - window.MolioAuth（auth.js；**必须先于本文件加载**）——付费下载登录门槛：
 *     未登录先弹登录框，登录成功才下单（订单带买家 uid 归属）。
 *
 * 用法：MolioPay.open(resource)，resource 为 MOLIO_RESOURCES 中的一条。
 * 流程：登录门槛 → /pay 下单（带 uid）→ 渲染二维码 → 每 3s 轮询 /order
 *       → SUCCESS 后 /deliver 拿 presign 下载链接。
 */
(function () {
  'use strict';

  var payBase = function () { return window.MOLIO_PAY_BASE || ''; };

  function buildModal() {
    if (document.getElementById('pay-modal')) return;

    var modal = document.createElement('div');
    modal.className = 'pay-modal';
    modal.id = 'pay-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '微信支付');
    modal.innerHTML =
      '<div class="pay-card">' +
        '<button type="button" class="pay-close" id="pay-close" aria-label="关闭">×</button>' +
        '<h3>微信支付</h3>' +
        '<div class="pay-amount" id="pay-amount"></div>' +
        '<div class="pay-qr" id="pay-qr"></div>' +
        '<p class="pay-tip" id="pay-tip"></p>' +
        '<a class="btn btn-primary pay-dl" id="pay-dl" hidden>下载资源包</a>' +
      '</div>';
    document.body.appendChild(modal);

    var qrBox = document.getElementById('pay-qr');
    var tip = document.getElementById('pay-tip');
    var dl = document.getElementById('pay-dl');
    var amountEl = document.getElementById('pay-amount');
    var pollTimer = null;

    function closePay() {
      modal.hidden = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      qrBox.innerHTML = '';
      dl.hidden = true;
    }

    document.getElementById('pay-close').addEventListener('click', closePay);
    modal.addEventListener('click', function (e) { if (e.target === modal) closePay(); });

    /** 实际下单/轮询/交付。uid（买家用户 id）为空时行为与旧版完全一致 */
    function startOrder(r, uid) {
      var base = payBase();
      modal.hidden = false;
      amountEl.textContent = '¥' + r.price;
      tip.textContent = '正在创建订单…';
      qrBox.innerHTML = '';
      dl.hidden = true;

      if (!base) { tip.textContent = '支付服务未开通，请直接联系购买'; return; }

      var payUrl = base + '/pay?id=' + encodeURIComponent(r.id);
      if (uid) payUrl += '&uid=' + encodeURIComponent(uid);

      fetch(payUrl)
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (data) {
          new QRCode(qrBox, { text: data.code_url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
          tip.textContent = '用微信扫码支付 ¥' + r.price + '，支付成功后自动解锁下载';
          pollTimer = setInterval(function () {
            fetch(base + '/order?out_trade_no=' + encodeURIComponent(data.out_trade_no))
              .then(function (res) { return res.json(); })
              .then(function (st) {
                if (st.status !== 'SUCCESS') return;
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                tip.textContent = '支付成功，正在解锁下载…';
                fetch(base + '/deliver?id=' + encodeURIComponent(r.id) + '&out_trade_no=' + encodeURIComponent(data.out_trade_no))
                  .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
                  .then(function (d) {
                    qrBox.innerHTML = '';
                    dl.href = d.url;
                    dl.hidden = false;
                    tip.textContent = '支付成功，下载链接 1 小时内有效';
                  })
                  .catch(function () {
                    tip.textContent = '获取下载链接失败，请凭订单号 ' + data.out_trade_no + ' 联系我们';
                  });
              })
              .catch(function () { /* 单次轮询失败忽略，继续 */ });
          }, 3000);
        })
        .catch(function (e) {
          console.error(e);
          tip.textContent = '创建订单失败，请关闭重试，或联系购买';
        });
    }

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildModal);
  } else {
    buildModal();
  }
})();

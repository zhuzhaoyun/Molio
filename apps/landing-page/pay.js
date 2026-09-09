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

  // 脚本自身地址（求值期捕获；支付成功的异步回调里 document.currentScript 为 null）。
  // 作为群二维码的解析基准，与 shared.js 的 SCRIPT_BASE 同思路：根部署（resources.html）、
  // SSR 商品页（/resource/*.html）、本地 file:// 预览，全部落到正确的 images/qrcode.png。
  var SCRIPT_BASE = document.currentScript && document.currentScript.src;

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

    var qrBox = document.getElementById('pay-qr');
    var tip = document.getElementById('pay-tip');
    var dl = document.getElementById('pay-dl');
    var amountEl = document.getElementById('pay-amount');
    var groupBox = document.getElementById('pay-group');
    var groupQr = document.getElementById('pay-group-qr');
    var pollTimer = null;

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

    function closePay() {
      modal.hidden = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      qrBox.innerHTML = '';
      dl.hidden = true;
      groupBox.hidden = true;
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
      groupBox.hidden = true;

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
                    // 交付时刻是加群转化最高点：付款完成后展示用户群二维码
                    groupBox.hidden = false;
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

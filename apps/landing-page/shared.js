/**
 * Molio 全站公共脚本
 * - 注入悬浮二维码（装饰性元素）
 * - 滚动入场 reveal
 * - 首页锚点导航高亮
 * 无 canvas，尊重 prefers-reduced-motion。
 */
(function () {
  'use strict';

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. 注入全局氛围层 ---------- */
  function injectAtmosphere() {
    if (document.getElementById('molio-atmosphere')) return;
    const div = document.createElement('div');
    div.id = 'molio-atmosphere';
    div.className = 'atmosphere';
    document.body.insertBefore(div, document.body.firstChild);
  }

  /* ---------- 2. 注入悬浮元素 ---------- */
  function injectFloaters() {
    if (document.getElementById('molio-floaters')) return;

    const qrPrefix = location.pathname.includes('/blog/') ? '../' : '';
    const customQr = document.body.dataset.floatQr;
    const customCaption = document.body.dataset.floatCaption;
    const qrSrc = customQr ? (qrPrefix + customQr) : (qrPrefix + 'images/qrcode.png');
    const caption = customCaption || '加入用户群';
    const altText = customCaption ? (customCaption + '二维码') : 'Molio 墨流用户交流群二维码';

    const wrap = document.createElement('div');
    wrap.id = 'molio-floaters';
    wrap.innerHTML = `
      <div class="float-qr-wrap" aria-label="${altText}">
        <div class="float-qr-img">
          <img src="${qrSrc}" alt="${altText}" loading="lazy" width="90" height="90">
        </div>
        <div class="float-qr-caption">${caption}</div>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  /* ---------- 3. 滚动 reveal ---------- */
  function initReveal() {
    const items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    if (prefersReduced) {
      items.forEach(el => el.classList.add('in-view'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
    );

    items.forEach(el => observer.observe(el));
  }

  /* ---------- 4. 首页锚点高亮 ---------- */
  function initAnchorNav() {
    const anchors = document.querySelectorAll('[data-anchor]');
    const sections = document.querySelectorAll('section[id], .section[id]');
    if (!anchors.length || !sections.length) return;

    function updateActive() {
      let current = '';
      const halfVH = window.innerHeight / 2;
      sections.forEach(sec => {
        const rect = sec.getBoundingClientRect();
        if (rect.top <= halfVH && rect.bottom >= halfVH) {
          current = sec.id;
        }
      });
      anchors.forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#' + current);
      });
    }

    window.addEventListener('scroll', updateActive, { passive: true });
    updateActive();
  }

  /* ---------- 初始化 ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }

  function run() {
    injectAtmosphere();
    injectFloaters();
    initReveal();
    initAnchorNav();
  }
})();

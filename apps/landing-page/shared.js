/**
 * Molio 全站公共脚本
 * - 注入悬浮二维码 / GitHub（装饰性元素）
 * - 注入统计占位符（GA + 百度）
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
    const wrap = document.createElement('div');
    wrap.id = 'molio-floaters';
    wrap.innerHTML = `
      <div class="float-qr-wrap" aria-label="用户交流群二维码">
        <div class="float-qr-img">
          <img src="${qrPrefix}images/qrcode.webp" alt="Molio 墨流用户交流群二维码" loading="lazy" width="90" height="90">
        </div>
        <div class="float-qr-caption">加好友交流</div>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  /* ---------- 2. 注入统计代码（占位符） ---------- */
  function injectAnalytics() {
    if (document.getElementById('molio-analytics')) return;

    const marker = document.createElement('div');
    marker.id = 'molio-analytics';
    marker.style.display = 'none';

    // Google Analytics 占位符
    const gaScript = document.createElement('script');
    gaScript.async = true;
    gaScript.src = 'https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX';

    const gaInit = document.createElement('script');
    gaInit.textContent = `
      window.dataLayer = window.dataLayer || [];
      function gtag(){ dataLayer.push(arguments); }
      gtag('js', new Date());
      gtag('config', 'G-XXXXXXXXXX');
    `;

    // 百度统计占位符
    const baidu = document.createElement('script');
    baidu.textContent = `
      var _hmt = _hmt || [];
      (function(){
        var hm = document.createElement("script");
        hm.src = "https://hm.baidu.com/hm.js?YOUR_BAIDU_ID";
        var s = document.getElementsByTagName("script")[0];
        s.parentNode.insertBefore(hm, s);
      })();
    `;

    document.body.appendChild(marker);
    document.body.appendChild(gaScript);
    document.body.appendChild(gaInit);
    document.body.appendChild(baidu);
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
    injectAnalytics();
    initReveal();
    initAnchorNav();
  }
})();

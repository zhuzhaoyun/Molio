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
    const qrSrc = customQr ? (qrPrefix + customQr) : (qrPrefix + '/images/qrcode.png');
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

  /* ---------- 5. 移动端汉堡菜单（按钮由脚本注入，各页 HTML 无需改动） ---------- */
  function initMobileNav() {
    const nav = document.querySelector('.top-nav');
    const inner = nav && nav.querySelector('.nav-inner');
    const links = nav && nav.querySelector('.nav-links');
    if (!nav || !inner || !links || nav.querySelector('.nav-toggle')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-toggle';
    btn.setAttribute('aria-label', '打开菜单');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="nav-toggle-bar"></span><span class="nav-toggle-bar"></span><span class="nav-toggle-bar"></span>';
    inner.appendChild(btn);

    function setOpen(open) {
      nav.classList.toggle('nav-open', open);
      btn.setAttribute('aria-expanded', String(open));
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!nav.classList.contains('nav-open'));
    });

    // 点击链接 / 登录入口后收起面板
    links.addEventListener('click', function (e) {
      if (e.target.closest('a') || e.target.closest('.nav-auth-btn')) setOpen(false);
    });

    document.addEventListener('click', function (e) {
      if (nav.classList.contains('nav-open') && !nav.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });

    const mq = window.matchMedia('(min-width: 721px)');
    const onWiden = function (e) { if (e.matches) setOpen(false); };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onWiden);
    else if (typeof mq.addListener === 'function') mq.addListener(onWiden);
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
    initMobileNav();
  }
})();

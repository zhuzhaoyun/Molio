/* SSR 卡片保持零 JS 可读；本脚本只做渐进增强：移动已存在、已转义的 DOM 节点。
   结构对齐设计原型 docs/prototype/resources-catalog.html（分类条 / 结果栏 / 分组 / 分页 / 分类弹窗）。 */
(function () {
  'use strict';
  var grid = document.getElementById('res-grid');
  var search = document.getElementById('rl-search');
  var catalog = window.MolioCatalogView;
  // 元素缺失（局部渲染、脚本被单独引入）时直接退出：整段脚本挂在 null 解引用上
  // 会让页面退化成纯 SSR 视图，且控制台报错 —— 见 2026-10 的排序/刷新控件移除事故。
  if (!grid || !search || !catalog) return;

  var PAGE_SIZE = 9;      // 每批显示的条数（原型 3 列 × 3 行）
  var LIST_LOAD_MARGIN_PX = 400; // 触底提前量：滚到底时下一批已经在了
  var listings = window.__LISTINGS__ || [];
  var lastView = null;    // 最近一次 render 的视图，供触底加载判断 hasMore
  var observer = null;
  var $ = function (id) { return document.getElementById(id); };
  var cards = new Map();
  grid.querySelectorAll('[data-resource-id]').forEach(function (card) {
    cards.set(card.dataset.resourceId, card);
  });
  var params = new URLSearchParams(location.search);
  var shown = PAGE_SIZE; // 当前显示多少条：视图状态，不进 URL（URL 只放用户意图：分类/类型/关键词）

  function element(tag, text, className) {
    var el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, action) {
    var b = element('button', text);
    b.type = 'button';
    b.onclick = action;
    return b;
  }
  function commit(replace) {
    var url = new URL(location.href);
    url.search = params.toString();
    history[replace ? 'replaceState' : 'pushState']({}, '', url);
    render();
  }
  function change(key, value, replace) {
    if (value && value !== 'all') params.set(key, value);
    else params.delete(key);
    shown = PAGE_SIZE; // 换了筛选条件就回到第一批
    commit(replace);
    scrollToFilters(); // 并回到列表顶部
  }
  function clear() {
    ['category', 'type', 'q'].forEach(function (k) { params.delete(k); });
    shown = PAGE_SIZE;
    search.value = '';
    commit(false);
  }
  function scrollToFilters() {
    var bar = document.querySelector('.rl-filters');
    if (bar) bar.scrollIntoView({ block: 'start' });
  }
  /* 触底自动加载下一批：哨兵接近视口底部就把 limit 再放大一批。
     数据本来就整包在页面里（SSR 已渲染全部卡片），这里只是逐批显示，不发请求。 */
  function observeSentinel() {
    if (observer) { observer.disconnect(); observer = null; }
    var target = $('rl-sentinel');
    if (!target || !lastView || !lastView.hasMore || typeof IntersectionObserver === 'undefined') return;
    observer = new IntersectionObserver(function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      shown += PAGE_SIZE; // 只动视图状态，不碰 URL/历史
      render();
    }, { rootMargin: LIST_LOAD_MARGIN_PX + 'px' });
    observer.observe(target);
  }

  function cardGrid(items) {
    var el = element('div', undefined, 'rl-grid');
    items.forEach(function (m) {
      var card = cards.get(m.id);
      if (card) el.append(card);
    });
    return el;
  }
  function nameOf(view, id) {
    for (var i = 0; i < view.categories.length; i++) {
      if (view.categories[i].id === id) return view.categories[i].name;
    }
    return id;
  }

  function render() {
    var selected = params.get('category') || 'all';
    var query = params.get('q') || '';
    var typeId = params.get('type') || 'all';
    var view = catalog(listings, {
      category: selected,
      type: typeId,
      q: query,
      limit: shown,
    });
    lastView = view;

    search.value = query;
    $('rl-search-clear').hidden = !query;

    // 分类 chips（计数用 <small>，与原型一致）
    var chips = $('rl-categories');
    chips.replaceChildren();
    [{ id: 'all', name: '全部资源', count: view.matchingTotal }].concat(view.categories).forEach(function (c) {
      var b = button(c.name, function () { change('category', c.id); });
      b.append(element('small', String(c.count)));
      b.setAttribute('aria-pressed', String(selected === c.id));
      b.dataset.category = c.id;
      chips.append(b);
    });

    // 类型行：只有多于一种类型才出现
    $('rl-type-label').hidden = view.types.length < 2;
    var typeSelect = $('rl-type');
    typeSelect.replaceChildren();
    [{ id: 'all', name: '全部类型' }].concat(view.types).forEach(function (t) {
      var o = element('option', t.name);
      o.value = t.id;
      typeSelect.append(o);
    });
    typeSelect.value = typeId;

    // 结果栏：#rl-scope 放「作用域 · 类型 · “关键词”」，#rl-count 只放计数
    var tail = '';
    if (typeId !== 'all') tail += ' · ' + (function () {
      for (var i = 0; i < view.types.length; i++) if (view.types[i].id === typeId) return view.types[i].name;
      return typeId;
    })();
    if (query.trim()) tail += ' · “' + query.trim() + '”';
    $('rl-scope').replaceChildren(
      element('strong', selected === 'all' ? '全部资源' : nameOf(view, selected)),
      document.createTextNode(tail + ' · ')
    );
    $('rl-count').textContent = view.total + ' 个资源';
    $('rl-clear').hidden = view.grouped;

    // 主体：未筛选按分类分组（每类 6 条），筛过之后平铺 + 分页
    grid.replaceChildren();
    if (view.grouped) {
      view.groups.filter(function (g) { return g.items.length; }).forEach(function (g) {
        var section = element('section', undefined, 'rl-section');
        var head = element('header');
        var h2 = element('h2', g.category.name);
        // 计数用该分类总数（不是当前显示条数）—— 与 SSR 首屏、与 app 侧一致
        h2.append(element('small', g.category.count + ' 个资源'));
        head.append(h2);
        section.append(head, cardGrid(g.items));
        grid.append(section);
      });
    } else {
      var flat = element('section', undefined, 'rl-section');
      flat.append(cardGrid(view.items));
      grid.append(flat);
    }

    $('rl-no-match').hidden = view.total !== 0;

    // 分类弹窗列表
    var term = ($('rl-cat-search').value || '').trim().toLowerCase();
    var list = $('rl-cat-list');
    list.replaceChildren();
    var matches = view.categories.filter(function (c) {
      return c.name.toLowerCase().indexOf(term) >= 0;
    });
    if (!matches.length) {
      list.append(element('p', '没有匹配的分类'));
    } else {
      matches.forEach(function (c) {
        var b = button('', function () { change('category', c.id); $('rl-dialog').close(); });
        b.append(element('span', c.name), element('small', String(c.count)));
        b.setAttribute('aria-pressed', String(selected === c.id));
        list.append(b);
      });
    }

    if (window.MolioAuth && window.MolioAuth.refreshLabels) window.MolioAuth.refreshLabels();
    observeSentinel();
  }

  search.addEventListener('input', function () { change('q', this.value, true); });
  $('rl-search-clear').onclick = function () { search.value = ''; change('q', '', true); search.focus(); };
  $('rl-type').onchange = function () { change('type', this.value); };
  $('rl-clear').onclick = clear;
  $('rl-empty-clear').onclick = clear;
  $('rl-search-all').onclick = function () { params.delete('type'); change('category', 'all'); };
  $('rl-all-categories').onclick = function () {
    $('rl-cat-search').value = '';
    render();
    $('rl-dialog').showModal();
  };
  $('rl-close').onclick = function () { $('rl-dialog').close(); };
  $('rl-cat-search').oninput = render;
  // hero 里的「试试 …」快捷搜索词
  document.addEventListener('click', function (e) {
    var hit = e.target.closest('[data-query]');
    if (hit) change('q', hit.dataset.query, true);
  });
  window.addEventListener('popstate', function () {
    params = new URLSearchParams(location.search);
    render();
  });
  render();
})();
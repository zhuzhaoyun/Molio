/**
 * 资源列表页（/resources）—— 对应设计原型 docs/prototype/resources-catalog.html 的内容区：
 * 两栏 hero（eyebrow + 衬线大标题 + 带图标的搜索框 + 快捷搜索词）、sticky 分类 chips、
 * 结果栏、3 列卡片网格。未筛选时按分类分组（每类 6 条），筛过之后平铺 + 分页（每页 9 条）。
 * 目录来自云端市场（经 daemon 镜像），拉取失败降级为 stale 提示，不阻塞浏览。
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { marketCatalogView, type MarketListing } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { marketToEntry } from '../../data/resources';
import { useMarketCatalog } from '../../hooks/useMarketCatalog';
import { useResourcePay } from '../../hooks/useResourcePay';
import { ResourceCard } from './ResourceCard';
import { ResourcePayModal } from './ResourcePayModal';

/** 首载骨架屏占位数（3 列 × 2 行，纯装饰） */
const SKELETON_CARDS = 6;
/** 每批显示的条数（3 列 × 3 行）；触底一次就再放一批 */
const PAGE_SIZE = 9;
/** 触底判定的提前量：离视口底部还有这么远就开始加载，滚到底时下一批已经在了 */
const LOAD_MARGIN_PX = 400;
/** hero 里的快捷搜索词 key：查询词固定中文（目录内容是中文），只有文案走 i18n */
const SHORTCUTS = ['classics', 'engineering', 'philosophy'] as const;

export function ResourcesPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const { listings, loading, stale, refresh } = useMarketCatalog();
  const pay = useResourcePay();
  const dialog = useRef<HTMLDialogElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [catSearch, setCatSearch] = useState('');

  const category = params.get('category') || 'all';
  const type = params.get('type') || 'all';
  const q = params.get('q') || '';
  // 当前显示多少条：**视图状态，不进 URL**。滚动加载若走路由导航，会与用户正在
  // 输入的搜索词抢同一次导航 —— 受控输入框会被按旧的 q 重置，输入直接丢掉。
  const [shown, setShown] = useState(PAGE_SIZE);
  const view = marketCatalogView(listings, { category, type, q, limit: shown });

  // 筛选条件一变就回到第一批
  useEffect(() => {
    setShown(PAGE_SIZE);
  }, [category, type, q]);

  // 触底自动加载下一批：哨兵接近视口底部就再放一批进来（数据已在内存，不产生请求）
  useEffect(() => {
    const root = scroll.current;
    const target = sentinel.current;
    if (!root || !target || !view.hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((s) => s + PAGE_SIZE);
      },
      { root, rootMargin: `${LOAD_MARGIN_PX}px` },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [view.hasMore, view.shown]);

  // 一律用函数式更新派生新 URL：连续两次改动（点分类后马上输入关键词）时，
  // 若基于可能还没刷新的 params 闭包，后一次会把前一次的条件挤掉。
  function change(key: string, value: string, replace = false) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (!value || value === 'all') next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace },
    );
    // 换了筛选条件就回到列表顶部（滚动加载本身不回顶，见上面的 observer）
    scroll.current?.scrollTo({ top: 0 });
  }

  const scope =
    category === 'all'
      ? t('catalog.all')
      : (view.categories.find((c) => c.id === category)?.name ?? category);
  const typeName = view.types.find((x) => x.id === type)?.name;
  const categoryMatches = view.categories.filter((c) =>
    c.name.toLowerCase().includes(catSearch.trim().toLowerCase()),
  );
  const card = (m: MarketListing) => (
    <ResourceCard key={m.id} r={marketToEntry(m)} onPay={pay.open} />
  );

  return (
    <div className="resources-shell">
      <div className="resources-scroll" ref={scroll}>
        <div className="catalog-wrap">
          <header className="catalog-hero">
            <div>
              <div className="catalog-eyebrow">{t('catalog.eyebrow')}</div>
              <h1>
                {t('catalog.headline')}
                <span>{t('catalog.headlineAccent')}</span>
              </h1>
              <p className="catalog-intro">{t('catalog.intro')}</p>
            </div>
            <div>
              <div className="catalog-searchbox">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <circle cx="10" cy="10" r="6.5" />
                  <path d="m15 15 6 6" />
                </svg>
                <input
                  type="search"
                  data-testid="resources-search"
                  aria-label={t('catalog.search')}
                  placeholder={t('catalog.search')}
                  autoComplete="off"
                  value={q}
                  onChange={(e) => change('q', e.target.value, true)}
                />
                {q !== '' && (
                  <button type="button" onClick={() => change('q', '')}>
                    {t('catalog.clearSearch')}
                  </button>
                )}
              </div>
              <div className="catalog-searchhint">
                {t('catalog.searchHint')}
                {SHORTCUTS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    data-query={t(`catalog.shortcut.${k}`)}
                    onClick={() => change('q', t(`catalog.shortcut.${k}`), true)}
                  >
                    {t(`catalog.shortcut.${k}`)}
                  </button>
                ))}
              </div>
            </div>
          </header>

          <div className="catalog-filters">
            <div className="catalog-filterrow">
              <div className="catalog-quick" role="group" aria-label={t('catalog.category')}>
                <button
                  type="button"
                  className="resources-filter"
                  aria-pressed={category === 'all'}
                  data-testid="resources-filter-all"
                  onClick={() => change('category', 'all')}
                >
                  {t('catalog.all')}
                  <small>{view.matchingTotal}</small>
                </button>
                {view.categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="resources-filter"
                    aria-pressed={category === c.id}
                    data-testid={`resources-category-${c.id}`}
                    onClick={() => change('category', c.id)}
                  >
                    {c.id === 'uncategorized' ? t('catalog.uncategorized') : c.name}
                    <small>{c.count}</small>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="catalog-allcats"
                onClick={() => {
                  setCatSearch('');
                  dialog.current?.showModal();
                }}
              >
                {t('catalog.allCategories')} ▾
              </button>
            </div>
            {view.types.length > 1 && (
              <div className="catalog-types">
                <label htmlFor="resources-type">{t('catalog.type')}</label>
                <select
                  id="resources-type"
                  data-testid="resources-type"
                  value={type}
                  onChange={(e) => change('type', e.target.value)}
                >
                  <option value="all">{t('catalog.allTypes')}</option>
                  {view.types.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <span>{t('catalog.typeHint')}</span>
              </div>
            )}
          </div>

          <div className="catalog-resultbar">
            <div className="catalog-scope">
              <strong>{scope}</strong>
              {typeName && <span> · {typeName}</span>}
              {q.trim() !== '' && <span> · “{q.trim()}”</span>}
              <span> · </span>
              <span role="status" data-testid="resources-count">
                {t('catalog.results', { count: view.total })}
              </span>
            </div>
            {!view.grouped && (
              <button type="button" className="catalog-clear" onClick={() => setParams({})}>
                {t('catalog.clear')}
              </button>
            )}
          </div>

          {stale && (
            <p className="catalog-stale" role="alert">
              {t('catalog.stale')} <button type="button" onClick={refresh}>{t('catalog.retry')}</button>
            </p>
          )}

          <div data-testid="resources-grid" aria-busy={loading}>
            {loading && !listings.length ? (
              <div className="resources-grid">
                {Array.from({ length: SKELETON_CARDS }, (_, i) => (
                  <div
                    key={i}
                    className="resources-skeleton-card"
                    data-testid="resources-skeleton-card"
                    aria-hidden="true"
                  >
                    <div className="resources-skeleton-card__meta">
                      <span className="resources-skeleton-card__symbol" />
                      <span className="resources-skeleton-card__line is-short" />
                    </div>
                    <span className="resources-skeleton-card__title" />
                    <span className="resources-skeleton-card__line" />
                    <span className="resources-skeleton-card__line" />
                    <span className="resources-skeleton-card__line is-short" />
                  </div>
                ))}
              </div>
            ) : view.grouped ? (
              view.groups
                .filter((g) => g.items.length)
                .map((g) => (
                  <section className="catalog-section" key={g.category.id}>
                    <header>
                      <h2>
                        {g.category.id === 'uncategorized'
                          ? t('catalog.uncategorized')
                          : g.category.name}
                        <small>{t('catalog.results', { count: g.category.count })}</small>
                      </h2>
                    </header>
                    <div className="resources-grid">{g.items.map(card)}</div>
                  </section>
                ))
            ) : (
              <div className="resources-grid">{view.items.map(card)}</div>
            )}

            {!loading && !view.total && (
              <div className="resources-empty">
                <h2>{t('catalog.empty')}</h2>
                <p>{t('catalog.emptyHint')}</p>
                <div className="resources-empty__actions">
                  <button
                    type="button"
                    className="catalog-primary"
                    onClick={() =>
                      setParams((prev) => {
                        const next = new URLSearchParams(prev);
                        next.delete('category');
                        next.delete('type');
                        return next;
                      })
                    }
                  >
                    {t('catalog.searchAll')}
                  </button>
                  <button type="button" onClick={() => setParams({})}>
                    {t('catalog.clear')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 触底加载哨兵：进入视口就再放一批进来（见上面的 IntersectionObserver） */}
          {view.hasMore && <div ref={sentinel} className="catalog-sentinel" aria-hidden="true" />}

          <dialog className="catalog-dialog" ref={dialog}>
            <div className="catalog-dialoghead">
              <h2>{t('catalog.allCategories')}</h2>
              <button
                type="button"
                aria-label={t('catalog.closeCategories')}
                onClick={() => dialog.current?.close()}
              >
                ×
              </button>
            </div>
            <input
              type="search"
              className="catalog-dialogsearch"
              aria-label={t('catalog.findCategory')}
              placeholder={t('catalog.findCategory')}
              value={catSearch}
              onChange={(e) => setCatSearch(e.target.value)}
            />
            <div className="catalog-categorylist">
              {categoryMatches.length === 0 ? (
                <p>{t('catalog.noMatchCategory')}</p>
              ) : (
                categoryMatches.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={category === c.id}
                    onClick={() => {
                      change('category', c.id);
                      dialog.current?.close();
                    }}
                  >
                    <span>{c.id === 'uncategorized' ? t('catalog.uncategorized') : c.name}</span>
                    <small>{c.count}</small>
                  </button>
                ))
              )}
            </div>
          </dialog>
        </div>
      </div>
      {pay.phase !== 'idle' && <ResourcePayModal pay={pay} />}
    </div>
  );
}
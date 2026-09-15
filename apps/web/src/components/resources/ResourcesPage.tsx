/**
 * 资源列表页（/resources）—— 对应官网 resources.html：
 * 标题区 + 筛选 pills（全部/付费/免费/社区分享）+ 卡片网格；付费购买在应用内弹微信支付。
 * 社区条目经 useMarketCatalog 动态合并（失败降级不影响官方货架）。
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { marketToEntry, type CatalogEntry } from '../../data/resources';
import { useMarketCatalog } from '../../hooks/useMarketCatalog';
import { useResourcePay } from '../../hooks/useResourcePay';
import { ResourceCard } from './ResourceCard';
import { ResourcePayModal } from './ResourcePayModal';

type Filter = 'all' | 'paid' | 'free';
const FILTERS: Filter[] = ['all', 'paid', 'free'];

function applyFilter(list: CatalogEntry[], f: Filter): CatalogEntry[] {
  if (f === 'paid') return list.filter((e) => e.price > 0);
  if (f === 'free') return list.filter((e) => e.price === 0);
  return list;
}

/** 首载骨架屏占位卡片数（与网格列宽自适应，纯装饰 aria-hidden） */
const SKELETON_CARDS = 6;

export function ResourcesPage() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const pay = useResourcePay();
  const { listings, loading, refresh } = useMarketCatalog();

  // 进入页面强制刷新一次目录（TTL 内命中缓存则不重复请求）
  useEffect(() => {
    refresh();
  }, [refresh]);

  const list = applyFilter(listings.map(marketToEntry), filter);
  // 首次加载（无任何数据在途）→ 骨架屏，避免"加载中"与"暂无资源"同形的空白页
  const skeleton = loading && list.length === 0;

  return (
    <div className="resources-shell">
      <div className="resources-scroll">
        <header className="resources-hero">
          <h1>{t('resources.title')}</h1>
          <p>{t('resources.subtitle')}</p>
        </header>

        <div className="resources-filters">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`resources-filter${filter === f ? ' is-active' : ''}`}
              data-testid={`resources-filter-${f}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`resources.filter.${f}`)}
            </button>
          ))}
        </div>

        <div className="resources-grid" data-testid="resources-grid" aria-busy={skeleton}>
          {skeleton ? (
            Array.from({ length: SKELETON_CARDS }, (_, i) => (
              <div
                key={i}
                className="resources-skeleton-card"
                data-testid="resources-skeleton-card"
                aria-hidden="true"
              >
                <div className="resources-skeleton-card__top">
                  <span className="resources-skeleton-card__icon" />
                  <span className="resources-skeleton-card__title" />
                </div>
                <span className="resources-skeleton-card__line" />
                <span className="resources-skeleton-card__line is-short" />
              </div>
            ))
          ) : (
            list.map((e) => <ResourceCard key={e.id} r={e} onPay={pay.open} />)
          )}
          {!skeleton && list.length === 0 && (
            <div className="resources-empty">{t('resources.empty')}</div>
          )}
        </div>
      </div>

      {pay.phase !== 'idle' && <ResourcePayModal pay={pay} />}
    </div>
  );
}

/**
 * 资源列表页（/resources）—— 对应官网 resources.html：
 * 标题区 + 筛选 pills（全部/付费/免费）+ 卡片网格；付费购买在应用内弹微信支付。
 */
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { RESOURCES, type MolioResource } from '../../data/resources';
import { useResourcePay } from '../../hooks/useResourcePay';
import { ResourceCard } from './ResourceCard';
import { ResourcePayModal } from './ResourcePayModal';

type Filter = 'all' | 'paid' | 'free';
const FILTERS: Filter[] = ['all', 'paid', 'free'];

function applyFilter(list: MolioResource[], f: Filter): MolioResource[] {
  if (f === 'paid') return list.filter((r) => r.price > 0);
  if (f === 'free') return list.filter((r) => r.price === 0);
  return list;
}

export function ResourcesPage() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const pay = useResourcePay();

  const list = applyFilter(RESOURCES, filter);

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

        <div className="resources-grid" data-testid="resources-grid">
          {list.map((r) => (
            <ResourceCard key={r.id} r={r} onPay={pay.open} />
          ))}
          {list.length === 0 && (
            <div className="resources-empty">{t('resources.empty')}</div>
          )}
        </div>
      </div>

      {pay.phase !== 'idle' && <ResourcePayModal pay={pay} />}
    </div>
  );
}

/**
 * 资源卡片（列表页网格项）—— 对应设计原型 docs/prototype/resources-catalog.html 的卡片：
 * 元信息条（emoji 符号 + 分类 / 类型 + 版本）、衬线标题、描述（3 行截断）、标签、底栏（价格 + 动作）。
 * 原型底栏只有「查看详情」；实现侧额外承载购买/下载 —— 那是应用的收入入口，必须保留。
 */
import { Link, useLocation } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { type CatalogEntry, type PayItem } from '../../data/resources';
import { useAuthStatus } from '../../stores/authStore';
import { startResourcePurchase } from './resourceAction';

export function ResourceCard({
  r,
  onPay,
}: {
  r: CatalogEntry;
  onPay: (r: PayItem) => void;
}) {
  const { t } = useI18n();
  const location = useLocation();
  const auth = useAuthStatus();
  const loggedIn = auth?.loggedIn === true;
  const paid = r.price > 0;

  return (
    <article className="resources-card" data-testid={`resource-card-${r.id}`}>
      <div className="resources-card__meta">
        <span className="resources-card__stamp">
          <span
            className="resources-card__symbol"
            style={{ backgroundColor: r.tint }}
            aria-hidden="true"
          >
            {r.icon}
          </span>
          {r.market?.category?.name ?? t('catalog.uncategorized')} /{' '}
          {r.market?.resourceType?.name ?? '知识库'}
        </span>
        <span className="resources-card__ver">{r.version}</span>
      </div>

      {/* 标题即详情入口：底栏再放一个「查看详情」只是同一个去处的重复，且挤占底栏宽度 */}
      <h3 className="resources-card__name">
        <Link
          to={`/resources/${r.id}`}
          state={{ catalogSearch: location.search }}
          data-testid={`resource-detail-link-${r.id}`}
        >
          {r.name}
        </Link>
      </h3>
      <p className="resources-card__desc">{r.desc}</p>

      {r.tags.length > 0 && (
        <div className="resources-card__tags">
          {r.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      )}

      <div className="resources-card__actions">
        <span className={`resources-card__price ${paid ? 'is-paid' : 'is-free'}`}>
          {paid ? `¥${r.price}` : t('resources.free')}
        </span>
        <button
          type="button"
          className="resources-card__buy"
          data-testid={`resource-buy-${r.id}`}
          onClick={() => startResourcePurchase(r, onPay)}
        >
          {paid
            ? t(loggedIn ? 'resources.buy' : 'resources.buyLogin', { price: r.price })
            : t(loggedIn ? 'resources.download' : 'resources.downloadLogin')}
        </button>
      </div>
    </article>
  );
}
/**
 * 资源卡片（列表页网格项）—— 对应官网 resources.html 的 resCard() 模板：
 * emoji 图标（tint 底色）+ 名称 + tags 副标题 + desc + 价格 pill + 购买/下载 + 详情。
 */
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { type CatalogEntry, type MolioResource } from '../../data/resources';
import { useAuthStatus } from '../../stores/authStore';
import { startResourcePurchase } from './resourceAction';

export function ResourceCard({
  r,
  onPay,
}: {
  r: CatalogEntry;
  onPay: (r: MolioResource) => void;
}) {
  const { t } = useI18n();
  const auth = useAuthStatus();
  const loggedIn = auth?.loggedIn === true;
  const paid = r.price > 0;

  return (
    <article className="resources-card" data-testid={`resource-card-${r.id}`}>
      <div className="resources-card__top">
        <div className="resources-card__icon" style={{ backgroundColor: r.tint }} aria-hidden="true">
          {r.icon}
        </div>
        <div className="resources-card__titles">
          <h3 className="resources-card__name">{r.name}</h3>
          {r.tags.length > 0 && (
            <div className="resources-card__sub">
              {r.tags.join(' · ')}
              <span className="resources-card__ver">{r.version}</span>
            </div>
          )}
        </div>
        <span className={`resources-card__price ${paid ? 'is-paid' : 'is-free'}`}>
          {paid ? `¥${r.price}` : t('resources.free')}
        </span>
      </div>
      <p className="resources-card__desc">{r.desc}</p>
      <div className="resources-card__actions">
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
        <Link
          to={`/resources/${r.id}`}
          className="resources-card__detail"
          data-testid={`resource-detail-link-${r.id}`}
        >
          {t('resources.detail')}
        </Link>
      </div>
    </article>
  );
}

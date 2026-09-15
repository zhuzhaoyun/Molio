/**
 * 我的上架分区 —— 「我的」页面（/me?tab=listings）内嵌，仅市场管理员可见入口。
 *
 * GET /api/market/my → 列表（图标/名称/状态徽标/版本）；操作：
 * 查看（官网详情页）/ 下架（DELETE /api/market/listings/:id，二次确认）/
 * 恢复（管理员，removed 条目）。
 * 前身是 AccountModal 里的 MyListingsPanel 弹层，账号模块页面化后改为内嵌分区。
 */
import { useCallback, useEffect, useState } from 'react';
import type { MarketMyListing } from '@molio/contracts';
import { useI18n } from '../../i18n';

export function ListingsSection() {
  const { t } = useI18n();
  const [listings, setListings] = useState<MarketMyListing[] | null>(null); // null = 加载中
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MarketMyListing | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<MarketMyListing | null>(null);
  const [removing, setRemoving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/market/my');
      if (!res.ok) throw new Error(`market ${res.status}`);
      const body = (await res.json()) as { isAdmin?: boolean; listings: MarketMyListing[] };
      setListings(body.listings);
      setIsAdmin(body.isAdmin === true);
    } catch {
      setError(t('myListings.error'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const confirmRemove = useCallback(async () => {
    if (!removeTarget || removing) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/market/listings/${removeTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`market ${res.status}`);
      setRemoveTarget(null);
      void load();
    } catch {
      setRemoveTarget(null);
      setError(t('myListings.error'));
    } finally {
      setRemoving(false);
    }
  }, [removeTarget, removing, load, t]);

  // 恢复（管理员）：云端 admin restore，仅 removed 且 isAdmin 时可用
  const confirmRestore = useCallback(async () => {
    if (!restoreTarget || removing) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/market/admin/listings/${restoreTarget.id}/restore`, { method: 'POST' });
      if (!res.ok) throw new Error(`market ${res.status}`);
      setRestoreTarget(null);
      void load();
    } catch {
      setRestoreTarget(null);
      setError(t('myListings.error'));
    } finally {
      setRemoving(false);
    }
  }, [restoreTarget, removing, load, t]);

  return (
    <div className="me-section" data-testid="my-listings-section">
      {error && <p className="mylistings-error">{error}</p>}
      {listings === null && !error && <p className="mylistings-note">{t('account.loading')}</p>}
      {listings !== null && listings.length === 0 && (
        <p className="mylistings-note" data-testid="my-listings-empty">{t('myListings.empty')}</p>
      )}
      {listings !== null && listings.length > 0 && (
        <ul className="mylistings-list">
          {listings.map((l) => (
            <li key={l.id} className="mylistings-item" data-testid="my-listings-item">
              <span className="mylistings-icon" aria-hidden="true">{l.icon}</span>
              <div className="mylistings-titles">
                <span className="mylistings-name">{l.name}</span>
                <span className="mylistings-sub">
                  <span className={`mylistings-status is-${l.status}`}>
                    {t(`myListings.status.${l.status}`)}
                  </span>
                  <span className="mylistings-ver">{l.version}</span>
                </span>
              </div>
              <div className="mylistings-actions">
                <a
                  className="mylistings-action"
                  href={`https://molio.cn/resource/${l.id}.html`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('myListings.view')}
                </a>
                {l.status === 'active' && (
                  <button
                    type="button"
                    className="mylistings-action is-danger"
                    disabled={removing}
                    onClick={() => { setError(null); setRemoveTarget(l); }}
                  >
                    {t('myListings.remove')}
                  </button>
                )}
                {l.status === 'removed' && isAdmin && (
                  <button
                    type="button"
                    className="mylistings-action"
                    disabled={removing}
                    onClick={() => { setError(null); setRestoreTarget(l); }}
                  >
                    {t('myListings.restore')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {removeTarget && (
        <div className="mylistings-confirm me-section-confirm">
          <p>{t('myListings.confirmRemove')}</p>
          <div className="mylistings-confirm-actions">
            <button type="button" disabled={removing} onClick={() => setRemoveTarget(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="is-danger" disabled={removing} onClick={() => void confirmRemove()}>
              {t('myListings.remove')}
            </button>
          </div>
        </div>
      )}
      {restoreTarget && (
        <div className="mylistings-confirm me-section-confirm">
          <p>{t('myListings.confirmRestore')}</p>
          <div className="mylistings-confirm-actions">
            <button type="button" disabled={removing} onClick={() => setRestoreTarget(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" disabled={removing} onClick={() => void confirmRestore()}>
              {t('myListings.restore')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

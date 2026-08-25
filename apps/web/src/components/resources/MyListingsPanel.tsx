/**
 * 我的上架面板 —— 账号模态框（AccountModal）入口。
 *
 * GET /api/market/my → 列表（图标/名称/状态徽标/版本）；操作：
 * 查看（官网详情页）/ 更新版本（打开 PublishWizard 更新模式）/
 * 下架（DELETE /api/market/listings/:id，面板内二次确认）。
 * 弹层骨架沿用 kb-modal 惯例；overlay 用 mylistings-overlay
 * （z-index 250：高于 kb-overlay 100、低于 publish-overlay 300）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { MarketMyListing } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { PublishWizard } from './PublishWizard';

interface MyListingsPanelProps {
  onClose: () => void;
}

export function MyListingsPanel({ onClose }: MyListingsPanelProps) {
  const { t } = useI18n();
  const [listings, setListings] = useState<MarketMyListing[] | null>(null); // null = 加载中
  const [error, setError] = useState<string | null>(null);
  const [updateTarget, setUpdateTarget] = useState<MarketMyListing | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MarketMyListing | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/market/my');
      if (!res.ok) throw new Error(`market ${res.status}`);
      const body = (await res.json()) as { isAdmin?: boolean; listings: MarketMyListing[] };
      setListings(body.listings);
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

  return (
    <div
      className="mylistings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kb-modal mylistings-modal">
        <div className="kb-modal-header">
          <h2>{t('account.myListings')}</h2>
          <button type="button" className="kb-modal-close" aria-label={t('common.close')} onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="kb-modal-body">
          {error && <p className="mylistings-error">{error}</p>}
          {listings === null && !error && <p className="mylistings-note">{t('account.loading')}</p>}
          {listings !== null && listings.length === 0 && (
            <p className="mylistings-note">{t('myListings.empty')}</p>
          )}
          {listings !== null && listings.length > 0 && (
            <ul className="mylistings-list">
              {listings.map((l) => (
                <li key={l.id} className="mylistings-item">
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
                      href={`https://molio.cn/resource.html?id=${l.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('myListings.view')}
                    </a>
                    <button type="button" className="mylistings-action" onClick={() => setUpdateTarget(l)}>
                      {t('myListings.update')}
                    </button>
                    <button
                      type="button"
                      className="mylistings-action is-danger"
                      disabled={removing}
                      onClick={() => { setError(null); setRemoveTarget(l); }}
                    >
                      {t('myListings.remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {removeTarget && (
          <div className="mylistings-confirm">
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
      </div>

      {updateTarget && (
        <PublishWizard
          vaultName={updateTarget.name}
          updateListingId={updateTarget.id}
          listing={updateTarget}
          onClose={() => setUpdateTarget(null)}
          onPublished={() => { void load(); }}
        />
      )}
    </div>
  );
}

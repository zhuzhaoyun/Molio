/**
 * 我的已购分区 —— 「我的」页面（/me?tab=purchases）内嵌。
 *
 * GET /api/market/purchases → 列表（图标/名称/版本/购买时间）；「下载」按钮走
 * GET /api/market/listings/:id/download 取限时签名 URL —— 资源更新覆盖同一
 * OSS key，因此重复下载天然拿到最新版本（分区顶部提示这一点）。
 *
 * 数据链路：daemon 镜像 → cloud（Bearer JWT 验明正身）→ wxpay-fc 已购索引。
 * 列表样式复用 mylistings-*（与「我的上架」同族）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { MarketPurchase } from '@molio/contracts';
import { useI18n } from '../../i18n';

export function PurchasesSection() {
  const { t } = useI18n();
  const [purchases, setPurchases] = useState<MarketPurchase[] | null>(null); // null = 加载中
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setPurchases(null);
    try {
      const res = await fetch('/api/market/purchases');
      if (!res.ok) throw new Error(`market ${res.status}`);
      const body = (await res.json()) as { purchases: MarketPurchase[] };
      setPurchases(body.purchases);
    } catch {
      setError(t('myPurchases.error'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const handleDownload = useCallback(async (p: MarketPurchase) => {
    if (downloadingId) return;
    setDownloadingId(p.id);
    setError(null);
    try {
      const res = await fetch(`/api/market/listings/${encodeURIComponent(p.id)}/download`);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const body = (await res.json()) as { url: string };
      window.open(body.url, '_blank', 'noopener,noreferrer');
    } catch {
      setError(t('myPurchases.downloadError'));
    } finally {
      setDownloadingId(null);
    }
  }, [downloadingId, t]);

  return (
    <div className="me-section" data-testid="my-purchases-section">
      {error && <p className="mylistings-error" data-testid="my-purchases-error">{error}</p>}
      {purchases === null && !error && <p className="mylistings-note">{t('account.loading')}</p>}
      {purchases !== null && purchases.length === 0 && !error && (
        <p className="mylistings-note" data-testid="my-purchases-empty">{t('myPurchases.empty')}</p>
      )}
      {purchases !== null && purchases.length > 0 && (
        <>
          <p className="mylistings-hint">{t('myPurchases.updateHint')}</p>
          <ul className="mylistings-list">
            {purchases.map((p) => (
              <li key={p.id} className="mylistings-item" data-testid="my-purchases-item">
                <span className="mylistings-icon" aria-hidden="true">{p.listing?.icon ?? '📦'}</span>
                <div className="mylistings-titles">
                  <span className="mylistings-name">{p.listing?.name ?? t('myPurchases.removed')}</span>
                  <span className="mylistings-sub">
                    {p.listing && <span className="mylistings-ver">{p.listing.version}</span>}
                    {p.purchasedAt && (
                      <span className="mylistings-ver" data-testid="my-purchases-date">
                        {t('myPurchases.purchasedAt', { date: p.purchasedAt.slice(0, 10) })}
                      </span>
                    )}
                    {!p.available && (
                      <span className="mylistings-status is-removed">{t('myPurchases.unavailable')}</span>
                    )}
                  </span>
                </div>
                <div className="mylistings-actions">
                  <button
                    type="button"
                    className="mylistings-action"
                    data-testid="my-purchases-download-btn"
                    disabled={!p.available || downloadingId !== null}
                    onClick={() => void handleDownload(p)}
                  >
                    {downloadingId === p.id ? t('myPurchases.downloading') : t('myPurchases.download')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && purchases === null && (
        <div className="mylistings-confirm-actions me-section-retry">
          <button type="button" data-testid="my-purchases-retry-btn" onClick={() => void load()}>
            {t('myPurchases.retry')}
          </button>
        </div>
      )}
    </div>
  );
}

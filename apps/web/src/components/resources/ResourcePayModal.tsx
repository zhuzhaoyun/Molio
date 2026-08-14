/**
 * 微信支付弹窗 —— 官网 pay.js 弹窗的 React 版：
 * 金额 + 二维码 + 状态提示 + 支付成功后的下载按钮。
 * 点遮罩 / 关闭按钮 / Esc 关闭；轮询清理在 useResourcePay 内。
 */
import { useEffect } from 'react';
import { useI18n } from '../../i18n';
import { isPaid } from '../../data/resources';
import type { ResourcePayHandle } from '../../hooks/useResourcePay';

export function ResourcePayModal({ pay }: { pay: ResourcePayHandle }) {
  const { t } = useI18n();
  const r = pay.resource;
  const { phase } = pay;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') pay.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pay]);

  if (!r) return null;

  let tip: string;
  switch (phase) {
    case 'creating':
      tip = t('resources.pay.creating');
      break;
    case 'waiting':
      tip = t('resources.pay.scan', { price: r.price });
      break;
    case 'delivering':
      tip = t('resources.pay.unlocking');
      break;
    case 'success':
      tip = t('resources.pay.linkReady');
      break;
    case 'error':
      tip =
        pay.errorKind === 'deliver'
          ? t('resources.pay.deliverFailed', { order: pay.outTradeNo })
          : pay.errorKind === 'no-base'
            ? t('resources.pay.noBase')
            : t('resources.pay.createFailed');
      break;
    default:
      tip = '';
  }

  return (
    <div
      className="resources-pay-modal"
      data-testid="resource-pay-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t('resources.pay.title')}
      onClick={(e) => {
        if (e.target === e.currentTarget) pay.close();
      }}
    >
      <div className="resources-pay-card">
        <button
          type="button"
          className="resources-pay-close"
          aria-label={t('common.close')}
          data-testid="resource-pay-close"
          onClick={pay.close}
        >
          ×
        </button>
        <h3>{t('resources.pay.title')}</h3>
        <div className="resources-pay-amount">
          {isPaid(r) ? `¥${r.price}` : t('resources.free')}
        </div>
        <div className="resources-pay-qr">
          {phase === 'waiting' && pay.qrDataUrl ? (
            <img src={pay.qrDataUrl} alt={t('resources.pay.title')} width={200} height={200} />
          ) : phase === 'success' ? (
            <a
              className="resources-pay-dl"
              href={pay.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="resource-pay-download"
            >
              {t('resources.pay.download')}
            </a>
          ) : phase === 'creating' || phase === 'delivering' ? (
            <div className="resources-pay-spinner" aria-hidden="true" />
          ) : null}
        </div>
        <p className="resources-pay-tip">{tip}</p>
      </div>
    </div>
  );
}

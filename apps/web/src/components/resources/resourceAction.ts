/**
 * 资源主按钮动作分发（列表卡片与详情页共用）：
 *   payUrl 非空 → 外部支付页；付费 → 应用内微信支付弹窗；免费 → OSS 直链下载。
 * （修正官网列表页免费资源也弹支付弹窗的瑕疵）
 */
import { isPaid, RES_BASE, type MolioResource } from '../../data/resources';

export function startResourcePurchase(
  r: MolioResource,
  onPay: (r: MolioResource) => void,
): void {
  if (r.payUrl) {
    window.open(r.payUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  if (isPaid(r)) {
    onPay(r);
    return;
  }
  window.open(`${RES_BASE}/${r.file}`, '_blank', 'noopener,noreferrer');
}

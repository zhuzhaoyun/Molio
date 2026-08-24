/**
 * 资源主按钮动作分发（列表卡片与详情页共用）：
 *   payUrl 非空 → 外部支付页；付费 → 应用内微信支付弹窗；免费 → OSS 直链下载。
 *
 * **登录门槛（全路径）**：三条分支执行前统一要求登录——未登录时挂起登录意图，
 * 弹出账号面板登录视图，登录成功后自动续接原动作（见 stores/loginIntentStore.ts）。
 * 与官网 apps/landing-page 的门槛语义一致：资源下载/购买不论免费付费都要登录。
 */
import { isPaid, RES_BASE, type MolioResource } from '../../data/resources';
import { authStore } from '../../stores/authStore';
import { loginIntentStore } from '../../stores/loginIntentStore';

export function startResourcePurchase(
  r: MolioResource,
  onPay: (r: MolioResource) => void,
): void {
  const act = () => {
    if (r.payUrl) {
      window.open(r.payUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (isPaid(r)) {
      onPay(r);
      return;
    }
    window.open(`${RES_BASE}/${r.file}`, '_blank', 'noopener,noreferrer');
  };

  const status = authStore.getStatus();
  if (status && status.loggedIn) {
    act();
    return;
  }
  // 未登录：拉起账号面板登录视图，登录成功续接本次动作
  loginIntentStore.requestLogin(act);
}

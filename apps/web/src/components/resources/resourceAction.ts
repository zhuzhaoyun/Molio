/**
 * 资源主按钮动作分发（列表卡片与详情页共用）：付费 → 应用内微信支付弹窗；
 * 免费 → 市场 API 取签名 URL 打开。静态官方直链已退役，所有资源统一走市场 API。
 *
 * **登录门槛（全路径）**：各分支执行前统一要求登录——未登录时挂起登录意图，
 * 弹出账号面板登录视图，登录成功后自动续接原动作（见 stores/loginIntentStore.ts）。
 *
 * 入参统一为 CatalogEntry（市场目录条目）。付费走 onPay(微信弹窗)，免费走市场下载。
 */
import { type CatalogEntry, type PayItem } from '../../data/resources';
import { authStore } from '../../stores/authStore';
import { loginIntentStore } from '../../stores/loginIntentStore';

export function startResourcePurchase(
  e: CatalogEntry,
  onPay: (r: PayItem) => void,
): void {
  const entry = e;

  const act = () => {
    if (entry.price > 0) {
      // 付费资源统一走应用内微信支付（Model B：微信 → OSS 下载链）
      onPay(entry);
      return;
    }
    if (entry.market) {
      // 免费资源：向市场 API 取签名下载链接再打开（登录门槛已在上方校验；401 兜底）
      fetch(`/api/market/listings/${encodeURIComponent(entry.id)}/download`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('download_denied'))))
        .then((body: { url: string }) => window.open(body.url, '_blank', 'noopener,noreferrer'))
        .catch(() => {
          /* 401/断网：静默降级（调用侧登录意图流程已挂起） */
        });
    }
  };

  const status = authStore.getStatus();
  if (status && status.loggedIn) {
    act();
    return;
  }
  // 未登录：拉起账号面板登录视图，登录成功续接本次动作
  loginIntentStore.requestLogin(act);
}

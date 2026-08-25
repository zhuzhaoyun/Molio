/**
 * 资源主按钮动作分发（列表卡片与详情页共用）：
 *   payUrl 非空 → 外部支付页；付费 → 应用内微信支付弹窗；
 *   免费 → OSS 直链下载（官方）；社区条目免费 → 市场 API 取签名 URL 再打开。
 *
 * **登录门槛（全路径）**：各分支执行前统一要求登录——未登录时挂起登录意图，
 * 弹出账号面板登录视图，登录成功后自动续接原动作（见 stores/loginIntentStore.ts）。
 * 与官网 apps/landing-page 的门槛语义一致：资源下载/购买不论免费付费都要登录。
 *
 * 入参为联合签名 CatalogEntry | MolioResource：列表卡片与详情页均传统一渲染模型
 * CatalogEntry；MolioResource 入参内部经 toEntry 归一后分发（兼容保留）。
 */
import {
  RESOURCES,
  RES_BASE,
  toEntry,
  type CatalogEntry,
  type MolioResource,
} from '../../data/resources';
import { authStore } from '../../stores/authStore';
import { loginIntentStore } from '../../stores/loginIntentStore';

export function startResourcePurchase(
  e: CatalogEntry | MolioResource,
  onPay: (r: MolioResource) => void,
): void {
  const entry = 'source' in e ? e : toEntry(e);

  const act = () => {
    if (entry.payUrl) {
      window.open(entry.payUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (entry.price > 0) {
      // 付费仅限官方资源（社区恒 0）；支付弹窗消费 MolioResource，按 id 取静态源对象
      const res = RESOURCES.find((r) => r.id === entry.id);
      if (res) onPay(res);
      return;
    }
    if (entry.market) {
      // 社区免费：向市场 API 取签名下载链接再打开（登录门槛已在上方校验；401 兜底）
      fetch(`/api/market/listings/${encodeURIComponent(entry.id)}/download`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('download_denied'))))
        .then((body: { url: string }) => window.open(body.url, '_blank', 'noopener,noreferrer'))
        .catch(() => {
          /* 401/断网：静默降级（调用侧登录意图流程已挂起） */
        });
      return;
    }
    if (entry.file) {
      window.open(`${RES_BASE}/${entry.file}`, '_blank', 'noopener,noreferrer');
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

// apps/cloud/src/market/pay-client.ts
// wxpay-fc 内部客户端：查已购索引（「我的已购」列表 + 付费资源已购下载放行的数据源）。
//
// 鉴权模型：x-internal-token 共享密钥（wxpay-fc 侧 PURCHASES_INTERNAL_TOKEN 同值）。
// uid 归属的信任链：cloud 先用 Bearer JWT 验明请求者身份，再以该身份查 wxpay-fc——
// wxpay-fc 的 uid 是下单时客户端声明的，只有经 cloud 这一跳才可信。
// 本客户端仅供 cloud 服务端调用，token 绝不下发客户端。

export interface PayPurchaseItem {
  /** 商品（listing）id */
  id: string;
  /** 首次购买时间（ISO） */
  purchased_at?: string;
  out_trade_no?: string;
  amount_cents?: number;
}

export interface PayInternalClient {
  /** 列出用户已购条目；网络失败/非 200 抛错，降级策略由调用方决定 */
  listPurchases(uid: string): Promise<PayPurchaseItem[]>;
}

export function createPayInternalClient(
  cfg: { url: string; token: string },
  fetchImpl: typeof fetch = fetch,
): PayInternalClient {
  const base = cfg.url.replace(/\/+$/, '');
  return {
    async listPurchases(uid) {
      const res = await fetchImpl(`${base}/purchases?uid=${encodeURIComponent(uid)}`, {
        headers: { 'x-internal-token': cfg.token },
      });
      if (!res.ok) throw new Error(`pay internal ${res.status}`);
      const body = (await res.json()) as { items?: PayPurchaseItem[] };
      return Array.isArray(body.items) ? body.items : [];
    },
  };
}

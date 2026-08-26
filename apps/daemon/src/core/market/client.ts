// apps/daemon/src/core/market/client.ts
// 云端 /market/* 客户端：token 取自 AuthClient（唯一持有者），错误映射同 auth 纪律。
import type {
  MarketCreateResponse,
  MarketDownloadResponse,
  MarketListing,
  MarketMyResponse,
} from '@molio/contracts';
import { AuthCloudError, type AuthClient } from '../auth/auth-client.js';

export interface MarketCreateInput {
  name: string;
  summary: string;
  icon: string;
  tags: string[];
  vaultSize: number;
  previews: { ext: string; size: number }[];
  /** 价格（分）；仅管理员可设 >0，非管理员云端强制 0 */
  priceCents?: number;
  /** 外部支付链接（付费资源 Model A 走外链交付） */
  payUrl?: string;
}

/**
 * 云端市场客户端（设计 §7）：daemon→云端 /market/* 的唯一通信方。
 * - token 取自 AuthClient（daemon 唯一持有者，Web UI 永不直连云端）
 * - base URL：构造参数 > AuthClient.getBaseUrl()（构造参数 > env MOLIO_AUTH_URL > 官方默认）；
 *   未配置（私有化关闭登录）抛 503 auth_not_configured，与 auth-client 内部 request() 同语义
 * - 网络层失败统一抛 AuthCloudError(0, 'cloud_unreachable')，由路由 cloudError 归一
 */
export class MarketClient {
  private f: typeof fetch;

  constructor(
    private auth: AuthClient,
    private baseUrl?: string,
    fetchImpl?: typeof fetch,
  ) {
    this.f = fetchImpl ?? fetch;
  }

  private async base(): Promise<string> {
    // 与 auth-client 同源：优先构造参数，其次 getBaseUrl()（构造参数 > env > 官方默认）
    if (this.baseUrl) return this.baseUrl.replace(/\/+$/, '');
    const b = this.auth.getBaseUrl();
    if (!b) throw new AuthCloudError(503, 'auth_not_configured');
    return b.replace(/\/+$/, '');
  }

  private async req(
    method: string,
    path: string,
    opts: { auth: boolean; body?: unknown },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth) headers['authorization'] = `Bearer ${await this.auth.getAccessToken()}`;
    let resp: Response;
    try {
      resp = await this.f(`${await this.base()}/market${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch {
      throw new AuthCloudError(0, 'cloud_unreachable');
    }
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { error?: string };
      throw new AuthCloudError(resp.status, body.error ?? 'internal');
    }
    return resp;
  }

  async list(): Promise<{ listings: MarketListing[] }> {
    return (await (await this.req('GET', '/listings', { auth: false })).json()) as {
      listings: MarketListing[];
    };
  }

  async get(id: string): Promise<MarketListing> {
    return (await (await this.req('GET', `/listings/${id}`, { auth: false })).json()) as MarketListing;
  }

  async download(id: string): Promise<MarketDownloadResponse> {
    return (await (
      await this.req('GET', `/listings/${id}/download`, { auth: true })
    ).json()) as MarketDownloadResponse;
  }

  async my(): Promise<MarketMyResponse> {
    return (await (await this.req('GET', '/my', { auth: true })).json()) as MarketMyResponse;
  }

  async create(input: MarketCreateInput): Promise<MarketCreateResponse> {
    return (await (await this.req('POST', '/listings', { auth: true, body: input })).json()) as MarketCreateResponse;
  }

  async confirm(id: string): Promise<unknown> {
    return (await this.req('POST', `/listings/${id}/confirm`, { auth: true })).json();
  }

  async update(id: string, previews: { ext: string; size: number }[], extra?: { priceCents?: number; payUrl?: string }): Promise<MarketCreateResponse> {
    return (await (
      await this.req('POST', `/listings/${id}/update`, { auth: true, body: { previews, ...extra } })
    ).json()) as MarketCreateResponse;
  }

  async remove(id: string): Promise<void> {
    await this.req('DELETE', `/listings/${id}`, { auth: true });
  }
}

/** 直传预签名目标（内容类型必须与签名一致） */
export async function putToSignedUrl(
  target: { url: string; contentType: string },
  body: Uint8Array,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const resp = await (fetchImpl ?? fetch)(target.url, {
    method: 'PUT',
    headers: { 'content-type': target.contentType },
    body,
  });
  if (!resp.ok) throw new Error(`oss_put_failed: ${resp.status}`);
}

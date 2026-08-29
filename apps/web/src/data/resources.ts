/**
 * 资源模块数据模型 —— 统一动态目录：官方与用户上架都在同一个云端市场(/market/listings)。
 * 静态数据(apps/landing-page/resources-data.js)已退役——官方数据迁移进云端后不再加载。
 * 付费资源统一走应用内微信支付(Model B)，无外链。列表/详情/支付均消费云端目录。
 */
import type { MarketListing } from '@molio/contracts';

/**
 * 微信支付后端地址。默认官网支付后端（与 landing-page/resources-data.js 一致，
 * CORS 已放行 *）；window.MOLIO_PAY_BASE 可覆盖——显式注入空串表示未开通，
 * 付费资源降级为“联系购买”。
 *
 * 历史教训（2026-08）：早期靠 side-effect import resources-data.js 顺带注入该值，
 * 社区市场重构移除 import 后桌面端静默降级为「支付服务未开通」，官网不受影响。
 * 因此默认值必须在这里显式声明，不能依赖外部注入。
 */
export const PAY_BASE: string = window.MOLIO_PAY_BASE ?? 'https://pay.molio.cn';

/** 官网根：预览图如为相对路径(兼容旧数据)则拼绝对 URL */
export const SITE_BASE = 'https://molio.cn';

/** 预览图路径转绝对 URL（已是 http(s) 绝对地址的原样返回） */
export function previewUrl(src: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  return `${SITE_BASE}/${src.replace(/^\/+/, '')}`;
}

/** 统一渲染条目（市场目录 | 详情） */
export interface CatalogEntry {
  id: string;
  source: 'official' | 'community';
  icon: string;
  tint: string;
  name: string;
  desc: string;
  author: string;
  version: string;
  price: number; // 元
  tags: string[];
  overview: string[];
  highlights: string[];
  preview: string[];
  payUrl: string;
  /** 社区/市场条目：详情页与下载经市场 API */
  market?: MarketListing;
}

/** 微信支付入口的最小商品形状（id/name/price 元）；官方与市场条目都满足 */
export interface PayItem {
  id: string;
  name: string;
  price: number;
}

export function marketToEntry(m: MarketListing): CatalogEntry {
  return {
    id: m.id,
    source: m.source,
    icon: m.icon,
    tint: m.tint,
    name: m.name,
    desc: m.summary,
    author: m.author,
    version: m.version,
    price: m.priceCents / 100,
    tags: m.tags,
    overview: m.overview,
    highlights: m.highlights,
    preview: m.previews,
    payUrl: m.payUrl,
    market: m,
  };
}

declare global {
  interface Window {
    MOLIO_PAY_BASE?: string;
  }
}

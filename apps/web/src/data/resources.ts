/**
 * 资源模块数据桥 —— 官方静态资源与官网 landing-page 共享同一份数据源。
 *
 * 静态数据 = 官方资源：来源是 apps/landing-page/resources-data.js（IIFE，向 window.MOLIO_* 赋值），
 * side-effect import 触发其执行，官网列表页 / 官网详情页 / 桌面端三处同时生效。
 * 上架新官方资源或改价只需改那一个文件（注意同步 OSS 上的权威定价 products.json）。
 *
 * 社区 = 运行时目录（见 ../hooks/useMarketCatalog.ts）：条目来自云端 /market/listings，
 * 与本文件的官方静态数据在渲染层合并，云端不可达时静默回退纯静态。
 *
 * 桌面端打包时官方静态数据被内联进 bundle —— 官方资源目录随应用版本固化，
 * 官网更新资源后，桌面端要发新版才能同步（设计取舍见资源模块移植方案）。
 */
import '../../../landing-page/resources-data.js';
import type { MarketListing } from '@molio/contracts';

export interface MolioResource {
  /** 唯一 id，用于路由 /resources/:id 与支付下单 */
  id: string;
  /** emoji 图标 */
  icon: string;
  /** 图标底色（十六进制） */
  tint: string;
  name: string;
  /** 一句话描述（列表卡片） */
  desc: string;
  /** 整理者署名（如“Molio 团队”） */
  author: string;
  /** 当前版本号（如 v1.0）；发新版时更新并同步替换 file */
  version: string;
  /** zip 文件名（免费资源直链 = RES_BASE + '/' + file） */
  file: string;
  /** 价格；0 = 免费 */
  price: number;
  tags: string[];
  /** 详情页概述段落 */
  overview: string[];
  /** 概述后的亮点列表 */
  highlights: string[];
  /** 效果预览图路径（相对官网根；空数组 → 详情页不显示预览区） */
  preview: string[];
  /** 非空 → 详情页按钮跳外部支付页（优先于微信支付） */
  payUrl: string;
}

declare global {
  interface Window {
    MOLIO_RESOURCES?: MolioResource[];
    MOLIO_PAY_BASE?: string;
    MOLIO_RES_BASE?: string;
  }
}

/** 官方资源条目列表（静态数据，与官网同一数据源；社区条目走运行时目录） */
export const RESOURCES: MolioResource[] = window.MOLIO_RESOURCES ?? [];

/** 微信支付后端地址；空串表示未开通，付费资源降级为“联系购买” */
export const PAY_BASE: string = window.MOLIO_PAY_BASE ?? '';

/** OSS 资源下载根（免费资源直链） */
export const RES_BASE: string = window.MOLIO_RES_BASE ?? '';

/** 官网根：预览图在数据中存相对路径，桌面端拼绝对 URL */
export const SITE_BASE = 'https://molio.cn';

/** 预览图路径转绝对 URL（已是 http(s) 绝对地址的原样返回） */
export function previewUrl(src: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  return `${SITE_BASE}/${src.replace(/^\/+/, '')}`;
}

export function isPaid(r: MolioResource): boolean {
  return r.price > 0;
}

/** 统一渲染条目：官方静态资源 或 社区动态资源 */
export interface CatalogEntry {
  id: string;
  source: 'official' | 'community';
  icon: string;
  tint: string;
  name: string;
  desc: string;
  author: string;
  version: string;
  price: number; // 元（官方静态数据语义不变；社区恒 0）
  tags: string[];
  overview: string[];
  highlights: string[];
  preview: string[]; // 绝对 URL（社区）或官网相对路径（官方）
  payUrl: string;
  /** 官方资源 zip 文件名（静态数据透传；社区条目无） */
  file?: string;
  /** 社区条目：详情页/下载经市场 API；官方条目：沿用现状 */
  market?: MarketListing;
}

export function toEntry(r: MolioResource): CatalogEntry {
  return {
    id: r.id,
    source: 'official',
    icon: r.icon,
    tint: r.tint,
    name: r.name,
    desc: r.desc,
    author: r.author,
    version: r.version,
    price: r.price,
    tags: r.tags,
    overview: r.overview,
    highlights: r.highlights,
    preview: r.preview,
    payUrl: r.payUrl,
    file: r.file,
  };
}

export function marketToEntry(m: MarketListing): CatalogEntry {
  return {
    id: m.id,
    source: 'community',
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

/**
 * 资源模块数据桥 —— 与官网 landing-page 共享同一份数据源。
 *
 * 单一数据源是 apps/landing-page/resources-data.js（IIFE，向 window.MOLIO_* 赋值）：
 * side-effect import 触发其执行，官网列表页 / 官网详情页 / 桌面端三处同时生效。
 * 上架新资源或改价只需改那一个文件（注意同步 OSS 上的权威定价 products.json）。
 *
 * 桌面端打包时该文件内容被内联进 bundle —— 资源目录随应用版本固化，
 * 官网更新资源后，桌面端要发新版才能同步（设计取舍见资源模块移植方案）。
 */
import '../../../landing-page/resources-data.js';

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

/** 资源条目列表（与官网同一数据源） */
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

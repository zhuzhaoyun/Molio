// packages/contracts/src/market.ts
// 资源市场（社区知识库分享）共享类型与预设常量。
// 常量为值导出：云端校验与前端表单同源，防漂移。

/** 推荐标签（前端快选）；校验不走白名单——用户可自定义标签（每个 ≤10 字，≤3 个） */
export const MARKET_TAGS = [
  '经典', '历史', '文学', '文献', '札记', '中医', '方剂',
  '读书', '科技', '学习', '生活', '其他',
] as const;
export type MarketTag = (typeof MARKET_TAGS)[number];

export const MARKET_ICONS = [
  '📖', '📚', '📝', '🗂️', '🏮', '🖋️', '🌿', '🏯',
  '📜', '🧭', '💡', '🔬', '🎨', '🎓', '🧩', '⭐',
] as const;
export type MarketIcon = (typeof MARKET_ICONS)[number];

/** 8 个柔和底色：前 6 个沿用官方资源已用色 */
export const MARKET_TINTS = [
  '#E8EDF2', '#F0E8DC', '#E8F0E4', '#F5E9D3', '#F2E3D5', '#F5E3E0', '#E6E9F5', '#F5EEE0',
] as const;
export type MarketTint = (typeof MARKET_TINTS)[number];

export type MarketListingSource = 'official' | 'community';
export type MarketListingStatus = 'uploading' | 'active' | 'removed';

/** 公开条目（列表/详情响应） */
export interface MarketListing {
  id: string;
  source: MarketListingSource;
  name: string;
  icon: string;
  tint: string;
  /** 一句话简介（列表卡片） */
  summary: string;
  /** 详情页段落（社区条目为空数组） */
  overview: string[];
  /** 亮点列表（社区条目为空数组） */
  highlights: string[];
  tags: string[];
  /** 预览图绝对 URL（1-4 张） */
  previews: string[];
  version: string;
  /** 价格（分）；Plan 1 恒 0 */
  priceCents: number;
  /** 外部支付链接；非空时详情页按钮跳外部 */
  payUrl: string;
  /** 展示署名（author_display ?? nickname，服务端解析后下发） */
  author: string;
  fileSize: number | null;
  /** ISO 时间；未上架为 null */
  publishedAt: string | null;
}

/** 「我的上架」条目 = 公开字段 + 状态 */
export interface MarketMyListing extends MarketListing {
  status: MarketListingStatus;
  removedReason: string | null;
}

/** 单个上传目标（预签名） */
export interface MarketUploadTarget {
  key: string;
  url: string;
  contentType: string;
}

/** POST /market/listings 请求（Plan 1 仅社区场景；管理员扩展字段 Plan 2） */
export interface MarketCreateRequest {
  name: string;
  summary: string;
  icon: string;
  /** 可省：服务端按用户已有上架数轮转分配 */
  tint?: string;
  tags: string[];
  /** 打包后 zip 字节数（声明值，confirm 以 HEAD 实测为准） */
  vaultSize: number;
  previews: { ext: string; size: number }[];
}

export interface MarketCreateResponse {
  listingId: string;
  /** 第一个恒为 vault.zip，其后按声明顺序为效果图 */
  uploads: MarketUploadTarget[];
  /** 凭证失效时间（epoch 毫秒） */
  expiresAt: number;
}

export interface MarketMyResponse {
  isAdmin: boolean;
  listings: MarketMyListing[];
}

export interface MarketDownloadResponse {
  url: string;
  expiresAt: number;
}

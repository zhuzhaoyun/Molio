// apps/cloud/src/store/market-types.ts
// MarketStore 持久层抽象：PgMarketStore（生产）+ MemoryMarketStore（node:test）。
// 时间戳接口层统一 epoch 毫秒（与 AuthStore 约定一致）。
import type { MarketListingSource, MarketListingStatus } from '@molio/contracts';

/** 更新流程暂存声明（confirm 消费后清空） */
export interface MarketPendingUpdate {
  previews: { key: string }[]; // 新效果图暂存键；空数组 = 沿用旧图
  name?: string;
  summary?: string;
  icon?: string;
  tags?: string[];
}

export interface MarketListingRecord {
  id: string;
  userId: string;
  source: MarketListingSource;
  name: string;
  icon: string;
  tint: string;
  summary: string;
  overview: string[];
  highlights: string[];
  tags: string[];
  previews: string[];
  version: string;
  priceCents: number;
  payUrl: string;
  authorDisplay: string | null;
  ossKey: string;
  fileSize: number | null;
  status: MarketListingStatus;
  removedReason: string | null;
  /** 更新流程暂存声明（update 发起时写入，confirm 消费后清空）；undefined 视同 null（兼容既有构造方） */
  pendingUpdate?: MarketPendingUpdate | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

export interface MarketStore {
  insertListing(rec: MarketListingRecord): Promise<void>;
  findListingById(id: string): Promise<MarketListingRecord | null>;
  /** 部分字段更新；不存在返回 null */
  updateListing(id: string, patch: Partial<Pick<MarketListingRecord,
    'status' | 'removedReason' | 'fileSize' | 'version' | 'previews' | 'ossKey' | 'publishedAt' | 'pendingUpdate'
    | 'priceCents' | 'payUrl' | 'name' | 'summary' | 'icon' | 'tags'
  >>, now: number): Promise<MarketListingRecord | null>;
  /** active 列表，published_at DESC */
  listActiveListings(limit: number): Promise<MarketListingRecord[]>;
  /** 某用户全部条目，created_at DESC */
  listUserListings(userId: string): Promise<MarketListingRecord[]>;
  /** 管理员视图：全部条目 + 上传者邮箱（账号已注销时为 null） */
  listAllWithOwner(): Promise<Array<{ listing: MarketListingRecord; ownerEmail: string | null }>>;
  countActiveByUser(userId: string): Promise<number>;
  countUserCreationsSince(userId: string, since: number): Promise<number>;
  /** 删除 before 之前创建且仍为 uploading 的僵尸行；返回删除数 */
  deleteStaleUploading(before: number): Promise<number>;
}

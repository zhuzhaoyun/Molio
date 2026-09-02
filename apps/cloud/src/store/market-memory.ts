// apps/cloud/src/store/market-memory.ts
import type { MarketListingRecord, MarketStore } from './market-types.js';
import { UniqueViolationError } from './types.js';

/** node:test 与本地开发用（无 DATABASE_URL 时，与 MemoryAuthStore 同待遇） */
export class MemoryMarketStore implements MarketStore {
  private listings = new Map<string, MarketListingRecord>();

  async insertListing(rec: MarketListingRecord): Promise<void> {
    if (this.listings.has(rec.id)) {
      throw new UniqueViolationError(`duplicate listing id: ${rec.id}`);
    }
    this.listings.set(rec.id, { ...rec });
  }

  async findListingById(id: string): Promise<MarketListingRecord | null> {
    const r = this.listings.get(id);
    return r ? { ...r } : null;
  }

  async updateListing(
    id: string,
    patch: Partial<Pick<MarketListingRecord,
      'status' | 'removedReason' | 'fileSize' | 'version' | 'previews' | 'ossKey' | 'publishedAt' | 'pendingUpdate'
      | 'priceCents' | 'payUrl' | 'name' | 'summary' | 'icon' | 'tags'>>,
    now: number,
  ): Promise<MarketListingRecord | null> {
    const r = this.listings.get(id);
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: now });
    return { ...r };
  }

  async listActiveListings(limit: number): Promise<MarketListingRecord[]> {
    return [...this.listings.values()]
      .filter((r) => r.status === 'active')
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listUserListings(userId: string): Promise<MarketListingRecord[]> {
    return [...this.listings.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ ...r }));
  }

  async listAllWithOwner(): Promise<Array<{ listing: MarketListingRecord; ownerEmail: string | null }>> {
    // 内存实现无 users 表访问：邮箱置 null（管理员端点测试用 Pg 或注入场景另行覆盖）
    return [...this.listings.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((listing) => ({ listing: { ...listing }, ownerEmail: null }));
  }

  async countActiveByUser(userId: string): Promise<number> {
    return [...this.listings.values()].filter((r) => r.userId === userId && r.status === 'active').length;
  }

  async countUserCreationsSince(userId: string, since: number): Promise<number> {
    return [...this.listings.values()].filter((r) => r.userId === userId && r.createdAt > since).length;
  }

  async deleteStaleUploading(before: number): Promise<number> {
    let n = 0;
    for (const [id, r] of this.listings) {
      if (r.status === 'uploading' && r.createdAt < before) {
        this.listings.delete(id);
        n++;
      }
    }
    return n;
  }
}

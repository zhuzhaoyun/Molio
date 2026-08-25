// apps/cloud/src/market/service.ts
// 资源市场服务：校验/限频/状态机/签发（设计 §五§六）。限频走 store 查询（同 auth 哲学）。
// 价格 Plan 1 恒 0；管理员定价为 Plan 2。
import {
  MARKET_ICONS, MARKET_TINTS,
  type MarketCreateRequest, type MarketCreateResponse, type MarketDownloadResponse,
  type MarketListing, type MarketMyListing, type MarketMyResponse, type MarketUploadTarget,
} from '@molio/contracts';
import { ulid } from '../crypto.js';
import type { AuthStore } from '../store/types.js';
import type { MarketListingRecord, MarketPendingUpdate, MarketStore } from '../store/market-types.js';
import type { OssSigner } from './signer.js';

export type MarketErrorCode =
  | 'invalid_metadata' | 'rate_limited' | 'too_many_active' | 'not_owner'
  | 'listing_not_found' | 'upload_incomplete' | 'size_exceeded';
export type MarketErrorStatus = 400 | 403 | 404 | 409 | 413 | 429;

export class MarketServiceError extends Error {
  constructor(public readonly code: MarketErrorCode, public readonly status: MarketErrorStatus,
    public readonly extra: Record<string, unknown> = {}) {
    super(code);
    this.name = 'MarketServiceError';
  }
}

export interface MarketConfig {
  maxZipMb: number;
  adminEmails: string[];
  maxActivePerUser: number;
  maxDailyCreates: number;
}

const MAX_NAME_CP = 30;
const MAX_TAG_CP = 10;
const MAX_SUMMARY_CP = 100;
const MAX_TAGS = 3;
const MAX_PREVIEWS = 4;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const UPLOAD_TTL_SEC = 60 * 60;
const DOWNLOAD_TTL_SEC = 60 * 60;
const LIST_LIMIT = 200;
const STALE_UPLOADING_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PREVIEW_EXT_CT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

const cpLen = (s: string): number => [...s].length;

export interface MarketServiceDeps {
  store: MarketStore;
  users: AuthStore;
  signer: OssSigner;
  config: { market: MarketConfig };
  now: () => number;
}

export class MarketService {
  constructor(private deps: MarketServiceDeps) {}

  private get now(): number { return this.deps.now(); }
  private get maxZipBytes(): number { return this.deps.config.market.maxZipMb * 1024 * 1024; }

  isAdminEmail(email: string): boolean {
    return this.deps.config.market.adminEmails.includes(email.trim().toLowerCase());
  }

  // ── 公开查询 ──

  async list(): Promise<MarketListing[]> {
    const recs = await this.deps.store.listActiveListings(LIST_LIMIT);
    return Promise.all(recs.map((r) => this.toPublic(r)));
  }

  async get(id: string): Promise<MarketListing> {
    const rec = await this.mustFind(id);
    if (rec.status !== 'active') throw new MarketServiceError('listing_not_found', 404);
    return this.toPublic(rec);
  }

  async my(userId: string, email: string): Promise<MarketMyResponse> {
    const recs = await this.deps.store.listUserListings(userId);
    const listings: MarketMyListing[] = [];
    for (const r of recs) listings.push(await this.toMy(r));
    return { isAdmin: this.isAdminEmail(email), listings };
  }

  // ── 创建 ──

  async create(userId: string, req: MarketCreateRequest): Promise<MarketCreateResponse> {
    const { store, config: { market } } = this.deps;
    this.validateMetadata(req);
    const user = await this.deps.users.findActiveUserById(userId);
    const admin = user !== null && this.isAdminEmail(user.email);
    if (!admin) {
      if ((await store.countActiveByUser(userId)) >= market.maxActivePerUser) {
        throw new MarketServiceError('too_many_active', 409);
      }
      if ((await store.countUserCreationsSince(userId, this.now - DAY_MS)) >= market.maxDailyCreates) {
        throw new MarketServiceError('rate_limited', 429);
      }
    }
    // 搭车清理僵尸上传行（孤儿对象靠后续对账脚本，设计 §十五）
    void store.deleteStaleUploading(this.now - STALE_UPLOADING_MS).catch(() => {});

    const id = ulid(this.now);
    const tint = req.tint && (MARKET_TINTS as readonly string[]).includes(req.tint)
      ? req.tint
      : MARKET_TINTS[(await store.countUserCreationsSince(userId, 0)) % MARKET_TINTS.length]!;
    const rec: MarketListingRecord = {
      id, userId, source: 'community',
      name: req.name.trim(), icon: req.icon, tint,
      summary: req.summary.trim(),
      overview: [], highlights: [],
      tags: [...new Set(req.tags.map((t) => t.trim()))].slice(0, MAX_TAGS), // 自定义允许，去重截断
      previews: req.previews.map((p, i) => `next/${id}-p${i + 1}${p.ext}`), // uploading 期存暂存键
      version: 'v1.0', priceCents: 0, payUrl: '', authorDisplay: null,
      ossKey: `resources/${id}-vault.zip`, fileSize: null,
      status: 'uploading', removedReason: null, pendingUpdate: null,
      createdAt: this.now, updatedAt: this.now, publishedAt: null,
    };
    await store.insertListing(rec);
    return { listingId: id, uploads: this.signUploads(rec), expiresAt: this.now + UPLOAD_TTL_SEC * 1000 };
  }

  private validateMetadata(req: MarketCreateRequest): void {
    const bad =
      typeof req.name !== 'string' || cpLen(req.name.trim()) < 1 || cpLen(req.name.trim()) > MAX_NAME_CP ||
      typeof req.summary !== 'string' || cpLen(req.summary.trim()) < 1 || cpLen(req.summary.trim()) > MAX_SUMMARY_CP ||
      !(MARKET_ICONS as readonly string[]).includes(req.icon) ||
      !Array.isArray(req.tags) ||
      req.tags.some((t) => typeof t !== 'string' || cpLen(t.trim()) < 1 || cpLen(t.trim()) > MAX_TAG_CP) ||
      !Array.isArray(req.previews) || req.previews.length < 1 || req.previews.length > MAX_PREVIEWS ||
      req.previews.some((p) => !(p.ext in PREVIEW_EXT_CT) || !(p.size > 0) || p.size > MAX_PREVIEW_BYTES) ||
      typeof req.vaultSize !== 'number' || !(req.vaultSize > 0) || req.vaultSize > this.maxZipBytes;
    if (bad) throw new MarketServiceError('invalid_metadata', 400);
  }

  private signUploads(rec: MarketListingRecord): MarketUploadTarget[] {
    const zip = this.deps.signer.signPut(`next/${rec.id}-vault.zip`, 'application/zip', UPLOAD_TTL_SEC);
    const imgs = rec.previews.map((key) => {
      const ext = key.slice(key.lastIndexOf('.'));
      return this.deps.signer.signPut(key, PREVIEW_EXT_CT[ext] ?? 'application/octet-stream', UPLOAD_TTL_SEC);
    });
    return [zip, ...imgs].map((t) => ({ key: t.key, url: t.url, contentType: t.contentType }));
  }

  // ── 确认（uploading=首发；active+pendingUpdate=更新版本）──

  async confirm(userId: string, listingId: string): Promise<MarketMyListing> {
    const rec = await this.mustFind(listingId);
    if (rec.userId !== userId) throw new MarketServiceError('not_owner', 403);
    if (rec.status === 'uploading') return this.confirmInitial(rec);
    if (rec.status === 'active' && rec.pendingUpdate) return this.confirmUpdate(rec);
    throw new MarketServiceError('upload_incomplete', 409);
  }

  private async confirmInitial(rec: MarketListingRecord): Promise<MarketMyListing> {
    const zip = await this.deps.signer.headObject(`next/${rec.id}-vault.zip`);
    if (!zip) throw new MarketServiceError('upload_incomplete', 409);
    for (const key of rec.previews) {
      if (!(await this.deps.signer.headObject(key))) throw new MarketServiceError('upload_incomplete', 409);
    }
    if (zip.size > this.maxZipBytes) throw new MarketServiceError('size_exceeded', 413);
    await this.deps.signer.copyObject(`next/${rec.id}-vault.zip`, rec.ossKey);
    const urls: string[] = [];
    for (let i = 0; i < rec.previews.length; i++) {
      const ext = rec.previews[i]!.slice(rec.previews[i]!.lastIndexOf('.'));
      const live = `resources/${rec.id}-p${i + 1}${ext}`;
      await this.deps.signer.copyObject(rec.previews[i]!, live, 'public-read');
      urls.push(`${this.deps.signer.baseUrl()}/${live}`);
    }
    const updated = await this.deps.store.updateListing(rec.id, {
      status: 'active', fileSize: zip.size, previews: urls, publishedAt: this.now,
    }, this.now);
    return this.toMy(updated!);
  }

  private async confirmUpdate(rec: MarketListingRecord): Promise<MarketMyListing> {
    const pend = rec.pendingUpdate!;
    const zip = await this.deps.signer.headObject(`next/${rec.id}-vault.zip`);
    if (!zip) throw new MarketServiceError('upload_incomplete', 409);
    if (zip.size > this.maxZipBytes) throw new MarketServiceError('size_exceeded', 413);
    for (const p of pend.previews) {
      if (!(await this.deps.signer.headObject(p.key))) throw new MarketServiceError('upload_incomplete', 409);
    }
    await this.deps.signer.copyObject(`next/${rec.id}-vault.zip`, rec.ossKey); // 覆盖 live zip
    let previews = rec.previews;
    if (pend.previews.length > 0) {
      const urls: string[] = [];
      for (let i = 0; i < pend.previews.length; i++) {
        const ext = pend.previews[i]!.key.slice(pend.previews[i]!.key.lastIndexOf('.'));
        const live = `resources/${rec.id}-p${i + 1}${ext}`;
        await this.deps.signer.copyObject(pend.previews[i]!.key, live, 'public-read');
        urls.push(`${this.deps.signer.baseUrl()}/${live}`);
      }
      const urlSet = new Set(urls);
      for (const old of rec.previews) { // 旧图尽力清理（含数量减少的残余）
        const oldKey = old.replace(/^https?:\/\/[^/]+\//, '');
        if (!urlSet.has(old)) void this.deps.signer.deleteObject(oldKey).catch(() => {});
      }
      previews = urls;
    }
    const updated = await this.deps.store.updateListing(rec.id, {
      version: bumpVersion(rec.version), previews, pendingUpdate: null,
    }, this.now);
    return this.toMy(updated!);
  }

  // ── 更新版本（发起）──

  async update(userId: string, listingId: string, input: { previews?: { ext: string; size: number }[] }): Promise<MarketCreateResponse> {
    const rec = await this.mustFind(listingId);
    if (rec.userId !== userId) throw new MarketServiceError('not_owner', 403);
    if (rec.status !== 'active') throw new MarketServiceError('listing_not_found', 404);
    const previews = input.previews ?? [];
    if (previews.length > MAX_PREVIEWS || previews.some((p) => !(p.ext in PREVIEW_EXT_CT) || !(p.size > 0) || p.size > MAX_PREVIEW_BYTES)) {
      throw new MarketServiceError('invalid_metadata', 400);
    }
    const pending: MarketPendingUpdate = {
      previews: previews.map((p, i) => ({ key: `next/${rec.id}-p${i + 1}${p.ext}` })),
    };
    await this.deps.store.updateListing(rec.id, { pendingUpdate: pending }, this.now);
    const zip = this.deps.signer.signPut(`next/${rec.id}-vault.zip`, 'application/zip', UPLOAD_TTL_SEC);
    const imgs = pending.previews.map((p) => {
      const ext = p.key.slice(p.key.lastIndexOf('.'));
      return this.deps.signer.signPut(p.key, PREVIEW_EXT_CT[ext] ?? 'application/octet-stream', UPLOAD_TTL_SEC);
    });
    return {
      listingId: rec.id,
      uploads: [zip, ...imgs].map((t) => ({ key: t.key, url: t.url, contentType: t.contentType })),
      expiresAt: this.now + UPLOAD_TTL_SEC * 1000,
    };
  }

  // ── 下载（登录门槛核心）──

  async download(_userId: string, listingId: string): Promise<MarketDownloadResponse> {
    const rec = await this.mustFind(listingId);
    if (rec.status !== 'active') throw new MarketServiceError('listing_not_found', 404);
    const filename = `${encodeURIComponent(rec.name)}-vault.zip`;
    const t = this.deps.signer.signGet(rec.ossKey, DOWNLOAD_TTL_SEC, `attachment; filename*=UTF-8''${filename}`);
    return { url: t.url, expiresAt: t.expiresAt };
  }

  // ── 下架 / 恢复 / 管理员 / 注销连坐 ──

  async remove(userId: string, listingId: string): Promise<{ ok: true }> {
    const rec = await this.mustFind(listingId);
    if (rec.userId !== userId) throw new MarketServiceError('not_owner', 403);
    await this.deps.store.updateListing(rec.id, { status: 'removed', removedReason: 'owner' }, this.now);
    return { ok: true };
  }

  async adminRemove(adminEmail: string, listingId: string, reason?: string): Promise<{ ok: true }> {
    this.assertAdmin(adminEmail);
    await this.mustFind(listingId);
    await this.deps.store.updateListing(listingId, {
      status: 'removed', removedReason: `admin:${adminEmail}${reason ? `:${reason}` : ''}`,
    }, this.now);
    return { ok: true };
  }

  async restore(adminEmail: string, listingId: string): Promise<{ ok: true }> {
    this.assertAdmin(adminEmail);
    const rec = await this.mustFind(listingId);
    if (rec.status !== 'removed') throw new MarketServiceError('listing_not_found', 404);
    if (!(await this.deps.signer.headObject(rec.ossKey))) {
      throw new MarketServiceError('upload_incomplete', 409); // 对象缺失，需走更新版本重传
    }
    await this.deps.store.updateListing(rec.id, { status: 'active', removedReason: null }, this.now);
    return { ok: true };
  }

  /** restore 的管理员别名（brief Interfaces 与下游路由契约均列 adminRestore） */
  async adminRestore(adminEmail: string, listingId: string): Promise<{ ok: true }> {
    return this.restore(adminEmail, listingId);
  }

  async adminList(adminEmail: string): Promise<Array<{ listing: MarketMyListing; ownerEmail: string | null }>> {
    this.assertAdmin(adminEmail);
    const rows = await this.deps.store.listAllWithOwner();
    const out: Array<{ listing: MarketMyListing; ownerEmail: string | null }> = [];
    for (const r of rows) out.push({ listing: await this.toMy(r.listing), ownerEmail: r.ownerEmail });
    return out;
  }

  async cascadeRemoveUser(userId: string): Promise<void> {
    const recs = await this.deps.store.listUserListings(userId);
    for (const r of recs) {
      if (r.status === 'active') {
        await this.deps.store.updateListing(r.id, { status: 'removed', removedReason: 'account_deleted' }, this.now);
      }
    }
  }

  private assertAdmin(email: string): void {
    if (!this.isAdminEmail(email)) throw new MarketServiceError('not_owner', 403);
  }

  private async mustFind(id: string): Promise<MarketListingRecord> {
    const rec = await this.deps.store.findListingById(id);
    if (!rec) throw new MarketServiceError('listing_not_found', 404);
    return rec;
  }

  private async toPublic(rec: MarketListingRecord): Promise<MarketListing> {
    const u = await this.deps.users.findActiveUserById(rec.userId);
    return {
      id: rec.id, source: rec.source, name: rec.name, icon: rec.icon, tint: rec.tint,
      summary: rec.summary, overview: rec.overview, highlights: rec.highlights, tags: rec.tags,
      previews: rec.previews, version: rec.version, priceCents: rec.priceCents, payUrl: rec.payUrl,
      author: rec.authorDisplay ?? u?.nickname ?? '墨友',
      fileSize: rec.fileSize,
      publishedAt: rec.publishedAt === null ? null : new Date(rec.publishedAt).toISOString(),
    };
  }

  private async toMy(rec: MarketListingRecord): Promise<MarketMyListing> {
    const u = await this.deps.users.findActiveUserById(rec.userId);
    return {
      ...(await this.toPublic(rec)),
      author: rec.authorDisplay ?? u?.nickname ?? '墨友',
      status: rec.status, removedReason: rec.removedReason,
    };
  }
}

function bumpVersion(v: string): string {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return 'v1.1';
  const [, maj, min, patch] = m;
  return patch !== undefined ? `v${maj}.${min}.${Number(patch) + 1}` : `v${maj}.${Number(min) + 1}`;
}

// apps/cloud/src/store/market-pg.ts
// PgMarketStore：语义与 MemoryMarketStore 逐条对齐（§资源市场设计）。
// JSONB 列（overview/highlights/tags/previews）出入参均为字符串数组；
// 时间列 TIMESTAMPTZ ↔ epoch 毫秒，同 PgAuthStore 约定。
import type { Pool } from 'pg';
import type { MarketListingRecord, MarketStore } from './market-types.js';

type Row = {
  id: string; user_id: string; source: string; name: string; icon: string; tint: string;
  summary: string; overview: string[]; highlights: string[]; tags: string[]; previews: string[];
  version: string; price_cents: number; pay_url: string; author_display: string | null;
  oss_key: string; file_size: string | null; status: string; removed_reason: string | null;
  created_at: Date; updated_at: Date; published_at: Date | null; owner_email?: string | null;
};

function fromRow(r: Row): MarketListingRecord {
  return {
    id: r.id, userId: r.user_id, source: r.source as MarketListingRecord['source'],
    name: r.name, icon: r.icon, tint: r.tint, summary: r.summary,
    overview: r.overview ?? [], highlights: r.highlights ?? [], tags: r.tags ?? [], previews: r.previews ?? [],
    version: r.version, priceCents: r.price_cents, payUrl: r.pay_url, authorDisplay: r.author_display,
    ossKey: r.oss_key, fileSize: r.file_size === null ? null : Number(r.file_size),
    status: r.status as MarketListingRecord['status'], removedReason: r.removed_reason,
    createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(),
    publishedAt: r.published_at === null ? null : r.published_at.getTime(),
  };
}

const SELECT_COLS = `id, user_id, source, name, icon, tint, summary, overview, highlights, tags,
  previews, version, price_cents, pay_url, author_display, oss_key, file_size, status,
  removed_reason, created_at, updated_at, published_at`;

export class PgMarketStore implements MarketStore {
  constructor(private pool: Pool) {}

  async insertListing(rec: MarketListingRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_listings (id, user_id, source, name, icon, tint, summary, overview,
        highlights, tags, previews, version, price_cents, pay_url, author_display, oss_key,
        file_size, status, removed_reason, created_at, updated_at, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        to_timestamp($20/1000.0), to_timestamp($21/1000.0),
        CASE WHEN $22::bigint IS NULL THEN NULL ELSE to_timestamp($22/1000.0) END)`,
      [rec.id, rec.userId, rec.source, rec.name, rec.icon, rec.tint, rec.summary,
        JSON.stringify(rec.overview), JSON.stringify(rec.highlights), JSON.stringify(rec.tags),
        JSON.stringify(rec.previews), rec.version, rec.priceCents, rec.payUrl, rec.authorDisplay,
        rec.ossKey, rec.fileSize, rec.status, rec.removedReason, rec.createdAt, rec.updatedAt, rec.publishedAt],
    );
  }

  async findListingById(id: string): Promise<MarketListingRecord | null> {
    const res = await this.pool.query(`SELECT ${SELECT_COLS} FROM market_listings WHERE id = $1`, [id]);
    return res.rows[0] ? fromRow(res.rows[0] as Row) : null;
  }

  async updateListing(
    id: string,
    patch: Partial<Pick<MarketListingRecord,
      'status' | 'removedReason' | 'fileSize' | 'version' | 'previews' | 'ossKey' | 'publishedAt'>>,
    now: number,
  ): Promise<MarketListingRecord | null> {
    // 动态 SET 拼接：字段白名单固定，参数化防注入
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.removedReason !== undefined) add('removed_reason', patch.removedReason);
    if (patch.fileSize !== undefined) add('file_size', patch.fileSize);
    if (patch.version !== undefined) add('version', patch.version);
    if (patch.previews !== undefined) add('previews', JSON.stringify(patch.previews));
    if (patch.ossKey !== undefined) add('oss_key', patch.ossKey);
    if (patch.publishedAt !== undefined) {
      args.push(patch.publishedAt);
      sets.push(`published_at = to_timestamp($${args.length}/1000.0)`);
    }
    args.push(now);
    sets.push(`updated_at = to_timestamp($${args.length}/1000.0)`);
    args.push(id);
    const res = await this.pool.query(
      `UPDATE market_listings SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING ${SELECT_COLS}`,
      args,
    );
    return res.rows[0] ? fromRow(res.rows[0] as Row) : null;
  }

  async listActiveListings(limit: number): Promise<MarketListingRecord[]> {
    const res = await this.pool.query(
      `SELECT ${SELECT_COLS} FROM market_listings WHERE status = 'active'
       ORDER BY published_at DESC NULLS LAST LIMIT $1`, [limit]);
    return res.rows.map((r: Row) => fromRow(r));
  }

  async listUserListings(userId: string): Promise<MarketListingRecord[]> {
    const res = await this.pool.query(
      `SELECT ${SELECT_COLS} FROM market_listings WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return res.rows.map((r: Row) => fromRow(r));
  }

  async listAllWithOwner(): Promise<Array<{ listing: MarketListingRecord; ownerEmail: string | null }>> {
    const res = await this.pool.query(
      `SELECT m.*, u.email AS owner_email FROM market_listings m
       LEFT JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
       ORDER BY m.created_at DESC`);
    return res.rows.map((r: Row) => ({ listing: fromRow(r), ownerEmail: r.owner_email ?? null }));
  }

  async countActiveByUser(userId: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT count(*)::int AS n FROM market_listings WHERE user_id = $1 AND status = 'active'`, [userId]);
    return (res.rows[0] as { n: number }).n;
  }

  async countUserCreationsSince(userId: string, since: number): Promise<number> {
    const res = await this.pool.query(
      `SELECT count(*)::int AS n FROM market_listings WHERE user_id = $1 AND created_at > to_timestamp($2/1000.0)`,
      [userId, since]);
    return (res.rows[0] as { n: number }).n;
  }

  async deleteStaleUploading(before: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM market_listings WHERE status = 'uploading' AND created_at < to_timestamp($1/1000.0)`, [before]);
    return res.rowCount ?? 0;
  }
}

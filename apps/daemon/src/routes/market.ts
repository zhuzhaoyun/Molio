// apps/daemon/src/routes/market.ts
// /api/market/*：云端市场镜像 + 发布编排（设计 §7.1）。纪律同 routes/auth.ts：
// daemon 是唯一云端通信方；写端点过 Origin 白名单 + Content-Length 尺寸闸门。
import { Hono, type Context } from 'hono';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { AuthCloudError, type AuthClient } from '../core/auth/auth-client.js';
import { MarketClient, putToSignedUrl } from '../core/market/client.js';
import { packVaultToZip } from '../core/market/packager.js';
import { denyCrossOrigin } from './auth.js';
import type { MarketPublishSuggestion } from '@molio/contracts';
import { suggestPublishMeta } from '../core/market/suggest.js';

/** multipart body 闸门（效果图 1-4×≤5MB + 表单字段，32MB 已宽裕） */
const MAX_MULTIPART_BYTES = 32 * 1024 * 1024;
/** 单张效果图上限 */
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
/** 打包后 zip 上限（与云端 confirm 实测口径一致的声明值约束） */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
/** Plan 2 预留：管理员直传 zip 的 body 闸门（当前未启用） */
export const MAX_ADMIN_DIRECT_ZIP_BYTES = 70 * 1024 * 1024;
/** publish-suggest 的 JSON body 闸门（仅 vaultId 字段，64KB 已宽裕） */
const MAX_SUGGEST_BODY_BYTES = 64 * 1024;

/** 表单 price（元字符串）→ 分；空/非法/≤0 → undefined（免费）。云端对非管理员再强制 0。 */
function parsePriceCents(raw: unknown): number | undefined {
  const v = Number(typeof raw === 'string' && raw.trim() !== '' ? raw : NaN);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : undefined;
}

export interface MarketRoutesOptions {
  /** 测试注入：覆盖云端请求与 OSS 直传的 fetch */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** 测试注入：覆盖发布元数据起草（默认走真实一次性 agent 调用） */
  suggestImpl?: (vaultPath: string) => Promise<MarketPublishSuggestion>;
}

export function marketRoutes(db: Database.Database, auth: AuthClient, opts: MarketRoutesOptions = {}): Hono {
  const client = new MarketClient(auth, opts.baseUrl, opts.fetchImpl);
  const putDirect = (t: { url: string; contentType: string }, b: Uint8Array) => putToSignedUrl(t, b, opts.fetchImpl);
  const app = new Hono();
  const suggestFn = opts.suggestImpl ?? ((vaultPath: string) => suggestPublishMeta(vaultPath));

  // 云端错误归一（同 routes/auth.ts 纪律）：
  // 断网/无会话（status=0）→ 502 cloud_unreachable；白名单 4xx 原样透传；其余 → 502。
  // 本地编排错误：zip_too_large → 413；vault_not_found → 400；兜底 publish_failed/500。
  const cloudError = (c: Context, e: unknown): Response => {
    if (e instanceof AuthCloudError) {
      if (e.status === 0) return c.json({ error: 'cloud_unreachable' }, 502);
      if (e.status === 400 || e.status === 401 || e.status === 402 || e.status === 403 || e.status === 404 || e.status === 409 || e.status === 413 || e.status === 429) {
        return c.json({ error: e.code, ...e.extra }, e.status);
      }
      return c.json({ error: e.code }, 502);
    }
    const msg = e instanceof Error ? e.message : 'publish_failed';
    if (msg.startsWith('zip_too_large')) return c.json({ error: 'zip_too_large' }, 413);
    if (msg.startsWith('vault_not_found')) return c.json({ error: 'vault_not_found' }, 400);
    return c.json({ error: 'publish_failed' }, 500);
  };

  /** Content-Length 尺寸闸门（阈值参数化，先于 body 缓冲，同 routes/auth.ts 的 OOM 防护） */
  const denyOversized = (c: Context, max: number): Response | null => {
    const len = Number(c.req.header('content-length') ?? '0');
    if (!Number.isFinite(len) || len < 0 || len > max) return c.json({ error: 'payload_too_large' }, 413);
    return null;
  };

  // ── 读侧：公开数据透传 + 离线缓存 ──

  app.get('/listings', async (c) => {
    try {
      const body = await client.list();
      db.prepare(`INSERT INTO market_cache (key, json, fetched_at) VALUES ('listings', ?, ?)
        ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
        .run(JSON.stringify(body.listings), Date.now());
      return c.json({ listings: body.listings, stale: false });
    } catch (e) {
      if (e instanceof AuthCloudError && e.status === 0) {
        const row = db.prepare("SELECT json FROM market_cache WHERE key = 'listings'").get() as { json: string } | undefined;
        return c.json({ listings: row ? (JSON.parse(row.json) as unknown[]) : [], stale: true });
      }
      return cloudError(c, e);
    }
  });

  app.get('/listings/:id', async (c) => {
    try { return c.json(await client.get(c.req.param('id'))); } catch (e) { return cloudError(c, e); }
  });
  app.get('/listings/:id/download', async (c) => {
    try { return c.json(await client.download(c.req.param('id'))); } catch (e) { return cloudError(c, e); }
  });
  app.get('/my', async (c) => {
    try { return c.json(await client.my()); } catch (e) { return cloudError(c, e); }
  });

  // ── 写侧：multipart 编排 ──

  /** 效果图本地预检：魔数 + 单张 ≤5MB + 张数 1-4（设计 §7.1） */
  const checkPreviews = async (files: File[]): Promise<Array<{ buf: Uint8Array; ext: string; size: number }>> => {
    if (files.length < 1 || files.length > 4) throw new AuthCloudError(400, 'invalid_previews');
    const out: Array<{ buf: Uint8Array; ext: string; size: number }> = [];
    for (const f of files) {
      if (f.size > MAX_PREVIEW_BYTES) throw new AuthCloudError(400, 'preview_too_large');
      const buf = new Uint8Array(await f.arrayBuffer());
      const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const isWebp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46;
      const ext = isPng ? '.png' : isJpg ? '.jpg' : isWebp ? '.webp' : null;
      if (!ext) throw new AuthCloudError(400, 'preview_bad_type');
      out.push({ buf, ext, size: f.size });
    }
    return out;
  };

  const vaultPathOf = (vaultId: string): string | null => {
    const row = db.prepare('SELECT path FROM vaults WHERE id = ?').get(vaultId) as { path: string } | undefined;
    return row?.path ?? null;
  };

  // 发布：本地校验 → 打包 → create → PUT 直传（zip + 图）→ confirm → market_local 落映射。
  // 中途失败且已 create → 尽力 DELETE 清理；无论成败 finally dispose 临时 zip。
  app.post('/publish', async (c) => {
    const denied = denyCrossOrigin(c) ?? denyOversized(c, MAX_MULTIPART_BYTES);
    if (denied) return denied;
    const parsed = await c.req.parseBody({ all: true }).catch(() => null);
    if (!parsed) return c.json({ error: 'invalid_body' }, 400);
    const str = (k: string): string => (typeof parsed[k] === 'string' ? (parsed[k] as string) : '');
    const vaultId = str('vaultId');
    const vaultPath = vaultPathOf(vaultId);
    if (!vaultPath) return c.json({ error: 'vault_not_found' }, 400);
    const previewFiles = (Array.isArray(parsed['previews']) ? parsed['previews'] : parsed['previews'] ? [parsed['previews']] : []) as File[];
    let previews: Array<{ buf: Uint8Array; ext: string; size: number }>;
    try { previews = await checkPreviews(previewFiles); } catch (e) { return cloudError(c, e); }

    let pack: Awaited<ReturnType<typeof packVaultToZip>> | null = null;
    let listingId: string | null = null;
    try {
      let include: string[] | undefined;
      try { include = JSON.parse(str('include') || '[]') as string[]; } catch { /* 非法 include 按空 */ }
      pack = await packVaultToZip(vaultPath, { maxBytes: MAX_ZIP_BYTES, include: include?.length ? include : undefined });
      let tags: string[] = [];
      try { tags = JSON.parse(str('tags') || '[]') as string[]; } catch { /* 非法 tags 按空，云端再兜底 */ }
      const created = await client.create({
        name: str('name'), summary: str('summary'), icon: str('icon'), tags,
        vaultSize: pack.size, previews: previews.map((p) => ({ ext: p.ext, size: p.size })),
        priceCents: parsePriceCents(parsed['price']), payUrl: str('payUrl') || undefined,
      });
      listingId = created.listingId;
      await putDirect(created.uploads[0]!, new Uint8Array(fs.readFileSync(pack.zipPath)));
      for (let i = 0; i < previews.length; i++) await putDirect(created.uploads[i + 1]!, previews[i]!.buf);
      const listing = await client.confirm(created.listingId);
      db.prepare('INSERT OR REPLACE INTO market_local (listing_id, vault_id, created_at) VALUES (?, ?, ?)')
        .run(created.listingId, vaultId, Date.now());
      return c.json({ listing });
    } catch (e) {
      console.error('[market.publish] failed:', e); // 定位用：打印真实错误（oss_put_failed 状态等）
      if (listingId) await client.remove(listingId).catch(() => {}); // 已创建的尽力清理
      return cloudError(c, e);
    } finally {
      pack?.dispose();
    }
  });

  // 发布元数据起草（AI 一次性生成）：JSON {vaultId} → MarketPublishSuggestion。
  // 纯 daemon 本地 agent 调用，不走云端、不要求登录会话；一切失败都归一为错误码，
  // 前端静默回落手填，绝不阻断发布主流程。
  app.post('/publish-suggest', async (c) => {
    const denied = denyCrossOrigin(c) ?? denyOversized(c, MAX_SUGGEST_BODY_BYTES);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null) as { vaultId?: unknown } | null;
    const vaultId = body && typeof body['vaultId'] === 'string' ? body['vaultId'] : '';
    const vaultPath = vaultId ? vaultPathOf(vaultId) : null;
    if (!vaultPath) return c.json({ error: 'vault_not_found' }, 400);
    try {
      return c.json(await suggestFn(vaultPath));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'suggest_failed';
      if (msg.startsWith('suggest_unavailable')) return c.json({ error: 'suggest_unavailable' }, 503);
      if (msg.startsWith('suggest_timeout')) return c.json({ error: 'suggest_timeout' }, 504);
      return c.json({ error: 'suggest_failed' }, 502);
    }
  });
  // 更新：vaultId 缺省回退 market_local 记录；不传效果图 = 沿用旧图。
  app.post('/listings/:id/update', async (c) => {
    const denied = denyCrossOrigin(c) ?? denyOversized(c, MAX_MULTIPART_BYTES);
    if (denied) return denied;
    const id = c.req.param('id');
    const parsed = await c.req.parseBody({ all: true }).catch(() => null);
    const bodyVaultId = parsed && typeof parsed['vaultId'] === 'string' && parsed['vaultId'] !== '' ? parsed['vaultId'] : null;
    const local = db.prepare('SELECT vault_id FROM market_local WHERE listing_id = ?').get(id) as { vault_id: string } | undefined;
    const vaultId = bodyVaultId ?? local?.vault_id ?? null;
    const vaultPath = vaultId ? vaultPathOf(vaultId) : null;
    if (!vaultId || !vaultPath) return c.json({ error: 'vault_not_found' }, 400);
    const previewFiles = parsed ? ((Array.isArray(parsed['previews']) ? parsed['previews'] : parsed['previews'] ? [parsed['previews']] : []) as File[]) : [];

    let pack: Awaited<ReturnType<typeof packVaultToZip>> | null = null;
    try {
      let include: string[] | undefined;
      try { include = JSON.parse(parsed && typeof parsed['include'] === 'string' ? parsed['include'] : '[]') as string[]; } catch { /* ignore */ }
      pack = await packVaultToZip(vaultPath, { maxBytes: MAX_ZIP_BYTES, include: include?.length ? include : undefined });
      const previews = previewFiles.length > 0 ? await checkPreviews(previewFiles) : []; // 不传 = 沿用旧图
      const upd = await client.update(
        id,
        previews.map((p) => ({ ext: p.ext, size: p.size })),
        { priceCents: parsePriceCents(parsed?.['price']), payUrl: (typeof parsed?.['payUrl'] === 'string' && parsed['payUrl']) ? parsed['payUrl'] : undefined },
      );
      await putDirect(upd.uploads[0]!, new Uint8Array(fs.readFileSync(pack.zipPath)));
      for (let i = 0; i < previews.length; i++) await putDirect(upd.uploads[i + 1]!, previews[i]!.buf);
      const listing = await client.confirm(id);
      if (bodyVaultId) {
        db.prepare('INSERT OR REPLACE INTO market_local (listing_id, vault_id, created_at) VALUES (?, ?, ?)').run(id, bodyVaultId, Date.now());
      }
      return c.json({ listing });
    } catch (e) {
      return cloudError(c, e);
    } finally {
      pack?.dispose();
    }
  });

  // 下架：云端 remove + 删 market_local 映射（云端权威，失败不清本地）。
  app.delete('/listings/:id', async (c) => {
    const denied = denyCrossOrigin(c);
    if (denied) return denied;
    const id = c.req.param('id');
    try {
      await client.remove(id);
      db.prepare('DELETE FROM market_local WHERE listing_id = ?').run(id);
      return c.json({ ok: true });
    } catch (e) { return cloudError(c, e); }
  });

  return app;
}

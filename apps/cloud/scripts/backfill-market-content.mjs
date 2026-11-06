#!/usr/bin/env node
/**
 * 将 content/market/<listingId>.json 回填到 market_listings.content（JSONB）。
 *
 * 用法（仓库根目录）：
 *   DATABASE_URL="postgres://..." node apps/cloud/scripts/backfill-market-content.mjs
 *   DATABASE_URL="postgres://..." node apps/cloud/scripts/backfill-market-content.mjs --dry-run
 *   DATABASE_URL="postgres://..." node apps/cloud/scripts/backfill-market-content.mjs --id 01M4PZPNGWR1YZ1W9GGVTJG82N
 *
 * 只更新已存在的 listing；不会创建/删除商品。content 为 null 时跳过。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const contentDir = path.join(root, 'content', 'market');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const idArgIndex = process.argv.indexOf('--id');
const onlyId = idArgIndex >= 0 ? process.argv[idArgIndex + 1] : null;

function fail(msg) {
  console.error('[backfill-content] ' + msg);
  process.exit(1);
}

function validateShape(id, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(id + ': not an object');
  if (data.version !== 1) throw new Error(id + ': version must be 1');
  if (!data.positioning || typeof data.positioning.what !== 'string' || !data.positioning.what.trim()) throw new Error(id + ': positioning.what required');
  if (!Array.isArray(data.facts) || data.facts.length === 0) throw new Error(id + ': facts required');
  if (!Array.isArray(data.themes) || data.themes.length === 0) throw new Error(id + ': themes required');
  if (!Array.isArray(data.questions)) throw new Error(id + ': questions must be an array');
  if (!data.delivery || typeof data.delivery.format !== 'string') throw new Error(id + ': delivery.format required');
  if (!data.review || typeof data.review.basis !== 'string' || typeof data.review.reviewedAt !== 'string') throw new Error(id + ': review required');
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  if (bytes > 60_000) throw new Error(id + ': content too large (' + bytes + ' bytes)');
  return bytes;
}

function loadFiles() {
  if (!readdirSync(contentDir).length) fail('no content files in ' + contentDir);
  return readdirSync(contentDir)
    .filter((name) => name.endsWith('.json') && name !== 'product-map.json')
    .filter((name) => !onlyId || name === onlyId + '.json')
    .map((name) => {
      const id = name.slice(0, -'.json'.length);
      const file = path.join(contentDir, name);
      const raw = readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      const bytes = validateShape(id, data);
      return { id, file, data, bytes };
    });
}

const files = loadFiles();
if (files.length === 0) fail('no matching content files' + (onlyId ? ' for ' + onlyId : ''));
console.log('[backfill-content] files:', files.length);
for (const f of files) console.log('  -', f.id, f.bytes + ' bytes', f.data.review.status);

if (dryRun) {
  console.log('[backfill-content] dry run: ok');
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) fail('DATABASE_URL is required (or pass --dry-run)');

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
try {
  await client.connect();
  await client.query('BEGIN');
  let updated = 0;
  let missing = 0;
  for (const f of files) {
    const res = await client.query(
      `UPDATE market_listings
       SET content = $1::jsonb, updated_at = now()
       WHERE id = $2
       RETURNING id, name, status`,
      [JSON.stringify(f.data), f.id],
    );
    if (res.rowCount === 0) {
      missing++;
      console.warn('[backfill-content] missing listing:', f.id);
    } else {
      updated++;
      console.log('[backfill-content] updated:', f.id, '|', res.rows[0].name, '|', res.rows[0].status);
    }
  }
  await client.query('COMMIT');
  console.log('[backfill-content] done. updated=' + updated + ' missing=' + missing);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('[backfill-content] failed:', err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

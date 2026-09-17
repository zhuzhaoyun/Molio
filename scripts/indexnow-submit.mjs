#!/usr/bin/env node
/**
 * IndexNow 批量提交（Bing / Yandex / Seznam / Naver）。
 *
 * 两个用途：
 * 1. **首次回填**：上线时把 sitemap 里已有的全部 URL 一次性推给 Bing，不必等爬虫自己发现。
 * 2. **补推**：日常由 apps/cloud 在商品上架时自动推（见 src/indexnow.ts）；
 *    若那次推送失败（网络、超时），用这个脚本重推。
 *
 * 用法：
 *   node scripts/indexnow-submit.mjs                  # 推 sitemap.xml 里全部 URL
 *   node scripts/indexnow-submit.mjs <url> [url...]   # 只推指定 URL
 *   INDEXNOW_DRY=1 node scripts/indexnow-submit.mjs   # 只打印不提交
 *
 * key 的来源刻意是 **landing-page 目录里那个待部署的 txt 文件**，而不是代码常量：
 * 协议要求「文件内容 == 文件名 == 提交用的 key」，从即将被 nginx 直接吐出去的那份文件
 * 反读，就不会出现「代码里的 key 和线上文件不一致」这种最难查的静默失败。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANDING_PAGE_DIR = join(REPO_ROOT, 'apps', 'landing-page');

const ORIGIN = (process.env.INDEXNOW_HOST ?? 'https://molio.cn').replace(/\/+$/, '');
const HOST = new URL(ORIGIN).host;
const ENDPOINT = process.env.INDEXNOW_ENDPOINT ?? 'https://api.indexnow.org/indexnow';
const DRY = process.env.INDEXNOW_DRY === '1';
/** 协议上限 10,000；保守取 500，避免单次请求体过大被网关截断 */
const BATCH = 500;

function readKey() {
  for (const file of readdirSync(LANDING_PAGE_DIR)) {
    const match = /^([0-9a-f]{32})\.txt$/.exec(file);
    if (!match) continue;
    const content = readFileSync(join(LANDING_PAGE_DIR, file), 'utf8').trim();
    // 文件名与内容必须一致，否则 IndexNow 会以 403 拒绝
    if (content === match[1]) return match[1];
    throw new Error(`${file} 的内容与文件名不一致（内容=${JSON.stringify(content)}）`);
  }
  throw new Error(`在 apps/landing-page 找不到 <32位hex>.txt 形式的 IndexNow key 文件`);
}

/** 把 sitemap（或 sitemap index）展开成 URL 列表，递归一层够用 */
async function collectSitemapUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`拉取 ${sitemapUrl} 失败：HTTP ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (/<sitemapindex/.test(xml)) {
    const nested = await Promise.all(locs.map((u) => collectSitemapUrls(u)));
    return nested.flat();
  }
  return locs;
}

function normalize(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    let u;
    try {
      u = new URL(raw, ORIGIN);
    } catch {
      continue;
    }
    if (u.host !== HOST) continue; // 外站 URL 会使整批被 422 拒掉
    u.hash = '';
    const s = u.toString();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function submitBatch(key, urlList) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key, keyLocation: `${ORIGIN}/${key}.txt`, urlList }),
  });
  // 200/202 = 成功（202 表示已受理，key 校验异步）；403 多为 key 文件未部署或内容不匹配
  return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 300) };
}

async function main() {
  const argUrls = process.argv.slice(2);
  const key = readKey();

  const raw = argUrls.length > 0 ? argUrls : await collectSitemapUrls(`${ORIGIN}/sitemap.xml`);
  const urls = normalize(raw);

  console.log(`[indexnow] host=${HOST} key=${key.slice(0, 8)}… 待提交 ${urls.length} 条`);
  if (urls.length === 0) return;
  if (DRY) {
    for (const u of urls) console.log(`  (dry) ${u}`);
    return;
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    const r = await submitBatch(key, batch);
    if (r.ok) {
      ok += batch.length;
      console.log(`[indexnow] 批次 ${i / BATCH + 1}：${batch.length} 条 → HTTP ${r.status}`);
    } else {
      failed += batch.length;
      console.error(`[indexnow] 批次 ${i / BATCH + 1} 失败：HTTP ${r.status} ${r.text}`);
    }
  }
  console.log(`[indexnow] 完成：成功 ${ok} 条，失败 ${failed} 条`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[indexnow] 出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

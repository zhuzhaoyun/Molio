// 商品页内链校验（node:test）。
//
// 商品页由云端 SSR 动态渲染，ID 在商品库里、不在仓库；但博客文章里指向
// 商品页的内链是手写的（博客是站内唯一有自然搜索曝光的内容页，靠它把
// 流量与权重导向商品页）。手写链接有两个会静默失效的点，用测试钉住：
//   1. ID 写歪 → 线上 404，而推荐区块在文末，没人会点到底
//   2. blog/ 下漏了 ../ → 解析成 /blog/resource/xxx.html，同样 404
// 运行：node --test apps/landing-page/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const LANDING_PAGE = path.join(here, '..');

// ULID：Crockford Base32（26 位，排除易混淆的 I / L / O / U）
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

function htmlFiles(dir, recursive = false) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return recursive ? htmlFiles(full, true) : [];
    return entry.name.endsWith('.html') ? [full] : [];
  });
}

// 抽商品页内链，返回 { href, id }
// 先剥掉 <script>：JS 模板里拼出来的 href 不是静态内链，爬虫也读不到
function productLinks(file) {
  const html = readFileSync(file, 'utf8').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  return [...html.matchAll(/href="([^"]*?resource\/([^"/]+)\.html)"/g)].map((m) => ({
    href: m[1],
    id: m[2],
  }));
}

const rel = (file) => path.relative(LANDING_PAGE, file).replace(/\\/g, '/');
const blogPages = () => htmlFiles(path.join(LANDING_PAGE, 'blog'), true);

test('内链：商品页 ID 必须是合法 ULID', () => {
  const bad = [];
  for (const file of [...htmlFiles(LANDING_PAGE), ...blogPages()]) {
    for (const { id } of productLinks(file)) {
      if (!ULID.test(id)) bad.push(`${rel(file)} → ${id}`);
    }
  }
  assert.deepEqual(bad, [], `以下商品页内链的 ID 不是合法 ULID：\n${bad.join('\n')}`);
});

test('内链：blog/ 下的商品页相对路径必须带 ../', () => {
  const bad = [];
  for (const file of blogPages()) {
    for (const { href } of productLinks(file)) {
      if (!href.startsWith('../resource/')) bad.push(`${rel(file)} → ${href}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `blog/ 下的商品页链接漏了 ../，线上会 404（实际解析成 /blog/resource/...）：\n${bad.join('\n')}`,
  );
});

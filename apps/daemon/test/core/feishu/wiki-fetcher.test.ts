import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  extractFeishuDocUrls,
  fetchWikiContent,
  isFetchable,
  materializeWikiLinks,
  tenantHost,
  urlDocType,
} from '../../../src/core/feishu/wiki-fetcher.js';

describe('extractFeishuDocUrls', () => {
  it('matches wiki URLs across tenants (feishu.cn + larksuite.com)', () => {
    const text =
      '看下这两篇：https://geekbang.feishu.cn/wiki/LRoAwfFPHiFtAJkkDk1c426Vnuh 和 https://acme.larksuite.com/wiki/ABC123xyz';
    const urls = extractFeishuDocUrls(text);
    assert.equal(urls.length, 2);
    assert.ok(urls[0] && urls[0].includes('geekbang.feishu.cn/wiki/'));
    assert.ok(urls[1] && urls[1].includes('acme.larksuite.com/wiki/'));
  });

  it('matches docx URLs', () => {
    const urls = extractFeishuDocUrls('https://open.feishu.cn/docx/AbC123XyZ');
    assert.equal(urls.length, 1);
    assert.equal(urls[0], 'https://open.feishu.cn/docx/AbC123XyZ');
  });

  it('matches sheets/base/slides URLs (for prompt-only fallback)', () => {
    const text =
      'https://geekbang.feishu.cn/sheets/ABC123 https://acme.feishu.cn/base/DEF456';
    const urls = extractFeishuDocUrls(text);
    assert.equal(urls.length, 2);
  });

  it('does NOT match mp.weixin or unrelated feishu URLs', () => {
    const text =
      'https://mp.weixin.qq.com/s/abc https://geekbang.feishu.cn/messenger/xyz https://www.feishu.cn';
    const urls = extractFeishuDocUrls(text);
    assert.equal(urls.length, 0);
  });

  it('dedups repeated URLs preserving first-seen order', () => {
    const text = 'https://geekbang.feishu.cn/wiki/Xyz first; https://geekbang.feishu.cn/wiki/Xyz second';
    const urls = extractFeishuDocUrls(text);
    assert.equal(urls.length, 1);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(extractFeishuDocUrls(''), []);
    assert.deepEqual(extractFeishuDocUrls('no urls here'), []);
  });

  it('trims trailing punctuation (Chinese + ASCII)', () => {
    const text = '看 https://geekbang.feishu.cn/wiki/AbC123，再看一下。';
    const urls = extractFeishuDocUrls(text);
    assert.equal(urls.length, 1);
    assert.ok(urls[0] && !urls[0].endsWith('，'));
    assert.ok(urls[0] && !urls[0].endsWith('。'));
  });

  it('strips trailing ASCII punctuation the regex char-class lets through (?, ., !)', () => {
    // The URL regex only excludes whitespace + CJK punctuation, so a link at the
    // end of a sentence drags in the trailing "?"/"." — which made Feishu serve
    // a blank page (render_timeout bodyLen=0) for .../wikcnsgm...?. Regression.
    const q = extractFeishuDocUrls('帮我看看 https://dsg5e3xwei.feishu.cn/wiki/wikcnsgm7cKZ?');
    assert.equal(q.length, 1);
    assert.equal(q[0], 'https://dsg5e3xwei.feishu.cn/wiki/wikcnsgm7cKZ');

    const dot = extractFeishuDocUrls('见 https://geekbang.feishu.cn/wiki/AbC123.');
    assert.equal(dot[0], 'https://geekbang.feishu.cn/wiki/AbC123');

    const bang = extractFeishuDocUrls('https://geekbang.feishu.cn/wiki/AbC123！不在白名单');
    assert.ok(bang[0] && !bang[0].endsWith('！'));
  });
});

describe('urlDocType + isFetchable', () => {
  it('classifies wiki / docx as fetchable', () => {
    assert.equal(urlDocType('https://x.feishu.cn/wiki/AbC'), 'wiki');
    assert.equal(urlDocType('https://x.feishu.cn/docx/AbC'), 'docx');
    assert.ok(isFetchable('https://x.feishu.cn/wiki/AbC'));
    assert.ok(isFetchable('https://x.feishu.cn/docx/AbC'));
  });

  it('classifies sheets / base / slides as not fetchable', () => {
    assert.equal(urlDocType('https://x.feishu.cn/sheets/AbC'), 'sheets');
    assert.equal(urlDocType('https://x.feishu.cn/base/AbC'), 'base');
    assert.equal(urlDocType('https://x.feishu.cn/slides/AbC'), 'slides');
    assert.ok(!isFetchable('https://x.feishu.cn/sheets/AbC'));
    assert.ok(!isFetchable('https://x.feishu.cn/base/AbC'));
  });
});

describe('fetchWikiContent', () => {
  it('returns fetcher_unavailable when port is undefined', async () => {
    const r = await fetchWikiContent('https://geekbang.feishu.cn/wiki/ABC', {});
    assert.equal(r.markdown, null);
    assert.equal(r.reason, 'fetcher_unavailable');
    assert.equal(r.docType, 'wiki');
  });

  it('returns doc_type_not_fetchable for sheets/base/slides even with port', async () => {
    const r = await fetchWikiContent('https://x.feishu.cn/sheets/ABC', { port: 12345 });
    assert.equal(r.markdown, null);
    assert.equal(r.reason, 'doc_type_not_fetchable');
    assert.equal(r.docType, 'sheets');
  });

  it('returns fetch_error on connection refused (port with no server)', async () => {
    // Use a port that's almost certainly not listening.
    const r = await fetchWikiContent('https://geekbang.feishu.cn/wiki/ABC', { port: 1 });
    assert.equal(r.markdown, null);
    // fetch() throws ECONNREFUSED — our wrapper surfaces as fetch_error or timeout.
    assert.ok(['fetch_error', 'timeout'].includes(r.reason || ''), `got reason=${r.reason}`);
    assert.equal(r.docType, 'wiki');
  });
});

describe('materializeWikiLinks', () => {
  it('passes through text with no feishu urls', async () => {
    const out = await materializeWikiLinks('hello world', {});
    assert.equal(out, 'hello world');
  });

  it('injects dev-mode note when port is unavailable', async () => {
    const text = '看下这篇 https://geekbang.feishu.cn/wiki/AbC123Xyz 帮我总结';
    const out = await materializeWikiLinks(text, {});
    assert.ok(out.includes('https://geekbang.feishu.cn/wiki/AbC123Xyz'));
    assert.ok(out.includes('dev 模式未启用桌面端 BrowserView 抓取'));
    assert.ok(out.includes('wiki'));
  });

  it('injects export prompt for sheets URLs (even with port)', async () => {
    const text = 'https://x.feishu.cn/sheets/AbC123';
    const out = await materializeWikiLinks(text, { port: 1 });
    assert.ok(out.includes('https://x.feishu.cn/sheets/AbC123'));
    assert.ok(out.includes('暂不支持自动抓取'));
    assert.ok(out.includes('sheets'));
  });

  it('preserves URL + injects fetch_error note when fetch fails', async () => {
    const text = 'https://geekbang.feishu.cn/wiki/AbC123Xyz 帮我总结要点';
    const out = await materializeWikiLinks(text, { port: 1 });
    assert.ok(out.includes('https://geekbang.feishu.cn/wiki/AbC123Xyz'));
    assert.ok(out.includes('正文抓取失败'));
    assert.ok(out.includes('wiki'));
  });

  it('handles multiple URLs in one message', async () => {
    const text =
      'A: https://geekbang.feishu.cn/wiki/AAA111 B: https://geekbang.feishu.cn/wiki/BBB222';
    const out = await materializeWikiLinks(text, {});
    assert.ok(out.includes('https://geekbang.feishu.cn/wiki/AAA111'));
    assert.ok(out.includes('https://geekbang.feishu.cn/wiki/BBB222'));
    // Both should get the dev-mode note.
    const matches = out.match(/dev 模式未启用桌面端/g) || [];
    assert.equal(matches.length, 2);
  });

  it('passes empty string through unchanged', async () => {
    assert.equal(await materializeWikiLinks('', {}), '');
  });
});

describe('tenantHost', () => {
  it('extracts the tenant domain for feishu / larksuite URLs', () => {
    assert.equal(tenantHost('https://geekbang.feishu.cn/wiki/AbC'), 'geekbang.feishu.cn');
    assert.equal(tenantHost('https://open.feishu.cn/docx/XyZ'), 'open.feishu.cn');
    assert.equal(tenantHost('https://acme.larksuite.com/wiki/Q1'), 'acme.larksuite.com');
  });

  it('returns null for non-feishu or invalid URLs', () => {
    assert.equal(tenantHost('https://mp.weixin.qq.com/s/abc'), null);
    assert.equal(tenantHost('not a url'), null);
  });
});

describe('login_required note (private doc)', () => {
  // Stub desktop fetcher that always reports a login wall, so we can assert the
  // daemon injects the tenant-aware, anti-curl/API guidance.
  let server: http.Server;
  let port = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ markdown: null, reason: 'login_required' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('names the tenant and warns against curl / open-API fetching', async () => {
    const text = '帮我看下 https://geekbang.feishu.cn/wiki/PrivDoc123';
    const out = await materializeWikiLinks(text, { port });
    assert.ok(out.includes('https://geekbang.feishu.cn/wiki/PrivDoc123'));
    assert.ok(out.includes('私有文档'), 'should explain it is a private doc');
    assert.ok(out.includes('geekbang.feishu.cn'), 'should name the tenant');
    assert.ok(out.includes('登录飞书账号'), 'should point to the login flow');
    assert.ok(/curl|WebFetch/.test(out), 'should warn against curl/WebFetch');
    assert.ok(out.includes('开放 API'), 'should warn against the open API');
  });
});

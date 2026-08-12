/**
 * Tests for monitoring-sanitize.js (pure functions, no SDK/Electron).
 *
 * Why these tests: Molio is a knowledge-base + AI chat app. URL paths carry
 * vaultId and file paths; error stacks carry local absolute paths. The ARMS
 * SDK uploads these by default. The sanitize layer must redact them before
 * any cloud upload — a regression here leaks user content.
 *
 * Pure-function tests; no Electron, no network, no @arms/rum-electron import
 * (which has an ESM resolution bug in its transitive dep @arms/rum-core).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeString, sanitizeBundle, sanitizeViewName, sanitizeResourceName, injectUserId, dropFetchFailedNoise } from '../../src/monitoring-sanitize.js';

describe('sanitizeString', () => {
  it('redacts Windows absolute paths', () => {
    const input = "Cannot read 'D:\\Users\\alice\\notes\\secret.md'";
    const out = sanitizeString(input);
    assert.ok(!out.includes('D:\\Users\\alice'), `got: ${out}`);
    assert.ok(out.includes('<local-path>'), `got: ${out}`);
  });

  it('redacts Windows forward-slash paths', () => {
    // Vite / Electron loader emit D:/code/foo (URL form) — the original regex
    // only matched backslash paths, leaking this through to ARMS.
    const input = 'failed to load D:/code/workspace/Molio/apps/web/src/main.tsx';
    const out = sanitizeString(input);
    assert.ok(!out.includes('D:/code'), `got: ${out}`);
    assert.ok(out.includes('<local-path>'), `got: ${out}`);
  });

  it('redacts file:// URLs', () => {
    const input = 'error loading resource file:///D:/code/workspace/Molio/index.html';
    const out = sanitizeString(input);
    assert.ok(!out.includes('file://'), `got: ${out}`);
    assert.ok(!out.includes('D:/code'), `got: ${out}`);
    assert.ok(out.includes('<file-url>'), `got: ${out}`);
  });

  it('redacts macOS home paths', () => {
    const input = 'ENOENT: /Users/bob/Documents/vault/file.md';
    const out = sanitizeString(input);
    assert.ok(!out.includes('/Users/bob'), `got: ${out}`);
    assert.ok(out.includes('<local-path>'), `got: ${out}`);
  });

  it('redacts Linux home paths', () => {
    const input = 'failed at /home/carol/vaults/x/notes.md';
    const out = sanitizeString(input);
    assert.ok(!out.includes('/home/carol'), `got: ${out}`);
  });

  it('redacts vaultId in URL-style paths', () => {
    const input = 'GET /api/vaults/abc-123-def/files/notes.md failed';
    const out = sanitizeString(input);
    assert.ok(!out.includes('abc-123-def'), `got: ${out}`);
    assert.ok(out.includes('/vaults/[vaultId]'), `got: ${out}`);
  });

  it('redacts file query params', () => {
    const input = '/knowledge?vault=abc-123&file=secret/notes.md';
    const out = sanitizeString(input);
    assert.ok(!out.includes('secret/notes.md'), `got: ${out}`);
    assert.ok(out.includes('file=[path]'), `got: ${out}`);
  });

  it('passes through non-string input unchanged', () => {
    assert.equal(sanitizeString(null), null);
    assert.equal(sanitizeString(undefined), undefined);
    assert.equal(sanitizeString(42), 42);
  });

  it('preserves basename + line:col in stack traces', () => {
    // Without basename the ARMS record is useless for debugging. Path prefix
    // (with username) is redacted, but main.js:10:1 stays so reviewers can
    // locate the source.
    const input = 'at readFile (D:\\code\\workspace\\src\\main.js:10:1)';
    const out = sanitizeString(input);
    assert.ok(!out.includes('D:\\code'), `got: ${out}`);
    assert.ok(out.includes('main.js:10:1'), `got: ${out}`);
    assert.ok(out.includes('<local-path>'), `got: ${out}`);
  });

  it('preserves basename of file:// URLs', () => {
    const input = 'error loading resource file:///D:/code/workspace/Molio/apps/desktop/src/splash.html';
    const out = sanitizeString(input);
    assert.ok(!out.includes('file://'), `got: ${out}`);
    assert.ok(!out.includes('D:/code'), `got: ${out}`);
    assert.ok(out.includes('<file-url>/splash.html'), `got: ${out}`);
  });

  it('preserves basename of macOS path', () => {
    const input = 'ENOENT: /Users/bob/Documents/vault/file.md';
    const out = sanitizeString(input);
    assert.ok(!out.includes('/Users/bob'), `got: ${out}`);
    assert.ok(out.includes('file.md'), `got: ${out}`);
  });
});

describe('sanitizeBundle', () => {
  it('recursively sanitizes nested objects and arrays', () => {
    const bundle = {
      type: 'exception',
      message: "Cannot read 'D:\\Users\\x\\secret.md'",
      stack: [
        'at readFile (/Users/x/molio/node_modules/x/y.js:10:1)',
        { frame: 'at /home/x/.vault/notes.md' },
      ],
      meta: { vault: '/api/vaults/abc-123/files/x.md' },
    };
    const out = sanitizeBundle(bundle);
    assert.ok(!JSON.stringify(out).includes('D:\\Users\\x'), 'leaked Windows path');
    assert.ok(!JSON.stringify(out).includes('/Users/x'), 'leaked macOS path');
    assert.ok(!JSON.stringify(out).includes('abc-123'), 'leaked vaultId');
  });

  it('handles null/number/boolean without throwing', () => {
    assert.equal(sanitizeBundle(null), null);
    assert.equal(sanitizeBundle(0), 0);
    assert.equal(sanitizeBundle(true), true);
    assert.deepEqual(sanitizeBundle([1, 'a', { x: 'D:\\z\\y.md' }]), [1, 'a', { x: '<local-path>\\y.md' }]);
  });

  it('returns input unchanged for non-string scalars', () => {
    const out = sanitizeBundle({ n: 42, b: true, s: '/Users/x/y' });
    assert.equal(out.n, 42);
    assert.equal(out.b, true);
    assert.ok(!out.s.includes('/Users/x'));
  });
});

describe('injectUserId', () => {
  // ARMS SDK（0.0.5–0.0.7）无 setUser API：bundle.user.id 只取内部匿名设备
  // UID，config.user.id 被显式跳过。beforeReport 注入是唯一路径——这组用例
  // 守护"登录用户的 ULID 替换匿名 uid"的注入契约。

  it('sets user.id when bundle has no user field', () => {
    const bundle = { type: 'pv', view: { name: '/' } };
    const out = injectUserId(bundle, '01HXYZUSER');
    assert.deepEqual(out.user, { id: '01HXYZUSER' });
    assert.equal(out.type, 'pv');
  });

  it('overrides anonymous uid but keeps other user fields', () => {
    const bundle = { user: { id: 'anon-device-uid', name: 'x' }, type: 'api' };
    const out = injectUserId(bundle, '01HXYZUSER');
    assert.equal(out.user.id, '01HXYZUSER');
    assert.equal(out.user.name, 'x');
  });

  it('does not mutate the input bundle', () => {
    const bundle = { user: { id: 'anon' } };
    const out = injectUserId(bundle, '01HXYZUSER');
    assert.equal(bundle.user.id, 'anon');
    assert.notEqual(out, bundle);
    assert.notEqual(out.user, bundle.user);
  });

  it('returns bundle unchanged when logged out (null/empty/non-string userId)', () => {
    const bundle = { user: { id: 'anon' }, type: 'pv' };
    assert.equal(injectUserId(bundle, null), bundle);
    assert.equal(injectUserId(bundle, ''), bundle);
    assert.equal(injectUserId(bundle, undefined), bundle);
    assert.equal(injectUserId(bundle, 42), bundle);
  });

  it('handles non-object bundle shapes without throwing', () => {
    assert.equal(injectUserId(null, 'u1'), null);
    assert.equal(injectUserId('str', 'u1'), 'str');
    const arr = [1, 2];
    assert.equal(injectUserId(arr, 'u1'), arr);
  });
});

describe('dropFetchFailedNoise', () => {
  // 构造 SDK exception collector 产生的「fetch failed」自报噪音事件。
  // 形态对齐 dist/index.mjs 里 errorHandle 构造的 EXCEPTION 事件。
  const noiseEvent = {
    event_type: 'exception',
    type: 'error',
    source: 'unhandledRejection',
    name: 'TypeError',
    message: 'fetch failed',
    stack: 'TypeError: fetch failed',
  };

  const mkBundle = (events) => ({
    app: { id: 'x', env: 'prod' },
    session: { id: 's' },
    events,
  });

  it('drops the SDK self-reported "fetch failed" exception event', () => {
    const real = { event_type: 'exception', type: 'error', source: 'unhandledRejection', name: 'ReferenceError', message: 'foo is not defined', stack: 'ReferenceError: foo is not defined\n at x.js:1:1' };
    const out = dropFetchFailedNoise(mkBundle([{ ...noiseEvent }, real]));
    assert.ok(out, 'bundle should survive when real events remain');
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].message, 'foo is not defined');
  });

  it('returns null when every event is noise (SDK skips falsy bundles)', () => {
    const out = dropFetchFailedNoise(mkBundle([{ ...noiseEvent }, { ...noiseEvent }]));
    assert.equal(out, null);
  });

  it('keeps renderer "Failed to fetch" (Chromium message differs, must not be dropped)', () => {
    const rendererEvent = { event_type: 'exception', type: 'error', source: 'unhandledrejection', name: 'TypeError', message: 'Failed to fetch', stack: 'TypeError: Failed to fetch' };
    const out = dropFetchFailedNoise(mkBundle([rendererEvent]));
    assert.ok(out, 'renderer fetch failure must NOT be filtered');
    assert.equal(out.events.length, 1);
  });

  it('keeps non-exception events even if message matches', () => {
    // api/resource 事件的 message 也可能出现 fetch failed（daemon 健康检查失败等），
    // 只过滤 exception 类型，避免误伤 API 监控数据。
    const apiEvent = { event_type: 'resource', type: 'api', url: '/api/health', message: 'fetch failed', success: 'failed' };
    const out = dropFetchFailedNoise(mkBundle([apiEvent]));
    assert.ok(out);
    assert.equal(out.events.length, 1);
  });

  it('returns bundle unchanged when there is no noise', () => {
    const b = mkBundle([{ event_type: 'view', name: '/' }]);
    const out = dropFetchFailedNoise(b);
    assert.equal(out, b, 'same reference when nothing filtered');
  });

  it('passes through null / undefined / non-object / no events array', () => {
    assert.equal(dropFetchFailedNoise(null), null);
    assert.equal(dropFetchFailedNoise(undefined), undefined);
    assert.equal(dropFetchFailedNoise(42), 42);
    const noEvents = { app: { id: 'x' } };
    assert.equal(dropFetchFailedNoise(noEvents), noEvents);
  });

  it('tolerates malformed entries inside events array', () => {
    // 过滤是保守的：只丢「精确匹配噪音特征」的事件，畸形条目原样保留。
    const out = dropFetchFailedNoise(mkBundle([null, 'str', 42, { ...noiseEvent }]));
    assert.deepEqual(out.events, [null, 'str', 42], 'junk preserved, only exact noise dropped');
    const out2 = dropFetchFailedNoise(mkBundle([null, { ...noiseEvent }]));
    assert.equal(out2.events.length, 1, 'still not null while any non-noise entry remains');
  });

  it('composes with sanitizeBundle as wired in monitoring.js', () => {
    // monitoring.js: beforeReport = (b) => sanitizeBundle(dropFetchFailedNoise(b))
    const allNoise = sanitizeBundle(dropFetchFailedNoise(mkBundle([{ ...noiseEvent }])));
    assert.equal(allNoise, null, 'all-noise bundle stays falsy after sanitize');
    const mixed = sanitizeBundle(dropFetchFailedNoise(mkBundle([{ ...noiseEvent }, { event_type: 'exception', name: 'Error', message: 'leak D:/secret/x.md' }])));
    assert.equal(mixed.events.length, 1);
    assert.ok(!JSON.stringify(mixed).includes('D:/secret'), 'sanitization still applied after filtering');
  });
});

describe('sanitizeViewName', () => {
  it('redacts vault and file from full URL', () => {
    const url = 'http://localhost:3100/knowledge?vault=abc-123&file=secret/notes.md';
    const out = sanitizeViewName(url);
    assert.ok(!out.includes('abc-123'), `got: ${out}`);
    assert.ok(!out.includes('secret/notes.md'), `got: ${out}`);
    assert.ok(out.includes('/knowledge'), `got: ${out}`);
  });

  it('handles empty input', () => {
    assert.equal(sanitizeViewName(''), '');
  });

  it('returns empty string for non-string input', () => {
    assert.equal(sanitizeViewName(42), '');
    assert.equal(sanitizeViewName(null), '');
    assert.equal(sanitizeViewName(undefined), '');
  });

  it('redacts /vaults/<id> in pathname', () => {
    const url = 'http://localhost:3100/api/vaults/abc-123/files/x.md';
    const out = sanitizeViewName(url);
    assert.ok(!out.includes('abc-123'), `got: ${out}`);
    assert.ok(out.includes('/vaults/[vaultId]'), `got: ${out}`);
  });

  it('redacts local path in file:// view URL', () => {
    // Electron loads file:// resources (splash, packaged assets) — pathname
    // becomes /D:/code/... and must not leak the dev's home dir.
    const url = 'file:///D:/code/workspace/Molio/apps/desktop/src/splash.html';
    const out = sanitizeViewName(url);
    assert.ok(!out.includes('D:/code'), `got: ${out}`);
    assert.ok(out.includes('<local-path>'), `got: ${out}`);
  });
});

describe('sanitizeResourceName', () => {
  it('returns pathname with vaultId redacted', () => {
    const url = 'http://localhost:3100/api/vaults/abc-123/files/x.md?token=secret';
    const out = sanitizeResourceName(url);
    assert.ok(!out.includes('abc-123'), `got: ${out}`);
    assert.ok(out.includes('/vaults/[vaultId]'), `got: ${out}`);
    assert.ok(!out.includes('token=secret'), `got: ${out}`); // search not included
  });

  it('redacts local path in file:// resource URL', () => {
    // ARMS resource panel was showing /file:///D:/code/workspacexxx —
    // sanitizeResourceName only ran vaultId regex, missing the local path.
    const url = 'file:///D:/code/workspace/Molio/apps/desktop/resources/web/index.html';
    const out = sanitizeResourceName(url);
    assert.ok(!out.includes('D:/code'), `got: ${out}`);
    assert.ok(!out.includes('file://'), `got: ${out}`);
    assert.ok(out.includes('<local-path>'), `got: ${out}`);
  });

  it('handles empty input', () => {
    assert.equal(sanitizeResourceName(''), '');
  });

  it('returns empty string for non-string input', () => {
    assert.equal(sanitizeResourceName(42), '');
    assert.equal(sanitizeResourceName(null), '');
    assert.equal(sanitizeResourceName(undefined), '');
  });
});

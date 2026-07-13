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
import { sanitizeString, sanitizeBundle, sanitizeViewName, sanitizeResourceName } from '../../src/monitoring-sanitize.js';

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
    assert.deepEqual(sanitizeBundle([1, 'a', { x: 'D:\\z\\y.md' }]), [1, 'a', { x: '<local-path>' }]);
  });

  it('returns input unchanged for non-string scalars', () => {
    const out = sanitizeBundle({ n: 42, b: true, s: '/Users/x/y' });
    assert.equal(out.n, 42);
    assert.equal(out.b, true);
    assert.ok(!out.s.includes('/Users/x'));
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, resolveCanonicalPath } from '../../src/core/knowledge.js';

test('case fallback handles nested directory segments and preserves canonical case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-case-'));
  try {
    mkdirSync(join(dir, 'Topics', 'Nested'), { recursive: true });
    writeFileSync(join(dir, 'Topics', 'Nested', 'Page.MD'), 'content');
    assert.equal(readFile(dir, 'topics/nested/page').content, 'content');
    assert.equal(resolveCanonicalPath(dir, 'topics/nested/page.md'), 'Topics/Nested/Page.MD');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('case fallback does not follow a directory symlink outside the vault', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'molio-case-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'molio-case-outside-'));
  try {
    writeFileSync(join(outside, 'Secret.md'), 'private');
    symlinkSync(outside, join(root, 'Link'), 'dir');
    assert.equal(resolveCanonicalPath(root, 'link/secret.md'), null);
    assert.throws(() => readFile(root, 'link/secret.md'));
    assert.equal(resolveCanonicalPath(root, 'Link/secret.md'), null);
    assert.throws(() => readFile(root, 'Link/secret.md'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('ambiguous case-insensitive directory matches do not select arbitrary content', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-case-ambiguous-'));
  try {
    mkdirSync(join(dir, 'Foo')); mkdirSync(join(dir, 'fOO'));
    writeFileSync(join(dir, 'Foo', 'entry.md'), 'first');
    writeFileSync(join(dir, 'fOO', 'entry.md'), 'second');
    assert.equal(readFile(dir, 'Foo/entry.md').content, 'first');
    assert.equal(resolveCanonicalPath(dir, 'foo/entry.md'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

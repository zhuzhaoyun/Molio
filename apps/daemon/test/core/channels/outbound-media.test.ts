import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractOutboundMedia } from '../../../src/core/channels/outbound-media.js';

/**
 * Path-traversal protection for `<attach/>` markers: the AI is driven by
 * inbound IM text, so a malicious message could try to trick it into emitting
 * `<attach path="../../.ssh/id_rsa"/>` to exfiltrate files outside the project
 * cwd. The dispatcher must reject such markers without delivering the file.
 */
describe('extractOutboundMedia — path traversal', () => {
  let cwd: string;
  let secretDir: string;
  let secretPath: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'molio-outbound-cwd-'));
    // Sibling directory outside cwd — simulates ~/.ssh/ or another secret.
    secretDir = mkdtempSync(join(tmpdir(), 'molio-outbound-secret-'));
    secretPath = join(secretDir, 'secret.key');
    writeFileSync(secretPath, 'ssh-secret');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });

  it('rejects a `..` traversal that escapes cwd and reports it as a failure', () => {
    const marker = `<attach path="../../${basename(secretDir)}/secret.key"/>`;
    // Note: the test deliberately constructs the marker from cwd's parent, so
    // the resolved path lands in secretDir (outside cwd).
    const rel = relativePathToSibling(cwd, secretPath);
    const text = `已附上文件。<attach path="${rel}"/>`;
    const { items, text: clean, failed } = extractOutboundMedia(text, cwd);
    assert.equal(items.length, 0, 'traversal marker must not produce a deliverable');
    // Marker still stripped from text so the IM channel never sees the path.
    assert.ok(!clean.includes(rel));
    // But the failure is REPORTED — the reply claims "已附上", so the
    // dispatcher must tell the user nothing was delivered.
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.reason, 'blocked-traversal');
  });

  it('delivers a file referenced by absolute path inside cwd', () => {
    const sub = join(cwd, 'reports');
    mkdirSync(sub, { recursive: true });
    const pdfPath = join(sub, 'report.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 body');
    const text = `已生成。<attach path="${pdfPath}"/>`;
    const { items } = extractOutboundMedia(text, cwd);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.filePath, pdfPath);
  });

  // Helper: build a `..`-prefixed relative path from cwd to an absolute target.
  function relativePathToSibling(fromDir: string, toAbsPath: string): string {
    const parts = toAbsPath.split(/[\\/]/);
    const cwdParts = fromDir.split(/[\\/]/);
    // Strip common prefix.
    let i = 0;
    while (i < parts.length && i < cwdParts.length && parts[i] === cwdParts[i]) i++;
    const ups = cwdParts.length - i;
    const rel = [...Array(ups).fill('..'), ...parts.slice(i)].join('/');
    return rel;
  }

  function basename(p: string): string {
    return p.split(/[\\/]/).pop() ?? '';
  }
});

/**
 * Marker-syntax tolerance. The AI is prompted to write `<attach path="..."/>`
 * but models drift: explicit closing tags, extra/reordered attributes, no
 * self-closing slash. A marker the regex MISSES leaks into the IM card as an
 * invisible HTML tag — the user sees "已附上" text but no file (part of the
 * 2026-08-23 feishu incident class). When in doubt, match more.
 */
describe('extractOutboundMedia — marker variant tolerance', () => {
  let cwd: string;
  let filePath: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'molio-outbound-var-'));
    filePath = join(cwd, '报告.md');
    writeFileSync(filePath, '# 报告');
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const variants = [
    ['self-closed', (p: string) => `<attach path="${p}"/>`],
    ['open tag, no slash', (p: string) => `<attach path="${p}">`],
    ['explicit closing tag', (p: string) => `<attach path="${p}"></attach>`],
    ['extra attribute after path', (p: string) => `<attach path="${p}" name="报告"/>`],
    ['reordered attribute', (p: string) => `<attach name="报告" path="${p}"/>`],
    ['single quotes', (p: string) => `<attach path='${p}'/>`],
    ['spaces around =', (p: string) => `<attach path = "${p}" />`],
    ['closing tag with whitespace', (p: string) => `<attach path="${p}"> </attach>`],
  ] as const;

  for (const [name, build] of variants) {
    it(`parses the ${name} variant`, () => {
      const { items, text, failed } = extractOutboundMedia(`已附上。${build(filePath)}`, cwd);
      assert.equal(items.length, 1, `${name} variant must deliver the file`);
      assert.equal(items[0]!.filePath, filePath);
      assert.equal(failed.length, 0);
      assert.ok(!text.includes(filePath), 'path stripped from user-facing text');
      assert.ok(!text.includes('<attach'), 'no marker residue in text');
    });
  }

  it('does not match a different attribute whose VALUE contains "path"', () => {
    // `note="save path"` must not be mistaken for the path attribute; the
    // real marker further in the string still resolves.
    const text = `<attach note="save path" path="${filePath}"/>`;
    const { items } = extractOutboundMedia(text, cwd);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.filePath, filePath);
  });
});

/**
 * Failure reporting. Before this fix, an unresolvable marker was silently
 * stripped: reply text said "已附上", the user got nothing, and nothing was
 * logged. Now every undeliverable marker is reported so the dispatcher can
 * warn the user. (2026-08-23 feishu incident: 两份会议记录"已附上"，实际没发，
 * 无任何日志可查。)
 */
describe('extractOutboundMedia — failure reporting', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'molio-outbound-fail-'));
    mkdirSync(join(cwd, 'reports'), { recursive: true });
    writeFileSync(join(cwd, 'reports', '纪要.md'), '# 纪要');
    writeFileSync(join(cwd, 'reports', 'data.ts'), 'export {};');
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('reports a marker whose path does not exist (and still strips it)', () => {
    const text = '已附上。<attach path="reports/不存在的文件.md"/>';
    const { items, text: clean, failed } = extractOutboundMedia(text, cwd);
    assert.equal(items.length, 0);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.reason, 'not-found');
    assert.equal(failed[0]!.path, 'reports/不存在的文件.md');
    assert.ok(!clean.includes('不存在的文件'), 'unresolved marker still stripped');
    assert.ok(clean.includes('已附上'), 'surrounding text preserved');
  });

  it('reports unsupported file types (source code is not deliverable)', () => {
    const { items, failed } = extractOutboundMedia('<attach path="reports/data.ts"/>', cwd);
    assert.equal(items.length, 0);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.reason, 'unsupported-type');
  });

  it('reports a directory path as not-a-file', () => {
    const { items, failed } = extractOutboundMedia('<attach path="reports"/>', cwd);
    assert.equal(items.length, 0);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.reason, 'not-a-file');
  });

  it('dedupes silently: a repeated marker for the same file is not a failure', () => {
    const text = '<attach path="reports/纪要.md"/> 和 <attach path="reports/纪要.md"/>';
    const { items, failed } = extractOutboundMedia(text, cwd);
    assert.equal(items.length, 1);
    assert.equal(failed.length, 0, 'duplicate markers are skipped, not failures');
  });

  it('mixes successes and failures in one reply', () => {
    const text = [
      '都发给你：',
      '<attach path="reports/纪要.md"/>',
      '<attach path="reports/丢了.md"/>',
    ].join('\n');
    const { items, failed } = extractOutboundMedia(text, cwd);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.fileName, '纪要.md');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.reason, 'not-found');
  });
});

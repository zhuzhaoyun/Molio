import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractOutboundMedia, classifyByExt } from '../../../src/core/weixin/outbound-media.js';

describe('classifyByExt', () => {
  it('classifies image extensions', () => {
    assert.equal(classifyByExt('png'), 'image');
    assert.equal(classifyByExt('JPG'), 'image');
    assert.equal(classifyByExt('webp'), 'image');
  });

  it('classifies video extensions', () => {
    assert.equal(classifyByExt('mp4'), 'video');
    assert.equal(classifyByExt('MOV'), 'video');
  });

  it('classifies document/archive/audio extensions as file', () => {
    assert.equal(classifyByExt('pdf'), 'file');
    assert.equal(classifyByExt('docx'), 'file');
    assert.equal(classifyByExt('zip'), 'file');
    assert.equal(classifyByExt('md'), 'file');
    assert.equal(classifyByExt('mp3'), 'file');
  });

  it('rejects source/config extensions', () => {
    assert.equal(classifyByExt('ts'), null);
    assert.equal(classifyByExt('tsx'), null);
    assert.equal(classifyByExt('js'), null);
    assert.equal(classifyByExt('json'), null);
    assert.equal(classifyByExt(''), null);
  });
});

describe('extractOutboundMedia', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-outbound-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses <attach/> markers, delivers files, and strips markers from text', () => {
    const md = join(tempDir, 'Goals.md');
    const pdf = join(tempDir, 'report.pdf');
    writeFileSync(md, '# goals');
    writeFileSync(pdf, '%PDF');

    const reply = `已附上两个文件。\n<attach path="${md}"/>\n<attach path="${pdf}"/>`;
    const { items, text } = extractOutboundMedia([], reply, tempDir);

    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.fileName).sort(), ['Goals.md', 'report.pdf']);
    // Markers stripped, no path leaks into text
    assert.ok(!text.includes(md), 'absolute path must not leak into text');
    assert.ok(!text.includes(pdf));
    assert.ok(text.includes('已附上两个文件'));
    assert.ok(!text.includes('<attach'));
  });

  it('strips markers but keeps them out of text even when file is missing', () => {
    const reply = `<attach path="${join(tempDir, 'missing.pdf')}"/>`;
    const { items, text } = extractOutboundMedia([], reply, tempDir);
    assert.equal(items.length, 0);
    assert.equal(text, ''); // marker stripped, nothing left
  });

  it('resolves relative paths in markers against cwd', () => {
    mkdirSync(join(tempDir, 'wiki', 'concepts'), { recursive: true });
    const rel = 'wiki/concepts/Goals.md';
    writeFileSync(join(tempDir, rel), '# goals');
    const reply = `<attach path="${rel}"/>`;
    const { items, text } = extractOutboundMedia([], reply, tempDir);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.fileName, 'Goals.md');
    assert.equal(text, '');
  });

  it('accepts single-quoted paths', () => {
    const pdf = join(tempDir, 'x.pdf');
    writeFileSync(pdf, 'x');
    const reply = `<attach path='${pdf}'/>`;
    const { items } = extractOutboundMedia([], reply, tempDir);
    assert.equal(items.length, 1);
  });

  it('does not deliver source/config files referenced by markers', () => {
    const ts = join(tempDir, 'mod.ts');
    writeFileSync(ts, 'export {}');
    const reply = `<attach path="${ts}"/>`;
    const { items, text } = extractOutboundMedia([], reply, tempDir);
    assert.equal(items.length, 0);
    // marker still stripped even though file not deliverable
    assert.ok(!text.includes('<attach'));
    assert.ok(!text.includes(ts));
  });

  it('collects files written by Write tool (no marker needed)', () => {
    const img = join(tempDir, 'chart.png');
    writeFileSync(img, 'x');
    const { items } = extractOutboundMedia(
      [{ name: 'Write', input: { file_path: img } }],
      '图已生成',
      tempDir,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, 'image');
  });

  it('ignores Edit/MultiEdit (existing-source edits are not deliverables)', () => {
    const src = join(tempDir, 'module.ts');
    writeFileSync(src, 'export {}');
    const { items } = extractOutboundMedia(
      [
        { name: 'Edit', input: { file_path: src } },
        { name: 'MultiEdit', input: { file_path: src } },
      ],
      '',
      tempDir,
    );
    assert.equal(items.length, 0);
  });

  it('dedupes when the same file is both Write-created and marker-referenced', () => {
    const md = join(tempDir, 'Goals.md');
    writeFileSync(md, '# goals');
    const reply = `<attach path="${md}"/>`;
    const { items } = extractOutboundMedia(
      [{ name: 'Write', input: { file_path: md } }],
      reply,
      tempDir,
    );
    assert.equal(items.length, 1);
  });

  it('does not treat [[wiki links]] or bare paths in text as attachments', () => {
    // Bare paths and wiki-links in the reply are NOT delivered — only
    // explicit <attach/> markers are. This prevents accidental delivery and
    // ensures paths never leak to WeChat as actionable text.
    mkdirSync(join(tempDir, 'concepts'), { recursive: true });
    writeFileSync(join(tempDir, 'concepts', 'Goals.md'), '# goals');
    const reply = '参见 [[concepts/Goals.md]]，或看 concepts/Goals.md。';
    const { items, text } = extractOutboundMedia([], reply, tempDir);
    assert.equal(items.length, 0);
    assert.equal(text, reply); // untouched — no markers to strip
  });

  it('tidies empty bullet/label lines left after stripping markers', () => {
    const md = join(tempDir, 'Goals.md');
    writeFileSync(md, '# goals');
    const reply = `- 文件：\`<attach path="${md}"/>\`\n- 其他说明`;
    const { text } = extractOutboundMedia([], reply, tempDir);
    // The marker is gone; the leftover empty bullet is cleaned up.
    assert.ok(!text.includes('<attach'));
    assert.ok(!text.includes(md));
    assert.ok(text.includes('其他说明'));
  });
});

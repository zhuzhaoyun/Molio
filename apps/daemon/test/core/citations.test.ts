import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { citationPathFromToolUse, formatCitationBlock } from '../../src/core/citations.js';

describe('citationPathFromToolUse', () => {
  test('Read.file_path → 路径', () => {
    assert.equal(citationPathFromToolUse('Read', { file_path: '/v/raw/a.txt' }), '/v/raw/a.txt');
  });
  test('Grep 带目录 → null（是搜索不是读）；带文件 → 路径', () => {
    assert.equal(citationPathFromToolUse('Grep', { pattern: '盗刷', path: 'raw' }), null);
    assert.equal(citationPathFromToolUse('Grep', { pattern: '盗刷', path: 'raw/刑法.txt' }), 'raw/刑法.txt');
  });
  test('Bash cat/head/tail/less → 路径；其余命令 → null', () => {
    assert.equal(citationPathFromToolUse('Bash', { command: 'cat wiki/hot.md' }), 'wiki/hot.md');
    assert.equal(citationPathFromToolUse('Bash', { command: 'head -50 raw/a.txt' }), 'raw/a.txt');
    assert.equal(citationPathFromToolUse('Bash', { command: 'ls -la raw' }), null);
  });
  test('Glob / WebFetch / WebSearch / Write → null', () => {
    assert.equal(citationPathFromToolUse('Glob', { pattern: '**/*.md' }), null);
    assert.equal(citationPathFromToolUse('WebFetch', { url: 'https://x.com' }), null);
    assert.equal(citationPathFromToolUse('Write', { file_path: 'a.md' }), null);
  });
  test('win 反斜杠与 ./ 前缀归一化；URL 拒绝', () => {
    assert.equal(citationPathFromToolUse('Read', { file_path: 'D:\\vault\\raw\\a.md' }), 'D:/vault/raw/a.md');
    assert.equal(citationPathFromToolUse('Read', { file_path: './wiki/hot.md' }), 'wiki/hot.md');
    assert.equal(citationPathFromToolUse('Read', { file_path: 'https://x.com/a' }), null);
  });
});

describe('formatCitationBlock', () => {
  test('去重 + ①②③ 标号 + basename 展示', () => {
    assert.equal(
      formatCitationBlock(['wiki/刑法分则.md', 'wiki/刑法分则.md', 'raw/剪藏.md']),
      '\n\n——\n依据：① 刑法分则.md ② 剪藏.md',
    );
  });
  test('上限截断（默认 5）；超过上限用 n. 标号', () => {
    const ten = Array.from({ length: 12 }, (_, i) => `f${i + 1}.md`);
    const block = formatCitationBlock(ten)!;
    assert.ok(block.includes('⑤ f5.md'));
    assert.ok(!block.includes('f6.md'));
    assert.ok(formatCitationBlock(['a.md', 'b.md'], 1)!.endsWith('① a.md'));
  });
  test('空路径数组 → null', () => {
    assert.equal(formatCitationBlock([]), null);
  });
  test('超过 10 项用 n. 标号', () => {
    const many = Array.from({ length: 12 }, (_, i) => `g${i + 1}.md`);
    const block = formatCitationBlock(many, 12)!;
    assert.ok(block.includes('⑩ g10.md'));
    assert.ok(block.includes('11. g11.md'));
    assert.ok(block.includes('12. g12.md'));
  });
});

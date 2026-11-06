import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { citationPathFromToolUse, citationPathsFromToolUse, formatCitationBlock } from '../../src/core/citations.js';

describe('citationPathsFromToolUse（E1 对账回归：Bash 记账规则从字符串级升级为命令级）', () => {
  test('Bash 单条命令 cat 多个文件 → 全部路径（旧口径只取第一条）', () => {
    assert.deepEqual(
      citationPathsFromToolUse('Bash', { command: 'cat a.md && cat b.md' }),
      ['a.md', 'b.md'],
    );
  });
  test('E1-F2：cd && 后的相对路径（旧口径完全漏记）', () => {
    assert.deepEqual(
      citationPathsFromToolUse('Bash', { command: 'cd /vault/wiki/刑诉 && cat 条号速查.md' }),
      ['条号速查.md'],
    );
  });
  test('sed / grep 单文件计入；grep 目录仍是搜索动作', () => {
    assert.deepEqual(
      citationPathsFromToolUse('Bash', { command: "sed -n '1,40p' notes/真题/zhuguan-2023.txt" }),
      ['notes/真题/zhuguan-2023.txt'],
    );
    assert.deepEqual(
      citationPathsFromToolUse('Bash', { command: 'grep -n "缺口" 法考刑法知识库总览.md' }),
      ['法考刑法知识库总览.md'],
    );
    assert.deepEqual(citationPathsFromToolUse('Bash', { command: 'grep -rn "转账" wiki/' }), []);
  });
  test('for 循环清单计入；重定向目标是写入不计入', () => {
    assert.deepEqual(
      citationPathsFromToolUse('Bash', { command: 'for f in a.md b.md; do cat "$f"; done' }),
      ['a.md', 'b.md'],
    );
    assert.deepEqual(citationPathsFromToolUse('Bash', { command: 'cat a.md > copy.md' }), ['a.md']);
  });
  test('非读命令与旧口径一致返回空', () => {
    assert.deepEqual(citationPathsFromToolUse('Bash', { command: 'rm notes.md' }), []);
    assert.deepEqual(citationPathsFromToolUse('Bash', { command: 'ls -la raw' }), []);
  });
  test('Read / Grep 走原语义（数组形态）', () => {
    assert.deepEqual(citationPathsFromToolUse('Read', { file_path: '/v/raw/a.txt' }), ['/v/raw/a.txt']);
    assert.deepEqual(citationPathsFromToolUse('Grep', { path: 'raw' }), []);
    assert.deepEqual(citationPathsFromToolUse('Grep', { path: 'raw/刑法.txt' }), ['raw/刑法.txt']);
    assert.deepEqual(citationPathsFromToolUse('Write', { file_path: 'a.md' }), []);
    assert.deepEqual(citationPathsFromToolUse('WebFetch', { url: 'https://x.com' }), []);
  });
});

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

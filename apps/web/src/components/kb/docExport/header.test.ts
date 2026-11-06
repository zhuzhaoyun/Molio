import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  MAX_HEADER_TAGS,
  countDocWords,
  formatHeaderDate,
  readingMinutes,
} from './header.ts';

describe('countDocWords', () => {
  it('CJK 逐字计，拉丁按词计', () => {
    assert.strictEqual(countDocWords('知识库知识库'), 6);
    assert.strictEqual(countDocWords('hello world'), 2);
    assert.strictEqual(countDocWords('知识 knowledge graph 图谱'), 6);
  });

  it('空文本为 0', () => {
    assert.strictEqual(countDocWords(''), 0);
  });

  it('中英标点不算词', () => {
    assert.strictEqual(countDocWords('你好，world。'), 3);
  });
});

describe('readingMinutes', () => {
  it('400 字/分钟，向上取整到至少 1 分钟', () => {
    assert.strictEqual(readingMinutes(0), 1);
    assert.strictEqual(readingMinutes(399), 1);
    assert.strictEqual(readingMinutes(401), 1);
    assert.strictEqual(readingMinutes(801), 2);
  });
});

describe('formatHeaderDate', () => {
  it('跟随 locale 输出长日期', () => {
    const date = new Date(2026, 9, 20);
    assert.match(formatHeaderDate(date, 'zh-CN'), /2026/);
    assert.match(formatHeaderDate(date, 'en-US'), /2026/);
    // 两个 locale 的月份写法不同：中文「10月」，英文「October」。
    assert.match(formatHeaderDate(date, 'zh-CN'), /10\s*月/);
    assert.match(formatHeaderDate(date, 'en-US'), /October/);
  });
});

describe('MAX_HEADER_TAGS', () => {
  it('标签最多展示 5 个', () => {
    assert.strictEqual(MAX_HEADER_TAGS, 5);
  });
});

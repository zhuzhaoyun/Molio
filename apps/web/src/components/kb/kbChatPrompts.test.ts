import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveChatTitle, stripLeadingRefs } from './kbChatPrompts.ts';

// 发送时 composer 会把文档引用 chip 还原成 `@path` 再展开成 `[📄 name](path)`，
// 贴在用户正文前面。标签标题必须只描述用户的问题（2026-10-22 实测：
// 不剥前缀时标题变成 `[📄 doc.md](doc.md) 关于 d`）。

test('stripLeadingRefs: 剥掉行首文件引用链接', () => {
  assert.equal(stripLeadingRefs('[📄 doc.md](doc.md) 关于 doc.md 的问题'), '关于 doc.md 的问题');
});

test('stripLeadingRefs: 连续多个引用一起剥', () => {
  assert.equal(
    stripLeadingRefs('[📄 a.md](a.md) [📄 b.md](b.md) 对比两篇'),
    '对比两篇',
  );
});

test('stripLeadingRefs: 裸 @token 也剥（未展开的场景）', () => {
  assert.equal(stripLeadingRefs('@笔记/入门.md 讲讲这篇'), '讲讲这篇');
});

test('stripLeadingRefs: 图片附件前缀同样剥掉', () => {
  assert.equal(stripLeadingRefs('![image](/tmp/a.png) 这张图讲什么'), '这张图讲什么');
});

test('stripLeadingRefs: 正文中间的链接不动', () => {
  assert.equal(stripLeadingRefs('看看 [文档](https://x.y) 怎么说'), '看看 [文档](https://x.y) 怎么说');
});

test('deriveChatTitle: 引用前缀不进入标题', () => {
  assert.equal(deriveChatTitle('[📄 doc.md](doc.md) 关于 doc.md 的问题'), '关于 doc.md 的问题');
});

test('deriveChatTitle: 取末行非空内容（前缀行在上方）', () => {
  assert.equal(deriveChatTitle('@doc.md\n\n末行的真问题'), '末行的真问题');
});

test('deriveChatTitle: 只有引用、没有正文时回退「新会话」', () => {
  assert.equal(deriveChatTitle('[📄 doc.md](doc.md)'), '新会话');
});

test('deriveChatTitle: 折叠空白并截断 24 字', () => {
  assert.equal(deriveChatTitle('  一句   很长的   话  '), '一句 很长的 话');
  assert.equal(deriveChatTitle('一'.repeat(30)), '一'.repeat(24));
});

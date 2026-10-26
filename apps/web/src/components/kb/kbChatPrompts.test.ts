import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveChatTitle, stripLeadingRefs, stripWikiQueryTrigger, WIKI_QUERY_TRIGGER } from './kbChatPrompts.ts';

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

// ── wiki-query 触发语（2026-10-24 软化为条件式 + 气泡剥离）──

test('WIKI_QUERY_TRIGGER: 以「本库主题」为锚的条件式 + 答案形状要求', () => {
  assert.ok(WIKI_QUERY_TRIGGER('x').includes('本库主题'));
  assert.ok(WIKI_QUERY_TRIGGER('x').includes('明显无关'));
  assert.ok(WIKI_QUERY_TRIGGER('x').includes('无需检索'));
  assert.ok(WIKI_QUERY_TRIGGER('x').includes('不要以检索过程'), '答案形状：不叙述检索过程');
});

test('WIKI_QUERY_TRIGGER: 文案长度不增（≤ #369 条件式的 101 字）', () => {
  // 设计 §4B 的承诺：触发语换文案不得变长——气泡剥离与标题派生都假设前缀短。
  const directive = WIKI_QUERY_TRIGGER('').replace(/\n$/, '');
  assert.ok([...directive].length <= 101, `实际 ${[...directive].length} 字`);
});

test('WIKI_QUERY_TRIGGER: 触发语以换行结尾、问题在末行（标题派生/剥离都依赖）', () => {
  assert.ok(WIKI_QUERY_TRIGGER('什么是熵').endsWith('\n什么是熵'));
});

test('stripWikiQueryTrigger: 剥掉现行触发语，只剩用户问题', () => {
  assert.equal(stripWikiQueryTrigger(WIKI_QUERY_TRIGGER('什么是熵')), '什么是熵');
});

test('stripWikiQueryTrigger: #369 条件式触发语（历史会话）也剥', () => {
  const legacy369 =
    '（知识库问答：若问题涉及本库内容，请先用 wiki-query skill 读 wiki/INDEX.md 检索相关页面，基于库内材料回答；与本库明显无关的通用问题（如闲聊、天气）可直接回答，无需检索）\n#369 时代的会话';
  assert.equal(stripWikiQueryTrigger(legacy369), '#369 时代的会话');
});

test('stripWikiQueryTrigger: 旧版无条件触发语（历史会话）也剥', () => {
  const legacy =
    '（知识库问答：请用 wiki-query skill，先读 wiki/INDEX.md 检索相关页面再回答，不要凭训练记忆作答）\n旧会话里的问题';
  assert.equal(stripWikiQueryTrigger(legacy), '旧会话里的问题');
});

test('stripWikiQueryTrigger: 剥离后保留触发语之后的前缀与多行正文', () => {
  const wrapped = `${WIKI_QUERY_TRIGGER('![image](/tmp/a.png)\n\n看这张图')}`;
  assert.equal(stripWikiQueryTrigger(wrapped), '![image](/tmp/a.png)\n\n看这张图');
});

test('stripWikiQueryTrigger: 普通消息原样返回', () => {
  assert.equal(stripWikiQueryTrigger('你好'), '你好');
  assert.equal(stripWikiQueryTrigger('请问（知识库问答）是什么'), '请问（知识库问答）是什么');
});

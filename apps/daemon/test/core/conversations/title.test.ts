import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveConversationTitle } from '../../../src/core/conversations/title.js';

// 2026-10-24 用户实测：KB 问答每条会话的首条消息都带固定的 wiki-query 触发语前缀
// （旧实现 `message.slice(0, 80)`），导致历史记录几乎每条同名。标题必须取真问题所在
// 的末行——触发语/附件前缀/引用前缀都以换行结尾。

describe('deriveConversationTitle', () => {
  it('KB 问答触发语前缀不进标题，取末行真问题', () => {
    const wrapped =
      '（知识库问答：请用 wiki-query skill，先读 wiki/INDEX.md 检索相关页面再回答，不要凭训练记忆作答）\n' +
      '史记里项羽本纪主要讲了什么';
    const title = deriveConversationTitle(wrapped);
    assert.equal(title, '史记里项羽本纪主要讲了什么');
    assert.ok(!title.includes('知识库问答'));
  });

  it('附件前缀 + 选中文字引用同样取末行', () => {
    const message =
      '![image](/tmp/a.png)\n\n' +
      '知识库问答的上下文：\n> 被引用的一段文字\n\n' +
      '这段话的出处是哪里';
    assert.equal(deriveConversationTitle(message), '这段话的出处是哪里');
  });

  it('无前缀的单行消息原样作为标题', () => {
    assert.equal(deriveConversationTitle('帮我写一封请假条'), '帮我写一封请假条');
  });

  it('超长单行截断 80', () => {
    assert.equal(deriveConversationTitle('长'.repeat(100)), '长'.repeat(80));
  });

  it('折叠行内连续空白', () => {
    assert.equal(deriveConversationTitle('一句   很长的    话'), '一句 很长的 话');
  });

  it('纯附件消息没有正文行，标题落附件行本身（与旧 slice 行为一致）', () => {
    assert.equal(deriveConversationTitle('![image](/tmp/a.png)\n\n'), '![image](/tmp/a.png)');
  });

  it('纯空白消息返回空串（调用方落 null）', () => {
    assert.equal(deriveConversationTitle('   \n  '), '');
  });
});

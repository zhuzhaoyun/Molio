// apps/web/test/session-output/aggregateSessionOutput.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { aggregateSessionOutput } from '../../src/utils/workSteps';
import type { ChatMessage, ToolEvent } from '../../src/hooks/useChatCore';

function tool(over: Partial<ToolEvent> = {}): ToolEvent {
  return { id: 't', name: 'Read', status: 'done', input: {}, isError: false, result: '', ...over };
}
function assistant(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a', role: 'assistant', content: '', timestamp: 0, tools: [], ...over };
}
function userMsg(content = 'hi'): ChatMessage {
  return { id: 'u', role: 'user', content, timestamp: 0 };
}

describe('aggregateSessionOutput', () => {
  it('writes 跨消息按 path 去重、仅收 done', () => {
    const msgs = [
      assistant({ tools: [tool({ name: 'Write', input: { file_path: '产出/总结.md' } })] }),
      assistant({
        tools: [
          tool({ name: 'Write', input: { file_path: '产出/总结.md' } }),
          tool({ name: 'Edit', input: { file_path: '笔记/入门.md' } }),
        ],
      }),
    ];
    assert.strictEqual(aggregateSessionOutput(msgs).writes.length, 2);
  });

  it('running / error 工具不当作产物或来源', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ name: 'Write', input: { file_path: 'a.md' }, status: 'running' }),
          tool({ name: 'Write', input: { file_path: 'b.md' }, isError: true }),
        ],
      }),
    ];
    assert.strictEqual(aggregateSessionOutput(msgs).writes.length, 0);
  });

  it('sources 跨消息按 target 去重、仅收 done', () => {
    const msgs = [
      assistant({ tools: [tool({ name: 'WebSearch', result: 'a https://x.com/1' })] }),
      assistant({ tools: [tool({ name: 'WebSearch', result: 'https://x.com/1 b https://y.com/2' })] }),
    ];
    assert.strictEqual(aggregateSessionOutput(msgs).sources.length, 2);
  });

  it('URL 上限 8 按每条消息计：两条各 10 条不同 URL → 聚合 16 条（非整会话截 8）', () => {
    const urlsA = Array.from({ length: 10 }, (_, i) => `https://a${i}.com/${i}`);
    const urlsB = Array.from({ length: 10 }, (_, i) => `https://b${i}.com/${i}`);
    const msgs = [
      assistant({ tools: [tool({ name: 'WebSearch', result: urlsA.join(' ') })] }),
      assistant({ tools: [tool({ name: 'WebSearch', result: urlsB.join(' ') })] }),
    ];
    // 错误实现（整会话拼一次）得 8；正确实现每消息各 8、跨消息不重复 → 16
    assert.strictEqual(aggregateSessionOutput(msgs).sources.length, 16);
  });

  it('turns = assistant 消息数；user 消息不参与聚合', () => {
    const out = aggregateSessionOutput([
      userMsg(),
      assistant(),
      assistant({ tools: [tool({ name: 'Write', input: { file_path: 'a.md' } })] }),
    ]);
    assert.strictEqual(out.turns, 2);
    assert.strictEqual(out.writes.length, 1);
  });
});

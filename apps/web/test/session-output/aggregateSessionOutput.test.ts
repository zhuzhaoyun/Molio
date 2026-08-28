// apps/web/test/session-output/aggregateSessionOutput.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { aggregateSessionOutput } from '../../src/utils/workSteps.ts';
import type { ChatMessage, ToolEvent } from '../../src/hooks/useChatCore.ts';

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

  it('同一文件多形态上报（绝对 / ./ 相对）归一化去重为一条', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ name: 'Write', input: { file_path: '/vault/wiki/hot.md' } }),
          tool({ name: 'Edit', input: { file_path: './wiki/hot.md' } }),
          tool({ name: 'Write', input: { file_path: '/vault/wiki/hot.md' } }),
        ],
      }),
    ];
    const { writes } = aggregateSessionOutput(msgs, '/vault');
    assert.strictEqual(writes.length, 1);
    // 去重时保留更完整（更长）的上报形态
    assert.strictEqual(writes[0]!.path, '/vault/wiki/hot.md');
  });

  it('同名不同目录的文件 label 加父目录消歧', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ name: 'Edit', input: { file_path: 'wiki/INDEX.md' } }),
          tool({ name: 'Edit', input: { file_path: 'wiki/sources/INDEX.md' } }),
          tool({ name: 'Edit', input: { file_path: 'wiki/log.md' } }),
        ],
      }),
    ];
    const labels = aggregateSessionOutput(msgs).writes.map((w) => w.label);
    // log.md 唯一，保持裸名；两个 INDEX.md 用尾部两级路径区分
    assert.ok(labels.includes('log.md'));
    const indexLabels = labels.filter((l) => l.endsWith('INDEX.md')).sort();
    assert.deepEqual(indexLabels, ['sources/INDEX.md', 'wiki/INDEX.md']);
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

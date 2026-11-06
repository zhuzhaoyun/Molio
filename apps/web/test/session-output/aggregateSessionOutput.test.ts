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
          tool({ name: 'Write', input: { file_path: '/vault/wiki/concepts/盗窃罪.md' } }),
          tool({ name: 'Edit', input: { file_path: './wiki/concepts/盗窃罪.md' } }),
          tool({ name: 'Write', input: { file_path: '/vault/wiki/concepts/盗窃罪.md' } }),
        ],
      }),
    ];
    const { writes } = aggregateSessionOutput(msgs, '/vault');
    assert.strictEqual(writes.length, 1);
    // 去重时保留更完整（更长）的上报形态
    assert.strictEqual(writes[0]!.path, '/vault/wiki/concepts/盗窃罪.md');
  });

  it('同名不同目录的文件 label 加父目录消歧', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ name: 'Write', input: { file_path: 'wiki/笔记/总结.md' } }),
          tool({ name: 'Write', input: { file_path: 'wiki/归档/总结.md' } }),
          tool({ name: 'Write', input: { file_path: 'wiki/概念/总结.md' } }),
        ],
      }),
    ];
    const labels = aggregateSessionOutput(msgs).writes.map((w) => w.label);
    // 用集合比，不耦中文排序规则
    assert.deepEqual(new Set(labels), new Set(['归档/总结.md', '笔记/总结.md', '概念/总结.md']));
  });

  it('元文件与文档同名时，消歧只在各自的篮子里做', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ name: 'Write', input: { file_path: 'wiki/笔记/INDEX.md' } }),
          tool({ name: 'Write', input: { file_path: 'wiki/笔记/总结.md' } }),
        ],
      }),
    ];
    const out = aggregateSessionOutput(msgs);
    // INDEX.md 进了折叠区，不和产出清单里的名字互相影响
    assert.deepEqual(out.writes.map((w) => w.label), ['总结.md']);
    assert.deepEqual(out.others.map((w) => w.label), ['INDEX.md']);
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

  describe('三层分流', () => {
    const noisy = [
      assistant({
        tools: [
          tool({ id: 'p', name: 'Write', input: { file_path: '/vault/wiki/concept.md' } }),
          tool({ id: 's', name: 'Write', input: { file_path: '/vault/scripts/build.py' } }),
          tool({ id: 'l', name: 'Edit', input: { file_path: '/vault/wiki/log.md' } }),
          tool({ id: 'h1', name: 'Write', input: { file_path: '/vault/.molio/wiki-build/plan.md' } }),
          tool({ id: 'h2', name: 'Write', input: { file_path: '/Users/albert/.claude/projects/x/memory/MEMORY.md' } }),
        ],
      }),
    ];

    it('writes 只留库内文档产出', () => {
      const out = aggregateSessionOutput(noisy, '/vault');
      assert.deepEqual(out.writes.map((w) => w.path), ['/vault/wiki/concept.md']);
    });

    it('库内非文档与构建日志进 others，保持首次出现顺序', () => {
      const msgs = [
        assistant({
          tools: [
            tool({ id: 's', name: 'Write', input: { file_path: '/vault/scripts/build.py' } }),
            tool({ id: 'd', name: 'Write', input: { file_path: '/vault/wiki/batches/a.tsv' } }),
            tool({ id: 'p', name: 'Write', input: { file_path: '/vault/wiki/concept.md' } }),
            tool({ id: 'l', name: 'Write', input: { file_path: '/vault/wiki/log.md' } }),
          ],
        }),
      ];
      const out = aggregateSessionOutput(msgs, '/vault');
      assert.deepEqual(out.writes.map((w) => w.path), ['/vault/wiki/concept.md']);
      assert.deepEqual(out.others.map((w) => w.path), [
        '/vault/scripts/build.py',
        '/vault/wiki/batches/a.tsv',
        '/vault/wiki/log.md',
      ]);
    });

    it('库外写入与隐藏目录既不进 writes 也不进 others', () => {
      const out = aggregateSessionOutput(noisy, '/vault');
      const all = [...out.writes, ...out.others].map((w) => w.path);
      assert.ok(!all.includes('.molio/wiki-build/plan.md'));
      assert.ok(!all.some((p) => p.startsWith('/Users/albert/.claude')));
    });

    it('other 条目同样带 messageId（面板要按它定位回对话）', () => {
      const out = aggregateSessionOutput(noisy, '/vault');
      assert.strictEqual(out.others[0]!.messageId, 'a');
      assert.strictEqual(out.others[0]!.label, 'build.py');
    });

    it('无 vaultPath 时仍能滤掉隐藏目录，其余按扩展名分流', () => {
      const msgs = [
        assistant({
          tools: [
            tool({ id: 'p', name: 'Write', input: { file_path: 'wiki/concept.md' } }),
            tool({ id: 's', name: 'Write', input: { file_path: 'scripts/build.py' } }),
            tool({ id: 'h', name: 'Write', input: { file_path: '.molio/plan.md' } }),
          ],
        }),
      ];
      const out = aggregateSessionOutput(msgs);
      assert.deepEqual(out.writes.map((w) => w.path), ['wiki/concept.md']);
      assert.deepEqual(out.others.map((w) => w.path), ['scripts/build.py']);
    });

    it('登记元文件（各级 INDEX.md / hot.md）进折叠区，不冒充产出', () => {
      const msgs = [
        assistant({
          tools: [
            tool({ id: 'p', name: 'Write', input: { file_path: '/vault/wiki/entities/长鑫存储.md' } }),
            tool({ id: 'i1', name: 'Write', input: { file_path: '/vault/wiki/INDEX.md' } }),
            tool({ id: 'i2', name: 'Write', input: { file_path: '/vault/wiki/entities/INDEX.md' } }),
            tool({ id: 'h', name: 'Write', input: { file_path: '/vault/wiki/hot.md' } }),
          ],
        }),
      ];
      const out = aggregateSessionOutput(msgs, '/vault');
      assert.deepEqual(out.writes.map((w) => w.path), ['/vault/wiki/entities/长鑫存储.md']);
      assert.deepEqual(out.others.map((w) => w.path), [
        '/vault/wiki/INDEX.md',
        '/vault/wiki/entities/INDEX.md',
        '/vault/wiki/hot.md',
      ]);
    });
  });

  // kind 不是「用了哪个工具」，而是「写之前这个路径在会话里出现过没有」——
  // Write 覆盖既有文件同样不是新建。判据与变更 tab（extractChanges）同源：
  // Claude Code 有 Read-before-Write 约束，覆写既有文件前几乎必然 Read 过。
  describe('写入 kind —— 新建 / 更新', () => {
    const write = (file_path: string) => tool({ name: 'Write', input: { file_path } });

    it('会话里从未出现过的路径：Write 记新建', () => {
      const out = aggregateSessionOutput([assistant({ tools: [write('wiki/a.md')] })]);
      assert.strictEqual(out.writes[0]!.kind, 'create');
    });

    it('同一路径写过两次仍是一条，kind 保持首次的新建', () => {
      const msgs = [assistant({ tools: [write('wiki/a.md'), write('wiki/a.md')] })];
      const out = aggregateSessionOutput(msgs);
      assert.strictEqual(out.writes.length, 1);
      assert.strictEqual(out.writes[0]!.kind, 'create');
    });

    it('同一条回复里先 Read 过：Write 记更新（覆写既有文件）', () => {
      const msgs = [
        assistant({
          tools: [
            tool({ name: 'Read', input: { file_path: 'wiki/hot.md' } }),
            write('wiki/hot.md'),
          ],
        }),
      ];
      const out = aggregateSessionOutput(msgs);
      assert.strictEqual(out.others[0]!.kind, 'update');
    });

    it('跨消息累积：上一条回复读过，这一条覆写算更新', () => {
      const msgs = [
        assistant({ tools: [tool({ name: 'Read', input: { file_path: 'wiki/a.md' } })] }),
        assistant({ tools: [write('wiki/a.md')] }),
      ];
      const out = aggregateSessionOutput(msgs);
      assert.strictEqual(out.writes[0]!.kind, 'update');
    });

    it('顺序敏感：Read 发生在 Write 之后，不影响该次判为新建', () => {
      const msgs = [
        assistant({
          tools: [
            write('wiki/a.md'),
            tool({ name: 'Read', input: { file_path: 'wiki/a.md' } }),
          ],
        }),
      ];
      const out = aggregateSessionOutput(msgs);
      assert.strictEqual(out.writes[0]!.kind, 'create');
    });

    it('Grep 带路径命中过也算该文件出现过', () => {
      const msgs = [
        assistant({
          tools: [
            tool({ name: 'Grep', input: { path: 'wiki/a.md', pattern: 'foo' } }),
            write('wiki/a.md'),
          ],
        }),
      ];
      const out = aggregateSessionOutput(msgs);
      assert.strictEqual(out.writes[0]!.kind, 'update');
    });

    it('增量编辑（Edit / MultiEdit / Append）一律记更新，不依赖是否读过', () => {
      const msgs = [
        assistant({
          tools: [
            tool({ name: 'Edit', input: { file_path: 'wiki/a.md', old_string: 'x', new_string: 'y' } }),
            tool({ name: 'MultiEdit', input: { file_path: 'wiki/b.md', edits: [] } }),
            tool({ name: 'Append', input: { file_path: 'wiki/c.md', content: 'z' } }),
          ],
        }),
      ];
      const out = aggregateSessionOutput(msgs);
      assert.deepEqual(out.writes.map((w) => w.kind), ['update', 'update', 'update']);
    });

    it('库内绝对路径与相对路径混报时，按归一化后的路径判定', () => {
      const msgs = [
        assistant({ tools: [tool({ name: 'Read', input: { file_path: '/vault/wiki/a.md' } })] }),
        assistant({ tools: [write('./wiki/a.md')] }),
      ];
      const out = aggregateSessionOutput(msgs, '/vault');
      assert.strictEqual(out.writes[0]!.kind, 'update');
    });
  });
});

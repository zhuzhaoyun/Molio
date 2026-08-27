// apps/web/test/session-output/extractChanges.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractChanges } from '../../src/utils/workSteps.ts';
import type { ChatMessage, ToolEvent } from '../../src/hooks/useChatCore.ts';

function tool(over: Partial<ToolEvent> = {}): ToolEvent {
  return { id: 't', name: 'Read', status: 'done', input: {}, isError: false, result: '', ...over };
}
function assistant(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a', role: 'assistant', content: '', timestamp: 0, tools: [], ...over };
}

describe('extractChanges', () => {
  it('抽取所有写入工具，同文件多次改动按出现顺序保留（不去重）', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ id: 'e1', name: 'Write', input: { file_path: '/vault/wiki/a.md' } }),
          tool({ id: 'e2', name: 'Edit', input: { file_path: '/vault/wiki/a.md', old_string: '旧', new_string: '新' } }),
          tool({ id: 'e3', name: 'Read', input: { file_path: '/vault/wiki/other.md' } }), // 非写入，忽略
        ],
      }),
    ];
    const changes = extractChanges(msgs, '/vault');
    // a.md 两条（Write + Edit），Read 不出现
    assert.strictEqual(changes.length, 2);
    assert.strictEqual(changes[0]!.path, 'wiki/a.md');
    assert.strictEqual(changes[0]!.toolName, 'Write');
    assert.strictEqual(changes[1]!.toolName, 'Edit');
    assert.ok(changes[1]!.diff);
    assert.deepEqual(changes[1]!.diff, [
      { type: 'del', text: '旧' },
      { type: 'add', text: '新' },
    ]);
  });

  it('Write → create + write-new-file 占位；Append → append 占位', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ id: 'w', name: 'Write', input: { file_path: '/vault/wiki/hot.md' } }),
          tool({ id: 'ap', name: 'Append', input: { file_path: '/vault/wiki/log.md' } }),
        ],
      }),
    ];
    const changes = extractChanges(msgs, '/vault');
    assert.strictEqual(changes.length, 2);
    assert.strictEqual(changes[0]!.kind, 'create');
    assert.strictEqual(changes[0]!.placeholder, 'write-new-file');
    assert.strictEqual(changes[1]!.kind, 'append');
    assert.strictEqual(changes[1]!.placeholder, 'append-file');
  });

  it('绝对 / ./ 相对形态归一化为同一 path key', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ id: 'e1', name: 'Edit', input: { file_path: '/vault/wiki/hot.md', old_string: 'x', new_string: 'y' } }),
          tool({ id: 'e2', name: 'Edit', input: { file_path: './wiki/hot.md', old_string: 'y', new_string: 'z' } }),
        ],
      }),
    ];
    const changes = extractChanges(msgs, '/vault');
    assert.strictEqual(changes.length, 2);
    assert.ok(changes.every((c) => c.path === 'wiki/hot.md'));
  });

  it('error 工具与 running 工具被排除', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ id: 'ok', name: 'Edit', input: { file_path: '/vault/wiki/hot.md', old_string: 'a', new_string: 'b' }, status: 'done' }),
          tool({ id: 'err', name: 'Edit', input: { file_path: '/vault/wiki/bad.md' }, isError: true }),
          tool({ id: 'run', name: 'Write', input: { file_path: '/vault/wiki/x.md' }, status: 'running' }),
        ],
      }),
    ];
    assert.strictEqual(extractChanges(msgs, '/vault').length, 1);
  });

  it('概要行数：Write 的 content 行数 = adds；Append 同理；Edit 由 diff 统计', () => {
    const msgs = [
      assistant({
        tools: [
          tool({ id: 'w', name: 'Write', input: { file_path: '/vault/wiki/new.md', content: '# 标题\n\n正文' } }),
          tool({ id: 'ap', name: 'Append', input: { file_path: '/vault/wiki/log.md', content: '新行1\n新行2' } }),
          tool({ id: 'ed', name: 'Edit', input: { file_path: '/vault/wiki/a.md', old_string: 'a1\na2', new_string: 'b1' } }),
        ],
      }),
    ];
    const [w, ap, ed] = extractChanges(msgs, '/vault');
    assert.strictEqual(w!.adds, 3);
    assert.strictEqual(w!.dels, undefined);
    assert.strictEqual(ap!.adds, 2);
    assert.strictEqual(ed!.adds, 1);
    assert.strictEqual(ed!.dels, 2);
  });

  it('MultiEdit：edits 数组逐段 diff 拼接，± 为合计', () => {
    const msgs = [
      assistant({
        tools: [
          tool({
            id: 'me', name: 'MultiEdit',
            input: {
              file_path: '/vault/wiki/a.md',
              edits: [
                { old_string: 'x1\nx2', new_string: 'y1' },
                { old_string: 'z', new_string: 'w1\nw2' },
              ],
            },
          }),
        ],
      }),
    ];
    const [c] = extractChanges(msgs, '/vault');
    assert.strictEqual(c!.adds, 3);
    assert.strictEqual(c!.dels, 3);
    assert.strictEqual(c!.diff!.length, 6);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSessionSources } from './sessionSources.ts';
import type { ChatMessage, ToolEvent } from '../hooks/useChatCore.ts';

/** 构造一条 assistant 消息，工具一律 done（extractSources 只收 done）。 */
function msg(id: string, tools: Array<{ name: string; input: unknown }>): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 0,
    tools: tools.map((t, i) => ({
      id: `${id}-t${i}`,
      name: t.name,
      input: t.input,
      status: 'done',
    })) as ToolEvent[],
  };
}

describe('aggregateSessionSources', () => {
  test('空输入 → 空数组', () => {
    assert.deepEqual(aggregateSessionSources([]), []);
    assert.deepEqual(aggregateSessionSources([msg('m1', [])]), []);
  });

  test('Read 的 file_path 计入文件，计数跨轮累加、只出一行', () => {
    const messages = [
      msg('m1', [{ name: 'Read', input: { file_path: '/v/wiki/a.md' } }]),
      msg('m2', [
        { name: 'Read', input: { file_path: '/v/wiki/a.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/b.md' } },
      ]),
    ];
    const out = aggregateSessionSources(messages, '/v');
    const a = out.find((r) => r.target.endsWith('a.md'));
    assert.equal(a?.count, 2);
    assert.equal(out.filter((r) => r.target.endsWith('a.md')).length, 1);
    assert.equal(a?.kind, 'file');
  });

  test('Grep 的目录路径不计入（不是文件）；带扩展名的文件计入', () => {
    const messages = [
      msg('m1', [
        { name: 'Grep', input: { pattern: '盗刷', path: '/v/raw' } },
        { name: 'Grep', input: { pattern: '盗刷', path: '/v/raw/case.md' } },
      ]),
    ];
    const out = aggregateSessionSources(messages, '/v');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.target.endsWith('case.md'), true);
  });

  test('Glob 的 pattern 不计入（navigable:false）', () => {
    const messages = [msg('m1', [{ name: 'Glob', input: { pattern: '**/*.md' } }])];
    assert.deepEqual(aggregateSessionSources(messages), []);
  });

  test('库外路径与隐藏目录（.molio/.claude）引用被过滤', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/outside/memory/MEMORY.md' } },
        { name: 'Read', input: { file_path: '/v/.molio/cache/x.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/keep.md' } },
      ]),
    ];
    const out = aggregateSessionSources(messages, '/v');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.target.endsWith('keep.md'), true);
  });

  test('URL（WebFetch）保留且归 url 组', () => {
    const messages = [msg('m1', [{ name: 'WebFetch', input: { url: 'https://example.com/a' } }])];
    const out = aggregateSessionSources(messages, '/v');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, 'url');
    assert.equal(out[0]!.target, 'https://example.com/a');
  });

  test('排序：count 降序，同 count 按首次出现', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/v/one.md' } },
        { name: 'Read', input: { file_path: '/v/two.md' } },
      ]),
      msg('m2', [{ name: 'Read', input: { file_path: '/v/two.md' } }]),
    ];
    const out = aggregateSessionSources(messages, '/v').filter((r) => r.kind === 'file');
    assert.equal(out[0]!.target.endsWith('two.md'), true);
    assert.equal(out[1]!.target.endsWith('one.md'), true);
  });

  test('同名文件 label 加父目录消歧', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/v/a/note.md' } },
        { name: 'Read', input: { file_path: '/v/b/note.md' } },
      ]),
    ];
    const labels = aggregateSessionSources(messages, '/v').filter((r) => r.kind === 'file').map((r) => r.label);
    assert.equal(new Set(labels).size, 2);
  });

  test('同一文件的不同上报形态（绝对/./相对/相对）→ 只出一行、计数合并', () => {
    const messages = [
      msg('m1', [{ name: 'Read', input: { file_path: '/v/wiki/a.md' } }]),
      msg('m2', [{ name: 'Bash', input: { command: 'cat ./wiki/a.md' } }]),
      msg('m3', [{ name: 'Grep', input: { pattern: 'x', path: 'wiki/a.md' } }]),
    ];
    const out = aggregateSessionSources(messages, '/v').filter((r) => r.kind === 'file');
    assert.equal(out.length, 1);            // 同一文件三形态归一化后只一行
    assert.equal(out[0]!.count, 3);
    assert.equal(out[0]!.label, 'a.md');    // 未触发同名消歧（无前缀路径）
  });

  test('Grep 的 glob 路径与目录路径不计入', () => {
    const messages = [
      msg('m1', [
        { name: 'Grep', input: { pattern: 'x', path: '/v/src/**/*.ts' } }, // glob 元字符
        { name: 'Grep', input: { pattern: 'x', path: '/v/raw' } },          // 目录（无扩展名）
      ]),
    ];
    assert.deepEqual(aggregateSessionSources(messages, '/v'), []);
  });

  test('Read 无扩展名文件（Makefile）仍计入', () => {
    const messages = [msg('m1', [{ name: 'Read', input: { file_path: '/v/Makefile' } }])];
    const out = aggregateSessionSources(messages, '/v');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.label, 'Makefile');
  });
});

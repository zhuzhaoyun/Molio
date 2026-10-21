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
  test('空输入 → 空结果', () => {
    assert.deepEqual(aggregateSessionSources([]), { refs: [], meta: [], omitted: [] });
    assert.deepEqual(aggregateSessionSources([msg('m1', [])]), { refs: [], meta: [], omitted: [] });
  });

  /**
   * 登记骨架（INDEX.md/log.md/hot.md）是 wiki 技能每次启动必读的导航文件，
   * 用户从不关心 —— 真机验收（2026-10-20 法考库）里它们占主列表 4/15，
   * 「乱」的形状有一半是它们贡献的。与产出面板折叠 INDEX/log/hot 同款处理：
   * 归入独立的 meta 组，主列表只留真实内容。
   */
  test('登记骨架（INDEX/log/hot）归 meta 组，不进主列表', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/v/wiki/INDEX.md' } },
        { name: 'Read', input: { file_path: '/v/hot.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/log.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/信用卡诈骗罪.md' } },
      ]),
    ];
    const { refs, meta } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.label, '信用卡诈骗罪.md');
    assert.equal(meta.length, 3);
    const labels = meta.map((m) => m.label).sort();
    assert.deepEqual(labels, ['INDEX.md', 'hot.md', 'log.md']);
  });

  test('meta 组内同名消歧与计数独立进行', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/v/wiki/INDEX.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/INDEX.md' } },
        { name: 'Read', input: { file_path: '/v/concepts/INDEX.md' } },
      ]),
    ];
    const { meta } = aggregateSessionSources(messages, '/v');
    assert.equal(meta.length, 2);
    const byTarget = new Map(meta.map((m) => [m.target, m.count]));
    assert.equal(byTarget.get('/v/wiki/INDEX.md'), 2);
    assert.equal(byTarget.get('/v/concepts/INDEX.md'), 1);
    assert.equal(new Set(meta.map((m) => m.label)).size, 2); // 同名消歧生效
  });

  test('只有骨架被读 → refs 空但 meta 非空（面板据此仍渲染折叠组）', () => {
    const messages = [msg('m1', [{ name: 'Read', input: { file_path: '/v/wiki/INDEX.md' } }])];
    const { refs, meta } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 0);
    assert.equal(meta.length, 1);
  });

  test('Read 的 file_path 计入文件，计数跨轮累加、只出一行', () => {
    const messages = [
      msg('m1', [{ name: 'Read', input: { file_path: '/v/wiki/a.md' } }]),
      msg('m2', [
        { name: 'Read', input: { file_path: '/v/wiki/a.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/b.md' } },
      ]),
    ];
    const { refs } = aggregateSessionSources(messages, '/v');
    const a = refs.find((r) => r.target.endsWith('a.md'));
    assert.equal(a?.count, 2);
    assert.equal(refs.filter((r) => r.target.endsWith('a.md')).length, 1);
    assert.equal(a?.kind, 'file');
  });

  /**
   * 计数语义 = 引用次数，不是「有几条消息引用过」。
   * 回归背景：extractSources 在单条消息内就按 target 去重，于是同一轮里读了 3 次
   * 同一文件的面板 badge 仍是 1 —— 一排「1」看起来像坏掉的数字。
   */
  test('同一消息内重复引用同一文件 → count 按次数累加（不是消息数）', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/v/wiki/a.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/a.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/a.md' } },
      ]),
    ];
    const { refs } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.count, 3);
  });

  test('Grep 的目录路径不计入（不是文件）；带扩展名的文件计入', () => {
    const messages = [
      msg('m1', [
        { name: 'Grep', input: { pattern: '盗刷', path: '/v/raw' } },
        { name: 'Grep', input: { pattern: '盗刷', path: '/v/raw/case.md' } },
      ]),
    ];
    const { refs } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.target.endsWith('case.md'), true);
  });

  test('Glob 的 pattern 不进展示清单，但计入 omitted（消息内联标签里看得见它）', () => {
    const messages = [msg('m1', [{ name: 'Glob', input: { pattern: '**/*.md' } }])];
    const { refs, omitted } = aggregateSessionSources(messages);
    assert.equal(refs.length, 0);
    assert.equal(omitted.length, 1);
    assert.equal(omitted[0]!.target, '**/*.md');
  });

  test('库外路径与隐藏目录（.molio/.claude）引用被过滤', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/outside/memory/MEMORY.md' } },
        { name: 'Read', input: { file_path: '/v/.molio/cache/x.md' } },
        { name: 'Read', input: { file_path: '/v/wiki/keep.md' } },
      ]),
    ];
    const { refs } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.target.endsWith('keep.md'), true);
  });

  /**
   * omitted = 「消息内联引用标签里看得到、但引用 tab 不展示」的条数。
   * 这条差值是面板唯一会骗人的地方：用户在同一屏看到 8 个引用标签、面板只列 5 个，
   * 少的那几个会让人以为面板漏了 —— 必须在面板上明说，而不是让人自己数。
   */
  test('被过滤的引用计入 omitted（库外文件 / 隐藏目录 / 检索目录）', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/outside/memory/MEMORY.md' } },
        { name: 'Read', input: { file_path: '/v/.molio/cache/x.md' } },
        { name: 'Grep', input: { pattern: '罪', path: '/v/wiki' } },
        { name: 'Read', input: { file_path: '/v/wiki/keep.md' } },
      ]),
    ];
    const { refs, omitted } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 1);
    assert.equal(omitted.length, 3);
    const labels = omitted.map((o) => o.label).sort();
    assert.deepEqual(labels, ['MEMORY.md', 'wiki', 'x.md']);
  });

  test('omitted 跨消息去重：同一库外文件被多次引用只算 1 条（次数照记）', () => {
    const messages = [
      msg('m1', [{ name: 'Read', input: { file_path: '/outside/memory/MEMORY.md' } }]),
      msg('m2', [{ name: 'Read', input: { file_path: '/outside/memory/MEMORY.md' } }]),
    ];
    const { omitted } = aggregateSessionSources(messages, '/v');
    assert.equal(omitted.length, 1);
    assert.equal(omitted[0]!.count, 2);
  });

  test('URL 不计入 omitted（引用 tab 里有网页链接分组）', () => {
    const messages = [msg('m1', [{ name: 'WebFetch', input: { url: 'https://example.com/a' } }])];
    const { refs, omitted } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.kind, 'url');
    assert.equal(refs[0]!.target, 'https://example.com/a');
    assert.equal(omitted.length, 0);
  });

  test('排序：count 降序，同 count 按首次出现', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/v/one.md' } },
        { name: 'Read', input: { file_path: '/v/two.md' } },
      ]),
      msg('m2', [{ name: 'Read', input: { file_path: '/v/two.md' } }]),
    ];
    const { refs } = aggregateSessionSources(messages, '/v');
    const files = refs.filter((r) => r.kind === 'file');
    assert.equal(files[0]!.target.endsWith('two.md'), true);
    assert.equal(files[1]!.target.endsWith('one.md'), true);
  });

  test('同名文件 label 加父目录消歧', () => {
    const messages = [
      msg('m1', [
        { name: 'Read', input: { file_path: '/v/a/note.md' } },
        { name: 'Read', input: { file_path: '/v/b/note.md' } },
      ]),
    ];
    const labels = aggregateSessionSources(messages, '/v').refs
      .filter((r) => r.kind === 'file')
      .map((r) => r.label);
    assert.equal(new Set(labels).size, 2);
  });

  test('同一文件的不同上报形态（绝对/./相对/相对）→ 只出一行、计数合并', () => {
    const messages = [
      msg('m1', [{ name: 'Read', input: { file_path: '/v/wiki/a.md' } }]),
      msg('m2', [{ name: 'Bash', input: { command: 'cat ./wiki/a.md' } }]),
      msg('m3', [{ name: 'Grep', input: { pattern: 'x', path: 'wiki/a.md' } }]),
    ];
    const { refs } = aggregateSessionSources(messages, '/v');
    const files = refs.filter((r) => r.kind === 'file');
    assert.equal(files.length, 1);            // 同一文件三形态归一化后只一行
    assert.equal(files[0]!.count, 3);
    assert.equal(files[0]!.label, 'a.md');   // 未触发同名消歧（无前缀路径）
  });

  test('Grep 的 glob 路径与目录路径不计入', () => {
    const messages = [
      msg('m1', [
        { name: 'Grep', input: { pattern: 'x', path: '/v/src/**/*.ts' } }, // glob 元字符
        { name: 'Grep', input: { pattern: 'x', path: '/v/raw' } },          // 目录（无扩展名）
      ]),
    ];
    const { refs, omitted } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 0);
    assert.equal(omitted.length, 2);
  });

  test('Read 无扩展名文件（Makefile）仍计入', () => {
    const messages = [msg('m1', [{ name: 'Read', input: { file_path: '/v/Makefile' } }])];
    const { refs } = aggregateSessionSources(messages, '/v');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.label, 'Makefile');
  });
});

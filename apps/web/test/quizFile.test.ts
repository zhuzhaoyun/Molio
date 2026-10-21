import { describe, it } from 'node:test';
import assert from 'node:assert';

const {
  quizDateStamp,
  sanitizeQuizTitle,
  buildQuizFilePath,
  serializeQuizMarkdown,
  saveQuizToVault,
} = await import('../src/utils/quizFile.ts');

const QUIZ = {
  version: 1 as const,
  title: '番茄工作法 · 3 题',
  questions: [{
    id: 'q1', type: 'single' as const, stem: '标准专注时长？',
    options: [{ key: 'A', text: '15 分钟' }, { key: 'B', text: '25 分钟' }],
    answer: ['B'], explanation: '25 分钟。',
    sources: [{ path: 'notes/番茄工作法.md', quote: '一个番茄钟为 25 分钟' }],
  }],
};

function fakeIo(existing: Set<string>) {
  const writes: Array<{ path: string; content: string }> = [];
  return {
    writes,
    io: {
      async readFile(_vaultId: string, filePath: string) {
        if (existing.has(filePath)) return { content: 'existing' };
        const error = new Error('Failed to read file: 404');
        throw error;
      },
      async writeFile(_vaultId: string, filePath: string, content: string) {
        writes.push({ path: filePath, content });
      },
    },
  };
}

describe('quiz file naming', () => {
  it('stamps the local date', () => {
    assert.equal(quizDateStamp(new Date(2026, 9, 19, 23, 59)), '2026-10-19');
  });

  it('sanitizes traversal, separators, control chars and length', () => {
    assert.equal(sanitizeQuizTitle('../../etc/passwd'), 'etc-passwd');
    assert.equal(sanitizeQuizTitle('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
    assert.equal(sanitizeQuizTitle('  \n\t  '), '练习');
    assert.equal(sanitizeQuizTitle('x'.repeat(100)).length, 60);
    assert.ok(!sanitizeQuizTitle('..\\..\\secret').includes('..'));
  });

  it('builds a path inside 题库/', () => {
    assert.equal(
      buildQuizFilePath('2026-10-19', '番茄工作法'),
      '题库/2026-10-19-番茄工作法.md',
    );
  });
});

describe('serializeQuizMarkdown', () => {
  it('writes frontmatter, title and a quiz fence', () => {
    const markdown = serializeQuizMarkdown(QUIZ, new Date('2026-10-19T10:00:00.000Z'));
    assert.ok(markdown.startsWith('---\n'));
    assert.ok(markdown.includes('type: quiz'));
    assert.ok(markdown.includes('created: 2026-10-19T10:00:00.000Z'));
    assert.ok(markdown.includes('sources:\n  - "notes/番茄工作法.md"'));
    assert.ok(markdown.includes('# 番茄工作法 · 3 题'));
    assert.ok(markdown.includes('```quiz'));
    assert.ok(markdown.includes('"version": 1'));
  });
});

describe('saveQuizToVault', () => {
  it('writes to the first free filename', async () => {
    const { io, writes } = fakeIo(new Set());
    const path = await saveQuizToVault('vault-1', QUIZ, io, new Date(2026, 9, 19));
    assert.equal(path, '题库/2026-10-19-番茄工作法 · 3 题.md');
    assert.equal(writes.length, 1);
    assert.ok(writes[0]!.content.includes('```quiz'));
  });

  it('appends a sequence number instead of overwriting', async () => {
    const existing = new Set(['题库/2026-10-19-番茄工作法 · 3 题.md']);
    const { io, writes } = fakeIo(existing);
    const path = await saveQuizToVault('vault-1', QUIZ, io, new Date(2026, 9, 19));
    assert.equal(path, '题库/2026-10-19-番茄工作法 · 3 题-2.md');
    assert.equal(writes[0]!.path, path);
  });

  it('aborts on a non-404 read error instead of overwriting', async () => {
    const io = {
      async readFile() {
        throw new Error('Failed to read file: 413');
      },
      async writeFile() {
        assert.fail('must not write');
      },
    };
    await assert.rejects(
      () => saveQuizToVault('vault-1', QUIZ, io, new Date(2026, 9, 19)),
      /413/,
    );
  });
});

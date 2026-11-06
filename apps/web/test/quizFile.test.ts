import { describe, it } from 'node:test';
import assert from 'node:assert';

const {
  quizDateStamp,
  sanitizeQuizTitle,
  buildQuizFilePath,
  serializeQuizMarkdown,
  prefixRelativeImagePaths,
  saveQuizToVault,
} = await import('../src/utils/quizFile.ts');

type QuizFileInput = import('../src/utils/quizFile.ts').QuizFileInput;

const SINGLE_Q = {
  id: 'q1', type: 'single' as const, stem: '标准专注时长？',
  options: [{ key: 'A', text: '15 分钟' }, { key: 'B', text: '25 分钟' }],
  answer: ['B'], explanation: '25 分钟。',
  sources: [{ path: 'notes/番茄工作法.md', quote: '一个番茄钟为 25 分钟' }],
};

const FILL_Q = {
  id: 'q3', type: 'fill' as const, stem: '一个番茄钟后休息 ![图](wiki/images/rest.png)',
  options: [], answer: ['5 分钟'], explanation: '短休 5 分钟。',
  sources: [{ path: 'notes/另一份.md' }],
};

const SUBJECT_Q = {
  id: 'q2', type: 'subject' as const, stem: '谈谈你的理解。',
  options: [], answer: ['评分点一', '评分点二'], explanation: '见评分点。',
  sources: [],
};

const INPUT: QuizFileInput = {
  title: '番茄工作法 · 3 题', version: 1, fingerprint: 'a'.repeat(64), totalQuestions: 3,
  questions: [
    { number: 1, question: SINGLE_Q, outcome: 'wrong', given: 'A' },
    { number: 3, question: FILL_Q, outcome: 'correct', given: '5 分钟' },
  ],
};

const CREATED = new Date('2026-11-04T10:00:00.000Z');

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
  it('writes quoted frontmatter and no quiz fence', () => {
    const md = serializeQuizMarkdown(INPUT, CREATED);
    assert.ok(md.startsWith('---\n'));
    assert.ok(md.includes('type: quiz'));
    assert.ok(md.includes('created: 2026-11-04T10:00:00.000Z'));
    assert.ok(md.includes(`quiz_fingerprint: "${'a'.repeat(64)}"`));
    assert.ok(md.includes('quiz_protocol_version: 1'));
    assert.ok(md.includes('quiz_title: "番茄工作法 · 3 题"'));
    assert.ok(md.includes('quiz_saved_questions: 2'));
    assert.ok(md.includes('quiz_total_questions: 3'));
    assert.ok(md.includes('quiz_question_ids:\n  - "q1"\n  - "q3"'));
    assert.ok(!md.includes('```quiz'));
  });

  it('writes readable question bodies', () => {
    const md = serializeQuizMarkdown(INPUT, CREATED);
    assert.ok(md.includes('# 番茄工作法 · 3 题'));
    assert.ok(md.includes('> 2026-11-04 保存 · 2/3 题'));
    assert.ok(md.includes('## 第 1 题'));
    assert.ok(md.includes('- A. 15 分钟\n- B. 25 分钟'));
    assert.ok(md.includes('**答案**：B'));
    assert.ok(md.includes('**你的答案**：A ✗'));
    assert.ok(md.includes('**解析**：25 分钟。'));
    assert.ok(md.includes('出处：[[notes/番茄工作法.md]]'));
    assert.ok(md.includes('## 第 3 题'));
    assert.ok(md.includes('**你的答案**：5 分钟 ✓'));
    assert.ok(md.split('\n---\n').length >= 2, 'questions are separated by ---');
  });

  it('keeps model text safe for YAML', () => {
    const md = serializeQuizMarkdown({ ...INPUT, title: 'a: b # c' }, CREATED);
    assert.ok(md.includes('quiz_title: "a: b # c"'));
  });

  it('only lists sources of the selected questions', () => {
    const md = serializeQuizMarkdown({ ...INPUT, questions: [INPUT.questions[0]!] }, CREATED);
    assert.ok(md.includes('notes/番茄工作法.md'));
    assert.ok(!md.includes('notes/另一份.md'));
    assert.ok(md.includes('quiz_saved_questions: 1'));
  });

  it('omits the fingerprint line when there is none', () => {
    const md = serializeQuizMarkdown({ ...INPUT, fingerprint: null }, CREATED);
    assert.ok(!md.includes('quiz_fingerprint:'));
  });

  it('renders subject points, grading and the missing-answer case', () => {
    const md = serializeQuizMarkdown({
      ...INPUT,
      questions: [{ number: 2, question: SUBJECT_Q, outcome: 'wrong', given: null, grading: { score: 4, total: 6 } }],
    }, CREATED);
    assert.ok(md.includes('**答案**：\n1. 评分点一\n2. 评分点二'));
    assert.ok(md.includes('**你的答案**：见会话'));
    assert.ok(md.includes('**批改**：4/6'));
  });

  it('marks an untouched question as unanswered', () => {
    const md = serializeQuizMarkdown({
      ...INPUT,
      questions: [{ number: 1, question: SINGLE_Q, outcome: 'ungraded', given: '' }],
    }, CREATED);
    assert.ok(md.includes('**你的答案**：未作答'));
    assert.ok(!md.includes('✗'));
  });

  it('joins multiple-choice answers', () => {
    const multi = { ...SINGLE_Q, type: 'multiple' as const, answer: ['A', 'C'] };
    const md = serializeQuizMarkdown({
      ...INPUT, questions: [{ number: 1, question: multi, outcome: 'correct', given: 'A、C' }],
    }, CREATED);
    assert.ok(md.includes('**答案**：A、C'));
  });
});

describe('prefixRelativeImagePaths', () => {
  it('prefixes vault-root relative images with one level', () => {
    assert.equal(prefixRelativeImagePaths('![x](wiki/a.png)'), '![x](../wiki/a.png)');
    assert.equal(prefixRelativeImagePaths('![x](../wiki/a.png)'), '![x](../wiki/a.png)');
    assert.equal(prefixRelativeImagePaths('![x](/wiki/a.png)'), '![x](/wiki/a.png)');
    assert.equal(prefixRelativeImagePaths('![x](https://e/a.png)'), '![x](https://e/a.png)');
  });

  it('leaves fenced code blocks alone', () => {
    const input = '```\n![x](wiki/a.png)\n```';
    assert.equal(prefixRelativeImagePaths(input), input);
  });

  it('rewrites the stem image in the saved file', () => {
    const md = serializeQuizMarkdown(INPUT, CREATED);
    assert.ok(md.includes('![图](../wiki/images/rest.png)'));
  });
});

describe('saveQuizToVault', () => {
  it('writes to the first free filename', async () => {
    const { io, writes } = fakeIo(new Set());
    const path = await saveQuizToVault('vault-1', INPUT, io, new Date(2026, 9, 19));
    assert.equal(path, '题库/2026-10-19-番茄工作法 · 3 题.md');
    assert.equal(writes.length, 1);
    assert.ok(writes[0]!.content.includes('## 第 1 题'));
  });

  it('writes only the selected questions', async () => {
    const { io, writes } = fakeIo(new Set());
    await saveQuizToVault('vault-1', { ...INPUT, questions: [INPUT.questions[0]!] }, io, new Date(2026, 9, 19));
    assert.ok(writes[0]!.content.includes('## 第 1 题'));
    assert.ok(!writes[0]!.content.includes('## 第 3 题'));
  });

  it('appends a sequence number instead of overwriting', async () => {
    const existing = new Set(['题库/2026-10-19-番茄工作法 · 3 题.md']);
    const { io, writes } = fakeIo(existing);
    const path = await saveQuizToVault('vault-1', INPUT, io, new Date(2026, 9, 19));
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
      () => saveQuizToVault('vault-1', INPUT, io, new Date(2026, 9, 19)),
      /413/,
    );
  });
});

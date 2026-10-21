/**
 * Quiz 协议纯函数。
 *
 * 这一层是所有渲染/持久化的入口：模型输出的是不可信文本，解析必须做到
 * 「整块坏 → 降级；单题坏 → 只废该题」，判分必须与答案 key 严格一致。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const {
  parseQuizBlock,
  gradeQuiz,
  isQuizComplete,
  computeQuizFingerprint,
  quizStorageKey,
  parseStoredQuizState,
  stripQuizForStreaming,
  quizStemOf,
  MAX_QUIZ_RAW_CHARS,
} = await import('../src/utils/quiz.ts');

const SINGLE = {
  id: 'q1',
  type: 'single' as const,
  stem: '1 + 1 = ?',
  options: [
    { key: 'A', text: '1' },
    { key: 'B', text: '2' },
  ],
  answer: ['B'],
  explanation: '**2** 是正确答案。',
  sources: [{ path: 'notes/math.md', quote: '1 + 1 = 2' }],
};

const VALID = { version: 1, title: '练习', questions: [SINGLE] };

function expectOk(raw: string) {
  const res = parseQuizBlock(raw);
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error(res.error);
  return res;
}

describe('parseQuizBlock', () => {
  it('parses a valid single-choice quiz', () => {
    const res = expectOk(JSON.stringify(VALID));
    assert.equal(res.quiz.title, '练习');
    assert.equal(res.quiz.questions.length, 1);
    assert.deepEqual(res.quiz.questions[0], SINGLE);
    assert.equal(res.invalidQuestions.length, 0);
  });

  it('fills implicit 正确/错误 options for judge questions', () => {
    const res = expectOk(JSON.stringify({
      version: 1,
      title: '判断题',
      questions: [{
        id: 'j1', type: 'judge', stem: '地球是圆的。',
        answer: ['A'], explanation: '常识。', sources: [{ path: 'notes/geo.md' }],
      }],
    }));
    assert.deepEqual(res.quiz.questions[0].options, [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' },
    ]);
  });

  it('rejects invalid JSON', () => {
    const res = parseQuizBlock('{not json');
    assert.equal(res.ok, false);
  });

  it('rejects an unsupported version', () => {
    const res = parseQuizBlock(JSON.stringify({ ...VALID, version: 2 }));
    assert.equal(res.ok, false);
  });

  it('keeps valid questions and reports the broken one', () => {
    const res = expectOk(JSON.stringify({
      ...VALID,
      questions: [
        SINGLE,
        { id: 'q2', type: 'single', stem: '坏题', options: [], answer: ['A'], explanation: 'x', sources: [{ path: 'p' }] },
      ],
    }));
    assert.equal(res.quiz.questions.length, 1);
    assert.equal(res.invalidQuestions.length, 1);
    assert.equal(res.invalidQuestions[0].index, 1);
    assert.equal(quizStemOf(res.invalidQuestions[0].raw), '坏题');
  });

  it('rejects an answer that is not in the options', () => {
    const res = parseQuizBlock(JSON.stringify({
      ...VALID,
      questions: [{ ...SINGLE, answer: ['C'] }],
    }));
    assert.equal(res.ok, false);
  });

  it('rejects duplicate question ids', () => {
    const res = parseQuizBlock(JSON.stringify({
      ...VALID,
      questions: [SINGLE, { ...SINGLE, stem: '另一题' }],
    }));
    assert.equal(res.ok, false);
  });

  it('rejects a multiple-choice question with one answer', () => {
    const res = parseQuizBlock(JSON.stringify({
      ...VALID,
      questions: [{ ...SINGLE, type: 'multiple', options: [...SINGLE.options, { key: 'C', text: '3' }] }],
    }));
    assert.equal(res.ok, false);
  });

  it('rejects the whole block when no question is valid', () => {
    const res = parseQuizBlock(JSON.stringify({
      ...VALID,
      questions: [{ id: 'q1', type: 'unknown', stem: 'x', answer: ['A'], explanation: 'x', sources: [{ path: 'p' }] }],
    }));
    assert.equal(res.ok, false);
  });

  it('rejects oversized raw JSON before parsing', () => {
    const res = parseQuizBlock('x'.repeat(MAX_QUIZ_RAW_CHARS + 1));
    assert.equal(res.ok, false);
  });

  it('rejects option keys longer than 64 chars and ids longer than 200', () => {
    // 与 daemon /api/quiz/attempts 的 chosen key / questionId 上限保持一致：
    // 渲染层放行、落库层整批拒绝 = 答题记录静默丢失。
    const longKey = { ...SINGLE, id: 'bad-key', options: [{ key: 'k'.repeat(65), text: 'x' }, { key: 'B', text: 'y' }], answer: ['B'] };
    const res = parseQuizBlock(JSON.stringify({ ...VALID, questions: [SINGLE, longKey] }));
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error(res.error);
    assert.equal(res.quiz.questions.length, 1);
    assert.equal(res.invalidQuestions.length, 1);
    assert.match(res.invalidQuestions[0]!.reason, /64/);

    const longId = parseQuizBlock(JSON.stringify({
      ...VALID,
      questions: [SINGLE, { ...SINGLE, id: 'q'.repeat(201) }],
    }));
    assert.equal(longId.ok, true);
    if (!longId.ok) throw new Error(longId.error);
    assert.equal(longId.quiz.questions.length, 1);
    assert.equal(longId.invalidQuestions.length, 1);
    assert.match(longId.invalidQuestions[0]!.reason, /200/);
  });

  it('rejects more than 100 questions', () => {
    const questions = Array.from({ length: 101 }, (_, i) => ({ ...SINGLE, id: `q${i}` }));
    const res = parseQuizBlock(JSON.stringify({ ...VALID, questions }));
    assert.equal(res.ok, false);
  });
});

describe('gradeQuiz / isQuizComplete', () => {
  it('grades single, multiple (exact only) and judge', () => {
    const judge = {
      id: 'j1', type: 'judge' as const, stem: 'x',
      options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }],
      answer: ['B'], explanation: 'x', sources: [{ path: 'p' }],
    };
    const multi = {
      id: 'm1', type: 'multiple' as const, stem: 'x',
      options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }],
      answer: ['A', 'B'], explanation: 'x', sources: [{ path: 'p' }],
    };
    const quiz = { version: 1 as const, title: 't', questions: [SINGLE, multi, judge] };

    const g = gradeQuiz(quiz, { q1: ['B'], m1: ['A'], j1: ['B'] });
    assert.deepEqual(g.map((x) => x.correct), [true, false, true]);
    assert.deepEqual(g[1].chosen, ['A']);

    const g2 = gradeQuiz(quiz, { q1: ['A'], m1: ['B', 'A'], j1: ['A'] });
    assert.deepEqual(g2.map((x) => x.correct), [false, true, false]);
    assert.deepEqual(g2[1].chosen, ['A', 'B']);
  });

  it('is complete only when every question has a valid selection', () => {
    const quiz = { version: 1 as const, title: 't', questions: [SINGLE] };
    assert.equal(isQuizComplete(quiz, {}), false);
    assert.equal(isQuizComplete(quiz, { q1: [] }), false);
    assert.equal(isQuizComplete(quiz, { q1: ['Z'] }), false);
    assert.equal(isQuizComplete(quiz, { q1: ['A'] }), true);
  });
});

describe('fingerprint / localStorage helpers', () => {
  it('fingerprint is stable across title changes and key order', async () => {
    const a = expectOk(JSON.stringify(VALID)).quiz;
    const b = expectOk(JSON.stringify({
      title: '另一个标题',
      questions: [{
        sources: [{ path: 'notes/math.md', quote: '1 + 1 = 2' }],
        explanation: '**2** 是正确答案。',
        answer: ['B'],
        options: [{ text: '1', key: 'A' }, { text: '2', key: 'B' }],
        stem: '1 + 1 = ?',
        type: 'single',
        id: 'q1',
      }],
      version: 1,
    })).quiz;
    const fa = await computeQuizFingerprint(a);
    const fb = await computeQuizFingerprint(b);
    assert.match(fa, /^[0-9a-f]{64}$/);
    assert.equal(fa, fb);
  });

  it('builds a key scoped by conversation and fingerprint', () => {
    assert.equal(quizStorageKey('conv-1', 'abc'), 'molio.quiz.conv-1.abc');
  });

  it('parses stored state and ignores malformed values', () => {
    assert.deepEqual(parseStoredQuizState('{"selections":{"q1":["B"]},"submitted":true}'), {
      selections: { q1: ['B'] }, submitted: true,
    });
    assert.deepEqual(parseStoredQuizState('{"selections":{"q1":"B","q2":[1]},"submitted":"yes"}'), {
      selections: {}, submitted: false,
    });
    assert.equal(parseStoredQuizState('not json'), null);
    assert.equal(parseStoredQuizState(null), null);
  });
});

describe('stripQuizForStreaming', () => {
  it('leaves plain text untouched', () => {
    assert.deepEqual(stripQuizForStreaming('hello'), { text: 'hello', generating: false });
  });

  it('reports generating for an unclosed fence and hides the JSON tail', () => {
    assert.deepEqual(stripQuizForStreaming('前言\n```quiz\n{"version":1,'), {
      text: '前言', generating: true,
    });
  });

  it('removes a complete quiz block from process text', () => {
    assert.deepEqual(stripQuizForStreaming('前言\n```quiz\n{}\n```\n后记'), {
      text: '前言\n\n后记', generating: false,
    });
  });

  it('handles a fence at the very start', () => {
    assert.deepEqual(stripQuizForStreaming('```quiz\n{}'), { text: '', generating: true });
  });
});

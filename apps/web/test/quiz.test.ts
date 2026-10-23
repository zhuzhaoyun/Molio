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
  isFillAnswerCorrect,
  normalizeFillText,
  MAX_QUIZ_RAW_CHARS,
  MAX_QUIZ_KEY_CHARS,
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

describe('fill 题型（填空）', () => {
  const FILL = {
    id: 'f1',
    type: 'fill' as const,
    stem: '标准番茄钟的专注时长为____分钟。',
    answer: ['25', '二十五'],
    explanation: '一个番茄钟为 25 分钟。',
    sources: [{ path: 'notes/番茄工作法.md' }],
  };

  it('parses a valid fill question without options', () => {
    const res = expectOk(JSON.stringify({ version: 1, title: '填空', questions: [FILL] }));
    assert.equal(res.quiz.questions[0].type, 'fill');
    assert.deepEqual(res.quiz.questions[0].options, []);
    assert.deepEqual(res.quiz.questions[0].answer, ['25', '二十五']);
    assert.equal(res.invalidQuestions.length, 0);
  });

  it('rejects a fill question that carries options', () => {
    const res = expectOk(JSON.stringify({
      version: 1, title: '填空',
      questions: [FILL, { ...FILL, id: 'f2', options: [{ key: 'A', text: '25' }] }],
    }));
    assert.equal(res.quiz.questions.length, 1);
    assert.equal(res.invalidQuestions.length, 1);
    assert.match(res.invalidQuestions[0]!.reason, /选项/);
  });

  it('rejects fill answers over 64 chars, duplicated or empty', () => {
    // 64 上限与 daemon /api/quiz/attempts 的 chosen 逐项上限一致：渲染放行、
    // 落库拒绝 = 答题记录静默丢失。
    const long = expectOk(JSON.stringify({
      version: 1, title: '填空',
      questions: [FILL, { ...FILL, id: 'f2', answer: ['x'.repeat(MAX_QUIZ_KEY_CHARS + 1)] }],
    }));
    assert.match(long.invalidQuestions[0]!.reason, /64/);

    const dup = expectOk(JSON.stringify({
      version: 1, title: '填空',
      questions: [FILL, { ...FILL, id: 'f2', answer: ['25', ' 25 '] }],
    }));
    assert.match(dup.invalidQuestions[0]!.reason, /重复/);

    const empty = expectOk(JSON.stringify({
      version: 1, title: '填空',
      questions: [FILL, { ...FILL, id: 'f2', answer: [] }],
    }));
    assert.equal(empty.invalidQuestions.length, 1);

    const tooMany = expectOk(JSON.stringify({
      version: 1, title: '填空',
      questions: [FILL, { ...FILL, id: 'f2', answer: Array.from({ length: 9 }, (_, i) => `写法${i}`) }],
    }));
    assert.match(tooMany.invalidQuestions[0]!.reason, /8/);
  });

  it('still rejects improvised subjective types (short_answer / essay)', () => {
    // 简答/论述不在协议内：必须走 invalid 路径，不得静默渲染。
    for (const type of ['short_answer', 'essay', '简答']) {
      const res = expectOk(JSON.stringify({
        version: 1, title: '主观',
        questions: [FILL, { id: 's1', type, stem: '论述。', answer: ['参考'], explanation: 'x', sources: [{ path: 'p' }] }],
      }));
      assert.equal(res.quiz.questions.length, 1);
      assert.equal(res.invalidQuestions.length, 1);
      assert.equal(res.invalidQuestions[0]!.index, 1);
    }
  });

  it('normalizes before matching: case, full/half width, spaces', () => {
    assert.equal(normalizeFillText('Ｃｌａｕｄｅ'), normalizeFillText('claude'));
    assert.ok(isFillAnswerCorrect('25', ['25']));
    assert.ok(isFillAnswerCorrect('  25  ', ['25']));
    assert.ok(isFillAnswerCorrect('Claude Code', ['claude code']));
    assert.ok(isFillAnswerCorrect('Ｃｌａｕｄｅ　Ｃｏｄｅ', ['claude code']));
    assert.ok(isFillAnswerCorrect('claudecode', ['Claude Code']));
    assert.ok(isFillAnswerCorrect('二十五', ['25', '二十五']));
    assert.ok(!isFillAnswerCorrect('', ['25']));
    assert.ok(!isFillAnswerCorrect('   ', ['25']));
    assert.ok(!isFillAnswerCorrect('二十四', ['25', '二十五']));
  });

  it('grades fill by normalized text match and reports the typed text', () => {
    const res = expectOk(JSON.stringify({
      version: 1, title: '填空',
      questions: [FILL, { ...FILL, id: 'f2', stem: '另一空：____。' }],
    }));
    const quiz = res.quiz;
    const grades = gradeQuiz(quiz, { f1: [' 二十五 '], f2: ['二十四'] });
    assert.equal(grades[0]!.correct, true);
    assert.deepEqual(grades[0]!.chosen, [' 二十五 ']);
    assert.equal(grades[1]!.correct, false);
    assert.deepEqual(grades[1]!.chosen, ['二十四']);
  });

  it('requires non-blank text for fill completeness', () => {
    const res = expectOk(JSON.stringify({ version: 1, title: '填空', questions: [FILL] }));
    const quiz = res.quiz;
    assert.equal(isQuizComplete(quiz, {}), false);
    assert.equal(isQuizComplete(quiz, { f1: ['   '] }), false);
    assert.equal(isQuizComplete(quiz, { f1: ['25'] }), true);
  });

  it('folds ascii notation on both sides before matching', () => {
    // 记法折叠只做「同一记法的不同写法」，不做数学等价（0.5 ≠ 1/2）。
    assert.ok(isFillAnswerCorrect('sqrt2/2', ['√2/2']));
    assert.ok(isFillAnswerCorrect('√2/2', ['sqrt2/2']));
    // 带括号的完整写法由模型在 answer 数组里并列给出（skill 的写法变体规则），
    // 折叠不猜括号——去括号会制造 (1+2)/4 与 1+2/4 的假等价。
    assert.ok(isFillAnswerCorrect('sqrt(2)/2', ['sqrt(2)/2']));
    assert.ok(isFillAnswerCorrect('2pi', ['2π']));
    assert.ok(isFillAnswerCorrect('π/4', ['pi/4']));
    assert.ok(isFillAnswerCorrect('a<=b', ['a≤b']));
    assert.ok(isFillAnswerCorrect('x>=1', ['x≥1']));
    assert.ok(isFillAnswerCorrect('a!=b', ['a≠b']));
    assert.ok(isFillAnswerCorrect('1+-i', ['1±i']));
    assert.ok(isFillAnswerCorrect('A->B', ['A→B']));
    // 折叠对两侧一致施加：普通单词同折后仍相等
    assert.ok(isFillAnswerCorrect('piano', ['piano']));
    assert.ok(!isFillAnswerCorrect('2pi', ['3π']));
    assert.ok(!isFillAnswerCorrect('0.5', ['1/2']));
  });
});

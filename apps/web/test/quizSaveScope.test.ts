import { describe, it } from 'node:test';
import assert from 'node:assert';

const {
  classifyQuestions,
  pickDefaultScope,
  selectForSave,
  buildQuizFileQuestions,
} = await import('../src/utils/quizSaveScope.ts');

type QuizSaveContext = import('../src/utils/quizSaveScope.ts').QuizSaveContext;

const SINGLE = {
  id: 'q1', type: 'single' as const, stem: '单选', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
  answer: ['B'], explanation: '', sources: [],
};
const SUBJECT = {
  id: 'q2', type: 'subject' as const, stem: '大题', options: [], answer: ['点一', '点二'],
  explanation: '', sources: [],
};
const FILL = {
  id: 'q3', type: 'fill' as const, stem: '填空', options: [], answer: ['5 分钟'],
  explanation: '', sources: [],
};
const MULTI = {
  id: 'q4', type: 'multiple' as const, stem: '多选', options: [],
  answer: ['A', 'C'], explanation: '', sources: [],
};

const QUIZ = { version: 1 as const, title: 't', questions: [SINGLE, SUBJECT, FILL, MULTI] };
const KEY = 'aaaa1111';

function ctx(overrides: Partial<QuizSaveContext> = {}): QuizSaveContext {
  return {
    submitted: false,
    grades: [],
    subjectGradings: new Map(),
    fingerprintKey: KEY,
    ...overrides,
  };
}

describe('classifyQuestions', () => {
  it('classifies a subject by its grading score, never by correct=false', () => {
    const out = classifyQuestions(QUIZ, ctx({
      submitted: true,
      // gradeQuiz 对 subject 一律 correct:false —— 不能拿它判错题。
      grades: [{ questionId: 'q2', correct: false, chosen: [] }],
      subjectGradings: new Map([[`${KEY}:2`, { questionIndex: 2, score: 4, total: 6, points: [] }]]),
    }));
    assert.equal(out[1]!.outcome, 'wrong');
  });

  it('treats a fully scored subject as correct', () => {
    const out = classifyQuestions(QUIZ, ctx({
      subjectGradings: new Map([[`${KEY}:2`, { questionIndex: 2, score: 6, total: 6, points: [] }]]),
    }));
    assert.equal(out[1]!.outcome, 'correct');
  });

  it('marks an ungraded subject as ungraded, not wrong', () => {
    const out = classifyQuestions(QUIZ, ctx({ submitted: true }));
    assert.equal(out[1]!.outcome, 'ungraded');
  });

  it('returns ungraded for every objective question before submission', () => {
    const out = classifyQuestions(QUIZ, ctx({ grades: [{ questionId: 'q1', correct: false, chosen: ['A'] }] }));
    assert.equal(out[0]!.outcome, 'ungraded');
    assert.equal(out[2]!.outcome, 'ungraded');
  });

  it('reads objective outcomes from the submitted grades', () => {
    const out = classifyQuestions(QUIZ, ctx({
      submitted: true,
      grades: [
        { questionId: 'q1', correct: false, chosen: ['A'] },
        { questionId: 'q3', correct: true, chosen: ['5 分钟'] },
        { questionId: 'q4', correct: true, chosen: ['A', 'C'] },
      ],
    }));
    assert.deepEqual(out.map((c) => c.outcome), ['wrong', 'ungraded', 'correct', 'correct']);
  });

  it('keeps indices aligned with the card numbering', () => {
    const out = classifyQuestions(QUIZ, ctx());
    assert.deepEqual(out.map((c) => c.index), [0, 1, 2, 3]);
  });
});

describe('pickDefaultScope', () => {
  it('defaults to wrong when any question was answered wrong', () => {
    assert.equal(pickDefaultScope([
      { index: 0, outcome: 'wrong' }, { index: 1, outcome: 'correct' },
    ]), 'wrong');
  });

  it('defaults to all when nothing is wrong', () => {
    assert.equal(pickDefaultScope([{ index: 0, outcome: 'ungraded' }]), 'all');
    assert.equal(pickDefaultScope([]), 'all');
  });
});

describe('selectForSave', () => {
  const candidates = [
    { index: 0, outcome: 'wrong' as const },
    { index: 1, outcome: 'correct' as const },
    { index: 2, outcome: 'ungraded' as const },
  ];

  it('keeps only wrong questions in wrong scope', () => {
    assert.deepEqual(selectForSave(candidates, 'wrong', new Set()).map((c) => c.index), [0]);
  });

  it('keeps everything in all scope', () => {
    assert.deepEqual(selectForSave(candidates, 'all', new Set()).map((c) => c.index), [0, 1, 2]);
  });

  it('keeps exactly the picked indices in pick scope', () => {
    assert.deepEqual(selectForSave(candidates, 'pick', new Set([1, 2])).map((c) => c.index), [1, 2]);
  });
});

describe('buildQuizFileQuestions', () => {
  it('renders typed answers and key lists as given text', () => {
    const out = buildQuizFileQuestions(
      QUIZ,
      classifyQuestions(QUIZ, ctx()),
      ctx(),
      { q1: ['A'], q3: ['5 分钟'], q4: ['C', 'A'] },
      new Map(),
    );
    assert.deepEqual(out.map((q) => q.number), [1, 2, 3, 4]);
    assert.equal(out[0]!.given, 'A');
    assert.equal(out[2]!.given, '5 分钟');
    assert.equal(out[3]!.given, 'A、C');
  });

  it('uses an empty string for a question the user never touched', () => {
    const out = buildQuizFileQuestions(QUIZ, [classifyQuestions(QUIZ, ctx())[0]!], ctx(), {}, new Map());
    assert.equal(out[0]!.given, '');
  });

  it('uses null for a subject whose answer body is missing', () => {
    const out = buildQuizFileQuestions(
      QUIZ, [classifyQuestions(QUIZ, ctx())[1]!], ctx(), {}, new Map(),
    );
    assert.equal(out[0]!.given, null);
  });

  it('uses the answer body for a subject', () => {
    const out = buildQuizFileQuestions(
      QUIZ,
      [classifyQuestions(QUIZ, ctx())[1]!],
      ctx(),
      {},
      new Map([[`${KEY}:2`, '我的作答']]),
    );
    assert.equal(out[0]!.given, '我的作答');
  });

  it('attaches the grading only to subjects that have one', () => {
    const context = ctx({
      subjectGradings: new Map([[`${KEY}:2`, { questionIndex: 2, score: 4, total: 6, points: [] }]]),
    });
    const [subject, single] = buildQuizFileQuestions(
      QUIZ,
      [classifyQuestions(QUIZ, context)[1]!, classifyQuestions(QUIZ, context)[0]!],
      context,
      {},
      new Map(),
    );
    assert.deepEqual(subject!.grading, { score: 4, total: 6 });
    assert.equal(single!.grading, undefined);
  });

  it('only includes the selected subset', () => {
    const out = buildQuizFileQuestions(
      QUIZ,
      selectForSave(classifyQuestions(QUIZ, ctx({ submitted: true, grades: [{ questionId: 'q1', correct: false, chosen: [] }] })), 'wrong', new Set()),
      ctx({ submitted: true, grades: [{ questionId: 'q1', correct: false, chosen: [] }] }),
      { q1: ['A'] },
      new Map(),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.number, 1);
  });
});

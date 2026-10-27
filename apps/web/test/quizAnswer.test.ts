/**
 * 大题作答的物化格式 + 批改回写解析的纯函数。
 *
 * 这里的输出格式是「唯一真源」：quiz skill 的批改协议按
 * 【大题作答·第N题】标记行确定性触发，两侧不得各自演化格式。
 * 物化 v2 在出处行后带「题目指纹」行（批改 ↔ 题卡关联键）；触发标记行
 * 字节不变。批改回复解析按 SKILL.md 批改协议的冻结格式：标记行
 * 【批改·第N题】得分 X/Y + 逐点行 N. 命中｜依据（枚举 命中/部分/未中）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const {
  subjectAnchorLabel,
  buildSubjectAnswerMessage,
  extractSubjectAnswerMeta,
  parseGradingReply,
  pairQuizGradings,
  gradingMapKey,
} = await import('../src/utils/quizAnswer.ts');

const ANCHOR = {
  questionIndex: 3,
  typeLabel: '解答题',
  stem: '证明：C_n^0 + C_n^1 + … + C_n^n = 2^n。',
  points: ['写出二项式定理公式', '代入 n=5 计算', '指出系数对称性'],
  sources: ['wiki/二项式定理.md', 'wiki/组合数的两个性质.md'],
  fingerprintKey: 'a1b2c3d4',
};

describe('subjectAnchorLabel', () => {
  it('joins index and type label', () => {
    assert.equal(subjectAnchorLabel({ questionIndex: 3, typeLabel: '解答题' }), '第3题 · 解答题');
    assert.equal(
      subjectAnchorLabel({ questionIndex: 12, typeLabel: 'Subjective' }),
      '第12题 · Subjective',
    );
  });
});

describe('buildSubjectAnswerMessage', () => {
  it('materializes stem, points, sources and the fingerprint line (v2)', () => {
    assert.equal(
      buildSubjectAnswerMessage(ANCHOR, '我的解答：由数学归纳法，n=1 时……'),
      [
        '【大题作答·第3题】',
        '题干：证明：C_n^0 + C_n^1 + … + C_n^n = 2^n。',
        '评分点：',
        '1. 写出二项式定理公式',
        '2. 代入 n=5 计算',
        '3. 指出系数对称性',
        '出处：wiki/二项式定理.md；wiki/组合数的两个性质.md',
        '题目指纹：a1b2c3d4',
        '',
        '我的解答：由数学归纳法，n=1 时……',
      ].join('\n'),
    );
  });

  it('omits the fingerprint line when the key is empty (fingerprint not ready)', () => {
    const msg = buildSubjectAnswerMessage({ ...ANCHOR, fingerprintKey: '' }, '答');
    assert.equal(msg.includes('题目指纹'), false);
    // 触发标记行仍在（批改契约不因指纹缺失而失效）。
    assert.ok(msg.startsWith('【大题作答·第3题】'));
  });

  it('renders a single point and single source without separators', () => {
    const msg = buildSubjectAnswerMessage(
      { ...ANCHOR, points: ['唯一评分点'], sources: ['wiki/a.md'] },
      '答',
    );
    assert.ok(msg.includes('1. 唯一评分点'));
    assert.equal(msg.includes('；'), false);
  });

  it('ends with the user text; empty text leaves only the blank separator', () => {
    const msg = buildSubjectAnswerMessage(ANCHOR, '');
    assert.equal(msg.endsWith('\n\n'), true);
    // 除收尾空行分隔符外不产生多余内容（没有「作答：」之类的空标签行）。
    const lines = msg.split('\n');
    assert.equal(lines[lines.length - 1], '');
    assert.equal(lines[lines.length - 2], '');
  });
});

describe('extractSubjectAnswerMeta', () => {
  it('reads questionIndex and fingerprint key from a v2 materialized message', () => {
    const msg = buildSubjectAnswerMessage(ANCHOR, '答');
    assert.deepEqual(extractSubjectAnswerMeta(msg), { questionIndex: 3, key: 'a1b2c3d4' });
    // 消息里带评分点编号等数字行不干扰题号提取。
    assert.ok(msg.includes('1. 写出二项式定理公式'));
  });

  it('returns null for v1 messages (no fingerprint line) and non-materialized text', () => {
    const v1 = buildSubjectAnswerMessage({ ...ANCHOR, fingerprintKey: '' }, '答');
    assert.equal(extractSubjectAnswerMeta(v1), null);
    assert.equal(extractSubjectAnswerMeta('普通聊天消息'), null);
  });
});

describe('parseGradingReply', () => {
  const REPLY = [
    '【批改·第4题】得分 2/3',
    '1. 命中｜写出定理公式，完全正确',
    '2. 部分命中｜代入正确但未指出对称性',
    '3. 未中｜结论错误，丢了一个常数项',
    '',
    '**错在哪里**：第三步把 +1 丢了。',
  ].join('\n');

  it('parses the marker line and consecutive point lines, leaves prose out', () => {
    assert.deepEqual(parseGradingReply(REPLY), {
      questionIndex: 4,
      score: 2,
      total: 3,
      points: [
        { status: 'hit', text: '写出定理公式，完全正确' },
        { status: 'partial', text: '代入正确但未指出对称性' },
        { status: 'miss', text: '结论错误，丢了一个常数项' },
      ],
    });
  });

  it('finds the marker anywhere (host may prepend context)', () => {
    const prefixed = `（来自题卡的作答）\n\n${REPLY}`;
    const parsed = parseGradingReply(prefixed);
    assert.equal(parsed?.questionIndex, 4);
    assert.equal(parsed?.total, 3);
  });

  it('accepts the short form 部分 and ignores half-streamed point lines', () => {
    const parsed = parseGradingReply(
      ['【批改·第1题】得分 1/2', '1. 命中｜对', '2. 部分｜依据', '3. 未'].join('\n'),
    );
    // 「3. 未」是半行（缺 ｜依据），不得计入。
    assert.equal(parsed?.points.length, 2);
    assert.equal(parsed?.points[1]!.status, 'partial');
  });

  it('returns null when the marker is missing or total is zero', () => {
    assert.equal(parseGradingReply('自由格式的批改文本，没有标记行'), null);
    assert.equal(parseGradingReply('【批改·第2题】得分 0/0\n1. 命中｜x'), null);
    assert.equal(parseGradingReply(''), null);
  });
});

describe('pairQuizGradings', () => {
  const answerFor = (index: number, key: string) =>
    buildSubjectAnswerMessage(
      { ...ANCHOR, questionIndex: index, fingerprintKey: key },
      '我的作答',
    );

  it('attaches a grading to the fingerprint of the most recent answer for that index', () => {
    const map = pairQuizGradings([
      { role: 'user', content: answerFor(4, 'aaaa1111') },
      { role: 'assistant', content: '【批改·第4题】得分 2/3\n1. 命中｜对' },
    ]);
    assert.equal(map.get(gradingMapKey('aaaa1111', 4))?.score, 2);
  });

  it('does not cross wires between two cards answering the same index', () => {
    const map = pairQuizGradings([
      { role: 'user', content: answerFor(3, 'aaaa1111') },
      { role: 'user', content: answerFor(3, 'bbbb2222') },
      { role: 'assistant', content: '【批改·第3题】得分 1/3\n1. 未中｜x' },
    ]);
    assert.equal(map.has(gradingMapKey('aaaa1111', 3)), false);
    assert.equal(map.get(gradingMapKey('bbbb2222', 3))?.score, 1);
  });

  it('keeps both gradings when one card holds two subject questions', () => {
    const map = pairQuizGradings([
      { role: 'user', content: answerFor(2, 'dddd4444') },
      { role: 'user', content: answerFor(4, 'dddd4444') },
      { role: 'assistant', content: '【批改·第2题】得分 1/2\n1. 部分｜x' },
      { role: 'assistant', content: '【批改·第4题】得分 2/2\n1. 命中｜y' },
    ]);
    assert.equal(map.get(gradingMapKey('dddd4444', 2))?.score, 1);
    assert.equal(map.get(gradingMapKey('dddd4444', 4))?.score, 2);
  });

  it('latest grading wins for the same card (re-answer overrides)', () => {
    const map = pairQuizGradings([
      { role: 'user', content: answerFor(3, 'cccc3333') },
      { role: 'assistant', content: '【批改·第3题】得分 0/3\n1. 未中｜第一版' },
      { role: 'user', content: answerFor(3, 'cccc3333') },
      { role: 'assistant', content: '【批改·第3题】得分 3/3\n1. 命中｜第二版' },
    ]);
    assert.equal(map.get(gradingMapKey('cccc3333', 3))?.score, 3);
  });

  it('drops gradings with no preceding materialized answer, ignores unrelated messages', () => {
    const map = pairQuizGradings([
      { role: 'assistant', content: '【批改·第2题】得分 1/2\n1. 命中｜凭空批改' },
      { role: 'user', content: '普通消息' },
      { role: 'assistant', content: '普通回复' },
    ]);
    assert.equal(map.size, 0);
  });
});

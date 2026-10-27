/**
 * 大题作答的物化格式纯函数。
 *
 * 这里的输出格式是「唯一真源」：skill 1.3.0 的批改协议按首行
 * 【大题作答·第N题】确定性触发，两侧不得各自演化格式。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const { subjectAnchorLabel, buildSubjectAnswerMessage } = await import(
  '../src/utils/quizAnswer.ts'
);

const ANCHOR = {
  questionIndex: 3,
  typeLabel: '解答题',
  stem: '证明：C_n^0 + C_n^1 + … + C_n^n = 2^n。',
  points: ['写出二项式定理公式', '代入 n=5 计算', '指出系数对称性'],
  sources: ['wiki/二项式定理.md', 'wiki/组合数的两个性质.md'],
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
  it('materializes stem, points and sources in the frozen format', () => {
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
        '',
        '我的解答：由数学归纳法，n=1 时……',
      ].join('\n'),
    );
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

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
  parseGradingReply,
  pairQuizGradings,
  pairSubjectAnswers,
  gradingMapKey,
} = await import('../src/utils/quizAnswer.ts');

const ANCHOR = {
  questionIndex: 3,
  stem: '证明：C_n^0 + C_n^1 + … + C_n^n = 2^n。',
  points: ['写出二项式定理公式', '代入 n=5 计算', '指出系数对称性'],
  sources: ['wiki/二项式定理.md', 'wiki/组合数的两个性质.md'],
  fingerprintKey: 'a1b2c3d4',
};

/** v2 单题物化消息的字面构建（buildSubjectAnswerMessage 已收为模块私有）。 */
const v2Message = (index: number, key: string, body = '我的作答') => [
  `【大题作答·第${index}题】`,
  `题干：${ANCHOR.stem}`,
  '评分点：',
  ...ANCHOR.points.map((point, i) => `${i + 1}. ${point}`),
  `出处：${ANCHOR.sources.join('；')}`,
  ...(key ? [`题目指纹：${key}`] : []),
  '',
  body,
].join('\n');

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

  // 真机事故（2026-10-27）：模型对 5 个评分点给 1.5 分（部分给分），标记行写成
  // 「得分 1.5/5」。旧正则只认整数分，整行匹配失败 → 整块批改被丢弃 → 题卡无徽标。
  it('accepts a fractional score in the marker line', () => {
    const parsed = parseGradingReply(
      [
        '【批改·第4题】得分 1.5/5',
        '1. 未中｜没有按题目要求的方向逐段论证',
        '2. 部分｜方向证到了，关键的构造步骤缺失',
        '3. 未中｜后面没再往下写',
      ].join('\n'),
    );
    assert.equal(parsed?.questionIndex, 4);
    assert.equal(parsed?.score, 1.5);
    assert.equal(parsed?.total, 5);
    assert.equal(parsed?.points.length, 3);
  });

  it('tolerates punctuation and spacing variations of the marker line', () => {
    // 模型自选排版：冒号、斜杠两侧空格、行尾句号都出现过。
    for (const line of [
      '【批改·第4题】得分 2/5',
      '【批改·第4题】得分：2/5',
      '【批改·第4题】得分 2 / 5',
      '【批改·第4题】得分 2/5。',
    ]) {
      const parsed = parseGradingReply(`${line}\n1. 命中｜依据`);
      assert.equal(parsed?.score, 2, line);
      assert.equal(parsed?.total, 5, line);
    }
  });

  it('accepts bullet-prefixed point lines and an ascii pipe separator', () => {
    const parsed = parseGradingReply(
      [
        '【批改·第4题】得分 1/3',
        '- 命中｜依据一',
        '- 部分 | 依据二',
        '- 未命中｜依据三',
      ].join('\n'),
    );
    assert.equal(parsed?.points.length, 3);
    assert.equal(parsed?.points[0]!.status, 'hit');
    assert.equal(parsed?.points[1]!.status, 'partial');
    // 「未命中」是「未中」的同义写法，按未中计。
    assert.equal(parsed?.points[2]!.status, 'miss');
  });

  it('stops collecting when the point-line style changes mid-block', () => {
    // 风格必须一致：首行是编号式，后面突然变成项目符号式 → 逐点块结束。
    const parsed = parseGradingReply(
      ['【批改·第1题】得分 1/2', '1. 命中｜对', '- 部分｜风格变了'].join('\n'),
    );
    assert.equal(parsed?.points.length, 1);
  });

  it('stops collecting when the numbering is not consecutive', () => {
    // 讲解里另起的编号列表（编号跳号）不得被并入评分点。
    const parsed = parseGradingReply(
      ['【批改·第1题】得分 1/2', '1. 命中｜对', '3. 未中｜跳号了'].join('\n'),
    );
    assert.equal(parsed?.points.length, 1);
  });

  // 真机同构：完整批改回复（标记行 + 5 条逐点行 + 空行 + 分隔线 + 讲解段落）。
  // 讲解段落里有大量「- 」「｜」形状的句子，绝不能被收成评分点。
  it('parses a full grading reply and stops at the prose section', () => {
    const REPLY = [
      '【批改·第2题】得分 1.5/4',
      '',
      '1. 未中｜全篇没有写出本节用到的判定定理的名字，条件里的两个已知量也没有逐一核对。',
      '2. 未中｜没有出现把通项代回递推式再移项化简的步骤，作答是从结论反推的。',
      '3. 部分｜单调性的方向确实论证到了，但缺少端点处取值的说明。',
      '4. 未中｜最后一行「证毕」之前没有回应题目问的第二个小问。',
      '5. 部分｜结论的写法抓对了，但两个系数的对应关系没有写全。',
      '',
      '---',
      '',
      '### 错在哪、正确思路是什么',
      '',
      '**第一，你的路线只走了一半。**',
      '',
      '- 先处理定义域：这一步必须单独做，否则后面的化简没有前提。',
      '- 对其余情形：把两式相减得到差分，再逐项验证。',
    ].join('\n');
    const parsed = parseGradingReply(REPLY);
    assert.equal(parsed?.questionIndex, 2);
    assert.equal(parsed?.score, 1.5);
    assert.equal(parsed?.total, 4);
    // 讲解段落里的 bullet 不得混进评分点。
    assert.equal(parsed?.points.length, 5);
    assert.deepEqual(
      parsed?.points.map((point) => point.status),
      ['miss', 'miss', 'partial', 'miss', 'partial'],
    );
  });

  it('stops at the prose section even when it contains a point-shaped line', () => {
    // 讲解段落里出现「- 命中｜…」形状的行（模型复述判定词）时不得被收成评分点。
    const parsed = parseGradingReply(
      [
        '【批改·第1题】得分 1/2',
        '1. 命中｜对',
        '',
        '- 命中｜这句在讲解里，不是一个评分点',
        '- 部分｜同理',
      ].join('\n'),
    );
    assert.equal(parsed?.points.length, 1);
    assert.equal(parsed?.points[0]!.status, 'hit');
  });
});

describe('pairQuizGradings', () => {
  const answerFor = (index: number, key: string) => v2Message(index, key);

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

describe('pairSubjectAnswers', () => {
  // 解答题的「已作答」态不在题卡本地——从会话消息序推导（交卷消息是消息
  // 流里的事实）。键与批改同构（指纹:题号），两张同有第 3 题的卡互不污染。
  const answerFor = (index: number, key: string) => v2Message(index, key);

  it('records the answered subject questions keyed by fingerprint and index', () => {
    const map = pairSubjectAnswers([
      { role: 'user', content: answerFor(4, 'aaaa1111') },
      { role: 'user', content: answerFor(2, 'aaaa1111') },
    ]);
    assert.deepEqual([...map.keys()].sort(), ['aaaa1111:2', 'aaaa1111:4'].sort());
  });

  it('does not leak the answered state across cards sharing the same index', () => {
    const map = pairSubjectAnswers([
      { role: 'user', content: answerFor(3, 'aaaa1111') },
      { role: 'user', content: answerFor(3, 'bbbb2222') },
    ]);
    assert.equal(map.has('aaaa1111:3'), true);
    assert.equal(map.has('bbbb2222:3'), true);
  });

  it('keeps the answer body so the saved file can quote it', () => {
    const map = pairSubjectAnswers([
      { role: 'user', content: answerFor(4, 'aaaa1111') },
    ]);
    assert.equal(map.get('aaaa1111:4'), '我的作答');
  });

  it('drops the header block when the body itself has blank lines', () => {
    const withBody = `${v2Message(1, 'aaaa1111', '')}第一段\n\n第二段`;
    const map = pairSubjectAnswers([{ role: 'user', content: withBody }]);
    assert.equal(map.get('aaaa1111:1'), '第一段\n\n第二段');
  });

  it('does not record an answer whose body is empty', () => {
    const map = pairSubjectAnswers([
      { role: 'user', content: v2Message(2, 'aaaa1111', '') },
    ]);
    assert.equal(map.size, 0);
  });

  it('ignores ordinary messages and unmaterialized answers', () => {
    const map = pairSubjectAnswers([
      { role: 'user', content: '普通消息' },
      { role: 'assistant', content: '普通回复' },
      // v1 物化消息（无指纹行）→ 无法归属到具体卡，不得算作已作答。
      { role: 'user', content: '【大题作答·第3题】\n题干：x\n评分点：\n1. y' },
    ]);
    assert.equal(map.size, 0);
  });
});

// ── v3：整卷一条消息 ──────────────────────────────────────────────────────

const {
  buildQuizSubmissionMessage,
  subjectImageMarkdown,
  extractSubjectAnswers,
  parseGradingReplies,
  mergeSubjectDrafts,
} = await import('../src/utils/quizAnswer.ts');
type Quiz = import('../src/utils/quiz.ts').Quiz;

const ENTRY_A = {
  questionIndex: 3,
  stem: ANCHOR.stem,
  points: ANCHOR.points,
  sources: ANCHOR.sources,
  fingerprintKey: 'a1b2c3d4',
  body: '我的解答：由数学归纳法……',
};
const ENTRY_B = {
  questionIndex: 5,
  stem: '论述番茄工作法为什么强调「一个番茄钟不可分割」。',
  points: ['指出打断破坏专注周期', '半个番茄钟不计入统计'],
  sources: ['wiki/番茄工作法.md'],
  fingerprintKey: 'a1b2c3d4',
  body: '理由如下……',
};

describe('buildQuizSubmissionMessage（v3 一卷一条消息）', () => {
  it('first line is the human-readable header; each entry is a byte-identical v2 block', () => {
    const msg = buildQuizSubmissionMessage('番茄工作法 · 5 题', [ENTRY_A, ENTRY_B]);
    const blockA = [
      '【大题作答·第3题】',
      `题干：${ENTRY_A.stem}`,
      '评分点：',
      '1. 写出二项式定理公式',
      '2. 代入 n=5 计算',
      '3. 指出系数对称性',
      '出处：wiki/二项式定理.md；wiki/组合数的两个性质.md',
      '题目指纹：a1b2c3d4',
      '',
      '我的解答：由数学归纳法……',
    ].join('\n');
    assert.equal(
      msg,
      ['提交判卷：《番茄工作法 · 5 题》', '', blockA, '', '【大题作答·第5题】', `题干：${ENTRY_B.stem}`, '评分点：', '1. 指出打断破坏专注周期', '2. 半个番茄钟不计入统计', '出处：wiki/番茄工作法.md', '题目指纹：a1b2c3d4', '', '理由如下……'].join('\n'),
    );
  });

  it('returns empty string for no entries (caller skips sending)', () => {
    assert.equal(buildQuizSubmissionMessage('任意', []), '');
  });
});

describe('subjectImageMarkdown', () => {
  it('renders vault-relative paths as markdown lines; empty stays empty', () => {
    assert.equal(subjectImageMarkdown(['raw/a.png', 'raw/b.jpg']), '![作答图片](raw/a.png)\n![作答图片](raw/b.jpg)');
    assert.equal(subjectImageMarkdown([]), '');
  });
});

describe('extractSubjectAnswers（多作答块提取）', () => {
  it('extracts every block from a v3 submission message', () => {
    const msg = buildQuizSubmissionMessage('卷子', [ENTRY_A, ENTRY_B]);
    const answers = extractSubjectAnswers(msg);
    assert.equal(answers.length, 2);
    assert.deepEqual(answers[0], { questionIndex: 3, key: 'a1b2c3d4', body: '我的解答：由数学归纳法……' });
    assert.deepEqual(answers[1], { questionIndex: 5, key: 'a1b2c3d4', body: '理由如下……' });
  });

  it('still extracts the single block from a legacy v2 message (regression)', () => {
    const msg = v2Message(3, 'a1b2c3d4', '旧版单题作答');
    assert.deepEqual(extractSubjectAnswers(msg), [
      { questionIndex: 3, key: 'a1b2c3d4', body: '旧版单题作答' },
    ]);
  });

  it('skips v1 blocks without fingerprint line and blocks with empty body', () => {
    const v1Block = v2Message(3, '', '无指纹作答');
    const emptyBody = buildQuizSubmissionMessage('卷', [{ ...ENTRY_A, body: '   ' }]);
    const msg = `${v1Block}\n\n${emptyBody}`;
    assert.deepEqual(extractSubjectAnswers(msg), []);
  });

  it('returns empty for plain chat text', () => {
    assert.deepEqual(extractSubjectAnswers('普通聊天消息'), []);
  });
});

describe('parseGradingReplies（多批改块解析）', () => {
  it('parses consecutive grading blocks in one reply, prose between blocks not miscollected', () => {
    const reply = [
      '【批改·第3题】得分 2/3',
      '1. 命中｜写出定理公式',
      '2. 部分｜代入正确但未指出对称性',
      '3. 未中｜结论错误',
      '',
      '**错在哪里**：第三步把 +1 丢了。',
      '',
      '【批改·第5题】得分 1/2',
      '1. 命中｜指出打断破坏专注周期',
      '2. 未中｜未提及统计口径',
      '',
      '整体来看，第二题需要补上统计口径的论证。',
    ].join('\n');
    const replies = parseGradingReplies(reply);
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[0], {
      questionIndex: 3, score: 2, total: 3,
      points: [
        { status: 'hit', text: '写出定理公式' },
        { status: 'partial', text: '代入正确但未指出对称性' },
        { status: 'miss', text: '结论错误' },
      ],
    });
    assert.deepEqual(replies[1], {
      questionIndex: 5, score: 1, total: 2,
      points: [
        { status: 'hit', text: '指出打断破坏专注周期' },
        { status: 'miss', text: '未提及统计口径' },
      ],
    });
  });

  it('returns only blocks that arrived (missing marker = missing grading, no fabrication)', () => {
    const reply = [
      '【批改·第3题】得分 3/3',
      '1. 命中｜完整',
      '',
      '【批改·第4题】得分 0/2',
      '1. 未中｜空白作答',
    ].join('\n');
    // 中间缺第 4 题后只剩一个块的场景：解析器只认到达的 marker，不补位。
    assert.equal(parseGradingReplies(reply).length, 2);
    assert.deepEqual(parseGradingReplies('没有批改标记的普通回复'), []);
  });
});

describe('mergeSubjectDrafts（草稿 ∪ 消息推导）', () => {
  const filler = (id: string) => ({
    id, type: 'single', stem: '占位', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
    answer: ['A'], explanation: 'e', sources: [{ path: 'p.md' }],
  });
  const quiz = JSON.parse(`{
    "version": 1, "title": "卷",
    "questions": [
      ${JSON.stringify(filler('q1'))},
      ${JSON.stringify(filler('q2'))},
      { "id": "s3", "type": "subject", "stem": "三", "answer": ["p3"], "explanation": "e", "sources": [{"path": "a.md"}] },
      ${JSON.stringify(filler('q4'))},
      { "id": "s5", "type": "subject", "stem": "五", "answer": ["p5"], "explanation": "e", "sources": [{"path": "b.md"}] }
    ]
  }`) as Quiz;

  it('drafts override derived; images append as markdown; derived-only keys survive', () => {
    const derived = new Map([['a1b2c3d4:5', '旧会话里第5题的作答']]);
    const merged = mergeSubjectDrafts(
      quiz,
      { s3: ['草稿正文'] },
      { s3: ['raw/paper.png'] },
      derived,
      'a1b2c3d4',
    );
    assert.equal(merged.get('a1b2c3d4:3'), '草稿正文\n![作答图片](raw/paper.png)');
    assert.equal(merged.get('a1b2c3d4:5'), '旧会话里第5题的作答');
    assert.equal(merged.size, 2);
  });

  it('empty draft text with images still counts (image-only answer)', () => {
    const merged = mergeSubjectDrafts(quiz, { s3: ['  '] }, { s3: ['raw/x.png'] }, new Map(), 'a1b2c3d4');
    assert.equal(merged.get('a1b2c3d4:3'), '![作答图片](raw/x.png)');
  });

  it('blank drafts without images do not appear', () => {
    const merged = mergeSubjectDrafts(quiz, { s3: ['  '] }, {}, new Map(), 'a1b2c3d4');
    assert.equal(merged.size, 0);
  });
});

describe('pairQuizGradings（重交覆盖：同一指纹同题号）', () => {
  it('a second grading for the same key overwrites the first', () => {
    const first = buildQuizSubmissionMessage('卷', [{ ...ENTRY_A, body: '第一版作答' }]);
    const grading1 = '【批改·第3题】得分 1/3\n1. 未中｜跑题了';
    const second = buildQuizSubmissionMessage('卷', [{ ...ENTRY_A, body: '重做后的作答' }]);
    const grading2 = '【批改·第3题】得分 3/3\n1. 命中｜完整';
    const gradings = pairQuizGradings([
      { role: 'user', content: first },
      { role: 'assistant', content: grading1 },
      { role: 'user', content: second },
      { role: 'assistant', content: grading2 },
    ]);
    const key = gradingMapKey('a1b2c3d4', 3);
    assert.equal(gradings.get(key)?.score, 3);
    assert.equal(gradings.size, 1);
  });
});

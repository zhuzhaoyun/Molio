// apps/web/src/utils/messageRail.test.ts
// 消息导航 rail 的纯函数口径（docs/2026-11-16-message-rail-design.md §4）：
//   - 刻度 = 一次提问（问答对）：user 开对，其后 assistant/error 并入，前导孤儿不入对
//   - 活跃刻度 = 第一个与视口相交的对；贴底（视口低于全部内容）= 末对
//   - 刻度布局：宽裕用 IDEAL=18/GAP=6，拥挤等差压缩，保底 MIN=4
//   - 可见阈值：≥3 对且内容溢出 >40px
//   - 预览清洗：剥图片/链接 markdown、折叠空白、超长截断
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRailPairs, findActivePair, railTickLayout, isRailVisible, previewText,
  RAIL_TICK_IDEAL, RAIL_TICK_MIN, RAIL_TICK_GAP, RAIL_MIN_PAIRS, RAIL_OVERFLOW_MIN,
} from './messageRail.ts';

const u = (content: string) => ({ role: 'user', content });
const a = (content = '答') => ({ role: 'assistant', content });

describe('buildRailPairs', () => {
  test('u,a,u,a,a,u → 3 对，lastMsgIndex 分别为 1/4/5，preview 为清洗后的 user 文本', () => {
    const pairs = buildRailPairs([u('问一'), a(), u('问二'), a(), a(), u('问三')]);
    assert.deepEqual(pairs.map((p) => [p.userMsgIndex, p.lastMsgIndex]), [[0, 1], [2, 4], [5, 5]]);
    assert.deepEqual(pairs.map((p) => p.preview), ['问一', '问二', '问三']);
  });

  test('开头的前导 assistant 不属于任何 pair（历史截断孤儿）', () => {
    const pairs = buildRailPairs([a('孤儿'), u('问'), a()]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.userMsgIndex, 1);
    assert.equal(pairs[0]!.lastMsgIndex, 2);
  });

  test('preview 走 previewText：剥整行图片、链接取文字', () => {
    const pairs = buildRailPairs([u('![image](/a.png)\n看 [这篇](./doc.md) 怎么说')]);
    assert.equal(pairs[0]!.preview, '看 这篇 怎么说');
  });

  test('quizCards：assistant 消息里的 quiz 围栏按渲染口径计数（M2 预览元信息）', () => {
    const quiz = '```quiz\n{"version":1,"title":"t","questions":[{"id":"q1","type":"single","stem":"s","options":[{"key":"A","text":"a"},{"key":"B","text":"b"}],"answer":["A"],"explanation":"e","sources":[{"path":"p.md"}]}]}\n```';
    const pairs = buildRailPairs([u('出题'), a(`讲一下。\n\n${quiz}`)]);
    assert.equal(pairs[0]!.quizCards, 1);
    // 一条 assistant 带两张卡 + 同轮另一条带一张 → 3
    const pairs2 = buildRailPairs([u('再来'), a(`${quiz}\n\n${quiz}`), a(quiz)]);
    assert.equal(pairs2[0]!.quizCards, 3);
  });

  test('quizCards：无题卡轮次为 undefined（预览退化为只有「第 N 问」）', () => {
    const pairs = buildRailPairs([u('问'), a('普通回答')]);
    assert.equal(pairs[0]!.quizCards, undefined);
  });

  test('quizCards：畸形 JSON 围栏不计数（与渲染器同口径——渲染不出来的不算）', () => {
    const bad = '```quiz\n{"version":1,"broken":true}\n```';
    const pairs = buildRailPairs([u('问'), a(`${bad}`)]);
    assert.equal(pairs[0]!.quizCards, undefined);
  });

  test('空数组 / 无 user → []', () => {
    assert.deepEqual(buildRailPairs([]), []);
    assert.deepEqual(buildRailPairs([a(), a()]), []);
  });
});

describe('findActivePair', () => {
  // 3 对：pair0 = 消息[0,1]，pair1 = 消息[2,4]，pair2 = 消息[5,5]
  const pairs = buildRailPairs([u('一'), a(), u('二'), a(), a(), u('三')]);
  // 消息几何：top 递增，pair 间留空隙（160-200 之间、420-500 之间）
  const tops = [0, 80, 200, 280, 350, 500];
  const heights = [60, 60, 60, 60, 70, 90];
  // pair 跨度：pair0 [0,140]，pair1 [200,420]，pair2 [500,590]

  test('视口相交首对', () => {
    assert.equal(findActivePair(pairs, tops, heights, 0, 60), 0);
    assert.equal(findActivePair(pairs, tops, heights, 100, 160), 0);
    assert.equal(findActivePair(pairs, tops, heights, 210, 270), 1);
    assert.equal(findActivePair(pairs, tops, heights, 505, 565), 2);
  });

  test('视口落在两对之间的空隙 → 后一对', () => {
    assert.equal(findActivePair(pairs, tops, heights, 160, 220), 1);
    assert.equal(findActivePair(pairs, tops, heights, 430, 490), 2);
  });

  test('视口低于全部内容（贴底/overscroll）→ 末对', () => {
    assert.equal(findActivePair(pairs, tops, heights, 10000, 10600), 2);
  });

  test('空 pairs → -1', () => {
    assert.equal(findActivePair([], [], [], 0, 100), -1);
  });

  test('topTolerance=8：前一对尾巴伸进视口顶呼吸位（≤8px）不抢活跃', () => {
    // 跳转语义：视口顶 = 目标 user 顶 - 8。真实布局消息间距可小到 ~1px，
    // 前一对尾巴会伸进呼吸位——无容差时活跃算给前一对（验收：回车后高亮在隔壁格）。
    const tops = [0, 60, 200, 280, 350, 500];
    const heights = [60, 135, 60, 60, 70, 90]; // pair0 底=195，pair1 顶=200（间距 5px）
    // 无容差（旧行为）：pair0 底 195 > scrollTop 192 → 选中 pair0
    assert.equal(findActivePair(pairs, tops, heights, 192, 700), 0);
    // 容差 8：从 scrollTop+8=200 起算，pair0 出局 → 选中 pair1（与跳转目标一致）
    assert.equal(findActivePair(pairs, tops, heights, 192, 700, 8), 1);
  });
});

describe('railTickLayout', () => {
  test('宽裕 → IDEAL/GAP 不压缩', () => {
    assert.deepEqual(railTickLayout(3, 300), { tick: 18, gap: 6 });
    assert.deepEqual(railTickLayout(5, 200), { tick: 18, gap: 6 });
  });

  test('拥挤 → 等差压缩（公式钉死，保底 MIN）', () => {
    // 3 对塞 30px：floor((30-12)/3)=6 ∈ [4,18] → tick=6, gap=6
    assert.deepEqual(railTickLayout(3, 30), { tick: 6, gap: 6 });
    // 10 对塞 100px：floor((100-54)/10)=4 → tick=4, gap=6（恰好 MIN，无需压 gap）
    assert.deepEqual(railTickLayout(10, 100), { tick: 4, gap: 6 });
  });

  test('极挤（MIN 也装不下）→ tick=MIN，gap 吃余量', () => {
    // 20 对塞 150px：floor((150-114)/20)=1 < MIN；4*20+19*6=194 > 150
    // → tick=4，gap=(150-80)/19 ≈ 3.684
    const { tick, gap } = railTickLayout(20, 150);
    assert.equal(tick, 4);
    assert.ok(Math.abs(gap - 70 / 19) < 1e-9);
  });

  test('count<=0 → 零尺寸', () => {
    assert.deepEqual(railTickLayout(0, 300), { tick: 0, gap: 0 });
  });
});

describe('isRailVisible', () => {
  test('≥3 对且溢出 >40px 才可见', () => {
    assert.equal(isRailVisible(3, 1000, 500), true);
    assert.equal(isRailVisible(2, 1000, 500), false);
    assert.equal(isRailVisible(5, 100, 100), false); // 无溢出（隐藏容器 clientHeight=0 同款）
    assert.equal(isRailVisible(4, 540, 500), false); // 溢出恰 40，不含
    assert.equal(isRailVisible(4, 541, 500), true);  // 溢出 41
  });
});

describe('previewText', () => {
  test('整行图片 markdown 被删', () => {
    assert.equal(previewText('![image](/a.png)\n你好'), '你好');
  });

  test('内联图片被删、链接取文字', () => {
    assert.equal(previewText('前 ![img](x.png) 后'), '前 后');
    assert.equal(previewText('看 [这篇](./doc.md) 怎么说'), '看 这篇 怎么说');
  });

  test('多行折叠为单个空格', () => {
    assert.equal(previewText('第一行\n\n  第二行\t第三行'), '第一行 第二行 第三行');
  });

  test('超长截断以 … 结尾', () => {
    const out = previewText('x'.repeat(100));
    assert.equal(out.length, 81);
    assert.ok(out.endsWith('…'));
    assert.equal(out.slice(0, 80), 'x'.repeat(80));
  });

  test('恰 80 字不截断', () => {
    assert.equal(previewText('y'.repeat(80)), 'y'.repeat(80));
  });

  test('空串与纯图片不炸', () => {
    assert.equal(previewText(''), '');
    assert.equal(previewText('![image](/a.png)'), '');
  });

  test('自定义 maxChars', () => {
    assert.equal(previewText('abcdef', 3), 'abc…');
  });
});

describe('常量与设计文档一致', () => {
  test('IDEAL/MIN/GAP/阈值', () => {
    assert.equal(RAIL_TICK_IDEAL, 18);
    assert.equal(RAIL_TICK_MIN, 4);
    assert.equal(RAIL_TICK_GAP, 6);
    assert.equal(RAIL_MIN_PAIRS, 3);
    assert.equal(RAIL_OVERFLOW_MIN, 40);
  });
});

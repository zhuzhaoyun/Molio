import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketContent } from '@molio/contracts';
import { isMarketContentComplete, sanitizeMarketContent } from './marketContent.ts';

function base(): MarketContent {
  return {
    version: 1,
    positioning: { what: '  一份测试知识库  ', who: [' 读者 ', ''], notFor: [] },
    facts: [{ label: ' 内容页 ', value: ' 12 个 ' }, { label: '', value: '' }],
    themes: [{ name: ' 主题 ', summary: ' 范围 ', items: [' 条目 ', ''] }],
    questions: [{ question: ' 问题？ ', answer: ' 答案。 ', source: '' }],
    samples: [{ title: ' 样例 ', body: ' 正文 ', source: ' ' }],
    delivery: { format: ' Markdown ', includes: [' wiki ', ''], requirements: [], steps: [] },
    review: { basis: ' ', reviewedAt: '', status: 'reviewed' },
    seo: { title: '  ', description: ' 描述 ', aliases: [' 别名 ', ''] },
  };
}

test('sanitizeMarketContent：去掉空行/空可选字段并 trim；保留 reviewed 状态', () => {
  const c = sanitizeMarketContent(base());
  assert.deepEqual(c.facts, [{ label: '内容页', value: '12 个' }]);
  assert.deepEqual(c.themes[0], { name: '主题', summary: '范围', items: ['条目'] });
  assert.deepEqual(c.questions, [{ question: '问题？', answer: '答案。' }], '空 source 不应落库');
  assert.deepEqual(c.samples, [{ title: '样例', body: '正文' }]);
  assert.deepEqual(c.positioning.who, ['读者']);
  assert.equal(c.review.status, 'reviewed');
  assert.ok(c.review.reviewedAt, '空日期补今天');
  assert.ok(c.review.basis, '空间依据补默认');
  assert.deepEqual(c.seo, { description: '描述', aliases: ['别名'] });
});

test('isMarketContentComplete：必填项缺失时拒绝', () => {
  assert.equal(isMarketContentComplete(sanitizeMarketContent(base())), true);
  assert.equal(isMarketContentComplete({ ...base(), facts: [] }), false);
  assert.equal(isMarketContentComplete({ ...base(), themes: [] }), false);
  assert.equal(isMarketContentComplete({ ...base(), delivery: { format: ' ', includes: [], requirements: [], steps: [] } }), false);
});

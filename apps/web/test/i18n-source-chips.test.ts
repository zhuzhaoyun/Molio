import { describe, it } from 'node:test';
import assert from 'node:assert';
import zh from '../src/i18n/locales/zh.ts';
import en from '../src/i18n/locales/en.ts';

/**
 * 引用区台账形态的新文案必须中英双语 —— `translate` 缺 key 时会静默回退到
 * 中文，英文用户会看到中文句子。与 i18n-onboarding.test.ts 同一道门槛。
 */
describe('引用区台账文案', () => {
  const KEYS = [
    'source.count',
    'source.showAll',
    'source.more',
    'source.bucket.media',
    'source.bucket.meta',
    'source.bucket.outside',
    'source.bucket.pattern',
  ];

  it('每条文案在英文表里都有，且不是中文回退', () => {
    for (const key of KEYS) {
      assert.ok(zh[key], `zh 缺少 ${key}`);
      assert.ok(en[key], `en 缺少 ${key}`);
      assert.doesNotMatch(en[key], /[一-鿿]/, `${key} 的英文值回落成了中文：${en[key]}`);
    }
  });

  it('带数量的文案保留 {n} 占位符', () => {
    for (const key of ['source.count', 'source.showAll', 'source.more']) {
      assert.match(zh[key], /\{n\}/, `${key} 缺少 {n}`);
      assert.match(en[key], /\{n\}/, `${key} 缺少 {n}`);
    }
  });
});

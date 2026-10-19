import { describe, it } from 'node:test';
import assert from 'node:assert';
import zh from '../src/i18n/locales/zh.ts';
import en from '../src/i18n/locales/en.ts';

/**
 * 新增 UI 文案必须中英双语（plan Global Constraint）——`translate` 缺 key 时
 * 会静默回退到中文，所以这里直接断言英文表里确实有该 key，且不是 CJK 回退。
 */
describe('onboarding failure copy', () => {
  it('localises the sample-vault creation failure in both languages', () => {
    const zhValue = zh['kb.sampleVaultCreateFailed'];
    const enValue = en['kb.sampleVaultCreateFailed'];

    assert.match(zhValue, /\{error\}/);
    assert.match(enValue, /\{error\}/);
    assert.match(zhValue, /[一-鿿]/, 'zh should carry the Chinese sentence');
    assert.doesNotMatch(enValue, /[一-鿿]/, 'en must not fall back to the zh string');
  });

  it('localises the connection-failure fallback in both languages', () => {
    assert.ok(zh['kb.connectionFailed']);
    assert.ok(en['kb.connectionFailed']);
    assert.doesNotMatch(en['kb.connectionFailed'], /[一-鿿]/);
  });
});

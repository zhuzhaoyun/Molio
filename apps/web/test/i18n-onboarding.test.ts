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

  it('localises every five-step checklist and feature-map string', () => {
    const keys = [
      'nextImport', 'nextAsk', 'nextSave', 'nextRuntime',
      'step1', 'step2', 'step3', 'step4', 'step5',
      'step1How', 'step2How', 'step3How', 'step4How', 'step5How',
      'current', 'expand', 'collapse', 'autoHint',
      'actionImport', 'actionAsk', 'actionConfigureAi',
      'mapTitle', 'mapBody', 'mapDaily', 'mapDailyBody',
      'mapOrganize', 'mapOrganizeBody', 'mapOutput', 'mapOutputBody',
      'mapManage', 'mapManageBody', 'mapBuild', 'mapGraph',
      'mapHistory', 'mapRuntime', 'mapDismiss',
    ];
    for (const key of keys) {
      const fullKey = `kb.onboarding.${key}`;
      assert.ok(zh[fullKey], `zh is missing ${fullKey}`);
      assert.ok(en[fullKey], `en is missing ${fullKey}`);
      assert.doesNotMatch(en[fullKey], /[一-鿿]/, `${fullKey} must not fall back to zh`);
    }
  });

  it('localises the help menu entries in both languages', () => {
    for (const key of ['nav.helpOnline', 'nav.onboardingGuide', 'nav.featureMap']) {
      assert.ok(zh[key], `zh is missing ${key}`);
      assert.ok(en[key], `en is missing ${key}`);
      assert.doesNotMatch(en[key], /[一-鿿]/, `${key} must not fall back to zh`);
    }
  });
});

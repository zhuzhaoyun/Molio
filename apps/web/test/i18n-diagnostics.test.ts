import { describe, it } from 'node:test';
import assert from 'node:assert';
import zh from '../src/i18n/locales/zh.ts';
import en from '../src/i18n/locales/en.ts';

/**
 * Molio 体检面板的文案必须中英双语 —— `translate` 缺 key 时会静默回退到中文，
 * 英文用户会看到中文句子。与 i18n-source-chips.test.ts 同一道门槛。
 */
describe('Molio 体检文案', () => {
  const KEYS = [
    'kb.molioCheckup',
    'checkup.title',
    'checkup.loading',
    'checkup.verdictIssues',
    'checkup.verdictWarnNote',
    'checkup.verdictWarnOnly',
    'checkup.verdictOk',
    'checkup.verdictOkNote',
    'checkup.okToggleOthers',
    'checkup.okToggleAll',
    'checkup.skipNote',
    'checkup.stepsLabel',
    'checkup.wikiLint',
    'checkup.wikiLintBtn',
    'checkup.askAi',
    'checkup.askAiIssues',
    'checkup.askAiAllOk',
    'checkup.recheck',
    'checkup.unreachableTitle',
    'checkup.unreachableSummary',
    'checkup.unreachableStep1',
    'checkup.unreachableStep2',
    'checkup.openLogFolder',
  ];

  it('每条文案中英双语', () => {
    for (const key of KEYS) {
      assert.ok(zh[key], `zh 缺少 ${key}`);
      assert.ok(en[key], `en 缺少 ${key}`);
      assert.doesNotMatch(en[key], /[一-鿿]/, `${key} 的英文值回落成了中文：${en[key]}`);
    }
  });

  it('带数量的文案保留占位符', () => {
    for (const key of [
      'checkup.verdictIssues',
      'checkup.verdictWarnNote',
      'checkup.verdictOkNote',
      'checkup.okToggleOthers',
      'checkup.okToggleAll',
    ]) {
      assert.match(zh[key], /\{n\}/, `${key} 缺少 {n}`);
      assert.match(en[key], /\{n\}/, `${key} 缺少 {n}`);
    }
    assert.match(zh['checkup.skipNote'], /\{n\}.*\{names\}/);
  });
});

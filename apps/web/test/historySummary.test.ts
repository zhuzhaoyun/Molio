import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { summarizeForHistory } = await import('../src/utils/historySummary.ts');

const F = '```';
const CARD = JSON.stringify({
  version: 1,
  title: 't',
  questions: [{
    id: 'q1', type: 'judge', stem: '1+1=2？',
    answer: ['A'], explanation: 'e', sources: [{ path: 'p.md' }],
  }],
});

describe('summarizeForHistory', () => {
  it('keeps plain text', () => {
    assert.equal(summarizeForHistory('你好\n世界'), '你好');
  });

  it('returns empty for a message that is only a quiz card', () => {
    assert.equal(summarizeForHistory(`${F}quiz\n${CARD}\n${F}`), '');
  });

  it('keeps the prose around a quiz card', () => {
    assert.equal(summarizeForHistory(`看这题：\n${F}quiz\n${CARD}\n${F}`), '看这题：');
  });

  it('keeps text that follows a quiz card', () => {
    assert.equal(summarizeForHistory(`${F}quiz\n${CARD}\n${F}\n然后呢`), '然后呢');
  });

  it('does not strip a fence whose language is not quiz', () => {
    assert.equal(summarizeForHistory(`${F}python\nx = 1\n${F}`), `${F}python`);
  });

  it('returns empty for empty content', () => {
    assert.equal(summarizeForHistory(''), '');
  });
});

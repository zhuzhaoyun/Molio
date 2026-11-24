import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { knowledgeDraft } from '../../../../distribution/desktop/molio-compose.ts';

test('context drafts reference shipped skill instructions and preserve file names and quoted excerpts', () => {
  const item = { vaultId: 'vault', vaultPath: '/vault', filePath: 'notes/原文.md', selectedText: '两行\n原文' };
  for (const [mode, skill] of [['ask', 'query'], ['build', 'build'], ['lint', 'lint'], ['ingest', 'ingest']]) {
    const draft = knowledgeDraft({ ...item, mode }, '/skills');
    assert.ok(draft.includes(join('/skills', 'wiki-' + skill, 'SKILL.md')));
    assert.ok(draft.includes('notes/原文.md'));
    assert.ok(draft.includes('两行\n原文'));
  }
  assert.throws(() => knowledgeDraft({ ...item, mode: 'ingest', filePath: '../other.md' }, '/skills'));
  assert.throws(() => knowledgeDraft({ ...item, mode: 'ingest', filePath: undefined }, '/skills'));
});

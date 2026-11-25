import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledgeDraft } from '../../../../packages/dsh-plugin-molio/desktop/molio-compose.ts';

test('context drafts express the operation without skill paths and preserve file names and quoted excerpts', () => {
  const item = { vaultId: 'vault', vaultPath: '/vault', filePath: 'notes/原文.md', selectedText: '两行\n原文' };
  for (const mode of ['ask', 'build', 'lint', 'ingest']) {
    const draft = knowledgeDraft({ ...item, mode });
    assert.doesNotMatch(draft, /SKILL\.md|wiki-(build|query|lint|ingest)/);
    assert.ok(draft.includes('notes/原文.md'));
    assert.ok(draft.includes('两行\n原文'));
  }
  assert.throws(() => knowledgeDraft({ ...item, mode: 'ingest', filePath: '../other.md' }));
  assert.throws(() => knowledgeDraft({ ...item, mode: 'ingest', filePath: undefined }));
});

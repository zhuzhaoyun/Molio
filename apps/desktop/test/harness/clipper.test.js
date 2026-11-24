import test from 'node:test';
import assert from 'node:assert/strict';
import { clipperRoute } from '../../../../distribution/desktop/molio-clipper.ts';

test('clipper file forms land on the existing vault-aware SPA route', () => {
  const file = '目录/100% #笔记.md';
  const url = new URL(clipperRoute('molio://open/vault/id%201/file/' + encodeURIComponent(file)), 'http://localhost');
  assert.equal(url.pathname, '/knowledge');
  assert.equal(url.searchParams.get('vault'), 'id 1');
  assert.equal(url.searchParams.get('file'), file);
  assert.equal(clipperRoute('molio://open/file/note.md'), '/knowledge?file=note.md');
  assert.equal(clipperRoute('molio://launch'), '/');
  assert.equal(clipperRoute('molio://open/file/%ZZ'), undefined);
  assert.equal(clipperRoute('molio://open/file/..%2Fprivate'), undefined);
});

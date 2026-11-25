import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { clipperRoute } from '../../../../packages/dsh-plugin-molio/desktop/molio-clipper.ts';

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

test('a pending vault URL update cannot replace a sidebar navigation to the market', () => {
  let navigate;
  const assigned = [];
  const pushed = [];
  const location = new URL('http://127.0.0.1:3100/knowledge?vault=one');
  location.assign = url => assigned.push(url);
  const preload = readFileSync(new URL('../../../desktop/preload.cjs', import.meta.url), 'utf8');
  runInNewContext(preload, {
    require: () => ({
      contextBridge: { exposeInMainWorld() {} },
      ipcRenderer: { on(_channel, handler) { navigate = handler; } },
    }),
    process, URL, crypto,
    window: { location, history: { pushState(_state, _title, url) { pushed.push(url); } }, dispatchEvent() {} },
    document: { getElementById: () => ({ firstElementChild: {} }) },
    PopStateEvent: class {}, MutationObserver: class { observe() {} disconnect() {} },
  });
  navigate(null, '/knowledge?panel=graph');
  navigate(null, '/resources');
  navigate(null, 'https://example.org/resources');
  assert.deepEqual(pushed, [location.origin + '/knowledge?panel=graph']);
  assert.deepEqual(assigned, [location.origin + '/resources']);
});

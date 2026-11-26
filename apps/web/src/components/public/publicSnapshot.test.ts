import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicGraph, PublicPage, PublicSite } from '@molio/contracts';

const pageId = '123e4567-e89b-42d3-a456-426614174000';
function site(revision: number): PublicSite {
  return { enabled: true, revision, pages: [{ id: pageId, title: `Page ${revision}` }] };
}
function page(revision: number): PublicPage {
  return { id: pageId, title: `Page ${revision}`, revision, markdown: `# Page ${revision}`, assetIds: [] };
}
function graph(revision: number): PublicGraph {
  return { revision, nodes: [{ id: pageId, title: `Page ${revision}` }], edges: [] };
}
function notFound(): Error & { status: number } {
  return Object.assign(new Error('unavailable'), { status: 404 });
}

test('public snapshot retries a stale page response using a fresh site revision', async () => {
  const { loadPublicSnapshot } = await import('./publicSnapshot.ts');
  let siteCalls = 0;
  const requestedRevisions: number[] = [];
  const result = await loadPublicSnapshot({
    site: async () => site(++siteCalls),
    page: async (_id: string, revision: number) => {
      requestedRevisions.push(revision);
      if (requestedRevisions.length === 1) throw notFound();
      return page(revision);
    },
    graph: async () => { throw new Error('unexpected graph read'); },
  }, { kind: 'page', pageId });
  assert.deepEqual(requestedRevisions, [1, 2]);
  assert.equal(result.site.revision, 2);
  assert.equal(result.page?.revision, 2);
  assert.equal(result.graph, null);
});

test('public snapshot treats a mismatched page DTO revision as stale and reloads', async () => {
  const { loadPublicSnapshot } = await import('./publicSnapshot.ts');
  let siteCalls = 0;
  const result = await loadPublicSnapshot({
    site: async () => site(++siteCalls),
    page: async (_id: string, revision: number) => revision === 1 ? page(0) : page(revision),
    graph: async () => { throw new Error('unexpected graph read'); },
  }, { kind: 'page', pageId });
  assert.equal(result.site.revision, 2);
  assert.equal(result.page?.revision, 2);
});

test('public snapshot retries a stale graph response and returns only the matching revision', async () => {
  const { loadPublicSnapshot } = await import('./publicSnapshot.ts');
  let siteCalls = 0;
  let graphCalls = 0;
  const result = await loadPublicSnapshot({
    site: async () => site(++siteCalls),
    page: async () => { throw new Error('unexpected page read'); },
    graph: async (revision: number) => ++graphCalls === 1 ? graph(revision - 1) : graph(revision),
  }, { kind: 'graph' });
  assert.equal(result.site.revision, 2);
  assert.equal(result.graph?.revision, 2);
  assert.equal(graphCalls, 2);
});

test('public snapshot exposes no stale content after both revision attempts fail', async () => {
  const { loadPublicSnapshot, PublicSnapshotError } = await import('./publicSnapshot.ts');
  let siteCalls = 0;
  await assert.rejects(loadPublicSnapshot({
    site: async () => site(++siteCalls),
    page: async () => { throw notFound(); },
    graph: async () => { throw new Error('unexpected graph read'); },
  }, { kind: 'page', pageId }), (error: unknown) => {
    assert.ok(error instanceof PublicSnapshotError);
    assert.equal(error.kind, 'unavailable');
    return true;
  });
  assert.equal(siteCalls, 2);
});

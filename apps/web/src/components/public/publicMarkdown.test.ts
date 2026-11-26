import { test } from 'node:test';
import assert from 'node:assert/strict';

const pageId = '123e4567-e89b-42d3-a456-426614174000';
const assetId = '123e4567-e89b-42d3-a456-426614174001';

test('public markdown rewrites snapshot page, asset, and unavailable links', async () => {
  const { renderPublicMarkdown } = await import('./publicMarkdown.ts');
  assert.equal(typeof renderPublicMarkdown, 'function');
  const html = renderPublicMarkdown(
    `[page](molio-page:${pageId}) [asset](molio-asset:${assetId}) [missing](molio-unavailable:)`,
    7,
  );
  assert.match(html, new RegExp(`/public/wiki/${pageId}\\?revision=7`));
  assert.match(html, new RegExp(`/api/public/assets/${assetId}\\?revision=7`));
  assert.match(html, /href="#unavailable"/);
});

test('public markdown keeps only revision-scoped public image assets', async () => {
  const { renderPublicMarkdown } = await import('./publicMarkdown.ts');
  const html = renderPublicMarkdown(
    `![approved](/api/public/assets/${assetId}?revision=7) ![remote](https://example.test/private.png) <img src="/api/knowledge/private.png">`,
    7,
  );
  assert.match(html, new RegExp(`/api/public/assets/${assetId}\\?revision=7`));
  assert.doesNotMatch(html, /private\.png|example\.test/);
});

test('public markdown strips executable HTML and event handlers in Node', async () => {
  const { renderPublicMarkdown } = await import('./publicMarkdown.ts');
  const html = renderPublicMarkdown('<script>window.__publicLeak = true</script><img src="/api/public/assets/123e4567-e89b-42d3-a456-426614174001?revision=7" onerror="window.__publicLeak = true">', 7);
  assert.doesNotMatch(html, /<script|onerror|__publicLeak/);
});

test('public markdown replaces internal unavailable-image marker with the localized label', async () => {
  const { renderPublicMarkdown } = await import('./publicMarkdown.ts');
  const html = renderPublicMarkdown('Before\n\n[[molio-image-unavailable]]\n\nAfter', 7, '图片暂不可用');
  assert.match(html, /图片暂不可用/);
  assert.doesNotMatch(html, /molio-image-unavailable/);
});

/** @area resources @priority P1 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderProductPage } from '../../cloud/src/ssr/render';
import type { MarketListing } from '@molio/contracts';

const content = JSON.parse(readFileSync(
  path.resolve(process.cwd(), '../../content/market/01M4PZPNGWR1YZ1W9GGVTJG82N.json'),
  'utf8',
));

const listing: MarketListing = {
  id: '01M4PZPNGWR1YZ1W9GGVTJG82N',
  name: '人教版高中数学五册知识图谱｜200个核心概念·AI知识库',
  summary: '覆盖人教 A 版高中数学全五册，将教材知识整理成可检索、可关联、可配合 AI 使用的高中数学知识图谱。',
  tags: ['高中数学', '知识图谱'],
  overview: [], highlights: [], content,
  previews: [], source: 'official', icon: '📖', tint: '#F0E8DC',
  version: 'v1.0', priceCents: 9850, payUrl: '', author: 'Molio 团队',
  fileSize: 146346305,
  publishedAt: '2026-10-12T02:41:57.490Z',
  updatedAt: '2026-10-26T08:00:00.000Z',
  category: { id: '01M4PXQAN5G8BSKT4G0RNXT3D4', name: 'K12', kind: 'category', position: 8 },
  resourceType: { id: 'knowledge', name: '知识库', kind: 'type', position: 7 },
};

test('product page content blocks: facts, Q&A, themes, samples, no mobile overflow', async ({ page }) => {
  await page.route('**', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://product.test') return route.abort();
    if (url.pathname === '/resource/01M4PZPNGWR1YZ1W9GGVTJG82N.html') {
      return route.fulfill({ contentType: 'text/html', body: renderProductPage(listing, []) });
    }
    if (url.pathname === '/styles.css') {
      return route.fulfill({
        contentType: 'text/css',
        body: readFileSync(new URL('../../landing-page/styles.css', import.meta.url), 'utf8'),
      });
    }
    return route.fulfill({ contentType: 'text/javascript', body: '' });
  });

  await page.goto('https://product.test/resource/01M4PZPNGWR1YZ1W9GGVTJG82N.html');
  await expect(page.locator('.res-facts')).toBeVisible();
  await expect(page.getByText('互斥事件和对立事件有什么区别？').first()).toBeVisible();
  await expect(page.locator('.res-c-theme').first()).toBeVisible();
  await expect(page.locator('.res-c-sample').first()).toBeVisible();
  await expect(page.locator('#delivery')).toBeVisible();
  await expect(page.locator('#source')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/product-content-mobile.png', fullPage: true });
});

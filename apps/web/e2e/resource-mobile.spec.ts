/**
 * @area landing-resource
 * @priority P1
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProductPage } from '../../cloud/src/ssr/render';
import type { MarketListing } from '@molio/contracts';

const listing: MarketListing = {
  id: '01M4PZPNGWR1YZ1W9GGVTJG82N', source: 'official',
  name: '人教版高中数学五册知识图谱｜200个核心概念·AI知识库',
  icon: '📖', tint: '#EDE6D8',
  summary: '覆盖人教 A 版高中数学全五册，将教材知识整理成可检索、可关联、可配合 AI 使用的高中数学知识图谱。'.repeat(4),
  overview: [], highlights: [], tags: ['高中数学', '知识图谱'],
  previews: ['https://molio.test/preview.svg', 'https://molio.test/preview.svg'],
  version: 'v1.0', priceCents: 9850, payUrl: '', author: 'Molio 团队',
  fileSize: 146381210, publishedAt: '2026-10-12T00:00:00Z',
};
const assets = fileURLToPath(new URL('../../landing-page/', import.meta.url));

async function openProduct(page: Page, options: { purchased?: boolean; free?: boolean; external?: boolean; noPreview?: boolean } = {}) {
  const product = { ...listing, priceCents: options.free ? 0 : listing.priceCents,
    payUrl: options.external ? 'https://checkout.test/buy' : '', previews: options.noPreview ? [] : listing.previews };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'molio.test') return route.abort();
    if (url.pathname.startsWith('/resource/')) return route.fulfill({ contentType: 'text/html', body: renderProductPage(product, []) });
    if (url.pathname === '/auth.js') return route.fulfill({ contentType: 'text/javascript', body: `
      window.MolioAuth = { isLoggedIn: () => ${!!options.purchased}, getAccessToken: async () => 'test',
        requireAuth: async () => {}, refreshLabels: () => {} };
      window.MOLIO_AUTH_BASE = 'https://molio.test';
      window.open = url => { document.body.dataset.opened = url; };
    ` });
    if (url.pathname === '/pay.js') return route.fulfill({ contentType: 'text/javascript', body: `window.MolioPay = {open: () => { document.body.dataset.payOpened = 'true'; }};` });
    if (url.pathname === '/market/purchases') return route.fulfill({ json: { purchases: [{ id: listing.id, available: true }] } });
    if (url.pathname.endsWith('/download')) return route.fulfill({ json: { url: 'https://download.test/resource.zip' } });
    if (['/styles.css', '/resource-hydrate.js', '/shared.js'].includes(url.pathname)) return route.fulfill({
      contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
      body: readFileSync(resolve(assets, url.pathname.slice(1)), 'utf8'),
    });
    if (url.pathname.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#ede6d8"/><text x="60" y="100" font-size="40">Resource preview fixture</text></svg>' });
    return route.fulfill({ status: 204 });
  });
  await page.goto('https://molio.test/resource/' + listing.id + '.html');
}

for (const width of [320, 390]) {
  test(`mobile ${width}: purchase in first viewport, previews first, no obstruction`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openProduct(page);
    const purchase = page.getByTestId('resource-purchase');
    await expect(purchase).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.res-preview-grid')).toBeInViewport();
    const preview = await page.locator('.res-preview-section').boundingBox();
    const overview = await page.locator('.res-overview-section').boundingBox();
    expect(preview!.y).toBeLessThan(overview!.y);
    expect(await page.locator('.res-preview-section').evaluate(el => getComputedStyle(el).marginTop)).toBe('0px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.float-qr-wrap')).toBeHidden();
    await expect(page.locator('.res-community img')).toBeHidden();
    await page.locator('#pay-btn').click();
    await expect(page.locator('body')).toHaveAttribute('data-pay-opened', 'true');
    await page.locator('.res-preview-grid a').first().click();
    await expect(page.locator('#res-lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#res-lightbox')).toBeHidden();
    await page.locator('.res-community summary').click();
    await expect(page.locator('.res-community img')).toBeVisible();
    await expect(purchase).toBeInViewport({ ratio: 1 });
  });
}

test('mobile purchased replacement stays in purchase bar and downloads without paying', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, { purchased: true });
  const button = page.locator('#pay-btn');
  await expect(button).toHaveText('已购 · 下载资源包');
  await expect(button).toBeInViewport({ ratio: 1 });
  await button.click();
  await expect(page.locator('body')).toHaveAttribute('data-opened', 'https://download.test/resource.zip');
  await expect(page.locator('body')).not.toHaveAttribute('data-pay-opened');
});

test('mobile free download and external checkout keep their original actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProduct(page, { free: true, noPreview: true });
  await expect(page.locator('#market-dl-btn')).toBeInViewport({ ratio: 1 });
  await page.locator('#market-dl-btn').click();
  await expect(page.locator('body')).toHaveAttribute('data-opened', 'https://download.test/resource.zip');
  await page.unrouteAll();
  await openProduct(page, { external: true });
  await expect(page.locator('#payurl-btn')).toBeInViewport({ ratio: 1 });
  await page.locator('#payurl-btn').click();
  await expect(page.locator('body')).toHaveAttribute('data-opened', 'https://checkout.test/buy');
});

test('desktop retains overview first and purchase sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openProduct(page);
  const purchase = await page.getByTestId('resource-purchase').boundingBox();
  const main = await page.locator('.res-main').boundingBox();
  expect(purchase!.x).toBeGreaterThan(main!.x + main!.width);
  expect(await page.getByTestId('resource-purchase').evaluate(el => getComputedStyle(el).position)).not.toBe('fixed');
  const overview = await page.locator('.res-overview-section').boundingBox();
  const preview = await page.locator('.res-preview-section').boundingBox();
  expect(overview!.y).toBeLessThan(preview!.y);
});

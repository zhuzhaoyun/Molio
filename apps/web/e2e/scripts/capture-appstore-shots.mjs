// 应用宝上架截图：1920x1080，横版，单张 <=1MB。
// 前置：pnpm dev，且本机存在演示库「资治通鉴2」。
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const VAULT_ID = process.env['MOLIO_SHOT_VAULT_ID'] || 'b15b1ccb-a2fe-4ef1-9c9d-3c5023efba13';
const BASE = process.env['MOLIO_SHOT_BASE'] || 'http://localhost:5173';
const OUT = path.resolve(process.cwd(), '../../docs/appstore/screenshots');

const shots = [
  {
    name: '01-knowledge-file',
    url: `/knowledge?vault=${VAULT_ID}&file=${encodeURIComponent('wiki/concepts/安史之乱.md')}`,
    waitFor: '.md-preview',
    settleMs: 2500,
  },
  {
    name: '02-knowledge-graph',
    url: `/knowledge?vault=${VAULT_ID}&panel=graph`,
    waitFor: '[data-testid="graph-canvas"]',
    settleMs: 7000,
  },
  {
    name: '03-resources',
    url: '/resources',
    waitFor: 'main, #root',
    settleMs: 4000,
  },
  {
    name: '04-typeset',
    url: `/knowledge?vault=${VAULT_ID}&file=${encodeURIComponent('wiki/concepts/安史之乱.md')}`,
    waitFor: '.md-preview',
    settleMs: 2000,
    action: async (page) => {
      await page.click('[data-testid="kb-btn-typeset"]');
      await page.waitForTimeout(3500);
    },
  },
  {
    name: '05-resource-detail',
    url: '/resources',
    waitFor: '[data-testid="resources-grid"]',
    settleMs: 3000,
    action: async (page) => {
      await page.locator('[data-testid^="resource-detail-link-"]').first().click();
      await page.waitForSelector('.resources-detail, h1', { timeout: 15000 });
      // 预览图是 loading=lazy 且首屏在折叠线以下，强制 eager 触发加载
      await page.evaluate(() => {
        document.querySelectorAll('.resources-preview-grid img').forEach((img) => {
          img.loading = 'eager';
          img.src = img.src;
        });
      });
      await page.waitForTimeout(4000);
    },
  },
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
});

for (const shot of shots) {
  const page = await context.newPage();
  try {
    await page.goto(BASE + shot.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(shot.waitFor, { timeout: 20000 });
    await page.waitForTimeout(shot.settleMs);
    if (shot.action) await shot.action(page);
    const file = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file });
    const size = fs.statSync(file).size;
    console.log(`${shot.name}: ${(size / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.error(`${shot.name}: FAILED ${err.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
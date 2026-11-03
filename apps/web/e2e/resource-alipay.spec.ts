/** @area resources @priority P1 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { renderProductPage } from '../../cloud/src/ssr/render';
import type { MarketListing } from '@molio/contracts';

test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });

for (const platform of ['iOS', 'Android']) {
test(`${platform} B站半屏资源页购买入口及浏览器兼容引导`, async ({ browser }) => {
  const userAgent = platform === 'Android' ? 'Mozilla/5.0 (Linux; Android 13; wv) Mobile BiliApp/76000100' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 BiliApp/76000100';
  const context = await browser.newContext({ viewport: { width: 390, height: 550 }, userAgent });
  const page = await context.newPage();
  const listing: MarketListing = { id: 'test', name: '测试资源', summary: '资源说明。'.repeat(800), tags: [], overview: [], highlights: [], previews: [], source: 'official', icon: '📚', tint: '#eee', version: '1', priceCents: 1990, payUrl: '', author: 'Molio', fileSize: 100, publishedAt: null };
  let orders = 0;
  await page.route('**', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'pay.molio.cn') { orders++; return route.abort(); }
    if (url.pathname === '/resource/test.html') return route.fulfill({ contentType: 'text/html', body: renderProductPage(listing, []) });
    if (['/pay.js', '/resource-hydrate.js', '/styles.css'].includes(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(new URL('../../landing-page' + url.pathname, import.meta.url), 'utf8') });
    if (url.pathname === '/auth.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.MolioAuth={requireAuth:()=>Promise.resolve({id:"01H8ZK3Q9VXWJ2YB5R6T7N0MPC"})};' });
    return route.fulfill({ body: '' });
  });
  await page.goto('https://molio.cn/resource/test.html');
  const buy = page.getByTestId('resource-pay-btn');
  await expect(buy).toBeInViewport();
  expect(await buy.evaluate(el => getComputedStyle(el.parentElement!).position)).toBe('fixed');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await expect(buy).toBeInViewport();
  await page.screenshot({ path: 'test-results/resource-mobile-purchase-bar.png' });
  await buy.click();
  await expect(page.locator('#pay-tip')).toContainText('系统浏览器');
  await expect(page.locator('#pay-browser-url')).toHaveValue('https://molio.cn/resource/test.html');
  await expect(page.locator('#pay-copy-link')).toBeVisible();
  if (platform === 'Android') {
    await expect(page.locator('#pay-open-browser')).toBeInViewport();
    await expect(page.locator('#pay-open-browser')).toHaveAttribute('href', /^intent:\/\/molio.cn\/resource\/test.html#Intent;/);
  } else await expect(page.locator('#pay-open-browser')).toBeHidden();
  expect(orders).toBe(0);
  await page.screenshot({ path: `test-results/alipay-bili-guidance-${platform}.png` });
  await page.locator('#pay-close').click();
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await buy.evaluate(el => getComputedStyle(el.parentElement!).position)).not.toBe('fixed');
  await context.close();
});
}

test('mobile browser opens Alipay and resumes paid order to download without creating another order', async ({ page }) => {
  let orders = 0;
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'openapi.alipay.com') {
      return route.fulfill({ contentType: 'text/html', body: '<a id="return" href="https://molio.cn/resource/test.html?molio_pay_resume=test~ALI123456">返回商家</a>' });
    }
    if (url.hostname === 'pay.molio.cn') {
      if (url.pathname === '/pay') {
        orders++;
        expect(url.searchParams.get('scene')).toBe('alipay');
        expect(url.searchParams.get('uid')).toBe('01H8ZK3Q9VXWJ2YB5R6T7N0MPC');
        return route.fulfill({ json: { pay_url: 'https://openapi.alipay.com/gateway.do?test=1', out_trade_no: 'ALI123456' } });
      }
      if (url.pathname === '/order') return route.fulfill({ json: { status: 'SUCCESS' } });
      if (url.pathname === '/deliver') return route.fulfill({ json: { url: 'https://download.test/test.zip' } });
    }
    if (url.pathname === '/pay.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('../../landing-page/pay.js', import.meta.url), 'utf8') });
    if (url.pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: readFileSync(new URL('../../landing-page/styles.css', import.meta.url), 'utf8') });
    if (url.pathname === '/resource/test.html') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><button data-testid="buy" onclick="MolioPay.open({id:'test',price:49})">立即购买</button><script>window.MOLIO_PAY_BASE='https://pay.molio.cn';window.__LISTING__={id:'test',priceCents:4900};window.MolioAuth={requireAuth:()=>Promise.resolve({id:'01H8ZK3Q9VXWJ2YB5R6T7N0MPC'})};</script><script src="/pay.js"></script>` });
    return route.fulfill({ body: '' });
  });
  await page.goto('https://molio.cn/resource/test.html');
  await page.getByTestId('buy').click();
  await expect(page).toHaveURL(/openapi.alipay.com/);
  await page.locator('#return').click();
  await expect(page.locator('#pay-dl')).toBeVisible();
  await expect(page.locator('#pay-dl')).toHaveAttribute('href', 'https://download.test/test.zip');
  expect(orders).toBe(1);
  expect(errors).toEqual([]);
});

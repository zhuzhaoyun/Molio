/** @area resources @priority P1 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });

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

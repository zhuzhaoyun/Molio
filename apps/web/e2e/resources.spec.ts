import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area resources
 * @priority P1
 *
 * E2E tests for the resources module (list / filters / detail / not-found).
 *
 * The catalog comes from the cloud market via daemon /api/market/listings
 * (since #233; the old static apps/landing-page/resources-data.js bridge is
 * retired). Counts are asserted relatively (all = paid + free) so adding a
 * resource does not break tests.
 *
 * NOTE: the pay button is intentionally NOT clicked here — it would create
 * real orders against pay.molio.cn. The pay modal is covered manually.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const cards = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="resources-grid"] [data-testid^="resource-card-"]');

const fixture = Array.from({length:14}, (_,i) => ({
  id:i===13?'literature':`math-${i}`, source:'official', name:i===13?'文学':'数学 '+i,
  icon:'📚', tint:'#eee', summary:'资源简介', overview:['概述'], highlights:[], tags:[], previews:[],
  version:'1.0', priceCents:0, payUrl:'', author:'test', fileSize:1024, publishedAt:null,
  category:{id:i===13?'history-literature':'math',name:i===13?'历史与文学':'数学',kind:'category',position:i===13?1:0},
  resourceType:{id:'knowledge',name:'知识库',kind:'type',position:0},
}));
test.beforeEach(async ({page}) => {
  await page.route('**/api/market/listings*', r=>r.fulfill({json:{listings:fixture,stale:false}}));
  await page.route('**/api/market/listings/*', r=> {
    const item=fixture.find(x=>r.request().url().endsWith('/'+x.id));
    return r.fulfill({status:item?200:404,json:item??{error:'not_found'}});
  });
});

test.describe('Resources page', () => {
  test('loads more on scroll (grouped and flat), keeps scope during search and restores URL', async ({ page }) => {
    await page.goto('/resources');
    // 分组视图也走滚动加载：滚到底后各分类都展开到全量（13 math + 1 文学 = 14）。
    // 不断言中间批次的条数：视口没填满时会连续加载，条数取决于布局，断言会飘。
    await page.locator('.resources-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(cards(page)).toHaveCount(14);
    // 显示条数是视图状态、不进 URL（避免与用户输入抢导航）：刷新回到第一批，滚到底再次展开
    expect(page.url()).not.toContain('shown=');
    await page.reload();
    await page.locator('.resources-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(cards(page)).toHaveCount(14);

    // 分类筛选改走顶部 chip（分组标题里的「查看全部」按钮已删）。
    // 先等 chip 的选中态落到 DOM（渲染产物）再输入：立刻 fill 会和还没提交的
    // re-render 交错，受控输入框被按旧的 q 重置、输入丢掉（真实击键不会）。
    await page.getByTestId('resources-category-math').click();
    await expect(page.getByTestId('resources-category-math')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('resources-search').fill('文学');
    await expect(page.locator('.resources-empty')).toBeVisible();
    await page.getByRole('button', {name:'搜索全部资源'}).click();
    await expect(cards(page)).toHaveCount(1);
    await page.getByTestId('resource-detail-link-literature').click();
    await page.getByTestId('resources-back').click();
    await expect(page.getByTestId('resources-search')).toHaveValue('文学');
    await expect(cards(page)).toHaveCount(1);

    // 窄屏不横向溢出（页面顶部那批控件最容易撑破）
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test('navigate to detail and back', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'resources');
    await expect(page.locator('.resources-shell')).toBeVisible();

    // Enter the first card's detail page
    const firstCard = cards(page).first();
    const firstTestId = await firstCard.getAttribute('data-testid');
    const id = firstTestId!.replace('resource-card-', '');

    await page.locator(`[data-testid="resource-detail-link-${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/resources/${id}$`));
    await expect(page.locator('.resources-detail-head h1')).toBeVisible();
    await expect(page.locator('.resources-section-title').first()).toBeVisible();

    // Back to list
    await page.locator('[data-testid="resources-back"]').click();
    await expect(page).toHaveURL(/\/resources$/);
    await expect(page.locator('[data-testid="resources-grid"]')).toBeVisible();

    // 「查看详情」按钮已删，整张卡片可点（标题链接的 ::after 铺满卡片）。
    // 用真实鼠标点描述区域（不是标题、不是购买按钮）—— 这里不能用 locator.click()：
    // 该点最上层是链接的伪元素，Playwright 的命中检查会判为被遮挡。
    const desc = page.locator(`[data-testid="resource-card-${id}"] .resources-card__desc`);
    const box = await desc.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page).toHaveURL(new RegExp(`/resources/${id}$`));
  });

  test('unknown resource id shows not-found state', async ({ page }) => {
    await gotoHome(page);
    await page.goto('/resources/does-not-exist');

    // 直接整页加载详情路由：vite dev 冷转换可超默认 5s，放宽等待
    await expect(page.locator('.resources-shell')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('resources-not-found')).toBeVisible();
    await expect(page.locator('.resources-tip-box')).toBeVisible();
    await expect(page.locator('[data-testid="resources-back"]')).toBeVisible();
  });

  /**
   * 详情页加载态回归：数据在途时先渲染骨架屏，绝不抢跑「资源不存在」——
   * 否则从卡片点进来会先闪一句「你访问的资源不存在或尚未上架」再出内容。
   */
  test('detail shows a skeleton, not the not-found copy, while the listing loads', async ({ page }) => {
    // 覆盖 beforeEach 的即时 mock：给这个 id 的详情请求加延迟
    await page.route('**/api/market/listings/math-0', async (route) => {
      await new Promise((r) => setTimeout(r, 1_000)); // 模拟慢云端
      await route.fulfill({ json: fixture.find((x) => x.id === 'math-0') });
    });

    await page.goto('/resources/math-0');
    await expect(page.getByTestId('resources-detail-skeleton')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('resources-not-found')).toHaveCount(0);

    // 数据到达：骨架屏让位给正文
    await expect(page.locator('.resources-detail-head h1')).toHaveText('数学 0');
    await expect(page.getByTestId('resources-detail-skeleton')).toHaveCount(0);
  });

  /**
   * 首载 loading 态回归（2026-09 资源页首开白屏 15s）：
   * 目录在途时渲染骨架屏占位卡片，而非与「暂无资源」同形的空白网格；
   * 数据落定（空目录）后骨架屏消失、显示空态文案。
   */
  test('shows skeleton while catalog loads, then resolves', async ({ page }) => {
    await page.route('**/api/market/listings', async (route) => {
      await new Promise((r) => setTimeout(r, 1_000)); // 模拟慢云端
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ listings: [], stale: false }),
      });
    });

    await gotoHome(page);
    await clickNav(page, 'resources');

    // 在途：骨架屏可见，且不误显空态
    await expect(page.locator('[data-testid="resources-skeleton-card"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('.resources-empty')).not.toBeVisible();

    // 落定：骨架屏消失，空目录显示空态文案
    await expect(page.locator('.resources-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="resources-skeleton-card"]')).toHaveCount(0);
  });
});

/**
 * 支付可用性回归（2026-08：#233 移除 resources-data.js 的 side-effect import 后，
 * web 端 window.MOLIO_PAY_BASE 无人注入，桌面端付费资源静默降级为
 * 「支付服务未开通，请直接联系购买」，官网正常 —— 见 resources.ts 的默认值修复）。
 *
 * 只断言文案形态（按钮带「微信支付」+ 侧栏为扫码说明），绝不点击购买按钮。
 */
test.describe('Pay base availability', () => {
  test('paid detail page offers WeChat pay instead of contact-us fallback', async ({ page }) => {
    // mock 一个付费条目，不依赖开发环境云端目录里是否有付费资源
    await page.route('**/api/market/listings/pay-regression', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'pay-regression',
          source: 'official',
          name: '支付回归用条目',
          icon: '💰',
          tint: '#f5c518',
          summary: '回归测试专用付费条目',
          overview: [],
          highlights: [],
          tags: [],
          previews: [],
          version: '1.0.0',
          priceCents: 100,
          payUrl: '',
          author: 'Molio E2E',
          fileSize: null,
          publishedAt: null,
        }),
      }),
    );

    await page.goto('/resources/pay-regression');
    await expect(page.locator('.resources-detail-head h1')).toHaveText('支付回归用条目', {
      timeout: 15_000,
    });

    // 按钮文案含「微信支付 ¥1」（未登录带「登录后」前缀，登录与否都命中）
    await expect(page.locator('[data-testid="resource-buy-pay-regression"]')).toContainText(
      '微信支付 ¥1',
    );
    // 侧栏说明为扫码支付文案，而非「支付服务未开通，请直接联系购买」
    await expect(page.locator('.resources-side-note')).toContainText('扫码支付成功后自动解锁下载');
    await expect(page.locator('.resources-side-note')).not.toContainText('支付服务未开通');
  });
});

/**
 * 登录门槛（资源下载/购买不论免费付费都要求登录）：
 * 未登录点购买 → 账号面板直达登录视图（门槛拦在下单之前，不产生任何订单）。
 *
 * ⚠️ 登录后绝不点击购买按钮：PAY_BASE 指向真实支付后端，点击会真实下单。
 * 「登录后自动续接原动作」走手动验证（本地三件套，见实施计划）。
 */
test.describe('Resources login gate', () => {
  test.beforeEach(async ({ page, request }) => {
    const res = await request.get('/api/auth/status');
    const status = (await res.json()) as { loggedIn?: boolean };
    if (status.loggedIn) await request.post('/api/auth/logout');
    await gotoHome(page);
    await clickNav(page, 'resources');
    await expect(page.locator('.resources-shell')).toBeVisible();
  });

  test('logged-out: buy button shows sign-in label and opens login view', async ({ page }) => {
    const firstCard = cards(page).first();
    const id = (await firstCard.getAttribute('data-testid'))!.replace('resource-card-', '');
    const buyBtn = page.locator(`[data-testid="resource-buy-${id}"]`);
    await expect(buyBtn).toHaveText(/登录后/);

    await buyBtn.click();
    // 门槛：账号面板直达登录视图（邮箱输入可见 = login 视图，而非资料主视图）
    await expect(page.locator('.account-modal')).toBeVisible();
    await expect(page.locator('[data-testid="account-email-input"]')).toBeVisible();

    // 取消 = 放弃本次动作，停留资源页，无任何下单副作用
    await page.locator('[data-testid="account-modal-close"]').click();
    await expect(page.locator('.account-modal')).not.toBeVisible();
    await expect(page.locator(`[data-testid="resource-card-${id}"]`)).toBeVisible();
  });

  test('logged-in: buy button drops the sign-in label', async ({ page, request }) => {
    const probe = (await (await request.get('/api/auth/status')).json()) as {
      configured?: boolean;
    };
    if (!probe.configured) {
      test.skip(true, 'daemon MOLIO_AUTH_URL not configured — login chain unavailable');
    }

    // 复用 auth.spec 的 devCode 登录链路（未登录打开面板即邮箱验证表单）
    const email = `molio-e2e-resgate-${Date.now()}@example.com`;
    await page.locator('[data-testid="nav-account-btn"]').click();
    await page.locator('[data-testid="account-email-input"]').fill(email);
    await page.locator('[data-testid="account-agree-checkbox"]').check();
    const startResp = page.waitForResponse(
      (r) => r.url().includes('/api/auth/start') && r.request().method() === 'POST',
    );
    await page.locator('[data-testid="account-send-code-btn"]').click();
    const body = (await (await startResp).json()) as { devCode?: string };
    if (typeof body.devCode !== 'string') {
      test.skip(true, 'cloud did not return devCode (prod-mode cloud)');
    }
    await page.locator('[data-testid="account-code-input"]').fill(body.devCode as string);
    await page.locator('[data-testid="account-verify-btn"]').click();
    await expect(page.locator('[data-testid="account-logged-email"]')).toHaveText(email, {
      timeout: 10_000,
    });
    // 账号模块页面化：登录成功 → 弹窗自动收起并导航 /me；回资源页断言按钮文案
    await expect(page).toHaveURL(/\/me$/);
    await clickNav(page, 'resources');
    await expect(page.locator('.resources-shell')).toBeVisible();

    // 登录后文案回归正常（未登录前缀消失）。不点击——点击会向真实支付后端下单。
    const firstCard = cards(page).first();
    const id = (await firstCard.getAttribute('data-testid'))!.replace('resource-card-', '');
    await expect(page.locator(`[data-testid="resource-buy-${id}"]`)).not.toHaveText(/登录后/);
  });
});

/**
 * @area navigation
 * @priority P1
 *
 * 首次运行引导。背景：全新安装（零知识库）时首页直接落在聊天框上，
 * 全程没有一个字提到「知识库」——客户在这里卡了一个多小时然后放弃。
 *
 * 引导卡独立于 HomePage 的 hero 分支渲染，条件是「一个知识库都没有」。
 *
 * 地址走 `gotoHome`（= `/chat`）而不是 `/`：`/` 现在是入口重定向，落点取决于
 * localStorage 里的上次路由；而且 HomePage 已从导航栏撤下，只剩深链可达——
 * 本 spec 就是它仅存的入口之一。零库用户实际的第一屏是 /knowledge 的空态 CTA，
 * 那条路径由 default-landing.spec.ts 覆盖。
 */

import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { gotoHome } from './helpers/navigation';

let vault: TempVault;

test.describe('首页首次运行引导', () => {
  test.beforeAll(async () => {
    // 「已有知识库」用例需要一个真实存在的库（E2E daemon 数据目录每次清空）。
    vault = await createTempVault('e2e-home-onboarding');
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('一个知识库都没有时，首页显示导入引导卡', async ({ page }) => {
    // 隔离用例：把库列表钉死为空，不依赖此刻 daemon 里真实有几个库。
    await page.route('**/api/knowledge/vaults', (route) =>
      // 响应形状跟 daemon 一致：client.listVaults() 解的是 data.vaults
      route.request().method() === 'GET' ? route.fulfill({ json: { vaults: [] } }) : route.continue(),
    );

    await gotoHome(page);

    const card = page.locator('[data-testid="home-onboarding-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('[data-testid="home-onboarding-cta"]')).toBeVisible();
    // 引导必须落在「建库/导入」上，而不是把人推去聊天。
    await expect(card).toContainText(/知识库/);
  });

  test('点引导卡主 CTA 直达知识库并打开仓库管理器', async ({ page }) => {
    await page.route('**/api/knowledge/vaults', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { vaults: [] } }) : route.continue(),
    );
    await gotoHome(page);

    await page.locator('[data-testid="home-onboarding-cta"]').click();

    // 落点必须是知识库页 + 管理器已开——否则这个 CTA 就是又一个死胡同
    await expect(page).toHaveURL(/\/knowledge/);
    await expect(page.locator('[data-testid="vault-manager-modal"]')).toBeVisible({ timeout: 10_000 });
  });

  test('已有知识库时不显示引导卡', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="home-onboarding-card"]')).toHaveCount(0);
  });
});

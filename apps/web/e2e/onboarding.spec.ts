/**
 * @area onboarding
 * @priority P0
 */
import { test, expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTempVault, cleanupTempVault } from './helpers/cleanup';
import { mockChatRun } from './helpers/mock-sse';

const DAEMON = `http://localhost:${Number(process.env.MOLIO_E2E_DAEMON_PORT ?? 3100)}`;
const SAMPLE_PATH = join(process.env.MOLIO_E2E_DATA_DIR!, 'sample-vault');

/** Force the "zero vaults" state without depending on other specs' leftovers. */
async function mockZeroVaultsUntilSampleCreated(page: Page) {
  let sampleCreated = false;
  await page.route('**/api/knowledge/vaults', async (route) => {
    if (route.request().method() === 'GET' && !sampleCreated) {
      await route.fulfill({ json: { vaults: [] } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/knowledge/sample-vault', async (route) => {
    sampleCreated = true;
    await route.continue();
  });
}

async function deleteSampleVaultIfAny() {
  const res = await fetch(`${DAEMON}/api/knowledge/vaults`);
  if (res.ok) {
    const body = await res.json() as { vaults: Array<{ id: string; path: string }> };
    for (const vault of body.vaults) {
      if (vault.path === SAMPLE_PATH) {
        await fetch(`${DAEMON}/api/knowledge/vaults/${vault.id}`, { method: 'DELETE' });
      }
    }
  }
  rmSync(SAMPLE_PATH, { recursive: true, force: true });
}

test.afterEach(async () => {
  await deleteSampleVaultIfAny();
});

test('零库首启展示两个对等动作', async ({ page }) => {
  await mockZeroVaultsUntilSampleCreated(page);
  await page.goto('/knowledge');

  await expect(page.locator('[data-testid="kb-empty-sample-vault-cta"]')).toBeVisible();
  await expect(page.locator('[data-testid="kb-empty-create-vault-cta"]')).toBeVisible();

  // 欢迎区必须落在主内容区的水平中线上：它是 flex 列里的一个 max-width 块，
  // 少了 auto 外边距会被钉在左边缘（用户 2026-10-19 验收截图即此）。
  const main = await page.locator('.kb-main').boundingBox();
  const welcome = await page.locator('.kb-empty-state--welcome').boundingBox();
  expect(main).not.toBeNull();
  expect(welcome).not.toBeNull();
  expect(Math.abs((main!.x + main!.width / 2) - (welcome!.x + welcome!.width / 2))).toBeLessThan(2);
});

const ACTIVE_STATE = {
  status: 'active',
  steps: { vault: false, openOrImport: false, ask: false },
  startedAt: Date.now(),
};

async function seedActiveOnboarding(page: Page) {
  // Seed once only. `addInitScript` runs on every navigation: re-writing on the
  // reload below would resurrect a dismissed state and hide a persistence bug.
  await page.addInitScript((state) => {
    if (!localStorage.getItem('molio.onboarding.v1')) {
      localStorage.setItem('molio.onboarding.v1', JSON.stringify(state));
    }
  }, ACTIVE_STATE);
}

test('点示例库 → 入口文档自动打开', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('molio.onboarding.v1'));
  await mockZeroVaultsUntilSampleCreated(page);
  await page.goto('/knowledge');

  await page.locator('[data-testid="kb-empty-sample-vault-cta"]').click();

  await expect(page.locator('.kb-wtab-title').filter({ hasText: '开始使用' })).toBeVisible();
  await expect(page.locator('.kb-workspace-tabs')).toContainText('开始使用');
  // 文件真的从磁盘读出来了（不是空标签）
  await expect(page.locator('body')).toContainText('三个动作，跑通一次闭环');
});

test('全新安装点示例库后 checklist 紧接着出现', async ({ page }) => {
  // 这是最短激活路径：零库首启 → 点「立即试用」→ 入口文档打开。checklist 必须
  // 与文档同一时刻出现，而不是等用户再打开一次文件（首屏的引导价值全在这一步）。
  await page.addInitScript(() => localStorage.removeItem('molio.onboarding.v1'));
  await mockZeroVaultsUntilSampleCreated(page);
  await page.goto('/knowledge');

  await page.locator('[data-testid="kb-empty-sample-vault-cta"]').click();

  await expect(page.locator('.kb-wtab-title').filter({ hasText: '开始使用' })).toBeVisible();
  await expect(page.locator('[data-testid="kb-onboarding"]')).toBeVisible();
  // 建库 + 自动打开入口文档至少完成两步，不可能是 0/3。
  await expect(page.locator('[data-testid="kb-onboarding"]')).toContainText(/[12]\/3/);
});

test('checklist 1/3 → 2/3 → 3/3，完成后显示完成态', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-checklist');
  try {
    // 真实库里已有测试 vault，首屏会写 done —— 清掉后让下一次 GET 返回 0 库，
    // 重载一次即可走到「全新安装」分支。
    let serveZero = false;
    await page.route('**/api/knowledge/vaults', async (route) => {
      if (route.request().method() === 'GET' && serveZero) {
        await route.fulfill({ json: { vaults: [] } });
        return;
      }
      await route.continue();
    });
    await mockChatRun(page);
    await page.goto('/knowledge');
    await page.evaluate(() => localStorage.removeItem('molio.onboarding.v1'));
    serveZero = true;
    await page.reload();
    // 必须等激活态真的落盘再切回真实列表：reload 的 load 事件早于 React 挂载后的
    // listVaults 请求，提前放行会让「0 库」那一刻永远不发生，init(1) 直接写 done。
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('molio.onboarding.v1')))
      .toContain('active');
    serveZero = false;

    // 重新加载真实库列表并进入测试库
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('[data-testid="kb-onboarding"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-onboarding"]')).toContainText('1/3');

    await page.locator('.kb-tree-item').filter({ hasText: 'test.md' }).first().click();
    await expect(page.locator('[data-testid="kb-onboarding"]')).toContainText('2/3');

    await page.locator('[data-testid="kb-btn-ask-tab"]').click();
    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('这篇文档讲了什么？');
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-send"]').click();

    await expect(page.locator('[data-testid="kb-onboarding-done"]')).toBeVisible();
  } finally {
    await cleanupTempVault(vault);
  }
});

test('关闭 checklist 后刷新不再出现', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-dismiss');
  try {
    await seedActiveOnboarding(page);
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('[data-testid="kb-onboarding"]')).toBeVisible();
    await page.locator('[data-testid="kb-onboarding-dismiss"]').click();
    await expect(page.locator('[data-testid="kb-onboarding"]')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('molio.onboarding.v1')))
      .toContain('dismissed');
    await page.reload();
    // 等库真的加载完再断言：reload 的 load 事件早于 React 挂载，空 DOM 窗口里
    // checklist 本来就不可见，直接 toHaveCount(0) 会对着真空窗假绿。
    await expect(page.locator('.kb-tree-item').first()).toBeVisible();
    await expect(page.locator('[data-testid="kb-onboarding"]')).toHaveCount(0);
  } finally {
    await cleanupTempVault(vault);
  }
});

test('已有库的用户升级后不出现 checklist', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-existing');
  try {
    await page.addInitScript(() => localStorage.removeItem('molio.onboarding.v1'));
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-tree-item').first()).toBeVisible();
    await expect(page.locator('[data-testid="kb-onboarding"]')).toHaveCount(0);
    const raw = await page.evaluate(() => localStorage.getItem('molio.onboarding.v1'));
    expect(JSON.parse(raw!).status).toBe('done');
  } finally {
    await cleanupTempVault(vault);
  }
});

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
});

const ACTIVE_STATE = {
  status: 'active',
  steps: { vault: false, openOrImport: false, ask: false },
  startedAt: Date.now(),
};

async function seedActiveOnboarding(page: Page) {
  await page.addInitScript((state) => {
    localStorage.setItem('molio.onboarding.v1', JSON.stringify(state));
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
    await page.reload();
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

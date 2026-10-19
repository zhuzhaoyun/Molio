/**
 * @area onboarding
 * @priority P0
 */
import { test, expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

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

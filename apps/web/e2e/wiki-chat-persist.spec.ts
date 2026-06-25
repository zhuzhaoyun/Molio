import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area kb
 * @priority P1
 *
 * Regression for https://github.com/zhuzhaoyun/Molio/issues/72
 *
 * Wiki chat panel must survive page switches: the underlying run keeps
 * streaming on the daemon side, and when the user returns to /knowledge
 * the panel reappears with the in-progress conversation intact.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

let vault: TempVault;

test.describe('Wiki chat panel — page switch persistence', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-wiki-persist');
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('panel stays open with progress after navigating away and back', async ({ page }) => {
    // Mock the wiki run with a script that emits a text delta but never
    // sends turn_end/usage — so isRunning stays true throughout the test.
    // Set up before gotoHome so /api/agents and /api/config are mocked when
    // App resolves selectedAgent (otherwise handleBuildWiki no-ops on null agentId).
    await mockChatRun(page, {
      runId: 'run-wiki-persist',
      convId: 'conv-wiki-persist',
      script: [
        { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
        { type: 'text_delta', delta: 'Ingesting knowledge base...' },
      ],
    });

    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Ensure a vault is active so the "构建 Wiki" toolbar button renders.
    // The test vault was registered via the daemon API in beforeAll; we
    // open the vault switcher and pick it. Wait for the vault list to load
    // first (useKnowledge fetches on mount).
    await page.locator('.kb-vault-bar').click();
    const vaultItem = page.locator('.vm-vault-item').filter({ hasText: vault.name });
    await expect(vaultItem).toBeVisible({ timeout: 10_000 });
    await vaultItem.click();
    // Wait for the file panel to reflect the active vault
    await expect(page.locator('button[title="构建 Wiki"]')).toBeVisible({ timeout: 5_000 });

    // Trigger a wiki operation via the "构建 Wiki" toolbar button.
    const buildBtn = page.locator('button[title="构建 Wiki"]').first();
    await buildBtn.click();

    // Chat panel should slide in and show the streaming message.
    const panel = page.locator('.wiki-chat-panel');
    await expect(panel).toBeVisible({ timeout: 3_000 });
    await expect(panel.locator('.wiki-chat-status')).toHaveText(/运行中/);
    await expect(panel.locator('[data-testid="assistant-message"]').first()).toContainText('Ingesting knowledge base');

    // Navigate away to Home — panel should disappear from the screen
    // (it's only rendered inside KnowledgeBasePage) but the run continues.
    await clickNav(page, 'home');
    await expect(page.locator('.wiki-chat-panel')).toHaveCount(0);

    // Navigate back to /knowledge — panel must reappear with the same
    // conversation and still be running.
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const panelAfter = page.locator('.wiki-chat-panel');
    await expect(panelAfter).toBeVisible({ timeout: 3_000 });
    await expect(panelAfter.locator('.wiki-chat-status')).toHaveText(/运行中/);
    await expect(panelAfter.locator('[data-testid="assistant-message"]').first()).toContainText('Ingesting knowledge base');
  });
});

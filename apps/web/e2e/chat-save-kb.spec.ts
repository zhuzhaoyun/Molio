import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * "Save to knowledge base" on an assistant message writes the raw markdown
 * to the active vault as a new .md file, one-click (no picker).
 */

const VAULT_ID = 'vault-1';

// A reply with a clear first line so the derived filename is readable.
const REPLY_WITH_TITLE = [
  { type: 'status', label: 'running' },
  { type: 'text_delta', delta: '## 如何做番茄炒蛋\n\n先热油，再下番茄。' },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
];

test.describe('Chat — save to knowledge base', () => {
  test.beforeEach(async ({ page }) => {
    // Persist an active vault so the save button is enabled without relying
    // on the vault-list fetch + auto-select race.
    await page.addInitScript((vid) => {
      try { localStorage.setItem('molio.activeVaultId', vid); } catch { /* ignore */ }
    }, VAULT_ID);

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: REPLY_WITH_TITLE });

    // Mock the vault list so the store keeps the persisted active vault.
    await page.route('**/api/knowledge/vaults', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          vaults: [
            { id: VAULT_ID, name: 'Test Vault', path: '/tmp/vault', createdAt: 0, updatedAt: 0 },
          ],
        }),
      });
    });

    // Active-vault endpoint (the store also syncs to it; harmless if mocked).
    await page.route('**/api/knowledge/active-vault', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ vaultId: VAULT_ID, vault: null }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    });
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
    await page.unroute('**/api/knowledge/vaults');
    await page.unroute('**/api/knowledge/active-vault');
  });

  test('save writes the reply markdown to the active vault as a .md file', async ({ page }) => {
    let savedPath: string | null = null;
    let savedBody: { content?: string } | null = null;
    await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
      if (route.request().method() === 'POST') {
        savedPath = route.request().url();
        try { savedBody = JSON.parse(route.request().postData() || '{}'); } catch { /* ignore */ }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await gotoHome(page);
    await sendMessage(page, '写个菜谱');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="msg-save-kb-btn"]').click();

    // The write hit the vault's files endpoint with the reply content.
    await expect.poll(() => savedPath).toContain('/files/');
    expect(savedPath).toMatch(/\.md$/);
    expect(savedBody?.content).toContain('如何做番茄炒蛋');

    // Button reflects success transiently.
    const btn = page.locator('[data-testid="msg-save-kb-btn"]');
    await expect(btn).toHaveAttribute('data-tip', /^已保存/);

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });

  test('save button disabled when no active vault is selected', async ({ page }) => {
    // Override: no persisted vault, empty vault list.
    await page.addInitScript(() => {
      try { localStorage.removeItem('molio.activeVaultId'); } catch { /* ignore */ }
    });
    await page.unroute('**/api/knowledge/vaults');
    await page.route('**/api/knowledge/vaults', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ vaults: [] }) });
    });

    await gotoHome(page);
    await sendMessage(page, 'anything');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    const btn = page.locator('[data-testid="msg-save-kb-btn"]');
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('data-tip', '先选择一个知识库');
  });
});

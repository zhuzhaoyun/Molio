import { test, expect } from '@playwright/test';

/**
 * E2E: Claude Code one-click install + DeepSeek provider configuration.
 *
 * Prerequisites: daemon (:3100) + web (:5173) running via `pnpm dev`.
 *
 * Tests:
 *  1. Navigate to runtimes page
 *  2. Find Claude Code agent card (should be available if installed)
 *  3. Expand provider config panel
 *  4. Select DeepSeek as provider
 *  5. Enter API key
 *  6. Save and verify persistence
 *  7. Clean up (reset to Anthropic default)
 */

test.describe('Runtime provider config', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Navigate to Settings → Runtimes tab (standalone /runtimes route was removed)
    await page.locator('[data-view="settings"]').click();
    await expect(page.locator('.settings-shell')).toBeVisible();
    const runtimesTab = page.locator('.settings-tab-btn').filter({ hasText: /Runtime|运行时/ });
    await runtimesTab.click({ timeout: 5_000 });
    await expect(page.locator('.rt-shell')).toBeVisible();
  });

  test('Claude Code card shows provider config button when installed', async ({ page }) => {
    // Find the Claude Code agent card — it should be in the "installed" section
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });
    await expect(claudeCard).toBeVisible();

    // Should show "可用" badge
    await expect(claudeCard.locator('.rt-badge--ok')).toBeVisible();

    // Should have the provider config toggle button (⚙ 模型提供商)
    const providerToggle = claudeCard.locator('.rt-provider-toggle');
    await expect(providerToggle).toBeVisible();
  });

  test('expand provider config and select DeepSeek', async ({ page }) => {
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });
    await expect(claudeCard).toBeVisible();

    // Click the provider toggle to expand
    const providerToggle = claudeCard.locator('.rt-provider-toggle');
    await providerToggle.click();

    // Provider config panel should appear
    const configPanel = claudeCard.locator('.rt-provider-config');
    await expect(configPanel).toBeVisible();

    // Provider selector dropdown should be present
    const providerSelect = configPanel.locator('.rt-provider-form__select');
    await expect(providerSelect).toBeVisible();

    // Select DeepSeek
    await providerSelect.selectOption('deepseek');

    // API key input should appear (not shown for Anthropic)
    const apiKeyInput = configPanel.locator('.rt-provider-form__input[type="password"]');
    await expect(apiKeyInput).toBeVisible();

    // Should show DeepSeek-specific hint
    await expect(configPanel.locator('.rt-provider-form__hint')).toContainText('sk-');

    // Should show link to get API key
    const apiKeyLink = configPanel.locator('.rt-provider-form__link').filter({ hasText: 'API Key' });
    await expect(apiKeyLink).toBeVisible();
    await expect(apiKeyLink).toHaveAttribute('href', 'https://platform.deepseek.com/api_keys');

    // Should show DeepSeek models
    const modelsSection = configPanel.locator('.rt-provider-form__models');
    await expect(modelsSection).toContainText('DeepSeek Chat (V3)');
    await expect(modelsSection).toContainText('DeepSeek Reasoner (R1)');
  });

  test('save DeepSeek config and verify persistence', async ({ page }) => {
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });

    // Expand provider config
    await claudeCard.locator('.rt-provider-toggle').click();
    const configPanel = claudeCard.locator('.rt-provider-config');
    await expect(configPanel).toBeVisible();

    // Select DeepSeek
    await configPanel.locator('.rt-provider-form__select').selectOption('deepseek');

    // Enter a test API key
    const apiKeyInput = configPanel.locator('.rt-provider-form__input[type="password"]');
    await apiKeyInput.fill('sk-test-e2e-deepseek-key');

    // Click save
    const saveBtn = configPanel.locator('.rt-provider-form__actions .rt-btn').first();
    await saveBtn.click();

    // Should show saved confirmation
    await expect(configPanel.locator('.rt-provider-form__status--ok')).toBeVisible({ timeout: 5000 });

    // Verify via API that config was persisted correctly
    const response = await page.evaluate(async () => {
      const res = await fetch('http://localhost:3100/api/config/agents/claude');
      return res.json();
    });

    expect(response.env).toBeDefined();
    expect(response.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com');
    expect(response.env.ANTHROPIC_API_KEY).toBe('sk-test-e2e-deepseek-key');

    // Collapse and re-expand — should detect DeepSeek as current provider
    await claudeCard.locator('.rt-provider-config__header .rt-btn').click(); // close
    await claudeCard.locator('.rt-provider-toggle').click(); // reopen

    const reopenedSelect = claudeCard.locator('.rt-provider-config .rt-provider-form__select');
    await expect(reopenedSelect).toHaveValue('deepseek');
  });

  test('switch between providers clears API key', async ({ page }) => {
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });

    // Expand
    await claudeCard.locator('.rt-provider-toggle').click();
    const configPanel = claudeCard.locator('.rt-provider-config');

    // Select DeepSeek and enter key
    await configPanel.locator('.rt-provider-form__select').selectOption('deepseek');
    await configPanel.locator('.rt-provider-form__input[type="password"]').fill('sk-some-key');

    // Switch to OpenRouter
    await configPanel.locator('.rt-provider-form__select').selectOption('openrouter');

    // API key should be cleared
    const apiKeyInput = configPanel.locator('.rt-provider-form__input[type="password"]');
    await expect(apiKeyInput).toHaveValue('');

    // Should show OpenRouter-specific hint
    await expect(configPanel.locator('.rt-provider-form__hint')).toContainText('sk-or-');
  });

  test('clean up: reset to Anthropic default', async ({ page }) => {
    // Reset via API
    await page.evaluate(async () => {
      await fetch('http://localhost:3100/api/config/agents/claude', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: { ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '' } }),
      });
    });

    // Verify
    const response = await page.evaluate(async () => {
      const res = await fetch('http://localhost:3100/api/config/agents/claude');
      return res.json();
    });
    expect(response.env.ANTHROPIC_BASE_URL).toBe('');
  });
});

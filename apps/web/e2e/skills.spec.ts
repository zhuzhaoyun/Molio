import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area settings
 * @priority P1
 *
 * E2E tests for the Skills library (Settings → 技能 tab).
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 * The daemon seeds built-in skills (写文章 / 总结提炼 / 润色改写) into the real
 * ~/.molio/skills on startup, so these tests run against real on-disk state.
 * The lifecycle test deletes the skill it creates to avoid polluting the library.
 *
 * The "存为技能" chat-button prefill flow needs a live Claude run, so it is NOT
 * covered here (P2 placeholder by design); the daemon prefill parser + fallback
 * are unit-tested in apps/daemon/test/core/skills/prefill.test.ts.
 */

async function gotoSkillsTab(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await clickNav(page, 'settings');
  await page.locator('[data-testid="settings-tab-skills"]').click();
  await expect(page.locator('.sk-shell')).toBeVisible({ timeout: 5_000 });
}

test.describe('Skills library', () => {
  test('tab shows the library with built-in skills and the Claude-only note', async ({ page }) => {
    await gotoSkillsTab(page);

    // Built-ins are seeded on daemon startup → at least one built-in badge.
    await expect(page.locator('.sk-badge--builtin').first()).toBeVisible({ timeout: 5_000 });
    // A known seeded built-in name is present.
    await expect(page.locator('.sk-row', { hasText: '写文章' }).first()).toBeVisible();
    // Claude-only footnote.
    await expect(page.locator('.sk-note')).toBeVisible();
  });

  test('built-in skills cannot be deleted (delete button disabled)', async ({ page }) => {
    await gotoSkillsTab(page);

    const builtinRow = page.locator('.sk-row', { hasText: '写文章' }).first();
    await expect(builtinRow).toBeVisible({ timeout: 5_000 });
    const deleteBtn = builtinRow.locator('[data-testid^="skill-delete-"]').first();
    await expect(deleteBtn).toBeDisabled();
  });

  test('full lifecycle: create → toggle → edit → delete', async ({ page }) => {
    await gotoSkillsTab(page);

    const unique = `E2E技能${Date.now()}`;

    // ── Create ──
    await page.locator('[data-testid="skill-new-btn"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    await page.getByTestId('skill-name-input').fill(unique);
    await page.getByTestId('skill-description-input').fill('自动化测试用技能');
    await page.getByTestId('skill-instructions-input').fill('这是测试指令正文。');
    await page.getByTestId('skill-form-submit').click();

    // Modal closes and the new row appears (enabled → checkbox checked).
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);
    const row = page.locator('.sk-row', { hasText: unique });
    await expect(row).toBeVisible({ timeout: 5_000 });
    // The native <input> is visually hidden behind a custom .sk-switch__track,
    // so click the visible track (the wrapping <label> forwards it to the input)
    // but assert on the input's checked state.
    const checkbox = row.locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked();

    // ── Toggle off ──
    await row.locator('.sk-switch__track').click();
    await expect(checkbox).not.toBeChecked({ timeout: 5_000 });

    // ── Edit (rename) ──
    const renamed = `${unique}-改`;
    await row.locator('[data-testid^="skill-edit-"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    // Edit form prefills the current name; instructions load async — wait for them.
    await expect(page.getByTestId('skill-name-input')).toHaveValue(unique);
    await expect(page.getByTestId('skill-instructions-input')).toHaveValue('这是测试指令正文。', { timeout: 5_000 });
    await page.getByTestId('skill-name-input').fill(renamed);
    await page.getByTestId('skill-form-submit').click();
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);

    const renamedRow = page.locator('.sk-row', { hasText: renamed });
    await expect(renamedRow).toBeVisible({ timeout: 5_000 });

    // ── Delete (two-step confirm) ──
    await renamedRow.locator('[data-testid^="skill-delete-"]').first().click();
    await renamedRow.locator('[data-testid^="skill-delete-confirm-"]').click();
    await expect(renamedRow).toHaveCount(0, { timeout: 5_000 });
  });

  test('create form validates required name and instructions', async ({ page }) => {
    await gotoSkillsTab(page);

    await page.locator('[data-testid="skill-new-btn"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();

    // Submit empty → inline error, modal stays open.
    await page.getByTestId('skill-form-submit').click();
    await expect(page.getByTestId('skill-form-error')).toBeVisible();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();

    await page.locator('.kb-modal-close').click();
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);
  });
});

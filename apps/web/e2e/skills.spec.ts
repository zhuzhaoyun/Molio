import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area settings
 * @priority P1
 *
 * E2E tests for the Skills library (Settings → 技能 tab).
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 * The daemon seeds bundled skills (docling / wiki-* / wechat-article-extractor /
 * remotion) into the real ~/.molio/skills on startup; the old writing trio
 * (写文章 / 总结提炼 / 润色改写) is hidden as `core`, so these tests assert against
 * the bundled set. The lifecycle test deletes the skill it creates to avoid
 * polluting the library.
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
  // Wait for the seeded library to render so the initial load storm (StrictMode
  // doubles every call + default-vault auto-select writes) has settled before we
  // interact — otherwise a later POST can be queued behind it and look "stuck".
  await expect(page.locator('.sk-row').first()).toBeVisible({ timeout: 10_000 });
}

test.describe('Skills library', () => {
  test('tab shows the library with bundled skills and the Claude-only note', async ({ page }) => {
    await gotoSkillsTab(page);

    // Bundled skills are seeded on daemon startup → at least one bundled badge.
    await expect(page.locator('.sk-badge--bundled').first()).toBeVisible({ timeout: 5_000 });
    // A known seeded bundled skill is present.
    await expect(page.locator('.sk-row', { hasText: 'docling' }).first()).toBeVisible();
    // Claude-only footnote.
    await expect(page.locator('.sk-note')).toBeVisible();
  });

  test('bundled skills cannot be deleted (delete button disabled)', async ({ page }) => {
    await gotoSkillsTab(page);

    const bundledRow = page.locator('.sk-row', { hasText: 'docling' }).first();
    await expect(bundledRow).toBeVisible({ timeout: 5_000 });
    const deleteBtn = bundledRow.locator('[data-testid^="skill-delete-"]').first();
    await expect(deleteBtn).toBeDisabled();
  });

  test('full lifecycle: create → toggle → edit → delete', async ({ page }) => {
    await gotoSkillsTab(page);

    const unique = `E2E技能${Date.now()}`;

    // ── Create (single SKILL.md editor) ──
    await page.locator('[data-testid="skill-new-btn"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    const createMd = `---\nname: ${unique}\ndescription: 自动化测试用技能\n---\n\n这是测试指令正文。`;
    await page.getByTestId('skill-markdown-input').fill(createMd);
    await page.getByTestId('skill-form-submit').click();

    // The row only appears once the create response is processed, so it is the
    // real success signal — wait on it (generous timeout tolerates the dev-server
    // request-queue stall), then the overlay closes right after.
    const row = page.locator('.sk-row', { hasText: unique });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);
    // The native <input> is visually hidden behind a custom .sk-switch__track,
    // so click the visible track (the wrapping <label> forwards it to the input)
    // but assert on the input's checked state.
    const checkbox = row.locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked();

    // ── Toggle off ──
    await row.locator('.sk-switch__track').click();
    await expect(checkbox).not.toBeChecked({ timeout: 5_000 });

    // ── Edit (rename via the markdown editor) ──
    const renamed = `${unique}-改`;
    await row.locator('[data-testid^="skill-edit-"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    // Edit prefills the skill's serialized SKILL.md (loads async) — wait for it.
    await expect(page.getByTestId('skill-markdown-input')).toHaveValue(new RegExp(unique), { timeout: 10_000 });
    await expect(page.getByTestId('skill-markdown-input')).toHaveValue(/这是测试指令正文。/, { timeout: 10_000 });
    const renamedMd = `---\nname: ${renamed}\ndescription: 自动化测试用技能\n---\n\n这是测试指令正文。`;
    await page.getByTestId('skill-markdown-input').fill(renamedMd);
    await page.getByTestId('skill-form-submit').click();

    const renamedRow = page.locator('.sk-row', { hasText: renamed });
    await expect(renamedRow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);

    // ── Delete (two-step confirm) ──
    await renamedRow.locator('[data-testid^="skill-delete-"]').first().click();
    await renamedRow.locator('[data-testid^="skill-delete-confirm-"]').click();
    await expect(renamedRow).toHaveCount(0, { timeout: 5_000 });
  });

  test('duplicate prefills a copy from an existing skill', async ({ page }) => {
    await gotoSkillsTab(page);

    const unique = `E2E副本${Date.now()}`;
    const src = page.locator('.sk-row', { hasText: 'docling' }).first();
    await expect(src).toBeVisible({ timeout: 5_000 });

    // Duplicate opens a create modal prefilled with the source SKILL.md.
    await src.locator('[data-testid^="skill-duplicate-"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    // Prefill loads async and carries the "副本" suffix on the name.
    await expect(page.getByTestId('skill-markdown-input')).toHaveValue(/副本/, { timeout: 10_000 });

    // Rename to something unique and save.
    const md = `---\nname: ${unique}\ndescription: 复制测试\n---\n\n复制来的指令。`;
    await page.getByTestId('skill-markdown-input').fill(md);
    await page.getByTestId('skill-form-submit').click();

    const row = page.locator('.sk-row', { hasText: unique });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Cleanup.
    await row.locator('[data-testid^="skill-delete-"]').first().click();
    await row.locator('[data-testid^="skill-delete-confirm-"]').click();
    await expect(row).toHaveCount(0, { timeout: 5_000 });
  });

  test('create form validates required name and instructions', async ({ page }) => {
    await gotoSkillsTab(page);

    await page.locator('[data-testid="skill-new-btn"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();

    // Submit empty → inline error (missing name), modal stays open.
    await page.getByTestId('skill-form-submit').click();
    await expect(page.getByTestId('skill-form-error')).toBeVisible();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();

    // Frontmatter but no body → still an error (missing instructions).
    await page.getByTestId('skill-markdown-input').fill('---\nname: 只有名字\ndescription: 无正文\n---\n\n');
    await page.getByTestId('skill-form-submit').click();
    await expect(page.getByTestId('skill-form-error')).toBeVisible();

    await page.locator('.kb-modal-close').click();
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);
  });

  test('import a multi-file skill directory via typed path', async ({ page }) => {
    // Build a real multi-file skill dir on the daemon host (pnpm dev runs the
    // daemon locally, so a host temp path is readable server-side).
    const unique = `E2E目录导入${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-skill-'));
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${unique}\ndescription: 目录导入测试\n---\n\n见 references/guide.md\n`,
      'utf8',
    );
    fs.mkdirSync(path.join(dir, 'references'));
    fs.writeFileSync(path.join(dir, 'references', 'guide.md'), 'detailed guide\n', 'utf8');

    try {
      await gotoSkillsTab(page);

      // Single "新建技能" button; switch its source to "导入文件 / 文件夹".
      await page.locator('[data-testid="skill-new-btn"]').click();
      await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
      await page.getByTestId('skill-source-import').click();
      // In a plain browser there is no Electron, so the native browse buttons
      // stay hidden — type the path.
      await expect(page.getByTestId('skill-import-browse-folder')).toHaveCount(0);
      await page.getByTestId('skill-import-folder').fill(dir);
      await page.getByTestId('skill-form-submit').click();

      // Row appears once the import is processed (generous timeout for dev queue).
      const row = page.locator('.sk-row', { hasText: unique });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);

      // Cleanup: delete the imported skill (mirrors the lifecycle test pattern).
      await row.locator('[data-testid^="skill-delete-"]').first().click();
      await row.locator('[data-testid^="skill-delete-confirm-"]').first().click();
      await expect(row).toHaveCount(0, { timeout: 5_000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

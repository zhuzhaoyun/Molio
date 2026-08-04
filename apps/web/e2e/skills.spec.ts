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
 * the bundled set. Tests that create skills delete them again to avoid
 * polluting the library.
 *
 * Authoring is the three-field form (name / description / instructions); the
 * instructions box accepts a whole pasted SKILL.md and auto-extracts the
 * frontmatter into the name / description fields. The paste event is
 * dispatched synthetically (ClipboardEvent + DataTransfer) so the test does not
 * depend on the OS clipboard.
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

/** Dispatch a synthetic paste of `text` into the instructions textarea. */
async function pasteIntoInstructions(page: import('@playwright/test').Page, text: string) {
  await page.getByTestId('skill-instructions-input').evaluate((el, value) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test.describe('Skills library', () => {
  test('tab shows the library with bundled skills and the runtime note', async ({ page }) => {
    await gotoSkillsTab(page);

    // Bundled skills are seeded on daemon startup → at least one bundled badge.
    await expect(page.locator('.sk-badge--bundled').first()).toBeVisible({ timeout: 5_000 });
    // A known seeded bundled skill is present.
    await expect(page.locator('.sk-row', { hasText: 'docling' }).first()).toBeVisible();
    // All-runtimes footnote.
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

    // ── Create (three-field form → save) ──
    await page.locator('[data-testid="skill-new-btn"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    await page.getByTestId('skill-name-input').fill(unique);
    await page.getByTestId('skill-description-input').fill('自动化测试用技能');
    await page.getByTestId('skill-instructions-input').fill('这是测试指令正文。');
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

    // ── Edit (rename) ──
    const renamed = `${unique}-改`;
    await row.locator('[data-testid^="skill-edit-"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    // Edit prefills the three fields (loads async) — wait for them.
    await expect(page.getByTestId('skill-name-input')).toHaveValue(unique, { timeout: 10_000 });
    await expect(page.getByTestId('skill-description-input')).toHaveValue('自动化测试用技能', { timeout: 10_000 });
    await expect(page.getByTestId('skill-instructions-input')).toHaveValue('这是测试指令正文。', { timeout: 10_000 });
    await page.getByTestId('skill-name-input').fill(renamed);
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

    // Duplicate opens the create editor prefilled with the source skill's fields.
    await src.locator('[data-testid^="skill-duplicate-"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    // Prefill loads async and carries the "副本" suffix on the name.
    await expect(page.getByTestId('skill-name-input')).toHaveValue(/副本/, { timeout: 10_000 });
    await expect(page.getByTestId('skill-description-input')).not.toHaveValue('', { timeout: 10_000 });
    await expect(page.getByTestId('skill-instructions-input')).not.toHaveValue('', { timeout: 10_000 });

    // Rename to something unique and save.
    await page.getByTestId('skill-name-input').fill(unique);
    await page.getByTestId('skill-form-submit').click();

    const row = page.locator('.sk-row', { hasText: unique });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Cleanup.
    await row.locator('[data-testid^="skill-delete-"]').first().click();
    await row.locator('[data-testid^="skill-delete-confirm-"]').click();
    await expect(row).toHaveCount(0, { timeout: 5_000 });
  });

  test('create form validates the required fields before saving', async ({ page }) => {
    await gotoSkillsTab(page);

    await page.locator('[data-testid="skill-new-btn"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();

    // All empty → name error.
    await page.getByTestId('skill-form-submit').click();
    await expect(page.getByTestId('skill-form-error')).toBeVisible();

    // Name only → description error (the model matches skills by description).
    await page.getByTestId('skill-name-input').fill('只有名字');
    await page.getByTestId('skill-form-submit').click();
    await expect(page.getByTestId('skill-form-error')).toBeVisible();

    // Name + description but no instructions → instructions error.
    await page.getByTestId('skill-description-input').fill('只有描述');
    await page.getByTestId('skill-form-submit').click();
    await expect(page.getByTestId('skill-form-error')).toBeVisible();

    // A stray click on empty space must NOT wipe the typed fields — only the
    // Back / Cancel buttons close the editor. Click the bottom-left padding
    // region of the fullscreen editor (clear of the top bar and all fields).
    const overlay = page.getByTestId('skill-form-overlay');
    const box = await overlay.boundingBox();
    await overlay.click({ position: { x: 5, y: (box?.height ?? 600) - 5 } });
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    await expect(page.getByTestId('skill-name-input')).toHaveValue('只有名字');

    await page.getByTestId('skill-form-cancel').click();
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);
  });

  test('pasting a platform copy whose frontmatter collapsed onto one line still extracts', async ({ page }) => {
    await gotoSkillsTab(page);

    await page.locator('[data-testid="skill-new-btn"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();

    // Regression (user report): platform copies lose the newlines between
    // frontmatter lines — `name: …` and `description: | …` land on ONE line.
    // Extraction must split them again instead of swallowing everything after
    // `name:` into the name field and leaving description empty.
    const description = '数字生命卡兹克（Khazix）的公众号长文写作skill。当用户需要撰写公众号文章、写稿子时使用。';
    const collapsed = [
      `name: khazix-writer description: | ${description}`,
      '卡兹克公众号长文写作',
      '这是正文第一行。',
    ].join('\n');
    await pasteIntoInstructions(page, collapsed);

    await expect(page.getByTestId('skill-name-input')).toHaveValue('khazix-writer');
    await expect(page.getByTestId('skill-description-input')).toHaveValue(description);
    await expect(page.getByTestId('skill-instructions-input')).toHaveValue('卡兹克公众号长文写作\n这是正文第一行。');

    // Nothing was saved → just close via Cancel, no cleanup needed.
    await page.getByTestId('skill-form-cancel').click();
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);
  });

  test('pasting a full SKILL.md auto-fills name and description', async ({ page }) => {
    await gotoSkillsTab(page);

    const unique = `E2E粘贴提取${Date.now()}`;
    await page.locator('[data-testid="skill-new-btn"]').click();
    await expect(page.getByTestId('skill-form-overlay')).toBeVisible();

    // Paste a whole SKILL.md into the instructions box → the frontmatter is
    // extracted into the name / description fields and stripped from the body.
    const md = `---\nname: ${unique}\ndescription: 粘贴提取测试\n---\n\n这是粘贴来的指令正文。`;
    await pasteIntoInstructions(page, md);

    await expect(page.getByTestId('skill-name-input')).toHaveValue(unique);
    await expect(page.getByTestId('skill-description-input')).toHaveValue('粘贴提取测试');
    await expect(page.getByTestId('skill-instructions-input')).toHaveValue('这是粘贴来的指令正文。');

    // Everything extracted → a single click saves.
    await page.getByTestId('skill-form-submit').click();

    const row = page.locator('.sk-row', { hasText: unique });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('skill-form-overlay')).toHaveCount(0);

    // Cleanup.
    await row.locator('[data-testid^="skill-delete-"]').first().click();
    await row.locator('[data-testid^="skill-delete-confirm-"]').first().click();
    await expect(row).toHaveCount(0, { timeout: 5_000 });
  });

  test('save failure shows the error inside the editor, keeping it open', async ({ page }) => {
    await gotoSkillsTab(page);

    // Force the create request to fail. The editor must stay open and surface
    // the daemon's error message itself — before the fix the error rendered
    // only in the panel banner BEHIND the overlay, invisible to the user.
    await page.route('**/api/skills', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'E2E模拟保存失败' } }),
      });
    });

    try {
      await page.locator('[data-testid="skill-new-btn"]').click();
      await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
      await page.getByTestId('skill-name-input').fill('E2E失败可见性');
      await page.getByTestId('skill-description-input').fill('错误显示测试');
      await page.getByTestId('skill-instructions-input').fill('这是正文。');
      await page.getByTestId('skill-form-submit').click(); // → save (fails)

      // The error text appears inside the editor and the editor stays open.
      await expect(page.getByTestId('skill-form-error')).toHaveText('E2E模拟保存失败', { timeout: 10_000 });
      await expect(page.getByTestId('skill-form-overlay')).toBeVisible();
    } finally {
      await page.unroute('**/api/skills');
    }

    // Nothing was created, so nothing to clean up — just close the editor.
    await page.getByTestId('skill-form-cancel').click();
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

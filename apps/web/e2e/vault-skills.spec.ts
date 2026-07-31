import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

/**
 * @area kb
 * @priority P1
 *
 * E2E tests for the per-vault skill enablement modal (Knowledge Base →
 * 「技能配置」 button). Covers: button visibility → open modal → bundled skills
 * (docling / wiki-* / remotion / wechat) render with the bundled badge and are
 * toggleable → the core writing trio (写文章/总结提炼/润色改写) is NEVER listed
 * → opt a bundled skill out of this vault (persists) → globally-disabled skills
 * render greyed + locked.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173). The daemon seeds
 * the built-in skills into the `skills` table on startup (8 bundled + 3 core);
 * the per-vault list shows the bundled ones and filters the core ones. We
 * register a real temp vault as the sync target and create one globally-DISABLED
 * temp skill (via the daemon API) to exercise the greyed/locked row; both are
 * torn down in afterAll so the real library and vault list stay clean.
 */

const DAEMON = 'http://localhost:3100';

/** A bundled skill seeded on startup — shown + configurable per vault. */
const BUNDLED_SLUG = 'docling';
/** Core (writing trio) ids — must never appear in the per-vault list. */
const CORE_IDS = ['write-article', 'summarize', 'polish-rewrite'];

interface TempSkill {
  id: string;
  name: string;
}

/** Create a skill via the daemon API and toggle it globally OFF. */
async function createDisabledSkill(name: string): Promise<TempSkill> {
  const created = await fetch(`${DAEMON}/api/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: '灰显测试', instructions: '正文' }),
  });
  const skill = (await created.json()).skill as { id: string };
  await fetch(`${DAEMON}/api/skills/${skill.id}/toggle`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  return { id: skill.id, name };
}

async function deleteSkill(id: string) {
  await fetch(`${DAEMON}/api/skills/${id}`, { method: 'DELETE' });
}

let vault: TempVault;
let offSkill: TempSkill;

test.describe('Per-vault skill configuration', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-vault-skills');
    offSkill = await createDisabledSkill(`E2E灰显${Date.now()}`);
  });

  test.afterAll(async () => {
    if (offSkill) await deleteSkill(offSkill.id);
    if (vault) await cleanupTempVault(vault);
  });

  /** Open the KB page with the temp vault active, then open the skills modal. */
  async function openSkillsModal(page: import('@playwright/test').Page) {
    // Hard-navigate straight to the knowledge route with the temp vault selected
    // via URL param (same mechanism as knowledge.spec). A full reload is more
    // reliable here than an SPA clickNav-then-goto sequence, which can race the
    // router under Vite dev and render a blank page.
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 15_000 });
    const btn = page.getByTestId('kb-btn-skills');
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();
    const overlay = page.getByTestId('vault-skills-overlay');
    await expect(overlay).toBeVisible({ timeout: 5_000 });
    return overlay;
  }

  test('skills button is visible and enabled with an active vault', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 15_000 });
    const btn = page.getByTestId('kb-btn-skills');
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });
  });

  test('lists bundled skills (with badge) and never the core writing trio', async ({ page }) => {
    const overlay = await openSkillsModal(page);

    // At least one skill row renders (bundled skills are seeded → never empty).
    await expect(overlay.locator('.sk-row').first()).toBeVisible({ timeout: 5_000 });

    // A seeded bundled skill is present and carries the bundled badge.
    const bundledRow = overlay.locator(`[data-testid="vault-skill-row-${BUNDLED_SLUG}"]`);
    await expect(bundledRow).toBeVisible({ timeout: 5_000 });
    await expect(bundledRow.locator('.sk-badge--bundled')).toBeVisible();

    // The core writing trio is hidden — none of their rows may render.
    for (const id of CORE_IDS) {
      await expect(overlay.locator(`[data-testid="vault-skill-row-${id}"]`)).toHaveCount(0);
    }
  });

  test('opting a bundled skill out of this vault persists across reopen', async ({ page }) => {
    const overlay = await openSkillsModal(page);

    // docling is a globally-enabled bundled skill → checked for a fresh vault.
    const row = overlay.locator(`[data-testid="vault-skill-row-${BUNDLED_SLUG}"]`);
    const checkbox = row.locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked({ timeout: 5_000 });

    // Click the visible custom track (native input is hidden behind it).
    await row.locator('.sk-switch__track').click();
    await expect(checkbox).not.toBeChecked({ timeout: 5_000 });

    // Close and reopen → the per-vault override persisted.
    await page.getByTestId('vault-skills-close').click();
    await expect(overlay).toHaveCount(0);
    await page.getByTestId('kb-btn-skills').click();
    await expect(overlay).toBeVisible({ timeout: 5_000 });
    const reopened = overlay.locator(`[data-testid="vault-skill-row-${BUNDLED_SLUG}"]`);
    await expect(reopened.locator('input[type="checkbox"]')).not.toBeChecked({ timeout: 5_000 });

    // Restore: re-enable so we leave the (temp) vault in its inherited state.
    await reopened.locator('.sk-switch__track').click();
    await expect(reopened.locator('input[type="checkbox"]')).toBeChecked({ timeout: 5_000 });
  });

  test('a globally-disabled skill renders greyed and locked', async ({ page }) => {
    const overlay = await openSkillsModal(page);

    const row = overlay.locator(`[data-testid="vault-skill-row-${offSkill.id}"]`);
    await expect(row).toBeVisible({ timeout: 5_000 });
    // Greyed state class applied.
    await expect(row).toHaveClass(/sk-row--off/);
    // Switch is disabled (master switch lives in Settings → Skills).
    const checkbox = row.locator('input[type="checkbox"]');
    await expect(checkbox).toBeDisabled();
    await expect(checkbox).not.toBeChecked();
  });
});

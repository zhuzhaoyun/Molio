import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

/**
 * @area chat
 * @priority P1
 *
 * E2E tests for the composer "/" skill palette (explicit skill invocation,
 * mirroring Claude Code's slash-command UX).
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173) — or just
 * `npx playwright test`, the config boots the servers.
 *
 * Seeding: the palette trigger requires an active vault (skills sync into
 * `<vault>/.claude/skills/` only), so beforeAll registers a temp vault.
 * Two library skills are created via the daemon API with unique names and
 * deleted again in afterAll. Bundled skills (docling etc.) exist on every
 * install and are surfaced read-only via GET /api/skills?includeBundled=1,
 * so the palette also asserts one.
 */

const DAEMON = 'http://localhost:3100';

let vault: TempVault;
let skillAId = '';
let skillBId = '';
let skillAName = '';
let skillBName = '';

async function createSkill(name: string, description: string): Promise<string> {
  const res = await fetch(`${DAEMON}/api/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, instructions: `# ${name}\n\ntest instructions` }),
  });
  if (!res.ok) throw new Error(`createSkill(${name}) failed: ${res.status}`);
  const data = await res.json();
  return (data.skill ?? data).id as string;
}

async function deleteSkill(id: string) {
  await fetch(`${DAEMON}/api/skills/${id}`, { method: 'DELETE' });
}

/**
 * Delete leftovers from crashed earlier runs (killed daemon mid-test, aborted
 * run). They share our `E2E技能甲/乙<ts>` naming; left in place they would sit
 * at the top of the palette's createdAt-sorted list and shift the ArrowDown
 * keyboard-navigation assertion onto a stale row.
 */
async function sweepLeftoverSkills() {
  try {
    const res = await fetch(`${DAEMON}/api/skills`);
    const data = await res.json();
    for (const s of data.skills ?? []) {
      if (/^E2E技能[甲乙]\d+$/.test(s.name)) await deleteSkill(s.id);
    }
  } catch {
    // best-effort — a failed sweep only risks the old flake, never a wrong pass
  }
}

test.beforeAll(async () => {
  vault = await createTempVault('e2e-skill-palette');
  await sweepLeftoverSkills();
  const uniq = Date.now();
  skillAName = `E2E技能甲${uniq}`;
  skillBName = `E2E技能乙${uniq}`;
  skillAId = await createSkill(skillAName, '测试技能甲的描述');
  skillBId = await createSkill(skillBName, '测试技能乙的描述');
});

test.afterAll(async () => {
  if (skillAId) await deleteSkill(skillAId);
  if (skillBId) await deleteSkill(skillBId);
  if (vault) await cleanupTempVault(vault);
});

test.describe('Composer / skill palette', () => {
  test('typing / at input start opens the palette listing installed skills', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/');

    const palette = page.locator('[data-testid="skill-palette"]');
    await expect(palette).toBeVisible({ timeout: 5_000 });
    // Library skills created in beforeAll are listed with their names.
    await expect(palette.locator('[data-testid="skill-palette-item"]', { hasText: skillAName })).toBeVisible();
    await expect(palette.locator('[data-testid="skill-palette-item"]', { hasText: skillBName })).toBeVisible();
    // Bundled skills are surfaced too (docling ships with every install).
    await expect(palette.locator('[data-testid="skill-palette-item"]', { hasText: 'docling' })).toBeVisible();
  });

  test('typing after / filters the skill list', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill(`/${skillAName}`);

    const palette = page.locator('[data-testid="skill-palette"]');
    await expect(palette).toBeVisible({ timeout: 5_000 });
    await expect(palette.locator('[data-testid="skill-palette-item"]', { hasText: skillAName })).toBeVisible();
    await expect(palette.locator('[data-testid="skill-palette-item"]', { hasText: skillBName })).toHaveCount(0);
  });

  test('clicking an item inserts the invocation prefix and closes the palette', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/');

    const item = page
      .locator('[data-testid="skill-palette-item"]', { hasText: skillAName })
      .first();
    await item.click({ timeout: 5_000 });

    // Deterministic zh prefix (default locale), matching the KB panel's
    // "用 <name> skill …" invocation pattern.
    await expect(input).toHaveValue(`用 ${skillAName} skill `);
    await expect(page.locator('[data-testid="skill-palette"]')).not.toBeVisible();
  });

  test('ArrowDown + Enter selects the next item and inserts its prefix', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/');
    await expect(page.locator('[data-testid="skill-palette"]')).toBeVisible({ timeout: 5_000 });

    await input.press('ArrowDown');
    await input.press('Enter');

    // Enter while the palette is open must SELECT — not send the message.
    await expect(input).toHaveValue(`用 ${skillBName} skill `);
    await expect(page.locator('[data-testid="skill-palette"]')).not.toBeVisible();
  });

  test('Escape closes the palette and clears the trigger text', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/');
    await expect(page.locator('[data-testid="skill-palette"]')).toBeVisible({ timeout: 5_000 });

    await input.press('Escape');
    await expect(page.locator('[data-testid="skill-palette"]')).not.toBeVisible();
    await expect(input).toHaveValue('');
  });

  test('a non-leading slash does not open the palette', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('hello /');
    await expect(page.locator('[data-testid="skill-palette"]')).not.toBeVisible({ timeout: 2_000 });

    // URL pasting must not trigger either.
    await input.fill('https://example.com');
    await expect(page.locator('[data-testid="skill-palette"]')).not.toBeVisible();
  });

  test('sending via the send button while the palette is open resets the trigger', async ({ page }) => {
    // The button really sends — mock the run so no agent binary is needed.
    await mockChatRun(page);
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/doc');
    await expect(page.locator('[data-testid="skill-palette"]')).toBeVisible({ timeout: 5_000 });

    // The send button sits outside the palette's Enter guard — clicking it
    // must send the message AND reset the trigger, leaving no palette
    // hovering over the now-empty input.
    await page.locator('[data-testid="composer-send"]').click();

    await expect(page.locator('[data-testid="skill-palette"]')).not.toBeVisible();
    await expect(input).toHaveValue('');
    await unmockAll(page);
  });
});

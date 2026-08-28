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

  test('clicking an item normalizes the input to /<skill name> and closes the palette', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/');

    const item = page
      .locator('[data-testid="skill-palette-item"]', { hasText: skillAName })
      .first();
    await item.click({ timeout: 5_000 });

    // Claude Code-style: the input keeps the RAW slash reference — the
    // natural-language expansion happens only at send time.
    await expect(input).toHaveValue(`/${skillAName} `);
    await expect(page.locator('[data-testid="skill-palette"]')).not.toBeVisible();
  });

  test('ArrowDown + Enter selects the next item and normalizes its slash ref', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/');
    const palette = page.locator('[data-testid="skill-palette"]');
    await expect(palette).toBeVisible({ timeout: 5_000 });
    // Wait for the LIST (not just the overlay) — keys pressed during the
    // loading state must not drive navigation.
    await expect(
      palette.locator('[data-testid="skill-palette-item"]').first(),
    ).toBeVisible({ timeout: 5_000 });

    // Capture the SECOND visible item's name BEFORE navigating: other skills
    // may exist in the shared daemon library and sort before ours — only
    // relative navigation is under test, not absolute list order.
    const secondName = (
      await palette
        .locator('[data-testid="skill-palette-item"]')
        .nth(1)
        .locator('.skill-palette-item-name')
        .innerText()
    )
      .replace('内置', '')
      .trim();

    await input.press('ArrowDown');
    await input.press('Enter');

    // Enter while the palette is open must SELECT — not send the message.
    await expect(input).toHaveValue(`/${secondName} `);
    await expect(palette).not.toBeVisible();
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

  test('Escape with a full typed message keeps the text and only closes the palette', async ({ page }) => {
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/docling 帮我转换这个文件');
    await expect(page.locator('[data-testid="skill-palette"]')).toBeVisible({ timeout: 5_000 });

    await input.press('Escape');
    await expect(page.locator('[data-testid="skill-palette"]')).not.toBeVisible();
    // The text is real message content, not scaffolding — Esc must not wipe it.
    await expect(input).toHaveValue('/docling 帮我转换这个文件');
  });

  test('sending a message with a leading /name expands it for the agent', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    await input.click();
    await input.fill('/docling 帮我转换这个文件');
    // Palette is open (leading /) and the filter has no exact match — Esc
    // closes it while keeping the text, then Enter sends.
    await input.press('Escape');
    await input.press('Enter');

    const userMsg = page.locator('[data-testid="user-message"]').first();
    await expect(userMsg).toContainText('用 docling skill 帮我转换这个文件', { timeout: 5_000 });
    await unmockAll(page);
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

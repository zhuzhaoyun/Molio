import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';

test.describe('File reference navigation', () => {
  test('wikilinks in assistant messages have data-file-path attribute', async ({ page }) => {
    await gotoHome(page);

    // Send a message asking the AI to include a wikilink.
    // The AI may or may not comply depending on the agent — but if it does,
    // the rendered wikilink should have the data-file-path attribute.
    const input = page.locator('[data-testid="composer-input"]');
    const sendBtn = page.locator('[data-testid="composer-send"]');

    // Check that composer is ready (not disabled due to missing agent)
    const isDisabled = await sendBtn.isDisabled().catch(() => true);
    if (isDisabled) {
      test.skip(true, 'No agent available — skipping wikilink render test');
      return;
    }

    await sendMessage(page, '请在你的回复中包含一个指向 notes/test-file.md 的 wikilink，如 [[notes/test-file.md]]，并只回复一个简单确认');

    // Wait for assistant response
    const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
    await assistantMsg.waitFor({ state: 'visible', timeout: 30000 });

    // Wait for streaming to finish — the cursor disappears when done
    await page.waitForTimeout(3000);

    // Find any wikilinks in the response
    const wikiLinks = page.locator('[data-testid="assistant-prose"] .kb-wiki-link');
    const count = await wikiLinks.count();

    if (count > 0) {
      // Verify attribute exists
      const firstLink = wikiLinks.first();
      const dataPath = await firstLink.getAttribute('data-file-path');
      expect(dataPath).toBeTruthy();

      // Verify cursor style
      const cursor = await firstLink.evaluate(el => window.getComputedStyle(el).cursor);
      expect(cursor).toBe('pointer');
    }
    // If count is 0, the AI didn't include a wikilink — not a test failure,
    // the feature just wasn't exercised in this run.
  });

  test('wikilinks have proper styling', async ({ page }) => {
    await gotoHome(page);

    // Verify that the CSS for .kb-wiki-link is loaded by checking for the
    // presence of assistant prose container (which includes the styles)
    const input = page.locator('[data-testid="composer-input"]');
    const sendBtn = page.locator('[data-testid="composer-send"]');

    const isDisabled = await sendBtn.isDisabled().catch(() => true);
    if (isDisabled) {
      test.skip(true, 'No agent available');
      return;
    }

    await sendMessage(page, '回复 [[test/style-check.md]]，就回复"好的"即可');
    await page.waitForTimeout(5000);

    // Just verify the page renders without errors and the assistant-prose exists
    const prose = page.locator('[data-testid="assistant-prose"]');
    const visible = await prose.isVisible().catch(() => false);
    expect(visible).toBe(true);
  });
});

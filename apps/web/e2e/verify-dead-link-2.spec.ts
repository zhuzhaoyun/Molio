/**
 * @area kb
 * @priority P2
 */
import { test, expect } from '@playwright/test';

const VAULT_ID = 'b1dba3bd-c36f-4921-b3a7-fea301705863';

test('investigate dead link behavior in detail', async ({ page }) => {
  // Open hot.md
  await page.goto(`http://localhost:5173/knowledge?vault=${VAULT_ID}&file=wiki/hot.md`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  });
  await page.waitForTimeout(3000);

  // Confirm page loaded
  await expect(page.locator('#output')).toBeVisible({ timeout: 10000 });
  const shellExists = await page.locator('.kb-shell').count();
  console.log(`KB shell: ${shellExists}`);

  // Find dead link
  const wikiLinks = page.locator('#output .kb-wiki-link');
  let deadLink = null;
  for (let i = 0; i < await wikiLinks.count(); i++) {
    const dataPath = await wikiLinks.nth(i).getAttribute('data-file-path');
    if (dataPath?.includes('硬科技vs软件创业壁垒对比')) {
      deadLink = wikiLinks.nth(i);
      break;
    }
  }
  expect(deadLink).not.toBeNull();

  // Log page state before click
  const beforeUrl = page.url();
  const beforeVaultName = await page.locator('.kb-vault-name, [data-testid="vault-name"]').textContent();
  const beforeFileTree = await page.locator('.kb-file-tree .kb-file-tree-item').count();
  console.log(`\nBefore click:`);
  console.log(`  URL: ${beforeUrl}`);
  console.log(`  Vault name: ${beforeVaultName?.trim()}`);
  console.log(`  File tree items: ${beforeFileTree}`);

  // Click dead link
  await deadLink!.click();
  await page.waitForTimeout(3000);

  // Log page state after click - more detailed
  const afterUrl = page.url();
  console.log(`\nAfter click:`);
  console.log(`  URL: ${afterUrl}`);

  // Check what's in the DOM
  const bodyHtml = await page.locator('.kb-shell').evaluate(el => ({
    className: el.className,
    childCount: el.children.length,
    firstChildClasses: el.children[0]?.className || '',
    secondChildClasses: el.children[1]?.className || '',
  }));
  console.log(`  KB shell children: ${JSON.stringify(bodyHtml)}`);

  // Check for various states
  const states = {
    'kb-empty-state': await page.locator('.kb-empty-state').count(),
    'kb-load-error': await page.locator('.kb-load-error').count(),
    '#output': await page.locator('#output').count(),
    'kb-file-tree': await page.locator('.kb-file-tree').count(),
    'kb-file-panel': await page.locator('.kb-file-panel').count(),
    'kb-main': await page.locator('.kb-main').count(),
  };
  console.log(`  State: ${JSON.stringify(states)}`);

  // Look for any visible text
  const visibleText = await page.locator('.kb-main').textContent();
  console.log(`  Main content text: "${visibleText?.trim().substring(0, 300)}"`);

  await page.screenshot({ path: '/tmp/dead-link-detailed.png' });
});

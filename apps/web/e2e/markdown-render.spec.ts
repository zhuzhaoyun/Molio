/**
 * @area kb
 * @priority P1
 *
 * E2E tests for Markdown rendering in the Knowledge Base.
 *
 * Creates a temporary vault with a comprehensive markdown file, then
 * verifies each rendering feature is correctly output by the doocs/md
 * rendering pipeline.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 *
 * CSS class reference (doocs/md Knowledge Base renderer):
 *   <table class="md-table"> inside <section class="table-wrapper">
 *   <li class="task-list-item"> with <input class="md-task-checkbox" disabled>
 *   <del> for strikethrough
 *   <img loading="lazy"> for images
 *   <li> for regular lists (display: block in default theme)
 * Note: Rich CSS styles (zebra-stripe, list-item display, comprehensive base) are
 *   defined in vendor/doocs-md/shared/configs/theme-css/ via applyTheme().
 */

import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON_API = 'http://localhost:3100/api';

// Reproduces the WeChat-clipping citation-marker crash: articles use
// `\\[1\\]` `\\[2\\]` as escaped-bracket reference markers, which the KaTeX
// extension's blockLatexRule mistook for LaTeX `\\[ ... \\]` block math and
// tried to call window.MathJax (never loaded) → "Cannot read properties of
// undefined (reading 'texReset')". See katex.ts guard.
const CITATION_TEST_MD = `飞樰 *2026年5月13日 08:30*

开源了一个名为"LLM-Wiki"的项目\\[1\\]，核心是 Markdown 文件\\[2\\]。

References

\\[1\\] LLM-Wiki：https://example.com/1

\\[2\\] AI Maker：https://example.com/2
`;

// LaTeX formulas in every supported syntax. Molio loads MathJax v3 locally
// (see src/utils/mathjaxLoader.ts) so the doocs/md KaTeX extension typesets
// these to real SVG; without MathJax they would render as raw LaTeX source.
const FORMULA_TEST_MD = `# Formula Test

Inline formula $E = mc^2$ here.

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

\\[ a^2 + b^2 = c^2 \\]

\\( x + y = z \\) inline latex.
`;

// Reproduces the ARMS-reported YAMLException: wiki skills mandate QUOTED
// wikilink lists in frontmatter (`related: - "[[页面]]"`). The renderer
// preprocessing used to rewrite [[…]] into `<a class="kb-wiki-link" href="…">`
// INSIDE the frontmatter block, corrupting the YAML ("bad indentation of a
// sequence entry" from js-yaml) — doocs/md's front-matter parse then failed
// and the whole frontmatter block leaked into the rendered body. The fix
// (preprocessKbMarkdown) keeps the frontmatter block verbatim.
const FRONTMATTER_WIKILINK_MD = `---
title: 李白
type: entity
tags:
  - 诗人
related:
  - "[[杜甫]]"
sources:
  - "[[旧唐书]]"
---

# 李白

唐代诗人，与 [[杜甫]] 并称"李杜"。
`;

const RENDER_TEST_MD = `# Test Markdown Rendering

## Table

| Header 1 | Header 2 |
|----------|----------|
| Row 1 Cell 1 | Row 1 Cell 2 |
| Row 2 Cell 1 | Row 2 Cell 2 |

## Task List

- [ ] Unchecked task item
- [x] Checked task item

## Strikethrough

This text has ~~strikethrough~~ formatting.

## Image

![Test Image](https://example.com/test.png)

## Regular List

- List item one
- List item two
- List item three
`;

let testVaultPath: string;
let vaultId: string;
const vaultName = `e2e-render-${Date.now()}`;

/**
 * Navigate to knowledge base, select the test vault, and open render-test.md.
 *
 * The vault was created in beforeAll via the daemon API, but the UI vault store
 * only fetches vaults on page mount. We reload once so the store picks up the
 * new vault before opening the vault switcher.
 */
async function openRenderTestFile(page: import('@playwright/test').Page, filename = 'render-test.md') {
  await gotoHome(page);
  // Reload to re-fetch vault list from daemon (picks up vault created in beforeAll)
  await page.reload({ waitUntil: 'networkidle' });
  await clickNav(page, 'knowledge');
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

  // Open vault switcher
  await page.locator('.kb-vault-bar').first().click({ timeout: 5_000 });
  await page.waitForTimeout(500);

  // Select the test vault (unique name avoids collision with leftover vaults)
  const vaultItem = page.locator('.vm-vault-item').filter({ hasText: vaultName });
  await vaultItem.click({ timeout: 5_000 });
  await page.waitForTimeout(1_000);

  // Click the target file in the file tree
  const fileItem = page.locator('.kb-tree-item').filter({ hasText: filename });
  await fileItem.click({ timeout: 10_000 });

  // Wait for file content to load
  await expect(page.locator('.kb-header-filename-center')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.kb-content-area').getByText('Loading...')).toBeHidden({ timeout: 10_000 });
}

test.describe('Markdown Rendering', () => {
  test.beforeAll(async () => {
    // Create a temporary directory with a comprehensive markdown test file
    testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-render-'));
    writeFileSync(join(testVaultPath, 'render-test.md'), RENDER_TEST_MD);
    writeFileSync(join(testVaultPath, 'citation-test.md'), CITATION_TEST_MD);
    writeFileSync(join(testVaultPath, 'formula-test.md'), FORMULA_TEST_MD);
    writeFileSync(join(testVaultPath, 'frontmatter-wikilink.md'), FRONTMATTER_WIKILINK_MD);

    // Register the vault via the daemon API
    const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: vaultName, path: testVaultPath }),
    });
    const vault = await res.json();
    vaultId = vault.id;
  });

  test.afterAll(async () => {
    // Cleanup: delete vault via API and remove temp directory
    if (vaultId) {
      await fetch(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
    }
    if (testVaultPath) {
      rmSync(testVaultPath, { recursive: true, force: true });
    }
  });

  test('renders tables with correct class names and structure', async ({ page }) => {
    await openRenderTestFile(page);

    // doocs/md renders tables as <table class="md-table"> inside <section class="table-wrapper">
    const tableWrapper = page.locator('#output .table-wrapper').first();
    await expect(tableWrapper).toBeVisible({ timeout: 5_000 });

    const table = tableWrapper.locator('table.md-table');
    await expect(table).toBeVisible();

    // Verify table structure: thead > th, tbody > td
    await expect(table.locator('thead th').first()).toBeVisible();
    await expect(table.locator('thead th')).toHaveCount(2);
    await expect(table.locator('tbody td').first()).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(2);
  });

  test('renders task list with disabled checkboxes', async ({ page }) => {
    await openRenderTestFile(page);

    // Task list checkboxes have class .md-task-checkbox and are disabled in read mode
    const checkboxes = page.locator('#output .md-task-checkbox');
    await expect(checkboxes).toHaveCount(2);
    await expect(checkboxes.first()).toBeDisabled();
    await expect(checkboxes.nth(1)).toBeDisabled();

    // Each checkbox is wrapped in a li with class .task-list-item
    const taskItems = page.locator('#output .task-list-item');
    await expect(taskItems).toHaveCount(2);
  });

  test('renders strikethrough with del tag', async ({ page }) => {
    await openRenderTestFile(page);

    // GFM strikethrough (~~text~~) renders as <del>text</del>
    const del = page.locator('#output del').first();
    await expect(del).toBeVisible({ timeout: 5_000 });
    await expect(del).toHaveText('strikethrough');
  });

  test('renders images with lazy loading', async ({ page }) => {
    await openRenderTestFile(page);

    // doocs/md adds loading="lazy" to all images
    const img = page.locator('#output img[loading="lazy"]').first();
    await expect(img).toHaveAttribute('loading', 'lazy', { timeout: 5_000 });
    await expect(img).toHaveAttribute('alt', 'Test Image');
    await expect(img).toHaveAttribute('src', 'https://example.com/test.png');

    // Image is wrapped in a <figure> element
    const figure = page.locator('#output figure').first();
    await expect(figure).toBeVisible();
  });

  test('list items display as block value', async ({ page }) => {
    await openRenderTestFile(page);

    // Our test content has 3 regular list items + 2 task list items
    const listItems = page.locator('#output li');
    await expect(listItems).toHaveCount(5);

    // [MOLIO] 修复后 li 使用原生 list-item 渲染，而非 display: block
    const firstRegularItem = page.locator('#output ul li').first();
    await expect(firstRegularItem).toBeVisible();
    const display = await firstRegularItem.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('list-item');
  });

  test('tables have zebra-stripe styling on even rows', async ({ page }) => {
    await openRenderTestFile(page);

    // Verify table body rows exist
    const rows = page.locator('#output .md-table tbody tr');
    await expect(rows).toHaveCount(2);

    // Verify even rows have a background color from doocs/md theme
    const evenRow = page.locator('#output .md-table tbody tr:nth-child(even)').first();
    await expect(evenRow).toBeVisible({ timeout: 5_000 });
  });

  test('quoted wikilinks inside frontmatter do not corrupt YAML or leak into body', async ({ page }) => {
    // ARMS regression: preprocessing once rewrote [[…]] inside the frontmatter
    // block into raw HTML anchors, breaking js-yaml ("bad indentation of a
    // sequence entry") and dumping the whole frontmatter into the document.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await openRenderTestFile(page, 'frontmatter-wikilink.md');

    const output = page.locator('#output');

    // Body wikilinks are still transformed into navigable anchors — and there
    // is EXACTLY one: without the fix the leaked frontmatter renders a second
    // anchor (from `related: - "[[杜甫]]"`), so count > 1 means regression.
    await expect(
      output.locator('a.kb-wiki-link[data-file-path="杜甫"]'),
    ).toHaveCount(1, { timeout: 5_000 });

    // The frontmatter block must NOT leak into the rendered body
    await expect(output).not.toContainText('related:');
    await expect(output).not.toContainText('sources:');
    await expect(output).not.toContainText('type: entity');

    // Frontmatter parsed successfully → property card shows the metadata
    const fmCard = page.locator('[data-testid="kb-fm-expanded"]');
    await expect(fmCard).toBeVisible({ timeout: 5_000 });
    await expect(fmCard).toContainText('李白');

    // No front-matter parse errors were logged (the ARMS-reported symptom)
    const fmErrors = consoleErrors.filter((t) => /front-matter|YAMLException/i.test(t));
    expect(fmErrors).toEqual([]);
  });

  test('escaped-bracket citation markers do not crash MathJax renderer', async ({ page }) => {
    // WeChat clippings use `\\[1\\]` as escaped-bracket citation markers. They
    // collide with the LaTeX block rule and (before the #113 guard) crashed the
    // renderer with "Cannot read properties of undefined (reading 'texReset')"
    // when MathJax was missing. Now MathJax is loaded locally, but the citation
    // guard (isCitationLike in katex.ts) must still keep them as literal `[N]`
    // text — NOT typeset as display math.
    await openRenderTestFile(page, 'citation-test.md');

    // Must NOT render the MdRenderer error fallback
    await expect(page.locator('#output')).not.toContainText('Error rendering content', { timeout: 5_000 });
    await expect(page.locator('#output')).not.toContainText('texReset');

    // The `\\[N\\]` markers should render as literal `[N]` text in the body
    const output = page.locator('#output');
    await expect(output).toContainText('[1]');
    await expect(output).toContainText('[2]');

    // Regression: even with MathJax loaded, citation markers must NOT be turned
    // into math — no SVG anywhere in this (formula-free) document.
    await expect(page.locator('#output svg')).toHaveCount(0, { timeout: 5_000 });
  });

  test('renders LaTeX formulas as MathJax SVG', async ({ page }) => {
    // Formulas must render as real math (SVG), not raw LaTeX source. Covers all
    // four doocs/md syntaxes: `$...$`, `$$...$$`, `\\[ ... \\]`, `\\( ... \\)`.
    await openRenderTestFile(page, 'formula-test.md');

    // Inline formulas render inside span.katex-inline, block inside section.katex-block
    const inlineSvg = page.locator('#output .katex-inline svg');
    const blockSvg = page.locator('#output .katex-block svg');
    await expect(inlineSvg).toHaveCount(2, { timeout: 10_000 });
    await expect(blockSvg).toHaveCount(2, { timeout: 10_000 });

    // The raw LaTeX source must NOT leak as visible text (only inside
    // data-math-raw attributes).
    const outputText = await page.locator('#output').innerText();
    expect(outputText).not.toContain('$E = mc^2$');
    expect(outputText).not.toContain('\\frac');

    // Regression: MathJax SVG must contain `<use>` glyph references. Without
    // them (DOMPurify strips `<use>` by default — see sanitizeHtml ADD_TAGS
    // `use` in vendor/doocs-md/src/utils/markdownHelpers.ts) the formula
    // renders as a blank box even though the `<svg>` element exists.
    await expect(page.locator('#output .katex-inline svg use').first()).toBeVisible({ timeout: 10_000 });
    expect(await page.locator('#output .katex-inline svg use').count()).toBeGreaterThan(0);
    expect(await page.locator('#output .katex-block svg use').count()).toBeGreaterThan(0);
  });
});

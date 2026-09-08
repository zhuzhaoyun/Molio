import { test, expect } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area graph
 * @priority P1
 *
 * 图谱局部图（graphScope）：companion 副视图图谱按 scope 显示。
 *   - file-scope：主格当前文档的 1 跳邻域（随主格文档自动切换 + 重锚定）。
 *   - dir-scope：文件夹子图（树右键「查看局部图谱」触发，不随主格重锚定）。
 *   - 「回到当前文档」（graph-scope-back）把 dir-scope 切回 file-scope。
 *
 * 图谱渲染依赖 PixiJS (WebGL) canvas，节点无法 DOM 查询 → 用 GraphSearchBox
 * 的候选下拉（graph-search-option / graph-search-empty）作节点存在性断言。
 * 断言一律限定在 companion pane（`[data-testid="kb-companion-pane"]`）。
 *
 * 注意：用例 1–5 依赖 FE-3（KBP file-scope 接线）与 FE-4（dir 入口 + 回退），
 * 尚未实现 → 现在跑会「先红」，待接线后转绿；用例 6 是全量图回归护栏。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('Graph local scope', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-graph-local');
    fs.mkdirSync(path.join(vault.path, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'notes', 'alpha.md'), '# Alpha\n\n[[beta]]\n');
    fs.writeFileSync(path.join(vault.path, 'notes', 'beta.md'), '# Beta\n\n[[alpha]] [[gamma]]\n');
    fs.writeFileSync(path.join(vault.path, 'notes', 'gamma.md'), '# Gamma\n\n[[beta]]\n');
    fs.writeFileSync(path.join(vault.path, 'solo.md'), '# Solo\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  const companion = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="kb-companion-pane"]');

  async function gotoVault(page: import('@playwright/test').Page) {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
  }

  async function clickTreeItem(page: import('@playwright/test').Page, fileName: string) {
    const item = page.locator('.kb-tree-item').filter({ hasText: fileName }).first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText(fileName, { timeout: 5_000 });
  }

  /** Open a file under notes/: expand the folder, then click the file. */
  async function openNoteFile(page: import('@playwright/test').Page, fileName: string) {
    const folder = page.locator('.kb-tree-group-label').filter({ hasText: 'notes' }).first();
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await folder.click(); // expand notes/
    await clickTreeItem(page, fileName);
  }

  async function splitGraphViaTab(page: import('@playwright/test').Page) {
    await page.locator('.kb-wtab.is-active').click({ button: 'right' });
    await expect(page.locator('[data-testid="tab-split-graph"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="tab-split-graph"]').click();
  }

  /** Open the search in the companion and type a term (works only when the graph has data). */
  async function searchGraph(page: import('@playwright/test').Page, root: import('@playwright/test').Locator, term: string) {
    const toggle = root.locator('[data-testid="graph-search-open"]');
    const input = root.locator('[data-testid="graph-search-input"]');
    await expect(toggle).toBeVisible({ timeout: 10_000 }); // graph has data → search toggle exists
    if (!(await input.isVisible())) await toggle.click();
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('');
    await input.fill(term);
  }

  test('file-scope: opens 1-hop neighborhood (alpha excludes gamma)', async ({ page }) => {
    await gotoVault(page);
    await openNoteFile(page, 'alpha.md');
    await splitGraphViaTab(page);

    const pane = companion(page);
    await expect(pane).toBeVisible();
    await expect(pane.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await expect(pane.locator('[data-testid="companion-close"]')).toBeVisible();
    // 导航（前进/后退）是主格专属：副格图谱不渲染顶栏箭头
    await expect(pane.locator('[data-testid="graph-nav-navigation"]')).toHaveCount(0);
    // 主格文件未被换掉
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md');

    // 1 跳：alpha → beta（alpha 不直接链到 gamma）
    await searchGraph(page, pane, 'beta');
    await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
    await searchGraph(page, pane, 'gamma');
    await expect(pane.locator('[data-testid="graph-search-empty"]')).toBeVisible();
  });

  test('file-scope: re-anchors when the main pane document changes (beta pulls gamma to 1 hop)', async ({ page }) => {
    await gotoVault(page);
    await openNoteFile(page, 'alpha.md');
    await splitGraphViaTab(page);

    const pane = companion(page);
    await expect(pane).toBeVisible({ timeout: 10_000 });
    // alpha 的 1 跳邻域不含 gamma
    await searchGraph(page, pane, 'gamma');
    await expect(pane.locator('[data-testid="graph-search-empty"]')).toBeVisible();

    // 主格换到 beta.md → 副格重锚定到 beta 的 1 跳邻域（含 gamma）
    await clickTreeItem(page, 'beta.md');
    await searchGraph(page, pane, 'gamma');
    await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
  });

  test('dir-scope: folder context menu opens the folder subgraph and does not re-anchor', async ({ page }) => {
    await gotoVault(page);
    await openNoteFile(page, 'alpha.md'); // fileMain true → menu item enabled
    // 右键 notes 目录 → 查看局部图谱
    const folder = page.locator('.kb-tree-group-label').filter({ hasText: 'notes' }).first();
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await folder.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-ctx-local-graph"]').click();

    const pane = companion(page);
    await expect(pane).toBeVisible({ timeout: 10_000 });
    await expect(pane.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    // dir-scope → 「回到当前文档」按钮可见
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toBeVisible();

    // notes/ 下三个文件都在子图里
    for (const name of ['alpha', 'beta', 'gamma']) {
      await searchGraph(page, pane, name);
      await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
    }

    // 主格换文档后 dir 子图不重锚定：三者仍在
    await clickTreeItem(page, 'beta.md');
    for (const name of ['alpha', 'beta', 'gamma']) {
      await searchGraph(page, pane, name);
      await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
    }
  });

  test('dir-scope: back-to-current-doc flips to file-scope of the current main document', async ({ page }) => {
    await gotoVault(page);
    await openNoteFile(page, 'alpha.md');
    // 进入 dir-scope
    const folder = page.locator('.kb-tree-group-label').filter({ hasText: 'notes' }).first();
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await folder.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-ctx-local-graph"]').click();

    const pane = companion(page);
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toBeVisible({ timeout: 10_000 });
    // 回到当前文档（主格仍为 alpha.md）→ 按钮消失，伴回 file-scope of alpha
    await pane.locator('[data-testid="graph-scope-back"]').click();
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toHaveCount(0);
    // alpha 的 1 跳邻域不含 gamma
    await searchGraph(page, pane, 'gamma');
    await expect(pane.locator('[data-testid="graph-search-empty"]')).toBeVisible();
  });

  test('isolated file: empty state (no links → empty graph, close works)', async ({ page }) => {
    await gotoVault(page);
    await clickTreeItem(page, 'solo.md');
    await splitGraphViaTab(page);

    const pane = companion(page);
    await expect(pane).toBeVisible({ timeout: 10_000 });
    await expect(pane.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    // solo 无出链 → file-scope 空图 → .graph-empty；无搜索框
    await expect(pane.locator('.graph-empty')).toBeVisible({ timeout: 10_000 });

    // 关闭副格
    await pane.locator('[data-testid="companion-close"]').click();
    await expect(pane).toHaveCount(0);
  });

  test('main graph tab regression: full graph, no scope-back, whole-vault nodes searchable', async ({ page }) => {
    await gotoVault(page);
    await clickNav(page, 'graph');
    const main = page.locator('.graph-page');
    await expect(main).toBeVisible({ timeout: 10_000 });
    // 主格全量图：无 graph-scope-back；能搜到根目录 solo
    await expect(page.locator('[data-testid="graph-scope-back"]')).toHaveCount(0);
    await searchGraph(page, main, 'solo');
    await expect(main.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
  });
});

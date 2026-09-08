import { test, expect, type Locator, type Page } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area graph
 * @priority P1
 *
 * 图谱两套交互的 E2E：
 *   1. 对照（companion 副格，`[data-testid="kb-companion-pane"]`）：纯 file-scope，
 *      始终跟随主格文档的 1 跳邻域。无返回按钮（graph-scope-back 不渲染）、无 dir-scope、
 *      不渲染顶栏前进/后退（graph-nav-navigation）；主格文档切换 → 副格重锚定到新文件 1 跳邻域。
 *   2. 局部知识图谱（主格图谱 tab，keep-alive pane `[data-testid="kb-graph-pane"]`）：
 *      树右键「查看局部图谱」（kb-ctx-local-graph）→ dir-scope 文件夹子图 / file-scope 1 跳；
 *      有 scope 时显示「回到全量图」（graph-scope-back），点它回全量图。
 *      dir-scope 跨 tab 切换 keep-alive 不重锚定；单击聚焦/双击打开为 WebGL 命中，不可自动化。
 *
 * 图谱渲染依赖 PixiJS (WebGL) canvas，节点无法 DOM 查询 → 用 GraphSearchBox 候选下拉
 * （graph-search-option / graph-search-empty）作节点存在性断言；空图用 .graph-empty。
 * 断言根：companion 副格 `[data-testid="kb-companion-pane"]`，主格图谱 tab `[data-testid="kb-graph-pane"]`。
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

  const companion = (page: Page) => page.locator('[data-testid="kb-companion-pane"]');
  const graphTab = (page: Page) => page.locator('[data-testid="kb-graph-pane"]');

  async function gotoVault(page: Page) {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
  }

  async function clickTreeItem(page: Page, fileName: string) {
    const item = page.locator('.kb-tree-item').filter({ hasText: fileName }).first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText(fileName, { timeout: 5_000 });
  }

  /** Open a file under notes/: expand the folder, then click the file. */
  async function openNoteFile(page: Page, fileName: string) {
    const folder = page.locator('.kb-tree-group-label').filter({ hasText: 'notes' }).first();
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await folder.click(); // expand notes/
    await clickTreeItem(page, fileName);
  }

  async function splitGraphViaTab(page: Page) {
    await page.locator('.kb-wtab.is-active').click({ button: 'right' });
    await expect(page.locator('[data-testid="tab-split-graph"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="tab-split-graph"]').click();
  }

  /** Open the search in the given graph root and type a term (works only when the graph has data). */
  async function searchGraph(page: Page, root: Locator, term: string) {
    const toggle = root.locator('[data-testid="graph-search-open"]');
    const input = root.locator('[data-testid="graph-search-input"]');
    await expect(toggle).toBeVisible({ timeout: 10_000 }); // graph has data → search toggle exists
    if (!(await input.isVisible())) await toggle.click();
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('');
    await input.fill(term);
  }

  test('companion: file-scope shows 1-hop neighborhood (alpha excludes gamma)', async ({ page }) => {
    await gotoVault(page);
    await openNoteFile(page, 'alpha.md');
    await splitGraphViaTab(page);

    const pane = companion(page);
    await expect(pane).toBeVisible();
    await expect(pane.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await expect(pane.locator('[data-testid="companion-close"]')).toBeVisible();
    // 副格图谱不渲染顶栏前进/后退（主格专属）
    await expect(pane.locator('[data-testid="graph-nav-navigation"]')).toHaveCount(0);
    // 对照是纯 file-scope：无「回到全量图」按钮、无 dir-scope
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toHaveCount(0);
    // 主格文件未被换掉
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md');

    // 1 跳：alpha → beta（alpha 不直接链到 gamma）
    await searchGraph(page, pane, 'beta');
    await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
    await searchGraph(page, pane, 'gamma');
    await expect(pane.locator('[data-testid="graph-search-empty"]')).toBeVisible();
  });

  test('companion: re-anchors when the main doc changes (beta pulls gamma into 1 hop)', async ({ page }) => {
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

  test('main graph tab: dir-scope folder subgraph does not re-anchor on main-doc switch', async ({ page }) => {
    await gotoVault(page);
    await openNoteFile(page, 'alpha.md'); // 展开 notes/，供后续切 beta 与右键

    // 右键 notes 目录 → 查看局部图谱（dir-scope）
    const folder = page.locator('.kb-tree-group-label').filter({ hasText: 'notes' }).first();
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await folder.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-ctx-local-graph"]').click();

    const pane = graphTab(page);
    await expect(pane).toBeVisible({ timeout: 10_000 });
    await expect(pane.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    // dir-scope → 「回到全量图」按钮可见
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toBeVisible();

    // notes/ 下三个文件都在子图里
    for (const name of ['alpha', 'beta', 'gamma']) {
      await searchGraph(page, pane, name);
      await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
    }

    // 主格切 beta.md → 图谱 tab 隐藏（kb-pane--closed）；重新激活后 dir 子图仍保留
    await clickTreeItem(page, 'beta.md');
    await expect(pane).toHaveClass(/kb-pane--closed/);
    await clickNav(page, 'graph');
    await expect(pane).toBeVisible({ timeout: 10_000 });
    for (const name of ['alpha', 'beta', 'gamma']) {
      await searchGraph(page, pane, name);
      await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
    }
  });

  test('main graph tab: file-scope 1-hop via the file context menu', async ({ page }) => {
    await gotoVault(page);
    await openNoteFile(page, 'alpha.md');

    // 右键文件 alpha.md → 查看局部图谱（file-scope，走主 tab）
    const fileItem = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' }).first();
    await expect(fileItem).toBeVisible({ timeout: 10_000 });
    await fileItem.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-ctx-local-graph"]').click();

    const pane = graphTab(page);
    await expect(pane).toBeVisible({ timeout: 10_000 });
    await expect(pane.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toBeVisible();

    // file 1 跳：alpha → beta；gamma 不在邻域
    await searchGraph(page, pane, 'beta');
    await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
    await searchGraph(page, pane, 'gamma');
    await expect(pane.locator('[data-testid="graph-search-empty"]')).toBeVisible();
  });

  test('main graph tab: graph-scope-back returns to the full graph (solo searchable)', async ({ page }) => {
    await gotoVault(page);

    // 进入 dir-scope
    const folder = page.locator('.kb-tree-group-label').filter({ hasText: 'notes' }).first();
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await folder.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-ctx-local-graph"]').click();

    const pane = graphTab(page);
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toBeVisible({ timeout: 10_000 });
    // 回到全量图 → 按钮消失
    await pane.locator('[data-testid="graph-scope-back"]').click();
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toHaveCount(0);

    // 全量图无 scope 隔离：根目录孤立文件 solo 可搜
    await searchGraph(page, pane, 'solo');
    await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
  });

  test('companion: isolated doc shows empty state and closes', async ({ page }) => {
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

  test('main graph tab: full graph regression (no scope-back, solo searchable)', async ({ page }) => {
    await gotoVault(page);
    await clickNav(page, 'graph');

    const pane = graphTab(page);
    await expect(pane).toBeVisible({ timeout: 10_000 });
    await expect(pane.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    // 全量图：无 graph-scope-back；能搜到根目录孤立文件 solo
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toHaveCount(0);
    await searchGraph(page, pane, 'solo');
    await expect(pane.locator('[data-testid="graph-search-option"]').first()).toBeVisible();
  });
});

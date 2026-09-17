import { test, expect } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area graph
 * @priority P1
 *
 * Knowledge graph as a KB tab. Graph rendering depends on the PixiJS (WebGL)
 * engine, so these are structural assertions (page shell / tab presence), not
 * pixel-perfect rendering.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('Graph as tab', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-graph-tab');
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n\n[[beta]]\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n\n[[alpha]]\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('NavRail 图谱 opens a graph tab in the KB workspace', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');

    // 图谱标签被打开并激活 → 图谱 pane 渲染（graph-open 才挂载 GraphPage）
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    // NavRail 图谱按钮在看图谱时高亮（graphViewStore 桥接）
    await expect(page.locator('[data-view="graph"]')).toHaveClass(/is-active/);
  });

  test('graph tab stays mounted (keep-alive) when switching to a file tab', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    // 打开一个文件标签 → 图谱 pane 隐藏但保持挂载（keep-alive），不在 DOM 中被移除
    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });

    // 图谱 pane 仍在 DOM（挂载、隐藏），证明 keep-alive 而非 re-mount
    await expect(page.locator('.graph-page')).toHaveCount(1);
  });

  // ── 引擎销毁故障隔离（v0.3.56 线上全局白屏回归）──
  // 线上崩溃：engine.destroy() → app.destroy() 内部 Pixi Text 纹理卸载级联在纹理池失效态下走
  // returnTexture → TypeError: Cannot read properties of undefined (reading 'push') → 异常逃逸出
  // effect cleanup → 无 ErrorBoundary → React 整树卸载 → 全局白屏（切主页/切历史/关副格三个入口同一调用点）。
  // 注入方式：在 app.destroy 上挂一次性炸弹抛同文 TypeError —— 故障类别与调用位置（app.destroy 内部）
  // 与线上一致，且不依赖 Pixi 私有 API 结构。

  /** 给当前页面的图谱引擎装上「app.destroy 一次性炸弹」（首次调用即抛线上同文 TypeError）。 */
  async function injectDestroyTypeError(page: import('@playwright/test').Page) {
    await page.waitForFunction(() => {
      const eng = (window as unknown as { __graphEngine?: { app?: unknown } | null }).__graphEngine;
      return !!eng?.app;
    }, undefined, { timeout: 15_000 });
    await page.evaluate(() => {
      const eng = (window as unknown as {
        __graphEngine: { app: { destroy: (...args: unknown[]) => void } };
      }).__graphEngine;
      const orig = eng.app.destroy.bind(eng.app);
      eng.app.destroy = (...args: unknown[]) => {
        eng.app.destroy = orig;
        throw new TypeError("Cannot read properties of undefined (reading 'push')");
      };
    });
  }

  test('engine destroy failure must not take down the app (graph tab → home)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err?.message ?? String(err)));

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await injectDestroyTypeError(page);

    // 切主页触发 KB 页卸载 → engine.destroy() → 炸弹在 Pixi 纹理归还路径引爆。
    // 回归要求：异常被引擎吞掉（不得逃逸成 pageerror），应用整体存活、主页正常渲染。
    await clickNav(page, 'home');
    await expect(page.locator('.home-landing')).toBeVisible({ timeout: 10_000 });
    expect(pageErrors.filter((e) => e.includes("reading 'push'"))).toHaveLength(0);
  });

  test('engine destroy failure must not take down the app (close split companion)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err?.message ?? String(err)));

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    // 开一个文档 tab，再右键 → 分屏-图谱
    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });

    await page.locator('.kb-wtab.is-active').click({ button: 'right' });
    await page.locator('[data-testid="tab-split-graph"]').click();
    await expect(page.locator('[data-testid="kb-companion-pane"] .graph-page')).toBeVisible({ timeout: 10_000 });
    await injectDestroyTypeError(page);

    // 关闭副格 → 副格 GraphPage 卸载 → engine.destroy() → 炸弹引爆。
    // 回归要求：异常被引擎吞掉，KB 工作区整体存活。
    await page.locator('[data-testid="companion-close"]').click();
    await expect(page.locator('[data-testid="kb-companion-pane"]')).toHaveCount(0);
    await expect(page.locator('.kb-shell')).toBeVisible();
    expect(pageErrors.filter((e) => e.includes("reading 'push'"))).toHaveLength(0);
  });
});

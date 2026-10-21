import { test, expect } from '@playwright/test';
import { gotoChatSpa, clickNav } from './helpers/navigation';
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

/** PNG 的 IHDR：8 字节签名 + 4 长度 + 4 "IHDR"，宽高各占 4 字节（大端）。 */
function pngSize(filePath: string | null): { width: number; height: number } {
  const buf = fs.readFileSync(filePath as string);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test.describe('Graph as tab', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-graph-tab');
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n\n[[beta]]\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n\n[[alpha]]\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('NavRail 图谱 opens a graph tab in the KB workspace', async ({ page }) => {
    // Hold vault resolution until after the click: the graph intent must survive
    // opening the page before its per-vault tab store has been created.
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/knowledge/vaults', async route => {
      await pending;
      await route.continue();
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    release();

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

  test('dark theme: hidden (keep-alive) graph tab must not repaint the main area light', async ({ page }) => {
    // 深色主题在应用加载前写入 localStorage（否则首帧是浅色）
    await page.addInitScript(() => localStorage.setItem('molio.theme', 'dark'));
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });

    // 图谱标签 keep-alive 常驻：切回文档后 .graph-page 仍在 DOM（仅 visibility:hidden）
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });
    await expect(page.locator('.graph-page')).toHaveCount(1);

    // 回归：图谱画布底曾把 .entry-main 硬编码成 #FAFAFA，且 :has() 只看 DOM 存在性，
    // 于是隐藏的图谱标签也会让文档区整片发白。文档 pane 各层透明，底色就是 .entry-main。
    const bg = await page.locator('.entry-main').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(24, 24, 22)'); // --bg（深色）= #181816
  });

  // ── 一键出图（对外分享/获客）──
  // 断言到「真的产出了一个 PNG 下载」为止：只断言按钮可见会假绿
  // （引擎没接上、canvas 是空白图，按钮照样可见）。

  test('导出图片：顶栏导出按钮真的产出一张 PNG', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    const exportBtn = page.locator('[data-testid="graph-export"]');
    await expect(exportBtn).toBeVisible({ timeout: 10_000 });
    await exportBtn.click();

    // 三个出口（版式 / 下载 / 复制）都在菜单里
    await expect(page.locator('[data-testid="graph-export-aspect-natural"]')).toBeVisible();
    await expect(page.locator('[data-testid="graph-export-download"]')).toBeVisible();
    await expect(page.locator('[data-testid="graph-export-copy"]')).toBeVisible();

    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.locator('[data-testid="graph-export-download"]').click();
    const download = await downloadPromise;

    // 文件名带库名 —— 下载文件夹里一堆 molio-graph-2026... 是找不出来的
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    expect(download.suggestedFilename()).toContain(vault.name);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    // 空白 PNG 压缩后极小；拦住「导出了但整张是空的」
    expect(fs.statSync(filePath as string).size).toBeGreaterThan(1000);
  });

  test('导出图片：1:1 版式真的产出正方形（卡片版式生效）', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="graph-export"]').click();
    await page.locator('[data-testid="graph-export-aspect-square"]').click();
    // 选中态必须跟着走，否则用户不知道这次导的是哪个版式
    await expect(page.locator('[data-testid="graph-export-aspect-square"]')).toHaveClass(/is-active/);

    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.locator('[data-testid="graph-export-download"]').click();
    const filePath = await (await downloadPromise).path();
    expect(filePath).toBeTruthy();

    // 直接读 PNG 的 IHDR：没有像素级断言，「版式」可能只是个状态位、画布根本没变
    const { width, height } = pngSize(filePath);
    expect(width).toBe(height);
    expect(width).toBeGreaterThan(500);
  });

  test('导出图片：关掉「附带信息」后卡片只剩图与署名', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    const exportBtn = page.locator('[data-testid="graph-export"]');
    const infoToggle = page.locator('[data-testid="graph-export-info"]');
    await exportBtn.click();
    // 默认带信息 —— 这是卡片的价值，不能悄悄关掉
    await expect(infoToggle).toBeChecked();

    let downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.locator('[data-testid="graph-export-download"]').click();
    const withInfo = pngSize(await (await downloadPromise).path());

    // 导出后气泡先显示结果提示，等它消失再开菜单
    await expect(page.locator('.graph-export-note')).toHaveCount(0, { timeout: 10_000 });
    await exportBtn.click();
    await infoToggle.uncheck();

    downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.locator('[data-testid="graph-export-download"]').click();
    const bare = pngSize(await (await downloadPromise).path());

    // 宽度只由图决定，不随信息块变；高度必须明显变矮（整块头部让给图）。
    // 只断言复选框选中态的话，开关可能根本没接进排版。
    expect(Math.abs(bare.width - withInfo.width)).toBeLessThanOrEqual(2);
    expect(bare.height).toBeLessThan(withInfo.height - 20);
  });

  test('导出图片：复制出口真的把 PNG 写进了剪贴板', async ({ page, context }) => {
    // 剪贴板读写都要授权（headless 下默认拒绝）
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://localhost:5173',
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="graph-export"]').click();
    await page.locator('[data-testid="graph-export-copy"]').click();

    // 提示语只在 write() 真的 resolve 后才出现（失败走另一条文案）
    await expect(page.locator('.graph-export-note')).toHaveText(/已复制/);

    // 读回剪贴板，确认落进去的确实是一张像样的 PNG ——
    // 只断言提示语等于相信 write() 的 resolve，读回来才算数。
    const bytes = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes('image/png')) return (await item.getType('image/png')).size;
      }
      return 0;
    });
    expect(bytes).toBeGreaterThan(1000);
  });

  test('导出图片：跟随系统 + 深色系统时气泡不能是亮色卡片', async ({ page }) => {
    // 显式 data-theme="dark" 走另一条路（见上面的深色用例）。这里专测「跟随系统」
    // ——此时 html 上没有 data-theme，--text 变浅，气泡底色若仍是白的就成浅压浅。
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="graph-export"]').click();

    const bg = await page
      .locator('.graph-export-pop')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = (bg.match(/[\d.]+/g) ?? []).map(Number);
    expect((r + g + b) / 3).toBeLessThan(80);
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
    await gotoChatSpa(page);
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

import { test, expect, type Page } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area graph
 * @priority P1
 *
 * 相机取景回归：scope 切换（全量图 ⇄ 局部图）后布局会重排，相机必须**等仿真收敛后**
 * 再动画到正确取景 —— 否则会「切换后视角不对、且看不到初始化过渡」（2026-09-09 用户反馈）。
 *
 * 断言方式：切换瞬间的视口 vs 收敛后的视口必须不同。这正是「收敛后重新取景」的信号；
 * 若引擎不再在收敛后取景（回归），两者相等，测试失败。
 *
 * 依赖 DEV 调试句柄 `window.__graphEngine`（同 graph-settings.spec.ts 的说明：Playwright
 * webServer 起的是 `pnpm dev`，句柄可用；若 CI 改 build+preview 需给画布另加可断言属性）。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

type Vp = { tx: number; ty: number; k: number };

test.describe('Graph camera framing', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-graph-camera');
    fs.mkdirSync(path.join(vault.path, 'notes'), { recursive: true });
    // 节点要足够多且分散：否则 fit 会被 K_MAX(=4) 全程 clamp，「立即落位」与「收敛后取景」
    // 算出同一个缩放，断言就失去意义。
    // notes/ 内 8 个（dir-scope 子图）+ 根目录 4 个（只进全量图）→ 两个 scope 的取景不同。
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(vault.path, 'notes', `note${i}.md`),
        `# Note ${i}\n\n[[note${(i + 1) % 8}]] [[note${(i + 3) % 8}]]\n`,
      );
    }
    for (let i = 0; i < 4; i++) {
      const cross = i === 0 ? ' [[note0]]' : '';
      fs.writeFileSync(
        path.join(vault.path, `root${i}.md`),
        `# Root ${i}\n\n[[root${(i + 1) % 4}]]${cross}\n`,
      );
    }
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  const readVp = (page: Page): Promise<Vp | null> =>
    page.evaluate(() => {
      const e = (window as unknown as {
        __graphEngine?: { getViewport(): { tx: number; ty: number; k: number } };
      }).__graphEngine;
      return e ? e.getViewport() : null;
    });

  /** 视口差异度量：缩放差异为主，位移折算成等价量级 */
  const vpDiff = (a: Vp, b: Vp): number =>
    Math.abs(a.k - b.k) + Math.abs(a.tx - b.tx) / 200 + Math.abs(a.ty - b.ty) / 200;

  /** 收敛后视口必须框住全部节点（fit 会留 FIT_PADDING，故节点应严格落在视口内）。
   *  这条能抓住「布局还在动时就取景」——那时算出的取景框不住最终布局。 */
  const expectAllNodesFramed = async (page: Page) => {
    const snap = await page.evaluate(() => {
      const e = (window as unknown as {
        __graphEngine?: {
          getSnapshot(): { nodes: Array<{ x: number; y: number }>; view: { x: number; y: number; w: number; h: number } } | null;
        };
      }).__graphEngine;
      return e ? e.getSnapshot() : null;
    });
    expect(snap).not.toBeNull();
    const { nodes, view } = snap!;
    expect(nodes.length).toBeGreaterThan(0);
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const tol = 2; // 浮点/渲染误差容差（sim 坐标）
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(view.x - tol);
    expect(Math.max(...xs)).toBeLessThanOrEqual(view.x + view.w + tol);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(view.y - tol);
    expect(Math.max(...ys)).toBeLessThanOrEqual(view.y + view.h + tol);
  };

  test('scope switch re-frames the camera after the layout settles (both directions)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await clickNav(page, 'graph');

    const pane = page.locator('[data-testid="kb-graph-pane"]');
    await expect(pane.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(
      () => (window as unknown as { __graphEngine?: unknown }).__graphEngine != null,
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(3_500); // 等全量图收敛

    // ── 进入局部图（dir scope）：立即落位 → 收敛后重新取景 ──
    const folder = page.locator('.kb-tree-group-label').filter({ hasText: 'notes' }).first();
    await expect(folder).toBeVisible({ timeout: 10_000 });
    await folder.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-ctx-local-graph"]').click();
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toBeVisible({ timeout: 10_000 });
    // 搜索按钮出现 = 子图数据已到、立即落位已执行 → 此刻的视口就是「落位瞬间」
    await expect(pane.locator('[data-testid="graph-search-open"]')).toBeVisible({ timeout: 10_000 });
    const enterEarly = await readVp(page);
    await page.waitForTimeout(4_000); // 等仿真收敛 + 过渡动画
    const enterSettled = await readVp(page);

    expect(enterEarly).not.toBeNull();
    expect(enterSettled).not.toBeNull();
    // ① 收敛后发生过重新取景（相机确实动了）
    expect(vpDiff(enterEarly!, enterSettled!)).toBeGreaterThan(0.1);
    // ② 且最终取景框住了整张子图（不是「早取景」留下的错误视角）
    await expectAllNodesFramed(page);

    // ── 返回全量图：同样应在收敛后重新取景 ──
    await pane.locator('[data-testid="graph-scope-back"]').click();
    await page.waitForTimeout(800); // 等全量数据到达 + 立即落位
    const backEarly = await readVp(page);
    await page.waitForTimeout(4_000);
    const backSettled = await readVp(page);

    expect(backEarly).not.toBeNull();
    expect(backSettled).not.toBeNull();
    expect(vpDiff(backEarly!, backSettled!)).toBeGreaterThan(0.1);
    await expectAllNodesFramed(page);
  });
});

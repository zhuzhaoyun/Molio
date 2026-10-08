import { test, expect, type Page } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { throttleFrameRateIfRequested } from './helpers/frame-rate';
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
 * ⚠️ 等「收敛」必须等条件，不能等固定时长。alpha 每渲染帧衰减一次、约 300 帧才到
 * alphaMin（引擎此刻才触发收敛后取景）：本地 120Hz ≈ 2.6s，CI 软件渲染帧率低则 10s+。
 * 原先固定 `waitForTimeout(4_000)` 在 CI 上于取景发生前就断言 —— vpDiff 恰好 0、
 * 视口还停在早取景（main nightly 连续多晚同样的两个用例失败，2026-10-01 定位）。
 * 现在：等「视口相对早取景真的变了」→ 等取景动画停下 → 再断言。
 * 复现：`MOLIO_E2E_SLOW_FPS=20 npx playwright test graph-camera.spec.ts`（见 helpers/frame-rate.ts）。
 *
 * 依赖 DEV 调试句柄 `window.__graphEngine`（同 graph-settings.spec.ts 的说明：Playwright
 * webServer 起的是 `pnpm dev`，句柄可用；若 CI 改 build+preview 需给画布另加可断言属性）。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

type Vp = { tx: number; ty: number; k: number };

test.describe('Graph camera framing', () => {
  // 这里等的是「仿真收敛」这类按帧计数的过程（约 300 帧到 alphaMin）：CI 帧率低时
  // 墙钟时间被拉长，30s 默认档会有余量不足的风险。给足上限——真出错时失败依然是失败，
  // 只是不会因为「等得久」而误判。
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await throttleFrameRateIfRequested(page);
  });

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
    // 取景用例：16 邻居的 hub —— 1 跳邻域铺得足够开（包围盒超过主格画布在 k=1.5 下的可视范围），
    // 才暴露「focusNode 放大裁掉邻居」。
    fs.writeFileSync(
      path.join(vault.path, 'hub.md'),
      `# Hub\n\n${Array.from({ length: 16 }, (_, i) => `[[n${i}]]`).join(' ')}\n`,
    );
    for (let i = 0; i < 16; i++) {
      fs.writeFileSync(
        path.join(vault.path, `n${i}.md`),
        `# N${i}\n\n[[hub]] [[n${(i + 1) % 16}]]\n`,
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

  /**
   * 等「收敛后重新取景」这件事真的发生：视口相对 base 移动超过阈值。
   * 阈值 0.1 与断言一致 —— 回归（引擎不再收敛后取景）时这里超时失败，报错直指
   * 「取景没发生」，好过固定 sleep 换来的 vpDiff=0 误报。
   */
  const waitForReframeFrom = async (page: Page, base: Vp, timeout = 30_000) => {
    await expect
      .poll(
        async () => {
          const now = await readVp(page);
          return now ? vpDiff(base, now) : 0;
        },
        { timeout, intervals: [200, 300, 500] },
      )
      .toBeGreaterThan(0.1);
  };

  /** 等取景动画停下（连续两次采样一致）——动画中途读到的视口不是最终取景，框不住整图。 */
  const waitForViewportStable = async (page: Page, timeout = 30_000) => {
    const started = Date.now();
    let prev = await readVp(page);
    while (Date.now() - started < timeout) {
      await page.waitForTimeout(250);
      const now = await readVp(page);
      if (now && prev && Math.abs(now.tx - prev.tx) < 1e-6 && Math.abs(now.ty - prev.ty) < 1e-6 && Math.abs(now.k - prev.k) < 1e-6) {
        return;
      }
      prev = now;
    }
    throw new Error('waitForViewportStable: 视口在超时内未稳定');
  };

  /** 引擎当前持有的节点数（判断新 scope 的数据是否已到达）。 */
  const readNodeCount = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const e = (window as unknown as {
        __graphEngine?: { getSnapshot(): { nodes: unknown[] } | null };
      }).__graphEngine;
      return e?.getSnapshot()?.nodes.length ?? 0;
    });

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
    expect(enterEarly).not.toBeNull();
    await waitForReframeFrom(page, enterEarly!); // 等仿真收敛 → 收敛后取景真的发生
    await waitForViewportStable(page);           // 等取景动画停下
    const enterSettled = await readVp(page);

    expect(enterSettled).not.toBeNull();
    // ① 收敛后发生过重新取景（相机确实动了）
    expect(vpDiff(enterEarly!, enterSettled!)).toBeGreaterThan(0.1);
    // ② 且最终取景框住了整张子图（不是「早取景」留下的错误视角）
    await expectAllNodesFramed(page);

    // ── 返回全量图：同样应在收敛后重新取景 ──
    await pane.locator('[data-testid="graph-scope-back"]').click();
    // 等全量数据到达（dir 子图是 8 个）——固定 800ms 在低帧率下会读到旧子图
    await expect.poll(() => readNodeCount(page), { timeout: 15_000, intervals: [100, 200, 400] })
      .toBeGreaterThan(8);
    const backEarly = await readVp(page);
    expect(backEarly).not.toBeNull();
    await waitForReframeFrom(page, backEarly!);
    await waitForViewportStable(page);
    const backSettled = await readVp(page);

    expect(backSettled).not.toBeNull();
    expect(vpDiff(backEarly!, backSettled!)).toBeGreaterThan(0.1);
    await expectAllNodesFramed(page);
  });

  /**
   * 对照副格：随主格文档高频重锚定 → 取景必须「瞬时 + 完整」——
   * 用 fit 整张子图（而非 file-scope 的圆心居中放大，小画布下会裁掉邻居），
   * 且布局同步跑完，不做「先落位 → 收敛后再动画」的两段式过渡。
   */
  test('companion frames the whole 1-hop neighborhood immediately, with no late re-frame', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    // 主格打开 hub.md，再右键标签 → 图谱对照
    await page.locator('.kb-tree-item').filter({ hasText: 'hub.md' }).first().click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('hub', { timeout: 5_000 });
    await page.locator('.kb-wtab.is-active').click({ button: 'right' });
    await expect(page.locator('[data-testid="tab-split-graph"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="tab-split-graph"]').click();

    const pane = page.locator('[data-testid="kb-companion-pane"]');
    await expect(pane).toBeVisible({ timeout: 10_000 });
    // 未开主格图谱 tab → 副格是唯一的 GraphPage 实例，__graphEngine 即副格引擎
    await expect(pane.locator('[data-testid="graph-search-open"]')).toBeVisible({ timeout: 15_000 });

    // ① 数据一到就框住整张 1 跳邻域（hub + 8 邻居）
    await expectAllNodesFramed(page);
    const vpA = await readVp(page);
    expect(vpA).not.toBeNull();

    // ② 不再有「约 2.8s 后的迟到取景」：等过一个仿真收敛周期，视口必须纹丝不动
    await page.waitForTimeout(3_500);
    const vpB = await readVp(page);
    expect(vpB).toEqual(vpA);
    await expectAllNodesFramed(page);
  });

  /**
   * 主格「局部知识图谱」的 file-scope：取景 = fit 整张 1 跳邻域 + 选中圆心。
   * （早先是 focusNode(k=1.5) 圆心居中放大 —— 大 hub 下会裁掉外圈邻居。）
   */
  test('main graph tab: file scope frames the whole 1-hop neighborhood and selects the anchor', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    const item = page.locator('.kb-tree-item').filter({ hasText: 'hub.md' }).first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-ctx-local-graph"]').click();

    const pane = page.locator('[data-testid="kb-graph-pane"]');
    await expect(pane.locator('[data-testid="graph-scope-back"]')).toBeVisible({ timeout: 10_000 });
    // 未开副格 → 主格图谱 tab 是唯一 GraphPage 实例
    await expect(pane.locator('[data-testid="graph-search-open"]')).toBeVisible({ timeout: 15_000 });

    // 等「收敛 → 收敛后取景」到位：直接重试断言本身（低帧率下固定 4s 会在取景前断言）
    await expect(async () => {
      await expectAllNodesFramed(page);
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1000] });
    // 圆心仍是视觉锚点（fit 不移动相机，靠 selectNode 选中）
    const selected = await page.evaluate(
      () => (window as unknown as { __graphEngine?: { getSelectedKey(): string | null } }).__graphEngine?.getSelectedKey() ?? null,
    );
    expect(selected).toBe('hub.md');
  });
});

import { test, expect, type Page } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area graph
 * @priority P1
 *
 * 图谱自动跟随知识库变化（「① 自动新鲜化」）。
 *
 * 改动前：图谱数据只在 (vault, scope) 变化时取一次 —— 文件树走 SSE 自动刷新，图谱却要
 * 用户切走再切回才更新，同一个知识库出现两种新鲜度。现在图谱复用同一条 `tree-changed`
 * 信号自动跟上，且：
 *   - 指纹去重：树变了但图谱数据没变（拷入 PDF、改个错别字）不重建
 *   - 位置保留：刷新不把布局重新炸开，也不打断用户相机
 *   - 仅可见时刷新、按规模防抖
 *
 * 这类回归只有把「真实文件写进真实 vault → chokidar → SSE → 图谱」整条链路跑通才能发现，
 * 单测覆盖不到；所以断言分两层：测试 1 用用户可见的节点统计（真·用户体验），
 * 其余用 DEV 调试句柄 `window.__graphEngine`（同 graph-camera.spec.ts 的说明）。
 *
 * 不测「位置缓存不跨 vault」：切库会连图谱页一起卸载（引擎 destroy、重新挂载时是全新实例），
 * 同一个引擎活不过切库——没有可达场景，而 `window.__graphEngine` 在卸载后仍是旧引用，
 * 照着它写断言只会测到「新建引擎」，看起来通过、实际什么都没验（试过，已删）。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

interface SnapNode { key: string; x: number; y: number }
interface Snapshot {
  nodes: SnapNode[];
  view: { x: number; y: number; w: number; h: number };
}
interface Vp { tx: number; ty: number; k: number }

type EngineHandle = {
  getSnapshot(): Snapshot | null;
  getViewport(): Vp;
};

let vault: TempVault;

test.describe('Graph live refresh', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-graph-live-refresh');
    // createTempVault 会预置一个无链接的 test.md；清掉它，让布局围绕一个连通簇展开
    fs.rmSync(path.join(vault.path, 'test.md'), { force: true });
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n\n[[beta]] [[gamma]]\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n\n[[alpha]]\n');
    fs.writeFileSync(path.join(vault.path, 'gamma.md'), '# Gamma\n\n[[alpha]]\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  // ── 读引擎状态 ──────────────────────────────────────────────────────

  const readSnap = (page: Page): Promise<Snapshot | null> =>
    page.evaluate(() => {
      const e = (window as unknown as { __graphEngine?: EngineHandle }).__graphEngine;
      return e ? e.getSnapshot() : null;
    });

  const readVp = (page: Page): Promise<Vp | null> =>
    page.evaluate(() => {
      const e = (window as unknown as { __graphEngine?: EngineHandle }).__graphEngine;
      return e ? e.getViewport() : null;
    });

  /** 仿真状态：alpha 归零 = 停表；重建会把 alpha 重新点回 1。 */
  const readAlpha = async (page: Page): Promise<number> =>
    (await page.evaluate(() => {
      const e = (window as unknown as { __graphEngine?: { getSimState(): { alpha: number } } }).__graphEngine;
      return e ? e.getSimState().alpha : null;
    })) ?? -1;

  const readNodeCount = async (page: Page): Promise<number> =>
    (await readSnap(page))?.nodes.length ?? 0;

  /**
   * 等仿真真的停住：连续两次采样（间隔 400ms）每个节点坐标逐位相同。
   * 不用固定 sleep —— 收敛耗时随图规模变化，固定值要么不够要么白等。
   */
  async function waitForSettle(page: Page, timeout = 25_000) {
    await expect
      .poll(
        async () => {
          const a = await readSnap(page);
          await page.waitForTimeout(400);
          const b = await readSnap(page);
          if (!a || !b || a.nodes.length !== b.nodes.length) return false;
          return a.nodes.every((n, i) => n.x === b.nodes[i]!.x && n.y === b.nodes[i]!.y);
        },
        { timeout, intervals: [100] },
      )
      .toBe(true);
  }

  /** 打开知识库的图谱标签并等引擎就绪。 */
  async function openGraphTab(page: Page, vaultId: string) {
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await clickNav(page, 'graph');
    await expect(page.locator('[data-testid="kb-graph-pane"] .graph-page')).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(
      () => (window as unknown as { __graphEngine?: unknown }).__graphEngine != null,
      undefined,
      { timeout: 15_000 },
    );
  }

  /** 往 vault 目录直接落文件 —— AI 产出、从外部拷入素材走的都是这条路。 */
  const writeNote = (name: string, body: string) => {
    fs.writeFileSync(path.join(vault.path, name), body);
  };

  // ── ① 自动新鲜化 ────────────────────────────────────────────────────

  test('库里新增带 wikilink 的笔记 → 图谱自动跟上（节点统计自己变多）', async ({ page }) => {
    await openGraphTab(page, vault.id);

    // 用户可见的入口：ℹ 统计弹层
    await page.locator('.graph-stats-ctrl button').click();
    const pop = page.locator('.graph-stats-pop');
    const readStatNodes = async () =>
      Number((await pop.locator('span').first().innerText()).replace(/[^\d]/g, ''));
    await expect(pop).toBeVisible({ timeout: 5_000 });
    const before = await readStatNodes();
    expect(before).toBeGreaterThan(0);

    writeNote('fresh.md', '# Fresh\n\n[[alpha]]\n');

    // 不点任何刷新按钮：图谱必须自己涨到 before + 1
    await expect.poll(readStatNodes, { timeout: 15_000 }).toBe(before + 1);
  });

  test('自动刷新保留老节点位置（不把布局重新炸开）', async ({ page }) => {
    await openGraphTab(page, vault.id);
    await waitForSettle(page);

    const before = await readSnap(page);
    expect(before).not.toBeNull();
    const n0 = before!.nodes.length;

    // 新文件故意排在最前（daemon 的 scanTree 按名字排序）——这样每个老节点的数组下标
    // 都会后移一位。d3-force 对新节点给的是「按下标算的」初始螺旋位，下标一变，
    // 不继承位置的实现会把整张图重新散一遍。加在末尾的文件反而测不出区别。
    writeNote('aaa-fresh.md', '# Fresh\n\n[[alpha]]\n');
    await expect.poll(() => readNodeCount(page), { timeout: 15_000 }).toBe(n0 + 1);
    await waitForSettle(page);

    const after = await readSnap(page);
    const byKey = new Map(after!.nodes.map((n) => [n.key, n]));
    let maxMove = 0;
    for (const n of before!.nodes) {
      const a = byKey.get(n.key);
      expect(a, `老节点 ${n.key} 不该消失`).toBeTruthy();
      maxMove = Math.max(maxMove, Math.hypot(a!.x - n.x, a!.y - n.y));
    }

    // 用图自身的跨度当标尺（跨坐标尺度无关）：保留位置时位移是零头，
    // 重新散开时位移与跨度同量级。
    const scale = extent(before!.nodes);
    expect(maxMove, `最大位移 ${maxMove.toFixed(1)}px，图跨度 ${scale.toFixed(1)}px`)
      .toBeLessThan(scale * 0.25);
  });

  test('自动刷新不打断用户相机（平移后刷新，视口纹丝不动）', async ({ page }) => {
    await openGraphTab(page, vault.id);
    await waitForSettle(page);
    const n0 = await readNodeCount(page);

    // 用户先自己动相机：滚轮缩放走 d3-zoom，不命中任何节点
    const box = await page.locator('[data-testid="graph-canvas"]').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(200);
    const vpBefore = await readVp(page);
    expect(vpBefore).not.toBeNull();

    writeNote('cam.md', '# Cam\n\n[[beta]]\n');
    await expect.poll(() => readNodeCount(page), { timeout: 15_000 }).toBe(n0 + 1);
    await waitForSettle(page);

    expect(await readVp(page)).toEqual(vpBefore);
  });

  test('非 .md 文件变化不触发重建（指纹去重）', async ({ page }) => {
    await openGraphTab(page, vault.id);
    await waitForSettle(page);
    const before = await readSnap(page);
    expect(await readAlpha(page)).toBeLessThan(0.01); // 已停表

    writeNote('raw-note.txt', 'not markdown\n');

    // 先确认信号确实到了：文件树是这个 vault 上同一条 SSE 的消费者，
    // 树里出现了新文件 ⇒ tree-changed 已送达 ⇒ 图谱这次不重建是真的被去重挡住的。
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'raw-note.txt' }))
      .toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(800); // 覆盖小图 400ms 防抖 + 取数
    const alphaEarly = await readAlpha(page);
    await page.waitForTimeout(600);
    const alphaLate = await readAlpha(page);

    // ① 仿真没有被重新点火 —— 重建会把 alpha 点回 1 再慢慢衰减，去重生效时它一次
    //    都不该离开 0。取两次峰值：采样点若偏早抓到 1，偏晚可能已衰减到阈值下。
    expect(Math.max(alphaEarly, alphaLate), `alpha 早=${alphaEarly} 晚=${alphaLate}`)
      .toBeLessThan(0.01);
    // ② 布局逐位不变（不是「差不多」）
    expect((await readSnap(page))!.nodes).toEqual(before!.nodes);
  });

});

/** 节点包围盒对角线 —— 与坐标缩放无关的「图有多大」标尺。 */
function extent(nodes: SnapNode[]): number {
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

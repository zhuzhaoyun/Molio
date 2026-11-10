/**
 * @area kb
 * @priority P1
 *
 * 回归（2026-11-03，用户报障）：连开第 3 个知识库窗口后**黑屏 + 永远加载不出来**。
 *
 * 根因：daemon 只提供 HTTP/1.1，而 Chromium 对同一 host 的 HTTP/1.1 socket 上限是
 * 6 条。每个知识库窗口打开后都会建一条**常驻** SSE（`/api/knowledge/vaults/:id/
 * events`，推 tree-changed），窗口不关就一直占着。窗口开够 6 个之后连接池被占满，
 * 新窗口的主框架导航永远排队等一个空 socket → 请求根本发不出去 → 窗口停在深色
 * 启动页上（桌面端日志里是 "page load still in flight (daemon busy?)"）。
 *
 * 实测（Electron 40）：同窗口内持 5 条长连接后再导航即卡死 >15s；连开 7 个窗口，
 * 第 7 个必挂。
 *
 * 修法：vault-events SSE 只在**窗口聚焦**时持有（后台窗口本来就靠 focus 时的
 * loadTree 补数据，见 useKnowledge 的 focus effect）。于是同时最多一条常驻长连接。
 *
 * 本文件锁住两件事：
 * 1) SSE 随窗口聚焦态开合（失焦关掉、聚焦接回）；
 * 2) 后台页面不持有常驻长连接时，多个知识库页面可以同时加载出来。
 */
import { test, expect, type Page } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

/** 在页面里包一层 EventSource，记录每次 open/close（含 URL）。 */
async function instrumentEventSource(page: Page) {
  await page.addInitScript(() => {
    const Orig = window.EventSource;
    const log: Array<{ url: string; event: 'open' | 'close' }> = [];
    (window as any).__sseLog = log;
    function Tracked(this: unknown, url: string | URL, init?: EventSourceInit) {
      const es = new Orig(url as string, init);
      log.push({ url: String(url), event: 'open' });
      const close = es.close.bind(es);
      es.close = () => {
        log.push({ url: String(url), event: 'close' });
        return close();
      };
      return es;
    }
    (window as any).EventSource = Tracked;
  });
}

type SseCounts = { vaultOpen: number; vaultClose: number };

async function countVaultEvents(page: Page): Promise<SseCounts> {
  return await page.evaluate((vaultId) => {
    const log = ((window as any).__sseLog ?? []) as Array<{ url: string; event: 'open' | 'close' }>;
    const isVaultEvents = (u: string) => u.includes(`/api/knowledge/vaults/${vaultId}/events`);
    return {
      vaultOpen: log.filter((l) => l.event === 'open' && isVaultEvents(l.url)).length,
      vaultClose: log.filter((l) => l.event === 'close' && isVaultEvents(l.url)).length,
    };
  }, vault.id);
}

test.describe('KB — 常驻 SSE 只在窗口聚焦时持有', () => {
  // 首次导航要等 vite 冷启动把模块图优化完（CI/本地首次跑常见 >30s）。
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-sse-focus');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('失焦 → 关掉 vault-events SSE；重新聚焦 → 接回来', async ({ page }) => {
    await instrumentEventSource(page);
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 20_000 });

    // 前台窗口必须持有 vault-events SSE（tree-changed 实时刷新靠它）
    await expect
      .poll(async () => (await countVaultEvents(page)).vaultOpen, { timeout: 15_000 })
      .toBeGreaterThan(0);

    const before = await countVaultEvents(page);

    // 失焦（Electron 里新开窗口会 blur 旧窗口）→ 必须关掉长连接
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect
      .poll(async () => (await countVaultEvents(page)).vaultClose, { timeout: 10_000 })
      .toBeGreaterThan(before.vaultClose);

    // 重新聚焦 → 必须接回
    const afterBlur = await countVaultEvents(page);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect
      .poll(async () => (await countVaultEvents(page)).vaultOpen, { timeout: 10_000 })
      .toBeGreaterThan(afterBlur.vaultOpen);
  });

  test('后台页面不持有常驻长连接 → 7 个知识库页面能同时加载出来', async ({ page, context }) => {
    // 复现用户场景：连开多个知识库窗口。真实时序（Electron）：新窗口一创建就抢
    // 焦点，老窗口随即 blur；而新窗口的导航**已经在途**。这里照搬这个顺序：
    // 先发起导航（不等），再让老页面失焦。Playwright 的多页面不会自动派发 blur，
    // 所以显式模拟。
    const pages: Page[] = [];
    for (let i = 0; i < 7; i++) {
      const p = i === 0 ? page : await context.newPage();
      await instrumentEventSource(p);
      const nav = p.goto(`/knowledge?vault=${vault.id}`);
      // 老窗口失焦 → 交还常驻长连接（修复前这里不会关，连接池被占满 → 新窗口卡死）
      for (const older of pages) {
        await older.evaluate(() => window.dispatchEvent(new Event('blur'))).catch(() => {});
      }
      await nav;
      await expect(p.locator('.kb-file-panel')).toBeVisible({ timeout: 20_000 });
      pages.push(p);
    }

    // 最后一个（前台）页面持有 SSE，其余都已交还
    const last = pages[pages.length - 1]!;
    await expect
      .poll(async () => (await countVaultEvents(last)).vaultOpen, { timeout: 15_000 })
      .toBeGreaterThan(0);
    for (const older of pages.slice(0, -1)) {
      const counts = await countVaultEvents(older);
      expect(counts.vaultOpen - counts.vaultClose).toBe(0);
    }

    // 关键断言：每个页面都真的加载出了知识库界面（修复前第 7 个会永远卡在启动页）
    for (const p of pages) {
      await expect(p.locator('.kb-file-panel')).toBeVisible({ timeout: 20_000 });
    }
  });
});

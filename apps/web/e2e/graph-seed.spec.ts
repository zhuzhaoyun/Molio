import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clickNav } from './helpers/navigation';

/**
 * @area graph
 * @priority P1
 *
 * H3 布局种子（docs/2026-11-25-graph-h3-seeded-positions-design.md）：
 * daemon worker 预跑同款力配方 → GET 图 best-effort 携带 positions →
 * 浏览器播种 + 低温精修（α=0.1）。「出生定形」的验收线：payload 到位后
 * 引擎坐标与种子平均偏差 < 50px（实验值 ~20px），2s 后仍在同量级内。
 *
 * fixture 用小库（40 节点 < 500 门，默认全量视图）——预跑毫秒级，E2E 不放大库。
 * 引擎状态断言一律 poll（#437 纪律：DOM 可见 ≠ 引擎就绪）。
 */

const DAEMON_API = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}/api`;

function makeSeedVault(dir: string): void {
  const name = (d: number, i: number) => `d${d}n${String(i).padStart(2, '0')}`;
  for (let d = 0; d < 2; d++) mkdirSync(path.join(dir, `dir${d}`), { recursive: true });
  for (let d = 0; d < 2; d++)
    for (let i = 0; i < 20; i++)
      writeFileSync(
        path.join(dir, `dir${d}`, `${name(d, i)}.md`),
        `# ${name(d, i)}\n\n- [[${name(d, (i + 1) % 20)}]]\n- [[${name((d + 1) % 2, i)}]]\n`,
      );
}

const vaultDirs: string[] = [];

async function createSeedVault(label: string): Promise<{ id: string; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), `molio-graph-seed-${label}-`));
  vaultDirs.push(dir);
  makeSeedVault(dir);
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `e2e-graph-seed-${label}`, path: dir }),
  });
  if (!res.ok) throw new Error(`create vault failed: ${res.status}`);
  return { id: (await res.json()).id, dir };
}

test.afterAll(async () => {
  for (const d of vaultDirs) rmSync(d, { recursive: true, force: true });
});

interface GraphPayload {
  nodes: Array<{ key: string }>;
  positions?: Array<[string, number, number]>;
}

/** 轮询图端点至 positions 在场（首 GET 触发建图，预跑毫秒级跟上） */
async function pollUntilPositions(vaultId: string, timeoutMs = 15_000): Promise<GraphPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${DAEMON_API}/graph/${vaultId}`);
    if (!res.ok) throw new Error(`graph GET ${res.status}`);
    const body = (await res.json()) as GraphPayload;
    if (body.positions && body.positions.length > 0) return body;
    if (Date.now() > deadline) throw new Error('positions 未在期限内到达');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function gotoGraph(page: Page, vaultId: string): Promise<void> {
  await page.goto(`/knowledge?vault=${vaultId}`);
  await clickNav(page, 'graph');
  await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible({ timeout: 15000 });
  // 引擎就绪（#437：DOM 可见 ≠ 快照就位）
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? 0))
    .toBeGreaterThan(0);
}

/** 引擎快照 vs 种子的平均偏差（px，sim 坐标系） */
async function meanDeviationFromSeeds(page: Page, seeds: Array<[string, number, number]>): Promise<number | null> {
  return page.evaluate((json) => {
    const seed = new Map<string, { x: number; y: number }>(
      (JSON.parse(json) as Array<[string, number, number]>).map(([k, x, y]) => [k, { x, y }]),
    );
    const snap = window.__graphEngine?.getSnapshot();
    if (!snap) return null;
    let sum = 0;
    let n = 0;
    for (const node of snap.nodes) {
      const p = seed.get(node.key);
      if (!p) continue;
      sum += Math.hypot(node.x - p.x, node.y - p.y);
      n++;
    }
    return n === 0 ? null : sum / n;
  }, JSON.stringify(seeds));
}

test('种子到达即出生定形：引擎坐标 ≈ payload positions，2s 后仍稳', async ({ page }) => {
  const { id } = await createSeedVault('main');
  const payload = await pollUntilPositions(id);
  expect(payload.positions!.length).toBe(payload.nodes.length);

  await gotoGraph(page, id);
  const mean = await meanDeviationFromSeeds(page, payload.positions!);
  expect(mean).not.toBeNull();
  expect(mean!).toBeLessThan(50); // 出生定形线（实验值 ~20px，留余量）

  await page.waitForTimeout(2000);
  const meanAfter = await meanDeviationFromSeeds(page, payload.positions!);
  expect(meanAfter).not.toBeNull();
  expect(meanAfter!).toBeLessThan(50); // 低温精修不越线（终端漂移 <0.6% 取景尺度）
});

test('局部图端点不携带 positions（回退路径零回归）', async ({ page }) => {
  const { id } = await createSeedVault('local');
  await pollUntilPositions(id); // 先让全量侧就绪——局部端点无论如何都不该带
  const res = await fetch(`${DAEMON_API}/graph/${id}/local?scope=dir&path=dir0`);
  expect(res.ok).toBeTruthy();
  const body = (await res.json()) as GraphPayload;
  expect(body.positions).toBeUndefined();
  // 局部图渲染照常（graph-local.spec 有专项，这里只钉 payload 契约 + 不炸）
  await gotoGraph(page, id);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? 0))
    .toBeGreaterThan(0);
});

test('树请求预热：不先碰图端点，首个图 GET 即带 positions', async ({ page }) => {
  const { id } = await createSeedVault('warm');
  // 只拉树（UI 打开知识库的第一步）——server.ts 的 onVaultTouched 应把建图+预跑提前
  const treeRes = await fetch(`${DAEMON_API}/knowledge/vaults/${id}/tree`);
  expect(treeRes.ok).toBeTruthy();
  // 固定等待的边界场景：被测对象是无 DOM 信号的后台管道（树响应不等预热完成）。
  // 40 节点建图+预跑 << 1s，3s 是慢机余量；断言本身是「首个图 GET 立即带种子」。
  await page.waitForTimeout(3000);
  const res = await fetch(`${DAEMON_API}/graph/${id}`);
  expect(res.ok).toBeTruthy();
  const body = (await res.json()) as GraphPayload;
  expect(body.positions?.length).toBe(body.nodes.length);
});

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clickNav } from './helpers/navigation';

/**
 * @area graph
 * @priority P1
 *
 * trunk 视图（全局视图语义 LOD，T2）：大库（>500 节点，过默认 minNodes 门）全局视图
 * 默认进枝干视图——几十个 trunk 对象（簇团 + hub + 聚合边）。
 * fixture：6 目录 × 85 文件 = 510 md（目录内互链 3 条 + 全员链 1 个总目录 hub），
 * LCG 固定种子可复现；LPA 聚出 6 簇（目录还原），总目录为唯一 hub。
 * E2E 不设 MOLIO_GRAPH_TRUNK_MIN_NODES（共享 daemon env 会波及其他 spec）——
 * 靠 510 文件过默认 500 门。
 */

const DAEMON_API = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}/api`;

const DIRS = 6;
const PER_DIR = 85; // 6×85 = 510 > 500（默认 minNodes 门）
const TOTAL = DIRS * PER_DIR;

function makeTrunkVault(dir: string): void {
  // LCG（确定性，与 scripts/make-synth-vault.mjs 同法）
  let seed = 20261118;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const ri = (excl: number) => Math.floor(rnd() * excl);

  const name = (i: number) => `笔记${String(i).padStart(5, '0')}`; // 文件名全局唯一（wikilink 裸名解析）
  for (let d = 0; d < DIRS; d++) {
    mkdirSync(path.join(dir, `主题${String(d).padStart(2, '0')}`), { recursive: true });
  }
  for (let i = 0; i < TOTAL; i++) {
    const dirIdx = i % DIRS;
    const dirName = `主题${String(dirIdx).padStart(2, '0')}`;
    const lines = [`# ${name(i)}`, ''];
    // 3 条同目录互链（目录内聚 → LPA 还原目录）+ 1 条总目录（hub）
    for (let j = 0; j < 3; j++) {
      const peer = ((Math.floor(i / DIRS) + 1 + j + ri(5)) % PER_DIR) * DIRS + dirIdx;
      if (peer !== i) lines.push(`- 关联 [[${name(peer)}]]`);
    }
    lines.push(`- 索引 [[总目录]]`);
    lines.push('', `正文段落 ${i}：占位。`);
    writeFileSync(path.join(dir, dirName, `${name(i)}.md`), lines.join('\n') + '\n');
  }
  writeFileSync(path.join(dir, '总目录.md'), '# 总目录\n\n索引页。\n');
}

/** 无结构随机链库（520 文件、纯随机出链 + hub）：LPA 聚出巨团 → quality=degenerate */
function makeDegenerateVault(dir: string): void {
  let seed = 20261119;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const ri = (excl: number) => Math.floor(rnd() * excl);
  const n = 520;
  const name = (i: number) => `散${String(i).padStart(5, '0')}`;
  for (let i = 0; i < n; i++) {
    const lines = [`# ${name(i)}`, ''];
    for (let j = 0; j < 3; j++) {
      const peer = ri(n);
      if (peer !== i) lines.push(`- 关联 [[${name(peer)}]]`);
    }
    lines.push(`- 索引 [[总目录]]`, '', '占位。');
    writeFileSync(path.join(dir, `${name(i)}.md`), lines.join('\n') + '\n');
  }
  writeFileSync(path.join(dir, '总目录.md'), '# 总目录\n\n索引页。\n');
}

let vaultId: string;
let vaultDir: string;
let smallVaultId: string;
let smallVaultDir: string;
let degenerateVaultId: string;
let degenerateVaultDir: string;

async function createVault(name: string, dir: string): Promise<string> {
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path: dir }),
  });
  if (!res.ok) throw new Error(`create vault ${name} failed: ${res.status}`);
  return (await res.json()).id;
}

test.beforeAll(async () => {
  // 清理上一次跑挂的残留 vault（graph-settings.spec.ts 同款防御）
  const existing = await (await fetch(`${DAEMON_API}/knowledge/vaults`)).json();
  for (const v of existing.vaults ?? existing) {
    if ((v.name ?? '').startsWith('e2e-graph-trunk')) {
      await fetch(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' });
    }
  }
  vaultDir = mkdtempSync(path.join(tmpdir(), 'molio-graph-trunk-'));
  makeTrunkVault(vaultDir);
  vaultId = await createVault('e2e-graph-trunk', vaultDir);

  smallVaultDir = mkdtempSync(path.join(tmpdir(), 'molio-graph-trunk-small-'));
  writeFileSync(path.join(smallVaultDir, 'a.md'), '# A\n\n[[b]]\n');
  writeFileSync(path.join(smallVaultDir, 'b.md'), '# B\n');
  smallVaultId = await createVault('e2e-graph-trunk-small', smallVaultDir);

  degenerateVaultDir = mkdtempSync(path.join(tmpdir(), 'molio-graph-trunk-deg-'));
  makeDegenerateVault(degenerateVaultDir);
  degenerateVaultId = await createVault('e2e-graph-trunk-degenerate', degenerateVaultDir);
});

test.afterAll(async () => {
  for (const [id, dir] of [
    [vaultId, vaultDir],
    [smallVaultId, smallVaultDir],
    [degenerateVaultId, degenerateVaultDir],
  ] as Array<[string | undefined, string | undefined]>) {
    if (id) await fetch(`${DAEMON_API}/knowledge/vaults/${id}`, { method: 'DELETE' });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem('molio.activeVaultId', id), vaultId);
});

async function gotoGraph(page: Page, id: string = vaultId): Promise<void> {
  await page.addInitScript((vid) => localStorage.setItem('molio.activeVaultId', vid), id);
  await page.goto(`/knowledge?vault=${id}`);
  await clickNav(page, 'graph');
  await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible({ timeout: 15000 });
}

test('大库全局视图默认进枝干：indicator + 开关激活 + trunk 对象 ≤45', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  const toggle = page.locator('[data-testid="graph-view-mode-toggle"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveClass(/is-active/);
  // 引擎快照：trunk 对象数（簇+hub）远小于全量 510+
  const count = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(45);
});

test('搜索联动（trunk 态）：簇名匹配高亮留 trunk；成员命中按拍板 A 切全量并定位', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });

  // ① 搜簇名（fixture 目录名 = 簇 label）：选项带 data-kind="cluster"，选中后仍 trunk + 高亮该簇
  await page.click('[data-testid="graph-search-open"]');
  await page.fill('[data-testid="graph-search-input"]', '主题');
  const clusterOpt = page.locator('[data-testid="graph-search-option"][data-kind="cluster"]').first();
  await expect(clusterOpt).toBeVisible({ timeout: 5000 });
  const clusterId = await clusterOpt.getAttribute('data-key');
  await clusterOpt.click();
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getTrunkMode()))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSelectedKey()))
    .toBe(clusterId);

  // ② 搜簇成员文件名：选中 → 拍板 A 切全量（开关翻转）+ 定位（选中 + k>1）
  await page.fill('[data-testid="graph-search-input"]', '笔记00042');
  const nodeOpt = page.locator('[data-testid="graph-search-option"]').first();
  await expect(nodeOpt).toBeVisible({ timeout: 5000 });
  const nodeKey = await nodeOpt.getAttribute('data-key');
  await nodeOpt.click();
  // 轮询真实状态翻转（settings debounce → 推送 → focusNode 动画），不赌固定 sleep
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getTrunkMode()))
    .toBe(false);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSelectedKey()))
    .toBe(nodeKey);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getViewport().k ?? 0))
    .toBeGreaterThan(1);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeHidden();
  await expect(page.locator('[data-testid="graph-view-mode-toggle"]')).not.toHaveClass(/is-active/);
});

test('切换持久化：trunk→full 后 reload 仍是全量；再点回枝干', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });

  await page.click('[data-testid="graph-view-mode-toggle"]');
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeHidden({ timeout: 10000 });
  const fullCount = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  expect(fullCount).toBeGreaterThan(100); // 全量 511+ 节点（对照 trunk ≤45）

  // 落盘有 300ms 防抖；reload 后仍应保持全量（显式选择必须尊重——用户偏好规则）
  await page.waitForTimeout(600);
  await page.reload();
  await clickNav(page, 'graph');
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeHidden({ timeout: 10000 });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('molio.graph.settings') ?? '{}'));
  expect(stored.globalView).toBe('full');
  expect(stored.version).toBe(7);

  // 点回枝干（还原默认，不污染后续用例——settings 是 localStorage 全局的）
  await page.click('[data-testid="graph-view-mode-toggle"]');
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(600);
});

test('小库（无 communities）：开关不渲染，与现状一致', async ({ page }) => {
  await gotoGraph(page, smallVaultId);
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(800);
  await expect(page.locator('[data-testid="graph-view-mode-toggle"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toHaveCount(0);
  // 全量行为照旧：两个节点都在引擎里
  const count = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  expect(count).toBe(2);
});

test('筛选偏离默认：开关置灰，图走全量（不静默留在 trunk）', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  await page.click('.graph-settings-btn');
  const panel = page.locator('.graph-settings-panel');
  await expect(panel).toBeVisible({ timeout: 5000 });
  // 关掉「孤立节点」→ 三开关偏离默认 → trunk 让位（fail-open 到全量），开关 disabled
  const orphans = panel.locator('.graph-settings__checkbox').filter({ hasText: '孤立节点' }).locator('input');
  await orphans.uncheck();
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('[data-testid="graph-view-mode-toggle"]')).toBeDisabled();
  const count = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  expect(count).toBeGreaterThan(100); // 渲染的是全量
  // 还原（不污染后续用例）
  await orphans.check();
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 10000 });
});

test('degenerate 库：横幅提示但仍渲染 trunk（不白屏不自动退全量）', async ({ page }) => {
  await gotoGraph(page, degenerateVaultId);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-testid="graph-trunk-banner"]')).toBeVisible();
  // 图仍在渲染：canvas 可见 + 引擎活着（trunk 对象少，巨团+hub）
  const mode = await page.evaluate(() => window.__graphEngine?.getTrunkMode());
  expect(mode).toBe(true);
});

test('单击铁律：trunk 态点 hub 节点 = 打开文件', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  // 从 snapshot 找 hub（key 以 .md 结尾且非簇 id cN）→ 换算屏幕坐标点击
  const hubScreen = await page.evaluate(() => {
    const eng = window.__graphEngine;
    const snap = eng?.getSnapshot();
    if (!snap) return null;
    const hub = snap.nodes.find((n) => n.key === '总目录.md') ?? snap.nodes.find((n) => n.key.endsWith('.md'));
    if (!hub) return null;
    const rect = eng!.canvas.getBoundingClientRect();
    const t = eng!.getViewport();
    return {
      sx: rect.left + (hub.x + rect.width / 2) * t.k + t.tx,
      sy: rect.top + (hub.y + rect.height / 2) * t.k + t.ty,
      key: hub.key,
    };
  });
  expect(hubScreen).toBeTruthy();
  await page.mouse.click(hubScreen!.sx, hubScreen!.sy);
  // 打开文件：KB 主内容显示 总目录.md 的内容（正文「索引页。」）
  await expect(page.getByText('索引页。')).toBeVisible({ timeout: 10000 });
});

test('选择残留回归（终审 Important-2）：trunk 选中簇后切全量，簇 id 选择清除不压暗', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  // 搜索选中一个簇（selectedId = c1..cN）
  await page.click('[data-testid="graph-search-open"]');
  await page.fill('[data-testid="graph-search-input"]', '主题');
  const clusterOpt = page.locator('[data-testid="graph-search-option"][data-kind="cluster"]').first();
  await expect(clusterOpt).toBeVisible();
  await clusterOpt.click();
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSelectedKey() ?? null))
    .toBeTruthy();
  // 点开关切全量：新节点集里没有簇 id → 选择必须被清除（否则全量图整体压暗）
  await page.click('[data-testid="graph-view-mode-toggle"]');
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getTrunkMode()))
    .toBe(false);
  expect(await page.evaluate(() => window.__graphEngine?.getSelectedKey())).toBeNull();
});

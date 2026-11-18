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

/** 从引擎快照找一个簇 blob（key 形如 cN）→ 屏幕坐标 + sim 坐标（收起回位断言用） */
async function findBlobScreen(page: Page): Promise<{ sx: number; sy: number; key: string; bx: number; by: number } | null> {
  return page.evaluate(() => {
    const eng = window.__graphEngine;
    const snap = eng?.getSnapshot();
    if (!snap) return null;
    const blob = snap.nodes.find((n) => /^c\d+$/.test(n.key));
    if (!blob) return null;
    const rect = eng!.canvas.getBoundingClientRect();
    const t = eng!.getViewport();
    return {
      sx: rect.left + (blob.x + rect.width / 2) * t.k + t.tx,
      sy: rect.top + (blob.y + rect.height / 2) * t.k + t.ty,
      key: blob.key,
      bx: blob.x,
      by: blob.y,
    };
  });
}

async function expandedContains(page: Page, key: string): Promise<boolean> {
  return page.evaluate((k) => window.__graphEngine?.getTrunkExpandedClusters().includes(k) ?? false, key);
}

test('大库全局视图默认进枝干：indicator + 开关激活 + trunk 对象 ≤45', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  const toggle = page.locator('[data-testid="graph-view-mode-toggle"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveClass(/is-active/);
  // 引擎快照：trunk 对象数（簇+hub）远小于全量 510+。
  // 必须 poll：indicator 可见只证 graphData 已到 React，__graphEngine 挂载与
  // setTrunkData 推送在异步引擎创建链后——慢 CI 上采样会落在「指示器已亮、
  // 引擎还没数据」的窗口（第二次 CI flake 的机制，本地窗口为 0 不可复现）
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1))
    .toBeGreaterThan(0);
  const count = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  expect(count).toBeLessThanOrEqual(45);
});

test('搜索联动（trunk 态）：簇名匹配高亮留 trunk；成员命中按拍板 A 切全量并定位', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });

  // ① 搜簇名（fixture 目录名 = 簇 label）：选项带 data-kind="cluster"，选中后仍 trunk + 高亮该簇。
  // 选择统一走键盘 Enter（组件 onKeyDown 路径）——慢 CI 上鼠标点击要与下拉重渲染
  // 赛跑 actionability（"element is not stable/detached" flake），键盘无此依赖。
  await page.click('[data-testid="graph-search-open"]');
  await page.fill('[data-testid="graph-search-input"]', '主题');
  const clusterOpt = page.locator('[data-testid="graph-search-option"][data-kind="cluster"]').first();
  await expect(clusterOpt).toBeVisible({ timeout: 5000 });
  const clusterId = await clusterOpt.getAttribute('data-key');
  await page.press('[data-testid="graph-search-input"]', 'Enter');
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getTrunkMode()))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSelectedKey()))
    .toBe(clusterId);

  // ② 搜簇成员文件名：H2 真展开（替换拍板 A）——仍 trunk、该簇展开、成员选中定位（k>1）、开关不翻转
  await page.fill('[data-testid="graph-search-input"]', '笔记00042');
  const nodeOpt = page.locator('[data-testid="graph-search-option"]').first();
  await expect(nodeOpt).toBeVisible({ timeout: 5000 });
  const nodeKey = await nodeOpt.getAttribute('data-key');
  await page.press('[data-testid="graph-search-input"]', 'Enter');
  // 轮询真实状态（引擎推送 + focusNode 动画），不赌固定 sleep
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getTrunkMode()))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSelectedKey()))
    .toBe(nodeKey);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getTrunkExpandedClusters().length))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getViewport().k ?? 0))
    .toBeGreaterThan(1);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible();
  await expect(page.locator('[data-testid="graph-view-mode-toggle"]')).toHaveClass(/is-active/);
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
  // 全量行为照旧：两个节点都在引擎里（poll 引擎就绪，同首用例的竞态注）
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1))
    .toBe(2);
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
  // 图仍在渲染：trunk 模式活着（poll 引擎就绪，同首用例的竞态注）
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getTrunkMode() ?? false))
    .toBe(true);
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

test('全量图标签 LOD：同屏可见标签 ≤60（统一规则防汤，H2）', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  // 切到全量（511+ 节点）——远焦全局视角下可见标签必须被 cap 住（旧规则 150 预算 + 焦点全显会远超）
  await page.click('[data-testid="graph-view-mode-toggle"]');
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeHidden({ timeout: 10000 });
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1))
    .toBeGreaterThan(100);
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getVisibleLabelCount() ?? -1))
    .toBeLessThanOrEqual(60);
  // 还原（不污染后续用例——settings 是 localStorage 全局的；落盘 300ms 防抖）
  await page.click('[data-testid="graph-view-mode-toggle"]');
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(600);
});

test('点击簇团展开/收起（H2）：成员注入 + chip 收回 + blob 回原位不跳', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  const blob = await findBlobScreen(page);
  expect(blob).toBeTruthy();
  const before = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  await page.mouse.click(blob!.sx, blob!.sy);
  // 250ms 点击 defer 窗后展开（双击抑制），poll 兑现
  await expect
    .poll(() => expandedContains(page, blob!.key), { timeout: 5000 })
    .toBe(true);
  // 成员注入：快照显著增长（簇大小由 LPA 决定，不精确等于目录的 85——首个用例的 ≤45 即此意）
  const expandedCount = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  expect(expandedCount).toBeGreaterThan(before + 15);
  // chip 收回：点 chip 屏幕坐标（canvas CSS px + boundingRect 偏移）→ 回 trunk 全 blob
  const chip = await page.evaluate(
    (k) => {
      const eng = window.__graphEngine;
      const pos = eng?.getTrunkCollapseChipPos(k) ?? null;
      if (!pos || !eng) return null;
      const rect = eng.canvas.getBoundingClientRect();
      return { sx: rect.left + pos.sx, sy: rect.top + pos.sy };
    },
    blob!.key,
  );
  expect(chip).toBeTruthy();
  await page.mouse.click(chip!.sx, chip!.sy);
  await expect
    .poll(() => expandedContains(page, blob!.key), { timeout: 5000 })
    .toBe(false);
  const after = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  expect(after).toBeLessThanOrEqual(45);
  // blob 回展开前坐标（缓存回位，不跳位）
  const back = await page.evaluate(
    (k) => window.__graphEngine?.getSnapshot()?.nodes.find((n) => n.key === k) ?? null,
    blob!.key,
  );
  expect(back).toBeTruthy();
  expect(Math.abs(back!.x - blob!.bx)).toBeLessThan(0.5);
  expect(Math.abs(back!.y - blob!.by)).toBeLessThan(0.5);
});

test('双击簇团 no-op（T2 deferred minor，H2 兑现）', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  const blob = await findBlobScreen(page);
  expect(blob).toBeTruthy();
  await page.mouse.dblclick(blob!.sx, blob!.sy);
  await page.waitForTimeout(600); // 250ms defer 窗 + 余量
  expect(await page.evaluate(() => window.__graphEngine?.getTrunkExpandedClusters().length)).toBe(0);
  expect(await page.evaluate(() => window.__graphEngine?.getTrunkMode())).toBe(true);
});

test('刷新保态（H2 代拍 O）：后台刷新不重置视口、展开态按身份保住', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  const blob = await findBlobScreen(page);
  expect(blob).toBeTruthy();
  await page.mouse.click(blob!.sx, blob!.sy);
  await expect
    .poll(() => expandedContains(page, blob!.key), { timeout: 5000 })
    .toBe(true);
  const vp = await page.evaluate(() => window.__graphEngine?.getViewport());
  // 直接写盘新增一个孤立 md → tree-changed → 防抖刷新（crumb +1：trunk-crumbs 徽标从无到有 = 刷新落地）
  writeFileSync(path.join(vaultDir, '刷新观察.md'), '# 刷新观察\n\n无链接孤立节点。\n');
  await expect(page.locator('.graph-trunk-crumbs')).toBeVisible({ timeout: 30000 });
  // 视口未被程序重置（preserveViewport），展开态保住（同簇身份 ≥80% 重合）
  const vp2 = await page.evaluate(() => window.__graphEngine?.getViewport());
  expect(Math.abs(vp2.k - vp.k)).toBeLessThan(0.01);
  expect(Math.abs(vp2.tx - vp.tx)).toBeLessThan(0.01);
  expect(Math.abs(vp2.ty - vp.ty)).toBeLessThan(0.01);
  expect(await expandedContains(page, blob!.key)).toBe(true);
});

test('巨簇分批展开（H2 代拍 F）：degenerate 库主簇流式注入，全程不 refit', async ({ page }) => {
  await gotoGraph(page, degenerateVaultId);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 30000 });
  const blob = await findBlobScreen(page);
  expect(blob).toBeTruthy();
  const before = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
  const vp = await page.evaluate(() => window.__graphEngine?.getViewport());
  await page.mouse.click(blob!.sx, blob!.sy);
  // 流式注入：快照节点数最终显著增长（degenerate 主簇数百成员，首批 300 + 余批流式）
  await expect
    .poll(() => page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1), { timeout: 20000 })
    .toBeGreaterThan(before + 100);
  // 视口全程不被程序改写（展开不 refit）
  const vp2 = await page.evaluate(() => window.__graphEngine?.getViewport());
  expect(Math.abs(vp2.k - vp.k)).toBeLessThan(0.01);
  expect(Math.abs(vp2.tx - vp.tx)).toBeLessThan(1);
  expect(Math.abs(vp2.ty - vp.ty)).toBeLessThan(1);
});

test('展开后空闲红线（H2）：动画与批次停息后状态稳定，#415 不回退', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  const blob = await findBlobScreen(page);
  expect(blob).toBeTruthy();
  await page.mouse.click(blob!.sx, blob!.sy);
  await expect
    .poll(() => expandedContains(page, blob!.key), { timeout: 5000 })
    .toBe(true);
  // 过渡动画（350ms+stagger）与批次流息止后，快照与标签计数不再变化（空闲期无持续重绘的 proxy；
  // render=0 的直接测量由 scripts/graph-perf-probe.mjs 承担）
  await page.waitForTimeout(1200);
  const sample = () =>
    page.evaluate(() =>
      JSON.stringify({
        n: window.__graphEngine?.getSnapshot()?.nodes.length ?? -1,
        labels: window.__graphEngine?.getVisibleLabelCount() ?? -1,
        vp: window.__graphEngine?.getViewport(),
      }),
    );
  const s1 = await sample();
  await page.waitForTimeout(600);
  const s2 = await sample();
  expect(s2).toBe(s1);
});

test('选择残留回归（终审 Important-2）：trunk 选中簇后切全量，簇 id 选择清除不压暗', async ({ page }) => {
  await gotoGraph(page);
  await expect(page.locator('[data-testid="graph-trunk-indicator"]')).toBeVisible({ timeout: 20000 });
  // 搜索选中一个簇（selectedId = c1..cN）——键盘 Enter 选择（慢 CI 鼠标 actionability 竞态，见搜索联动用例注）
  await page.click('[data-testid="graph-search-open"]');
  await page.fill('[data-testid="graph-search-input"]', '主题');
  const clusterOpt = page.locator('[data-testid="graph-search-option"][data-kind="cluster"]').first();
  await expect(clusterOpt).toBeVisible();
  await page.press('[data-testid="graph-search-input"]', 'Enter');
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

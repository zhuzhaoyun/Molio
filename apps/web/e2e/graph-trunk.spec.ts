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

let vaultId: string;
let vaultDir: string;

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
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'e2e-graph-trunk', path: vaultDir }),
  });
  if (!res.ok) throw new Error(`create vault failed: ${res.status}`);
  vaultId = (await res.json()).id;
});

test.afterAll(async () => {
  if (vaultId) await fetch(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' });
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem('molio.activeVaultId', id), vaultId);
});

async function gotoGraph(page: Page): Promise<void> {
  await page.goto(`/knowledge?vault=${vaultId}`);
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

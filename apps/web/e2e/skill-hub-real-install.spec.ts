/**
 * @area skills
 * @priority P2
 *
 * 商店技能「更新防丢」的真实全链路（daemon → 真实 HTTP → mock 源 → zip 下载 →
 * 入库 → vault 镜像）：安装 → 手改库内容 → 再次安装（原地刷新）→ 隔离备份 +
 * hub-update 事件 + 设置页横幅；内容干净后再次安装 → 不再新增事件。
 *
 * skill-hub.spec.ts 在浏览器网络层 page.route 拦截（请求到不了 daemon），
 * 覆盖的是商店 UI 交互；hub 的安全网逻辑另有 daemon 单测
 *（test/core/skills/hub-drift.test.ts，注入 fetch）。本 spec 补的是两者
 * 之间没人盖住的缝：真实 HTTP 下载 + zip 解码 + 隔离/横幅整链。
 *
 * 运行（无 MOLIO_SKILLHUB_API 时整条 skip，CI 零成本）：
 *   node e2e/fixtures/mock-hub.mjs                  # 默认 :4310
 *   MOLIO_SKILLHUB_API=http://localhost:4310 \
 *     pnpm --filter @molio/web exec playwright test e2e/skill-hub-real-install.spec.ts
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}`;
const DATA_DIR = process.env.MOLIO_E2E_DATA_DIR;

async function gotoSkillsTab(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await clickNav(page, 'settings');
  await page.locator('[data-testid="settings-tab-skills"]').click();
  await expect(page.locator('.sk-shell')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.sk-list, .rt-empty').first()).toBeVisible({ timeout: 10_000 });
}

interface QuarantineEvent {
  id: number;
  source: string;
  skillId?: string;
  quarantinedPath: string;
  acked: boolean;
}

test('hub refresh quarantines hand-edited library content; clean refresh stays silent', async ({ page }) => {
  test.skip(!process.env.MOLIO_SKILLHUB_API, 'needs MOLIO_SKILLHUB_API (e2e/fixtures/mock-hub.mjs)');
  test.skip(!DATA_DIR, 'needs MOLIO_E2E_DATA_DIR (isolated daemon)');
  const req = page.request;

  const unackedHubEvents = async (): Promise<QuarantineEvent[]> =>
    ((await (await req.get(`${DAEMON}/api/skills/quarantine`)).json()).events as QuarantineEvent[])
      .filter((e) => !e.acked && e.source === 'hub-update');

  // ① 安装（真实下载链路：daemon → mock 源 → zip → 入库）
  const r1 = await req.post(`${DAEMON}/api/skills/hub/install`, { data: { slug: 'accept-demo' } });
  expect(r1.status()).toBe(201);
  const { skill } = await r1.json();
  expect(skill.id).toBeTruthy();
  const mdPath = path.join(DATA_DIR!, 'skills', skill.id as string, 'SKILL.md');
  expect(fs.existsSync(mdPath)).toBeTruthy();
  expect(fs.readFileSync(mdPath, 'utf8')).toContain('V1 官方正文内容');
  expect((await unackedHubEvents()).length).toBe(0);

  // ② 手改库内容（绕过 Molio），再次安装 → 原地刷新并触发安全网
  fs.appendFileSync(mdPath, '\n用户手改的一行', 'utf8');
  const r2 = await req.post(`${DAEMON}/api/skills/hub/install`, { data: { slug: 'accept-demo' } });
  expect((await r2.json()).updated).toBe(true);

  const evs = await unackedHubEvents();
  expect(evs.length).toBe(1);
  expect(evs[0]!.skillId).toBe(skill.id);
  // 备份里有用户的手改；库内容已恢复官方版
  expect(fs.readFileSync(path.join(evs[0]!.quarantinedPath, 'SKILL.md'), 'utf8')).toContain('用户手改的一行');
  expect(fs.readFileSync(mdPath, 'utf8')).not.toContain('用户手改的一行');

  // ③ 内容已干净 → 再刷新不新增事件（不滚雪球）
  const r3 = await req.post(`${DAEMON}/api/skills/hub/install`, { data: { slug: 'accept-demo' } });
  expect((await r3.json()).updated).toBe(true);
  expect((await unackedHubEvents()).length).toBe(1);

  // ④ 设置页横幅展示 + ack 消散
  await gotoSkillsTab(page);
  const banner = page.getByTestId('skill-quarantine-banner');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText('accept-demo');
  await page
    .getByTestId(/^skill-quarantine-ack-/)
    .filter({ hasNotText: 'coldstart' })
    .first()
    .click();
  await expect(banner).toHaveCount(0, { timeout: 10_000 });
});

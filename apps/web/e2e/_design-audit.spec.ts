import { test } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/** 临时设计审计截图 —— 看完即删，不提交。 */
const OUT = '/tmp/molio-pill-shots';
const DAEMON = 'http://localhost:3101';

async function firstVaultId(): Promise<string | null> {
  try {
    const res = await fetch(`${DAEMON}/api/knowledge/vaults`);
    const d = await res.json();
    const list = d.vaults ?? d ?? [];
    return list[0]?.id ?? null;
  } catch { return null; }
}

test.afterEach(async ({ page }) => { await unmockAll(page); });

test('dark landing', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('molio.theme', 'dark'));
  await mockChatRun(page);
  await gotoHome(page);
  await page.screenshot({ path: `${OUT}/d1-dark.png`, clip: { x: 0, y: 480, width: 1280, height: 320 } });
});

test('multiline typed', async ({ page }) => {
  await mockChatRun(page);
  await gotoHome(page);
  await page.getByTestId('composer-input').fill('第一行：帮我整理这篇笔记\n第二行：重点看知识图谱部分\n第三行：输出成小红书文案');
  await page.screenshot({ path: `${OUT}/d2-typed.png`, clip: { x: 0, y: 430, width: 1280, height: 370 } });
});

test('running state', async ({ page }) => {
  await mockChatRun(page, {
    frameDelay: 400,
    script: [{ type: 'status', label: 'running' }, { type: 'text_delta', delta: '思考中…' }],
  });
  await gotoHome(page);
  await page.getByTestId('composer-input').fill('长时间任务');
  await page.keyboard.press('Enter');
  await page.getByTestId('composer-stop').waitFor({ timeout: 10_000 });
  await page.screenshot({ path: `${OUT}/d3-running.png`, clip: { x: 0, y: 430, width: 1280, height: 370 } });
});

test('@ file picker', async ({ page }) => {
  const vaultId = await firstVaultId();
  test.skip(!vaultId, 'no vault');
  await page.addInitScript((id) => localStorage.setItem('molio.activeVaultId', id), vaultId);
  await mockChatRun(page);
  await gotoHome(page);
  await page.getByTestId('composer-input').pressSequentially('@', { delay: 50 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/d4-atpicker.png`, clip: { x: 0, y: 330, width: 1280, height: 470 } });
});

test('/ skill palette', async ({ page }) => {
  const vaultId = await firstVaultId();
  test.skip(!vaultId, 'no vault');
  await page.addInitScript((id) => localStorage.setItem('molio.activeVaultId', id), vaultId);
  await mockChatRun(page);
  await gotoHome(page);
  await page.getByTestId('composer-input').pressSequentially('/', { delay: 50 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/d5-slash.png`, clip: { x: 0, y: 330, width: 1280, height: 470 } });
});

test('kb docked panel', async ({ page }) => {
  const vaultId = await firstVaultId();
  test.skip(!vaultId, 'no vault');
  await page.addInitScript((id) => localStorage.setItem('molio.activeVaultId', id), vaultId);
  await mockChatRun(page);
  await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
  await page.waitForTimeout(2500);
  const askTab = page.locator('[data-testid="kb-btn-ask-tab"]');
  if (await askTab.count()) {
    await askTab.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/d6-kbdock.png` });
  } else {
    await page.screenshot({ path: `${OUT}/d6-kbdock.png` });
  }
});

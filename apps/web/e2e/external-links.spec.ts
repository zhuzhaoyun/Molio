/**
 * @area kb
 * @priority P0
 *
 * 回归：KB 渲染出的普通外链（<a href="https://…">，无 target=_blank）点击后
 * 不得把整个应用窗口导航走。修复前在 Electron 桌面端点击外链会原地跳转，
 * 应用被外部网站替换、知识库无法继续操作。
 *
 * 修复（App.tsx 根部 installExternalLinkHandler）：跨源 http(s) 链接点击被
 * 委托监听拦截，改走 window.open —— 浏览器里开新标签页，Electron 里经
 * setWindowOpenHandler 转系统浏览器。
 *
 * 断言（Playwright 里 window.open 表现为 popup 事件）：
 *   1. 点击外链触发 popup（新标签页/新窗口），目标 URL 正确
 *   2. 当前页面停留在 /knowledge，应用未被导航走
 *   3. 同源/相对链接不触发 popup（行为不变）
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON_API = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}/api`;

let extServer: Server;
let extPort = 0;
let testVaultPath: string;
let vaultId: string;
const vaultName = `e2e-extlink-${Date.now()}`;

async function openLinksFile(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await page.reload({ waitUntil: 'networkidle' });
  await clickNav(page, 'knowledge');
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

  await page.locator('.kb-vault-bar').first().click({ timeout: 5_000 });
  await page.waitForTimeout(500);
  await page.locator('.vm-vault-item').filter({ hasText: vaultName }).click({ timeout: 5_000 });
  await page.waitForTimeout(1_000);
  // 同库切换时仓库管理器按设计不自动收起（跨库才走新窗口分支），Esc 关闭。
  await page.keyboard.press('Escape');
  await expect(page.locator('.vm-overlay')).toBeHidden({ timeout: 5_000 });

  await page.locator('.kb-tree-item').filter({ hasText: 'links.md' }).click({ timeout: 10_000 });
  await expect(page.locator('.kb-header-filename-center')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.kb-content-area').getByText('Loading...')).toBeHidden({ timeout: 10_000 });
}

test.describe('外部链接在新页面打开（不劫持应用窗口）', () => {
  test.beforeAll(async () => {
    /* 跨源目标：本地临时 HTTP 服务（端口不同 = 跨源），避免依赖外网 */
    extServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('external target');
    });
    await new Promise<void>((r) => extServer.listen(0, '127.0.0.1', r));
    extPort = (extServer.address() as AddressInfo).port;

    testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-extlink-'));
    writeFileSync(
      join(testVaultPath, 'links.md'),
      `# Links\n\n[External](http://localhost:${extPort}/ext) 外链。\n\n[Relative](links.md) 同源相对链接。\n`,
    );

    const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: vaultName, path: testVaultPath }),
    });
    const vault = await res.json();
    vaultId = vault.id;
  });

  test.afterAll(async () => {
    if (vaultId) {
      await fetch(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
    }
    if (testVaultPath) rmSync(testVaultPath, { recursive: true, force: true });
    extServer?.close();
  });

  test('点击外链开新标签页，当前页停留在知识库', async ({ page, context }) => {
    await openLinksFile(page);
    const link = page.locator('#output a', { hasText: 'External' });
    await expect(link).toBeVisible({ timeout: 5_000 });

    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 5_000 }),
      link.click(),
    ]);
    await popup.waitForURL(`http://localhost:${extPort}/ext`, { timeout: 10_000 });

    // 应用窗口未被导航走：仍停留在知识库页面
    expect(page.url()).toContain('/knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible();
    await popup.close();
  });

  test('同源相对链接不触发新标签页', async ({ page, context }) => {
    await openLinksFile(page);
    const link = page.locator('#output a', { hasText: 'Relative' });
    await expect(link).toBeVisible({ timeout: 5_000 });

    let popupFired = false;
    context.on('page', () => { popupFired = true; });
    await link.click();
    await page.waitForTimeout(1_000);
    expect(popupFired).toBe(false);
  });
});

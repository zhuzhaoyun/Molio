// apps/web/e2e/floating-chat.spec.ts
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 * 方案 D 全局悬浮对话：任意页面右下角按钮、展开/收起显隐、与 KB 页内 💬问答共用同一面板、
 * 历史就地打开不跳转。
 * Prerequisites: `pnpm dev`.
 */

let vault: TempVault;

test.describe('Floating chat (方案 D)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-floating-chat');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('默认收起：任意页面右下角悬浮按钮可见，面板不可见', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await expect(page.locator('[data-testid="floating-chat-btn"]')).toBeVisible();
    // 面板 DOM 常驻（保 ref 恒有效），收起态是 CSS --closed → display:none
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeHidden();
  });

  test('点击悬浮按钮 → 面板展开、按钮隐藏；收起后按钮复现', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(0);

    // 收起 → 按钮复现、面板隐藏
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeHidden();
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toBeVisible();
  });

  test('KB 页内 💬问答展开的是同一全局面板，按钮隐藏', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 方案 D：KB 页不再渲染页内面板，💬问答直接展开全局面板
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);
  });

  test('首页同样可用悬浮面板（不依赖 KB 页）', async ({ page }) => {
    await mockChatRun(page);
    await page.goto('http://localhost:5173/');
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="floating-chat-btn"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    // 无 vault 上下文也能打开：面板空态
    await expect(page.locator('[data-testid="kb-chat-sessions-empty"]')).toBeVisible();
  });
});

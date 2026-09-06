import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * Unified chat panel + scoped entry buttons:
 * - 💬问答 (document) in kb-main-header → 1 click, qa mode + @当前文档.
 * - 💬问答 (vault) in KbTabBar actions → 无文件也可用（库级问答，不带 @文档）.
 * - 💬问答 empty-state CTA in「未选择文件」空状态 → 同上.
 * - 📚构建Wiki / 🩺健康检查 (vault) in KbTabBar actions → open + auto-send.
 * Prerequisites: `pnpm dev`.
 */
let vault: TempVault;

test.describe('KB chat entry (scoped buttons)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-chat-entry');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('💬问答 opens chat in qa mode with @当前文档 (one click)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();

    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    // qa 会话标签标题固定为「新会话」，不含文档名（顶栏标题已移除）
    await expect(panel.locator('[data-testid="kb-chat-session-tab"] .chat-session-tab-title')).not.toContainText('doc.md');
    // composer seeded with the file as a @ ref (chip / mention present)
    await expect(panel.locator('.file-chat-input')).toContainText(/doc\.md/);
  });

  test('📚构建Wiki opens chat + auto-sends (run starts)', async ({ page }) => {
    // mockChatRun 同时 mock /api/agents → 模拟已配置 agent。真实 CI daemon 无 agent，
    // 否则 handleBuildWiki 的 `if (!agentId) return` 会静默拦截，面板永不打开（回归）。
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-build-wiki"]').click();

    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-testid="kb-chat-session-tab"] .chat-session-tab-title')).toContainText(/构建|Wiki|Build/);
    // a user message (the skill prompt) appears
    await expect(panel.locator('.file-chat-messages')).toContainText(/wiki-build/, { timeout: 10_000 });

    // Regression: clicking build again after closing the panel reopens it
    // (existing tab must call setPanelOpen(true), not just activate).
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(panel).toBeHidden();
    await page.locator('[data-testid="kb-btn-build-wiki"]').click();
    await expect(panel).toBeVisible();
  });

  test('💬问答 while a build is active opens a separate qa tab — build tab keeps its thread', async ({ page }) => {
    // 同上：mock /api/agents → 模拟已配置 agent，否则 build 被 agentId guard 拦截、面板不开。
    await mockChatRun(page);
    // Open with a file so the 💬问答 (document-scoped) button is available.
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Start a wiki build — it lives in its OWN ⚙️ session tab (auto-sends the skill prompt).
    await page.locator('[data-testid="kb-btn-build-wiki"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.file-chat-messages')).toContainText(/wiki-build/, { timeout: 10_000 });
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);

    // Click 💬问答 — a SECOND 💬 session tab opens; its active view is empty with
    // @当前文档 seeded (问答不重置 build 标签，也绝不中断 build 的 run).
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2);
    const activeSession = panel.locator('[data-testid="kb-chat-session"]:visible');
    await expect(activeSession.locator('.file-chat-empty')).toBeVisible();
    await expect(activeSession.locator('.file-chat-input')).toContainText(/doc\.md/);

    // Switch back to the build tab — the wiki-build prompt is still there (no reset).
    await page.locator('[data-testid="kb-chat-session-tab"]').first().click();
    const activeBuild = panel.locator('[data-testid="kb-chat-session"]:visible');
    await expect(activeBuild.locator('.file-chat-messages')).toContainText(/wiki-build/);
  });

  test('🩺健康检查 disabled when wiki not initialized', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-btn-lint-wiki"]')).toBeDisabled();
  });

  test('💬问答 available when no file open (tab-bar entry, vault-scoped)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    // 头部文档级按钮仍只在选中文件时渲染（就近上下文入口，职责不变）
    await expect(page.locator('[data-testid="kb-btn-ask"]')).toHaveCount(0);
    // Tab 栏常驻入口可见可用（无论是否打开文件）
    const tabAsk = page.locator('[data-testid="kb-btn-ask-tab"]');
    await expect(tabAsk).toBeVisible();
    await expect(tabAsk).toBeEnabled();
    // 空状态 CTA 可见
    await expect(page.locator('[data-testid="kb-empty-ask-cta"]')).toBeVisible();

    // 点击 Tab 栏入口 → 面板打开，无文件 → 不带 @文档上下文
    await tabAsk.click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.file-chat-input')).not.toContainText(/doc\.md/);
  });

  test('💬问答 empty-state CTA opens chat when no file open', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const cta = page.locator('[data-testid="kb-empty-ask-cta"]');
    await expect(cta).toBeVisible();
    await cta.click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
  });

  test('Cmd+K opens qa panel', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-btn-ask"]')).toBeVisible();
    await page.locator('.kb-main').click();
    await page.keyboard.press('Control+KeyK');
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
  });

  test('💬问答 empty-state CTA also in 未选择文件 state (wiki initialized, no file)', async ({ page }) => {
    // wiki/INDEX.md 存在 → wikiInitialized=true → 空状态走「未选择文件」分支
    // （放 describe 末尾：写 INDEX.md 会翻转后续测试的 wiki 状态）
    fs.mkdirSync(path.join(vault.path, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'wiki', 'INDEX.md'), '# Index\n');
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    // 限定 .kb-main：文件面板的「Empty vault」也用 .kb-empty-state，不限定会 strict 冲突
    await expect(page.locator('.kb-main .kb-empty-state')).toContainText('未选择文件');
    const cta = page.locator('[data-testid="kb-empty-ask-cta"]');
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    fs.rmSync(path.join(vault.path, 'wiki'), { recursive: true, force: true });
  });
});

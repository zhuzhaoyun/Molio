import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area diagnostics
 * @priority P1
 *
 * 隐式诊断入口（utils/diagnoseIntent.ts + kbChatPrompts 的 DIAGNOSE_DIRECTIVE）：
 * - KB 问答里抱怨 Molio 自身故障 → 首条消息外层包「（Molio 诊断：…）」指令，
 *   用户气泡看不到它（展示层 stripDiagnoseDirective 剥离，同 wiki-query 触发语）
 * - 普通提问（含故障词的写作请求）不注入——精度优先，误判即劫持无关对话（#369 教训）
 * - 同一会话只在首次命中时注入一次（diagnosedRef）
 *
 * Prerequisites: `pnpm dev`.
 */
let vault: TempVault;

test.describe('KB qa — implicit diagnose directive', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-diagnose-directive');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('对话里抱怨 Molio 故障 → 首条消息带诊断指令，气泡里看不到', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 库级问答入口（Tab 栏常驻，无文件也可用）
    await page.locator('[data-testid="kb-btn-ask-tab"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    const input = panel.locator('[data-testid="composer-input"]');

    const createRunReq = page.waitForRequest(
      (req) => req.url().includes('/api/runs')
        && req.method() === 'POST'
        && !req.url().includes('/messages'),
      { timeout: 10_000 },
    );
    await input.fill('知识图谱打不开');
    await input.press('Enter');

    const body = (await createRunReq).postDataJSON();
    // 指令独占首行、用户原话收尾（会话标题取末行 → 标题是用户的话）
    expect(body.message.startsWith('（Molio 诊断：')).toBe(true);
    expect(body.message.endsWith('知识图谱打不开')).toBe(true);

    // 用户气泡只见用户自己的话：诊断指令与 wiki-query 触发语都剥离
    const bubble = panel.locator('[data-testid="user-message"]').first();
    await expect(bubble).toContainText('知识图谱打不开');
    await expect(bubble).not.toContainText('Molio 诊断');
    await expect(bubble).not.toContainText('知识库问答');
  });

  test('普通提问不带诊断指令', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask-tab"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    const input = panel.locator('[data-testid="composer-input"]');

    const createRunReq = page.waitForRequest(
      (req) => req.url().includes('/api/runs')
        && req.method() === 'POST'
        && !req.url().includes('/messages'),
      { timeout: 10_000 },
    );
    // 含故障词的写作请求：创作动词一票否决，不得被劫持成体检
    await input.fill('帮我写一篇关于系统报错的文章');
    await input.press('Enter');

    const body = (await createRunReq).postDataJSON();
    expect(body.message).not.toContain('Molio 诊断');
    expect(body.message).toContain('帮我写一篇关于系统报错的文章');
  });

  test('同一会话只在首次抱怨时注入一次', async ({ page }) => {
    await mockChatRun(page, { frameDelay: 10, secondTurnScripts: [SCRIPTS.simpleTextReply] });
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask-tab"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    const input = panel.locator('[data-testid="composer-input"]');

    // ── Turn 1: 首次抱怨 → 注入 ──
    const createRunReq = page.waitForRequest(
      (req) => req.url().includes('/api/runs')
        && req.method() === 'POST'
        && !req.url().includes('/messages'),
      { timeout: 10_000 },
    );
    await input.fill('知识图谱打不开');
    await input.press('Enter');
    const firstBody = (await createRunReq).postDataJSON();
    expect(firstBody.message.startsWith('（Molio 诊断：')).toBe(true);

    // 等 turn 1 结束（mock SSE turn_end → 输入框解锁）
    await expect(panel.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });
    await expect(input).toBeEnabled({ timeout: 10_000 });

    // ── Turn 2: 仍是故障抱怨（「还是加载不出来」命中界面失灵词）→ 不再注入 ──
    const followUpReq = page.waitForRequest(
      (req) => req.url().includes('/messages') && req.method() === 'POST',
      { timeout: 10_000 },
    );
    await input.fill('还是加载不出来');
    await input.press('Enter');

    const secondBody = (await followUpReq).postDataJSON();
    expect(secondBody.message).toContain('还是加载不出来');
    expect(secondBody.message).not.toContain('Molio 诊断');
  });
});

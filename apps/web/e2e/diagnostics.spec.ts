import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';
import { mockDiagnostics, DIAGNOSTICS_FIXTURE } from './helpers/diagnostics';
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

test.describe('Molio 体检面板（听诊器入口）', () => {
  let cvault: TempVault;

  test.beforeAll(async () => {
    cvault = await createTempVault('e2e-checkup-panel');
    fs.writeFileSync(path.join(cvault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (cvault) await cleanupTempVault(cvault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('体检按钮在未构建 Wiki 时可用，面板先给结论，正常项默认收起', async ({ page }) => {
    await mockDiagnostics(page);
    await page.goto(`/knowledge?vault=${cvault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-lint-wiki"]').click();
    await expect(page.locator('[data-testid="checkup-view-report"]')).toBeVisible();
    await expect(page.locator('[data-testid="checkup-verdict"]')).toHaveText('有 1 处问题需要处理');
    await expect(page.locator('[data-testid="checkup-verdict-note"]')).toHaveText('另有 1 处建议留意');
    await expect(page.locator('[data-testid="checkup-item"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="checkup-item"][data-level="error"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="checkup-item"]').first()).toContainText('你要做的事');
    await expect(page.locator('[data-testid="checkup-ok"] summary')).toHaveText('其余 1 项都正常');
    await expect(page.locator('[data-testid="checkup-ok-list"]')).toBeHidden();
    await page.locator('[data-testid="checkup-ok"] summary').click();
    await expect(page.locator('[data-testid="checkup-ok-list"]')).toContainText('版本');
    await expect(page.locator('[data-testid="checkup-skip"]')).toHaveText('有 1 项没能检查：安全软件');
    // 没有桌面桥：桌面专属动作不渲染；未构建 Wiki：不出现 Wiki 检查入口
    await expect(page.getByRole('button', { name: '重启 Molio' })).toHaveCount(0);
    await expect(page.locator('[data-testid="checkup-wiki-lint"]')).toHaveCount(0);
  });

  test('按 Esc 关闭体检面板', async ({ page }) => {
    await mockDiagnostics(page);
    await page.goto(`/knowledge?vault=${cvault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-lint-wiki"]').click();
    await expect(page.locator('[data-testid="checkup-dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="checkup-dialog"]')).toBeHidden();
  });

  test('面板里的「检查 Wiki 内容健康」走原有的 lint 会话', async ({ page }) => {
    await mockChatRun(page);
    await mockDiagnostics(page);
    // 「继续检查 Wiki 内容健康」行只在 Wiki 已构建时渲染
    await page.route('**/api/knowledge/vaults/*/wiki/status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ initialized: true }) }));

    await page.goto(`/knowledge?vault=${cvault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-lint-wiki"]').click();
    await expect(page.locator('[data-testid="checkup-view-report"]')).toBeVisible();
    await page.locator('[data-testid="checkup-wiki-lint"]').click();

    // 与旧听诊器按钮同一条链路：面板关闭 + 打开 lint 会话标签 + 自动发送 wiki-lint 提示词
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.file-chat-messages')).toContainText(/wiki-lint/, { timeout: 10_000 });
  });

  test('「让 AI 帮我看」开新会话并发送带诊断指令的消息', async ({ page }) => {
    await mockChatRun(page);
    await mockDiagnostics(page);
    const createRunReq = page.waitForRequest(
      (req) => req.url().includes('/api/runs')
        && req.method() === 'POST'
        && !req.url().includes('/messages'),
      { timeout: 10_000 },
    );

    await page.goto(`/knowledge?vault=${cvault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-lint-wiki"]').click();
    await expect(page.locator('[data-testid="checkup-view-report"]')).toBeVisible();
    await page.locator('[data-testid="checkup-ask-ai"]').click();

    const body = (await createRunReq).postDataJSON();
    expect(body.message.startsWith('（Molio 诊断：')).toBe(true);
    expect(body.message).toContain('Molio 体检发现了需要处理的问题');

    // 用户气泡只见人话：诊断指令是发给 agent 的，展示层剥离
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    const bubble = panel.locator('[data-testid="user-message"]').first();
    await expect(bubble).toContainText('Molio 体检发现了需要处理的问题');
    await expect(bubble).not.toContainText('Molio 诊断');
  });

  test('后台服务没有响应时给出重启与打开日志文件夹的指引', async ({ page }) => {
    // 体检接口彻底失败（abort）→ 不是白屏/裸报错，是「重启 + 日志文件夹」指引
    await page.route('**/api/diagnostics*', (route) => route.abort());
    await page.goto(`/knowledge?vault=${cvault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-lint-wiki"]').click();
    const un = page.locator('[data-testid="checkup-unreachable"]');
    await expect(un).toBeVisible();
    await expect(un).toContainText('后台服务没有响应');
    // 「重启 Molio」既出现在步骤里，也是（有桌面桥时的）主按钮文案
    await expect(un).toContainText('重启 Molio');
  });

  test('全部正常时显示「Molio 运行正常」且仍可让 AI 帮我看', async ({ page }) => {
    await mockChatRun(page);
    await mockDiagnostics(page, {
      ...DIAGNOSTICS_FIXTURE,
      items: [{ code: 'vaults', level: 'ok', title: '知识库', summary: '1 个知识库状态正常' }],
    });

    await page.goto(`/knowledge?vault=${cvault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-lint-wiki"]').click();
    await expect(page.locator('[data-testid="checkup-verdict"]')).toHaveText('Molio 运行正常');
    await expect(page.locator('[data-testid="checkup-ask-ai"]')).toBeVisible();
  });
});

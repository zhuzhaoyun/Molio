/**
 * @area chat
 * @priority P1
 * 工作可见性三件套（方向 A/B/D）：
 *   - WorkTimeline 锚定最后一条回复：运行中当前动作行+扫描条，完成后结果摘要（可展开、证据回跳）
 *   - SourceChips 出现引用文件 chips，点击跳转打开
 *   - WorkCompleteBanner 完成后展示产物，点击跳转
 * Prerequisites: `pnpm dev`.
 */
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, SCRIPTS, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;

test.describe('KB chat — work visibility', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-work-visibility');
    fs.mkdirSync(path.join(vault.path, '笔记'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, '笔记', '入门.md'), '# 入门笔记\n');
    fs.mkdirSync(path.join(vault.path, '产出'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, '产出', '总结.md'), '# 总结\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  function openQaAndSend(page: import('@playwright/test').Page, text: string) {
    return (async () => {
      await page.locator('[data-testid="kb-btn-ask"]').click();
      const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
      await input.fill(text);
      await page.locator('[data-testid="composer-send"]').click();
    })();
  }

  function sendOnHome(page: import('@playwright/test').Page, text: string) {
    return (async () => {
      const input = page.locator('[data-testid="composer-input"]');
      await input.fill(text);
      await page.locator('[data-testid="composer-send"]').click();
    })();
  }

  test('WorkTimeline 锚定最后一条回复：运行中当前动作、完成后结果摘要（可展开 + 证据回跳）', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.workflowRun, frameDelay: 800 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await openQaAndSend(page, '总结知识库');

    // 运行中：最后一条 assistant 消息内部出现当前动作行（读取文件 · 笔记/入门.md）
    const lastAssistant = page.locator('[data-testid="assistant-message"]').last();
    const timeline = lastAssistant.locator('[data-testid="work-timeline"]');
    await expect(timeline).toBeVisible({ timeout: 5_000 });
    const current = timeline.locator('[data-testid="work-timeline-current"]');
    await expect(current).toContainText('读取文件');
    await expect(current).toContainText('笔记/入门.md');

    // 完成后：折叠成结果摘要（清单非计数），展开显示步骤、点击回跳证据
    const summary = page.locator('[data-testid="work-timeline-summary"]');
    await expect(summary).toBeVisible({ timeout: 10_000 });
    await expect(summary).toContainText('已完成');
    await expect(summary).toContainText('读取文件');
    await expect(summary).not.toContainText('步');

    await summary.click();
    const steps = timeline.locator('[data-testid="work-timeline-step"]');
    await expect(steps).toHaveCount(3); // Read/Grep/Write（生成回复为静态行，不计按钮）
    await expect(steps.filter({ hasText: '写入文件' })).toHaveCount(1);
    await expect(steps.filter({ hasText: '写入文件' })).toContainText('产出/总结.md');

    // 点击「写入文件」步骤 → 滚动到证据 ToolCard
    await steps.filter({ hasText: '写入文件' }).click();
    await expect(page.locator('[data-tool-id="w1"]')).toBeInViewport();

    const banner = page.locator('[data-testid="work-complete-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
  });

  test('来源 chips 出现引用文件，点击跳转打开', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.workflowRun, frameDelay: 200 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await openQaAndSend(page, '总结知识库');

    // 完成后：Read → 笔记/入门.md，Grep → 笔记，去重后 2 个 chip
    const chips = page.locator('[data-testid="source-chips"] [data-testid="source-chip"]');
    await expect(chips).toHaveCount(2, { timeout: 10_000 });
    await expect(chips.first()).toContainText('入门.md');

    // 有 active vault → 文件 chip 可点
    await expect(chips.first()).toBeEnabled();

    // 点击 chip → 导航打开对应文件
    await chips.first().click();
    await expect(page.locator('#output')).toContainText('入门笔记', { timeout: 10_000 });
  });

  test('Glob pattern chip 不可跳转、Bash cat 跳过选项标志', async ({ page }) => {
    // Glob 事件同时带 pattern + path：必须取 pattern 且不可跳转（评审 FINDING 1）
    // Bash `cat -n` 需跳过选项标志、指向实际文件（评审 FINDING 2）
    await mockChatRun(page, {
      script: [
        { type: 'status', label: 'running' },
        { type: 'tool_use', id: 'g1', name: 'Glob', input: { pattern: '**/*.ts', path: '/base' } },
        { type: 'tool_result', toolUseId: 'g1', content: '匹配 3 处', isError: false },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'cat -n 笔记/入门.md' } },
        { type: 'tool_result', toolUseId: 'b1', content: '# 入门笔记', isError: false },
        { type: 'text_delta', delta: '已完成。' },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'usage', usage: { input_tokens: 400, output_tokens: 60 }, costUsd: 0.02 },
      ],
      frameDelay: 100,
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await openQaAndSend(page, '总结知识库');

    const chips = page.locator('[data-testid="source-chips"] [data-testid="source-chip"]');
    await expect(chips).toHaveCount(2, { timeout: 10_000 });

    // Glob → pattern（'*.ts'）且 disabled，绝不落入通用 path 分支变可跳转
    const globChip = chips.nth(0);
    await expect(globChip).toContainText('*.ts');
    await expect(globChip).toBeDisabled();

    // Bash cat -n → 跳过选项，指向实际文件
    await expect(chips.nth(1)).toContainText('入门.md');
  });

  test('完成后展示产物回写 banner，点击跳转打开', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.workflowRun, frameDelay: 200 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await openQaAndSend(page, '总结知识库');

    const banner = page.locator('[data-testid="work-complete-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    // banner 展示产物文件（label 为 basename；完整路径在 button 的 title tooltip）
    await expect(banner).toContainText('总结.md');
    await expect(banner.locator('[data-testid="work-complete-file"]')).toHaveAttribute('title', '产出/总结.md');

    // 有 active vault → 产物文件按钮可点
    await expect(banner.locator('[data-testid="work-complete-file"]')).toBeEnabled();

    await banner.locator('[data-testid="work-complete-file"]').click();
    await expect(page.locator('#output')).toContainText('总结', { timeout: 10_000 });
  });

  test('失败的工具不显示为来源 chip 或产物 banner', async ({ page }) => {
    // 评审 FINDING：tool_result isError:true → useChatCore 映射 status:'error'，
    // 抽取函数此前只跳过 running，会把失败工具当作成功引用/已写入展示。
    // 成功 Read/Write 保留展示，失败 Read/Write 必须被排除。
    await mockChatRun(page, {
      script: [
        { type: 'status', label: 'running' },
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '笔记/入门.md' } },
        { type: 'tool_result', toolUseId: 'r1', content: '# 入门笔记', isError: false },
        { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '笔记/缺失.md' } },
        { type: 'tool_result', toolUseId: 'r2', content: '文件不存在', isError: true },
        { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '产出/成功.md' } },
        { type: 'tool_result', toolUseId: 'w1', content: '已写入', isError: false },
        { type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: '产出/失败.md' } },
        { type: 'tool_result', toolUseId: 'w2', content: '写入失败', isError: true },
        { type: 'text_delta', delta: '完成。' },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'usage', usage: { input_tokens: 400, output_tokens: 60 }, costUsd: 0.02 },
      ],
      frameDelay: 150,
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await openQaAndSend(page, '总结知识库');

    // 来源 chips：只保留成功的 Read（1 个），失败的 缺失.md 不出现
    const chips = page.locator('[data-testid="source-chips"] [data-testid="source-chip"]');
    await expect(chips).toHaveCount(1, { timeout: 10_000 });
    await expect(chips).toContainText('入门.md');
    await expect(chips).not.toContainText('缺失.md');

    // 产物 banner：只保留成功的 Write（1 个），失败的 失败.md 不出现
    const banner = page.locator('[data-testid="work-complete-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('成功.md');
    await expect(banner).not.toContainText('失败.md');
    await expect(banner.locator('[data-testid="work-complete-file"]')).toHaveCount(1);
  });

  test('主页问答：时间线锚定最后一条回复（不再悬浮消息流顶部）+ 产物 banner', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.workflowRun, frameDelay: 800 });
    await page.goto('http://localhost:5173/');
    await expect(page.locator('[data-testid="composer-input"]')).toBeVisible({ timeout: 5_000 });

    await sendOnHome(page, '总结知识库');

    // 运行中：时间线在最后一条 assistant 消息内部，且 .chat-log 首个子元素不再是时间线
    const chatLog = page.locator('.home-chat-log');
    const lastAssistant = page.locator('[data-testid="assistant-message"]').last();
    const timeline = lastAssistant.locator('[data-testid="work-timeline"]');
    await expect(timeline).toBeVisible({ timeout: 5_000 });
    const current = timeline.locator('[data-testid="work-timeline-current"]');
    await expect(current).toContainText('读取文件');
    await expect(current).toContainText('笔记/入门.md');
    await expect(chatLog.locator(':scope > [data-testid="work-timeline"]')).toHaveCount(0);

    // 完成后：折叠摘要 + banner
    const summary = page.locator('[data-testid="work-timeline-summary"]');
    await expect(summary).toBeVisible({ timeout: 10_000 });
    await expect(summary).toContainText('已完成');
    const banner = page.locator('[data-testid="work-complete-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('总结.md');
  });

  test('WebSearch 来源抽 URL 成可点链接 chip（去重 + host 标签）', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.newsRun, frameDelay: 150 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await openQaAndSend(page, '整理今日新闻');

    // ws1×2 + ws2×3，其中 ithome 首条重复 → 去重后 4 条，各自独立 chip
    const chips = page.locator('[data-testid="source-chips"] [data-testid="source-chip"]');
    await expect(chips).toHaveCount(4, { timeout: 10_000 });
    // 标签 = host（去协议/取首段）。多元素 locator 上 toContainText 会触发 strict mode，
    // 故用 filter 单元素定位；hasText 子串匹配 + toHaveCount(1) 同时校验去重（每 host 恰好一个 chip）
    for (const host of ['www.ithome.com', '36kr.com', 'sspai.com', 'news.example.com']) {
      await expect(chips.filter({ hasText: host })).toHaveCount(1);
    }

    // URL chip 可点击 → 新标签打开
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      chips.filter({ hasText: '36kr.com' }).click(),
    ]);
    await expect(popup).toBeDefined();
    await expect(popup.url()).toContain('36kr.com');
  });

  test('来源 URL 上限 8 条，超出静默丢弃', async ({ page }) => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://news.example.com/item/${i}`);
    await mockChatRun(page, {
      script: [
        { type: 'status', label: 'running' },
        { type: 'tool_use', id: 'ws1', name: 'WebSearch', input: { query: '新闻' } },
        { type: 'tool_result', toolUseId: 'ws1', content: urls.join('\n'), isError: false },
        { type: 'text_delta', delta: '整理完毕。' },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'usage', usage: { input_tokens: 400, output_tokens: 60 }, costUsd: 0.02 },
      ],
      frameDelay: 100,
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await openQaAndSend(page, '整理今日新闻');

    const chips = page.locator('[data-testid="source-chips"] [data-testid="source-chip"]');
    await expect(chips).toHaveCount(8, { timeout: 10_000 }); // MAX_URL_CHIPS = 8
  });
});

import { test, expect } from '@playwright/test';
import { gotoHome, gotoChatSpa, sendMessage, clickNav } from './helpers/navigation';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';
import { createTempVault, cleanupTempVault } from './helpers/cleanup';

/**
 * @area chat
 * @priority P1
 *
 * 会话产出聚合面板（主页 dock）——本次会话 Molio 写入的 KB 文件 rollup。
 * 纯前端聚合（aggregateSessionOutput）；外部引用（读过的文件 / 网页 URL）只在
 * 消息内联 SourceChips 展示，不进产出面板。触及 HomePage.tsx / App.tsx →
 * 全量 E2E 门禁；CLAUDE.md「UI 改动与 E2E 同 commit」。
 */

// 写入产物（全部绝对路径）：产出文档 3 篇（新建 1 / 更新 2）+ 脚本 1 个 +
// 登记元文件 3 个（各级 INDEX.md / log.md / hot.md → 折叠区）+ 同一 hot.md 的 ./ 相对形态
// （对齐真实 agent：上报形态不稳定、还会把构建脚本写进 vault）。vaultPath 动态注入。
// 另含两类「必须完全不出现」的写入：隐藏目录（.molio/agent 的中间产物）与库外路径
// （Claude Code 自己的 memory 文件）—— 它们的预览与定位必然失败。
const OUTSIDE_PATH = '/tmp/molio-e2e-outside/memory/MEMORY.md';
function buildAbsRun(vaultPath: string) {
  const news = `${vaultPath}/wiki/2026-08-27-新闻要点.md`;
  const review = `${vaultPath}/wiki/2026-08-27-要闻综述.md`;
  const deep = `${vaultPath}/wiki/2026-08-27-深度报道.md`;
  return [
    { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
    // 新建一篇产出文档
    { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: news, content: '# 新闻要点\n\n近端上下文正文\n' } },
    { type: 'tool_result', toolUseId: 'w1', content: '已写入', isError: false },
    // 改一篇已有文档：先 Read（覆写判据的依据）再 Edit 带 old/new → 变更 tab 的 ±行数来源。
    // 这条以前挂在 INDEX.md 上 —— 元文件已归折叠区，±diff 覆盖必须落在真正的产出文档上。
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: review } },
    { type: 'tool_result', toolUseId: 'r1', content: '全文 318 字', isError: false },
    { type: 'tool_use', id: 'w2', name: 'Edit', input: { file_path: review, old_string: '全文 318 字', new_string: '全文 319 字' } },
    { type: 'tool_result', toolUseId: 'w2', content: '已更新', isError: false },
    // 覆写既有文档的 Write（先 Read 过）→ 必须是「更新」而不是「新建」：判据是会话内
    // 该路径出现过没有，不是用了哪个工具（用户报障即「每次都显示新建」）。
    { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: deep } },
    { type: 'tool_result', toolUseId: 'r2', content: '旧稿正文', isError: false },
    { type: 'tool_use', id: 'w3', name: 'Write', input: { file_path: deep, content: '# 深度报道\n\n重写后的正文\n' } },
    { type: 'tool_result', toolUseId: 'w3', content: '已写入', isError: false },
    // 登记元文件（各级 INDEX.md / log.md / hot.md）：agent 每次操作都重写一遍，但不是产出 → 折叠区
    { type: 'tool_use', id: 'w4', name: 'Edit', input: { file_path: `${vaultPath}/wiki/INDEX.md`, old_string: '内容页共 318 页', new_string: '内容页共 319 页' } },
    { type: 'tool_result', toolUseId: 'w4', content: '已更新', isError: false },
    { type: 'tool_use', id: 'w5', name: 'Edit', input: { file_path: `${vaultPath}/wiki/log.md` } },
    { type: 'tool_result', toolUseId: 'w5', content: '已更新', isError: false },
    { type: 'tool_use', id: 'w6', name: 'Write', input: { file_path: `${vaultPath}/wiki/hot.md`, content: '# 热点\n' } },
    { type: 'tool_result', toolUseId: 'w6', content: '已写入', isError: false },
    // 构建脚本也写进 vault（库内非文档）
    { type: 'tool_use', id: 'w7', name: 'Write', input: { file_path: `${vaultPath}/scripts/build_report.py`, content: 'import re\n\nprint("build report")\n' } },
    { type: 'tool_result', toolUseId: 'w7', content: '已写入', isError: false },
    // 同一 hot.md 的另一种上报形态 —— 聚合层应去重，不得出现两个 hot.md
    { type: 'tool_use', id: 'w8', name: 'Edit', input: { file_path: './wiki/hot.md' } },
    { type: 'tool_result', toolUseId: 'w8', content: '已更新', isError: false },
    // 隐藏目录（agent 中间产物）—— 不进面板任何一栏
    { type: 'tool_use', id: 'w9', name: 'Write', input: { file_path: `${vaultPath}/.molio/wiki-build/plan.md`, content: '# 页面规划' } },
    { type: 'tool_result', toolUseId: 'w9', content: '已写入', isError: false },
    // 库外路径（Claude Code memory）—— 不进面板任何一栏
    { type: 'tool_use', id: 'w10', name: 'Write', input: { file_path: OUTSIDE_PATH, content: '# Memory' } },
    { type: 'tool_result', toolUseId: 'w10', content: '已写入', isError: false },
    { type: 'text_delta', delta: '归档完成。' },
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 900, output_tokens: 120 }, costUsd: 0.02 },
  ] as const;
}

// Write 产物 1 个 + WebSearch 来源 2 个（来源不再进面板，仅用于验证「外部引用不混入产出」）
const outputRun = [
  { type: 'status', label: 'running' },
  { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '产出/总结.md' } },
  { type: 'tool_result', toolUseId: 'w1', content: '已写入', isError: false },
  { type: 'tool_use', id: 'ws1', name: 'WebSearch', input: { query: '今日科技新闻' } },
  { type: 'tool_result', toolUseId: 'ws1', content: '英伟达 https://www.ithome.com/a\n小米 https://36kr.com/p/1', isError: false },
  { type: 'text_delta', delta: '已整理完毕。' },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 400, output_tokens: 60 }, costUsd: 0.02 },
];

test.describe('Home 会话产出面板', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('dock 默认关闭；toggle 打开后聚合写入/stats（外部引用不混入）', async ({ page }) => {
    await mockChatRun(page, { script: outputRun });
    await gotoHome(page);
    // 默认关闭：面板不在 DOM
    await expect(page.locator('[data-testid="session-output-panel"]')).toHaveCount(0);
    await sendMessage(page, '整理产出');
    // 完成态：有工具 → hasWorkBlock → 工作块折叠摘要头
    await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
    // toggle 打开
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    await expect(panel).toBeVisible();
    // 写入 1 项（label=basename 总结.md）
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-output-write"]')).toContainText('总结.md');
    // 外部引用不进面板（来源分区已移除，只在消息内联 SourceChips）
    await expect(panel.locator('[data-testid="session-output-source"]')).toHaveCount(0);
    // stats 行
    await expect(panel.locator('[data-testid="session-output-stats"]')).toContainText('写入 1 · 1 轮');
  });

  test('跨消息聚合去重：两轮 Write 同路径 → 只显示一次', async ({ page }) => {
    await mockChatRun(page, { script: outputRun });
    await gotoHome(page);
    await sendMessage(page, '第一轮');
    await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
    await sendMessage(page, '第二轮');
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2, { timeout: 15_000 });
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    // writes 跨消息按 path 去重 → 仍 1 项；turns=2
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-output-stats"]')).toContainText('2 轮');
  });

  test('点击写入项 → 面板内嵌预览渲染文件内容；返回恢复列表（不跳转知识库）', async ({ page }) => {
    const vault = await createTempVault('e2e-dock-preview');
    try {
      // 真实 vault 存在 → 写入项可点；拦截 readFile 返回 mock 内容（不依赖真实文件落盘）
      await page.addInitScript((id) => { localStorage.setItem('molio.activeVaultId', id); }, vault.id);
      await page.route('**/knowledge/vaults/*/files/**', (route) => {
        return route.fulfill({
          json: {
            path: '产出/总结.md',
            content: '# Mock 预览标题\n\n预览正文内容段落',
            size: 100,
            modifiedAt: Date.now(),
          },
        });
      });
      await mockChatRun(page, { script: outputRun });
      await gotoHome(page);
      await sendMessage(page, '整理产出');
      await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
      await page.locator('[data-testid="home-output-toggle"]').click();
      const panel = page.locator('[data-testid="session-output-panel"]');
      // 点击写入项 → 预览视图出现，mock 内容渲染可见
      await panel.locator('[data-testid="session-output-write"]').click();
      await expect(panel.locator('[data-testid="session-output-preview"]')).toBeVisible();
      await expect(panel.locator('[data-testid="session-output-preview"]')).toContainText('Mock 预览标题');
      await expect(panel.locator('[data-testid="session-output-preview"]')).toContainText('预览正文内容段落');
      // 仍在整页对话（未跳转知识库）—— 不打破对话注意力
      await expect(page).toHaveURL(/\/chat$/);
      // 返回 → 列表恢复
      await panel.locator('[data-testid="session-output-preview-back"]').click();
      await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
      await expect(panel.locator('[data-testid="session-output-preview"]')).toHaveCount(0);
    } finally {
      await cleanupTempVault(vault);
    }
  });

  test('无产出会话显示空态', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.simpleTextReply });
    await gotoHome(page);
    await sendMessage(page, '纯问答');
    // 无工具 → 无工作块 → 完成态信号用独立 usage-footer
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    await expect(panel.locator('[data-testid="session-output-empty"]')).toBeVisible();
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(0);
  });

  test('只写了脚本的会话：不冒充「没有写入产出的记录」，只给折叠区', async ({ page }) => {
    // 空态判据若只看 docs 清单，一个「只生成脚本」的会话会同时显示
    // 「该会话没有写入产出的记录」和「其他写入 1 项」—— 自相矛盾。
    await mockChatRun(page, {
      script: [
        { type: 'status', label: 'running' },
        { type: 'tool_use', id: 's1', name: 'Write', input: { file_path: 'scripts/build_report.py', content: 'print(1)\n' } },
        { type: 'tool_result', toolUseId: 's1', content: '已写入', isError: false },
        { type: 'text_delta', delta: '脚本就绪。' },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'usage', usage: { input_tokens: 400, output_tokens: 60 }, costUsd: 0.02 },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '生成脚本');
    await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');

    // 先钉住面板已渲染出内容（否则 toHaveCount(0) 在内容落地前就秒过 = 假绿）
    const toggle = panel.locator('[data-testid="session-output-others-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('其他写入 1 项');
    await expect(panel.locator('[data-testid="session-output-empty"]')).toHaveCount(0);
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(0);

    // 默认收起 → 条目不在 DOM；展开后才出现
    await expect(panel.locator('[data-testid="session-output-other-item"]')).toHaveCount(0);
    await toggle.click();
    await expect(panel.locator('[data-testid="session-output-other-item"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-output-other-item"]')).toContainText('build_report.py');
  });

  test('点击定位 → 展开工作块并高亮生成该文件的工具步（不触发预览）', async ({ page }) => {
    await mockChatRun(page, { script: outputRun });
    await gotoHome(page);
    await sendMessage(page, '整理产出');
    await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    // hover 写入行 → 定位按钮可见（stopPropagation：不打开预览）
    await panel.locator('[data-testid="session-output-write"]').hover();
    await panel.locator('[data-testid="session-output-locate"]').click();
    await expect(page.locator('[data-testid="session-output-preview"]')).toHaveCount(0);
    // 折叠的工作块自动展开，目标工具行（Write w1）出现在 DOM 并被闪烁标记
    const target = page.locator('.work-block-detail [data-tool-id="w1"]');
    await expect(target).toBeVisible({ timeout: 5_000 });
    await expect(target).toHaveClass(/evidence-flash/);
  });

  test('绝对路径写入项预览：readFile 请求保留 %2F 编码；形态归一化去重；py 走代码视图', async ({ page }) => {
    const vault = await createTempVault('e2e-dock-abs-path');
    try {
      await page.addInitScript((id) => { localStorage.setItem('molio.activeVaultId', id); }, vault.id);
      // 拦 readFile：断言 URL 里绝对路径保持 %2F 编码；若被还原成真实斜杠则判死。
      // .py 返回代码内容，验证预览走代码视图而非 markdown 渲染。
      let sawEncoded = false;
      let sawRawSlash = false;
      const newsAbs = `${vault.path}/wiki/2026-08-27-新闻要点.md`;
      const reviewAbs = `${vault.path}/wiki/2026-08-27-要闻综述.md`;
      const deepAbs = `${vault.path}/wiki/2026-08-27-深度报道.md`;
      const pyAbs = `${vault.path}/scripts/build_report.py`;
      const hotAbs = `${vault.path}/wiki/hot.md`;
      await page.route('**/knowledge/vaults/*/files/**', (route) => {
        const rawUrl = route.request().url();
        if (rawUrl.includes(encodeURIComponent(newsAbs))) sawEncoded = true;
        if (/\/files\/\//.test(rawUrl)) sawRawSlash = true;
        const decoded = decodeURIComponent(rawUrl);
        const isPy = decoded.endsWith('.py');
        return route.fulfill({
          json: {
            path: isPy ? pyAbs : newsAbs,
            content: isPy
              ? 'import re\n\nprint("build report")\n'
              : '# 新闻要点\n\n近端上下文正文',
            size: 100, modifiedAt: Date.now(),
          },
        });
      });
      await mockChatRun(page, { script: buildAbsRun(vault.path) });
      await gotoHome(page);
      await sendMessage(page, '归档');
      await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
      await page.locator('[data-testid="home-output-toggle"]').click();
      const panel = page.locator('[data-testid="session-output-panel"]');

      // ── 三层分流 ──
      // 主列表：3 篇库内文档，分「新建 1 / 更新 2」两段（清单一列到底会被读成全是新建）
      await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(3);
      await expect(panel.locator('[data-testid="session-output-section-creates"]')).toContainText('新建 1');
      await expect(panel.locator('[data-testid="session-output-section-updates"]')).toContainText('更新 2');
      await expect(panel.locator('[data-testid="session-output-stats"]')).toContainText('写入 3 · 1 轮');
      // kind 判据是「会话里该路径出现过没有」，不是工具名：新建的 Write → create；
      // Read 过的文档再用 Write 覆写 → update（用户报障的核心：一切 Write 都标成了新建）
      await expect(panel.locator(`[data-path=${JSON.stringify(newsAbs)}]`)).toHaveAttribute('data-kind', 'create');
      await expect(panel.locator(`[data-path=${JSON.stringify(deepAbs)}]`)).toHaveAttribute('data-kind', 'update');
      await expect(panel.locator(`[data-path=${JSON.stringify(reviewAbs)}]`)).toHaveAttribute('data-kind', 'update');
      // 折叠区（登记元文件 INDEX.md·log.md·hot.md + 脚本）默认收起：条目不进 DOM
      await expect(panel.locator('[data-testid="session-output-others-toggle"]')).toContainText('其他写入 4 项');
      await expect(panel.locator('[data-testid="session-output-others-toggle"]')).toContainText('索引·日志·脚本');
      await expect(panel.locator('[data-testid="session-output-other-item"]')).toHaveCount(0);
      // 隐藏目录与库外写入：任何一栏都不得出现
      await expect(panel.locator('[data-path*=".molio"]')).toHaveCount(0);
      await expect(panel.locator(`[data-path=${JSON.stringify(OUTSIDE_PATH)}]`)).toHaveCount(0);
      await expect(panel).not.toContainText('MEMORY.md');
      await expect(panel).not.toContainText('plan.md');

      // md 预览正常渲染（不是「无法读取」错误）
      await panel.locator(`[data-path=${JSON.stringify(newsAbs)}]`).click();
      await expect(panel.locator('[data-testid="session-output-preview"]')).toContainText('近端上下文正文', { timeout: 5_000 });
      await panel.locator('[data-testid="session-output-preview-back"]').click();

      // 展开折叠区 → 元文件与脚本出现（可追溯，但不占主列表）
      await panel.locator('[data-testid="session-output-others-toggle"]').click();
      await expect(panel.locator('[data-testid="session-output-other-item"]')).toHaveCount(4);
      const others = panel.locator('[data-testid="session-output-others"]');
      await expect(others).toContainText('build_report.py');
      await expect(others).toContainText('INDEX.md');
      await expect(others).toContainText('log.md');
      // hot.md 的 ./ 相对形态不产生第二行
      await expect(panel.locator(`[data-path=${JSON.stringify(hotAbs)}]`)).toHaveCount(1);
      await expect(panel.locator('[data-testid="session-output-write"]').filter({ hasText: 'hot.md' })).toHaveCount(0);

      // .py 脚本 → 等宽代码视图原文展示，不被 markdown 吞掉
      await panel.locator(`[data-path=${JSON.stringify(pyAbs)}]`).click();
      const codeView = panel.locator('.session-output-preview-code');
      await expect(codeView).toBeVisible({ timeout: 5_000 });
      await expect(codeView).toContainText('print("build report")');
      await panel.locator('[data-testid="session-output-preview-back"]').click();

      // ── 变更 tab：WorkBuddy 式两级 —— 文件概要行（±行数）默认全折叠，点击展开逐条 diff ──
      await panel.locator('[data-testid="session-output-tab-changes"]').click();
      // 只余 3 个产出文档分组：登记元文件（INDEX.md / log.md / hot.md）、脚本、隐藏目录、
      // 库外写入都不进变更序列 —— 用户不关心的文件在变更 tab 同样不该占位。
      await expect(panel.locator('[data-testid="session-output-change-group"]')).toHaveCount(3);
      const changesBody = panel.locator('[data-testid="session-output-changes"]');
      for (const absent of ['INDEX.md', 'hot.md', 'log.md', 'build_report.py']) {
        await expect(changesBody).not.toContainText(absent);
      }
      // 折叠态：不渲染任何 diff
      await expect(panel.locator('[data-testid="session-output-diff"]')).toHaveCount(0);
      // 更新过的产出文档概要：Edit(318→319) 各一行 → +1 −1
      const reviewFile = panel.locator('[data-testid="session-output-change-file"]', { hasText: '要闻综述.md' });
      await expect(reviewFile.locator('.is-add')).toHaveText('+1');
      await expect(reviewFile.locator('.is-del')).toHaveText('−1');
      // 点击展开 → 行级 diff 出现（−318 / +319）
      await reviewFile.click();
      const reviewGroup = panel.locator('[data-testid="session-output-change-group"]', { hasText: '要闻综述.md' });
      await expect(reviewGroup.locator('[data-testid="session-output-diff-del"]').first()).toContainText('318');
      await expect(reviewGroup.locator('[data-testid="session-output-diff-add"]').first()).toContainText('319');
      // 手风琴单开：展开新建的文档后上一组收起（− 行全消失，只剩这组的 +全文）
      await panel.locator('[data-testid="session-output-change-file"]', { hasText: '新闻要点.md' }).click();
      await expect(panel.locator('[data-testid="session-output-diff-del"]')).toHaveCount(0);
      const newsGroup = panel.locator('[data-testid="session-output-change-group"]', { hasText: '新闻要点.md' });
      await expect(newsGroup.locator('[data-testid="session-output-change"]')).toHaveCount(1);
      await expect(newsGroup.locator('[data-testid="session-output-change"]')).toContainText('新建文件');
      await expect(newsGroup.locator('[data-testid="session-output-diff-add"]').first()).toContainText('新闻要点');
      // 覆写既有文档的 Write（先 Read 过）→ update 且旧内容未记录 → 占位说明，不出伪 diff
      const deepGroup = panel.locator('[data-testid="session-output-change-group"]', { hasText: '深度报道.md' });
      await deepGroup.locator('[data-testid="session-output-change-file"]').click();
      await expect(deepGroup.locator('[data-testid="session-output-change"]')).toContainText('编辑');
      await expect(deepGroup.locator('[data-testid="session-output-diff"]')).toHaveCount(0);

      // 回到概览，写入列表恢复（折叠区保持展开）
      await panel.locator('[data-testid="session-output-tab-overview"]').click();
      await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(3);

      expect(sawEncoded).toBe(true);
      expect(sawRawSlash).toBe(false);
    } finally {
      await cleanupTempVault(vault);
    }
  });

  test('切换知识库 → 旧 vault 会话被重置（消息清空 + 产出面板空态）', async ({ page }) => {
    const vaultA = await createTempVault('e2e-reset-a');
    const vaultB = await createTempVault('e2e-reset-b');
    try {
      await page.addInitScript((id) => { localStorage.setItem('molio.activeVaultId', id); }, vaultA.id);
      await mockChatRun(page, { script: outputRun });
      await gotoHome(page);
      await sendMessage(page, '整理产出');
      await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
      // 先确认 vault A 上下文里有产出
      await page.locator('[data-testid="home-output-toggle"]').click();
      const panel = page.locator('[data-testid="session-output-panel"]');
      await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
      // 去知识库页，URL 驱动就地切 vault（KB 页 URL→store effect 触发 setActiveVaultId）
      await clickNav(page, 'knowledge');
      await expect(page.locator('.kb-vault-bar')).toBeVisible();
      // 等 URL→vaultStore 的切换真正生效（vault bar 换成 B）再回主页。旧实现靠
      // `vault-switch-notice` 出现来做这个同步；提示条已在 L2a 移除，改用 vault bar 名称。
      // 用 toPass 重试：SPA 下 pushState+popstate 驱动就地切库在整跑高负载时偶发不生效
      // （vault bar 仍停在 A），交替 URL 强制 searchParams 变化后重发即可收敛。
      await expect(async () => {
        await page.evaluate((vid) => {
          window.history.pushState({}, '', '/knowledge');
          window.dispatchEvent(new PopStateEvent('popstate'));
          window.history.pushState({}, '', `/knowledge?vault=${vid}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, vaultB.id);
        await expect(page.locator('.kb-vault-bar__name')).toHaveText(vaultB.name, { timeout: 1_500 });
      }).toPass({ timeout: 15_000 });
      // 回主页 → 旧会话已清空：标签保留、落在空的全屏 shell（不再是 landing），
      // 产出面板仍在（它是当前会话产出的视图，开关状态不随会话重置），但必须回空态。
      // （跨 vault 重置由 KbChatSessionController 按标签处理。）
      await gotoChatSpa(page);
      await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
      await expect(page.locator('.home-page.chat-active')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('[data-testid="session-output-empty"]')).toBeVisible({ timeout: 5_000 });
      // 关键回归判据：旧 vault 的写入项不得残留（空态断言本身不足以证明这一点）
      await expect(page.locator('[data-testid="session-output-write"]')).toHaveCount(0);
    } finally {
      await cleanupTempVault(vaultA);
      await cleanupTempVault(vaultB);
    }
  });
});

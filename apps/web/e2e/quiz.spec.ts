import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import { cleanupTempVault, createTempVault } from './helpers/cleanup';

/**
 * @area chat
 * @priority P0
 *
 * Quiz 交互块：模型输出 ```quiz 围栏 JSON 后，聊天内渲染成可作答的题卡。
 * 判分完全在前端完成，不依赖 runtime 工具调用。
 */

const VAULT_ID = 'vault-1';

// 1×1 透明 PNG —— 让 raw 路由 mock 返回真实可解码的图片字节，
// 断言 naturalWidth 才能证明「真的加载了」而不只是 src 对。
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 拦截 raw 文件请求并回一张真 PNG（模拟 daemon /raw/* 的行为）。 */
async function mockRawImage(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/knowledge/vaults/vault-1/raw/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
  });
}

const QUIZ_MARKDOWN = `我来出 3 道题，检验一下对材料的理解。

\`\`\`quiz
{
  "version": 1,
  "title": "番茄工作法 · 3 题",
  "questions": [
    {
      "id": "q1",
      "type": "single",
      "stem": "番茄工作法的标准专注时长是？",
      "options": [
        { "key": "A", "text": "15 分钟" },
        { "key": "B", "text": "25 分钟" },
        { "key": "C", "text": "45 分钟" }
      ],
      "answer": ["B"],
      "explanation": "标准番茄钟为 **25 分钟** 专注 + 5 分钟休息。",
      "sources": [{ "path": "notes/番茄工作法.md", "quote": "一个番茄钟为 25 分钟" }]
    },
    {
      "id": "q2",
      "type": "multiple",
      "stem": "下列哪些属于番茄工作法的规则？",
      "options": [
        { "key": "A", "text": "一个番茄钟不可分割" },
        { "key": "B", "text": "每 4 个番茄钟后长休息" },
        { "key": "C", "text": "可以边做边刷手机" }
      ],
      "answer": ["A", "B"],
      "explanation": "番茄钟不可分割；每 4 个番茄钟后安排一次长休息。",
      "sources": [{ "path": "notes/番茄工作法.md" }]
    },
    {
      "id": "q3",
      "type": "judge",
      "stem": "番茄钟中途被打断时，应重新开始计时。",
      "answer": ["B"],
      "explanation": "被打断的番茄钟应作废并重新开始，而不是继续计时。",
      "sources": [{ "path": "notes/番茄工作法.md" }]
    }
  ]
}
\`\`\``;

const SCRIPT = [
  { type: 'status', label: 'running' },
  { type: 'text_delta', delta: QUIZ_MARKDOWN },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 100, output_tokens: 80 }, costUsd: 0.01 },
];

/** 2 客观 + 1 subject 的混合围栏（subject: 无 options、answer=评分点数组）。 */
const MIXED_QUIZ = `我来出 3 道题。

\`\`\`quiz
{
  "version": 1,
  "title": "混合 · 3 题",
  "questions": [
    {
      "id": "q1",
      "type": "single",
      "stem": "标准番茄钟的专注时长是？",
      "options": [
        { "key": "A", "text": "15 分钟" },
        { "key": "B", "text": "25 分钟" }
      ],
      "answer": ["B"],
      "explanation": "标准番茄钟为 25 分钟专注。",
      "sources": [{ "path": "notes/番茄工作法.md" }]
    },
    {
      "id": "q2",
      "type": "judge",
      "stem": "番茄钟中途被打断时，应重新开始计时。",
      "answer": ["B"],
      "explanation": "被打断的番茄钟应作废。",
      "sources": [{ "path": "notes/番茄工作法.md" }]
    },
    {
      "id": "q3",
      "type": "subject",
      "stem": "证明：从 n 个不同元素中选 k 个的方法数满足帕斯卡法则。",
      "answer": ["写出帕斯卡法则 C(n,k)=C(n-1,k-1)+C(n-1,k)", "把选法按是否含第 n 个元素分成两类", "指出边界情形 C(n,0)=1"],
      "explanation": "按评分点逐步给分。",
      "sources": [{ "path": "notes/组合数.md" }]
    }
  ]
}
\`\`\``;

/** 纯 subject 围栏：没有任何可本地判分的题。 */
const SUBJECT_ONLY_QUIZ = `\`\`\`quiz
{
  "version": 1,
  "title": "解答 · 1 题",
  "questions": [
    {
      "id": "s1",
      "type": "subject",
      "stem": "论述二项式定理的组合意义。",
      "answer": ["指出定理左端是选 k 个元素的计数", "说明右端按「是否含某特定元素」分类求和"],
      "explanation": "按评分点给分。",
      "sources": [{ "path": "notes/二项式定理.md" }]
    }
  ]
}
\`\`\``;

test.describe('Quiz interaction block', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((vid) => {
      try { localStorage.setItem('molio.activeVaultId', vid); } catch { /* ignore */ }
    }, VAULT_ID);

    await page.route('**/api/knowledge/vaults', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          vaults: [{ id: VAULT_ID, name: 'Test Vault', path: '/tmp/vault', createdAt: 0, updatedAt: 0 }],
        }),
      });
    });

    await page.route('**/api/knowledge/active-vault', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ vaultId: VAULT_ID, vault: null }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    });

    await page.route('**/api/knowledge/vaults/vault-1/resolve/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: 'notes/番茄工作法.md' }),
      });
    });

    // 默认把答题落库挡在浏览器里：否则 E2E 会写进开发者的真实数据库。
    await page.route('**/api/quiz/attempts', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, inserted: 0 }),
      });
    });
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
    await page.unroute('**/api/knowledge/vaults');
    await page.unroute('**/api/knowledge/active-vault');
    await page.unroute('**/api/knowledge/vaults/vault-1/resolve/**');
    await page.unroute('**/api/quiz/attempts');
  });

  test('renders questions, options and enables submit once at least one question is answered', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('[data-testid="quiz-title"]')).toHaveText('番茄工作法 · 3 题');
    await expect(card.locator('[data-testid="quiz-question"]')).toHaveCount(3);

    // 整卷表单门槛：≥1 题已答即可交（可交白卷的对称面）；按钮文案统一「提交判卷」。
    const submit = card.locator('[data-testid="quiz-submit"]');
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveText('提交判卷');
    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]').click();
    await expect(submit).toBeEnabled();
  });

  test('grades all three types and shows answer, explanation and sources', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]').click();

    await page.unroute('**/api/quiz/attempts');
    let attemptBody: any = null;
    await page.route('**/api/quiz/attempts', async (route) => {
      attemptBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, inserted: 3 }),
      });
    });

    await card.locator('[data-testid="quiz-submit"]').click();

    await expect.poll(() => attemptBody?.attempts?.length).toBe(3);
    expect(attemptBody.quizFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(attemptBody.conversationId).toBe('conv-1');
    expect(attemptBody.attempts[0]).toMatchObject({
      questionId: 'q1', chosen: ['B'], correct: true,
    });

    const results = card.locator('[data-testid="quiz-result"]');
    await expect(results).toHaveCount(3);
    await expect(results.nth(0)).toHaveAttribute('data-correct', 'true');
    await expect(results.nth(1)).toHaveAttribute('data-correct', 'true');
    await expect(results.nth(2)).toHaveAttribute('data-correct', 'true');

    await expect(card.locator('[data-testid="quiz-explanation"]')).toHaveCount(3);
    await expect(card.locator('[data-testid="quiz-explanation"]').first()).toContainText('25 分钟');
    await expect(card.locator('[data-testid="quiz-source"]').first()).toContainText('notes/番茄工作法.md');

    // 出处链接走既有 wikilink 导航。
    await card.locator('[data-testid="quiz-source"]').first().click();
    await expect(page).toHaveURL(/\/knowledge/);
  });

  test('marks a wrong single answer and highlights the correct option', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-submit"]').click();

    await expect(card.locator('[data-testid="quiz-result"]').nth(0)).toHaveAttribute('data-correct', 'false');
    await expect(
      card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]'),
    ).toHaveClass(/correct/);
    await expect(
      card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="A"]'),
    ).toHaveClass(/wrong/);
  });

  test('marks picked options and shows your answer after submitting', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 多选题故意错答：选 A（对）和 C（错），漏掉答案里的 B——复现「颜色只能看出
    // 对错、看不出自己当时选了哪些」：✓ 标记（data-picked）只表达「选没选」，
    // 绿/红颜色只表达「对不对」，两条信息解耦后四种状态一目了然。
    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="C"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-submit"]').click();

    // 选中标记：选过的一律 data-picked=true（含选错的 C）；漏选的 B 不得标。
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="A"]')).toHaveAttribute('data-picked', 'true');
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]')).toHaveAttribute('data-picked', 'true');
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="C"]')).toHaveAttribute('data-picked', 'true');
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]')).toHaveAttribute('data-picked', 'false');
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]')).toHaveAttribute('data-picked', 'true');

    // 标记形状承载结果（真机反馈：错选挂 ✓ 会被对勾的固有含义误读成「正确」）：
    // data-mark ✓＝选对、✗＝选错、无属性＝没选。与picked的解耦语义一致：
    // 有标（✓或✗）＝选了，形状+颜色只管结果。
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="A"]')).toHaveAttribute('data-mark', '✗');
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]')).toHaveAttribute('data-mark', '✓');
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="C"]')).toHaveAttribute('data-mark', '✗');
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]')).not.toHaveAttribute('data-mark', /.+/);
    await expect(card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]')).toHaveAttribute('data-mark', '✓');

    // 「你的答案」行：客观题逐题显示，选项按字母序（与判分归一化同源、与「正确答案」同格式）。
    const yourAnswers = card.locator('[data-testid="quiz-your-answer"]');
    await expect(yourAnswers).toHaveCount(3);
    await expect(yourAnswers.nth(0)).toContainText('A');
    await expect(yourAnswers.nth(1)).toContainText('A / C');
    await expect(yourAnswers.nth(2)).toContainText('B');
  });

  test('shows a generating placeholder while the quiz fence is still streaming', async ({ page }) => {
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      // 每帧 800ms：未闭合围栏从第一帧一直持续到 turn_end，窗口约 2.4s。
      // 不要调到几百毫秒以下——断言 SSE 中间帧是已知 flake 源。
      frameDelay: 800,
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: '我在出题。\n```quiz\n{"version":1,' },
        { type: 'text_delta', delta: '"title":"练习","questions":[' },
        { type: 'text_delta', delta: ']}' },
        { type: 'turn_end', stopReason: 'end_turn' },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    await expect(page.locator('[data-testid="quiz-generating"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="quiz-card"]')).toHaveCount(0);
  });

  test('falls back to a code block when the JSON is invalid', async ({ page }) => {
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: '题目如下：\n```quiz\n{not json}\n```' },
        { type: 'turn_end', stopReason: 'end_turn' },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const invalid = page.locator('[data-testid="quiz-invalid"]');
    await expect(invalid).toBeVisible({ timeout: 10_000 });
    await expect(invalid).toContainText('格式');
    await expect(invalid.locator('pre')).toContainText('{not json}');
  });

  test('keeps two quiz blocks in one message independent', async ({ page }) => {
    const second = `\n\n\`\`\`quiz
{
  "version": 1,
  "title": "第二组",
  "questions": [{
    "id": "s1",
    "type": "single",
    "stem": "第二组的题",
    "options": [{ "key": "A", "text": "甲" }, { "key": "B", "text": "乙" }],
    "answer": ["A"],
    "explanation": "解析。",
    "sources": [{ "path": "notes/番茄工作法.md" }]
  }]
}
\`\`\``;

    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: QUIZ_MARKDOWN + second },
        { type: 'turn_end', stopReason: 'end_turn' },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '出两组题');

    const cards = page.locator('[data-testid="quiz-card"]');
    await expect(cards).toHaveCount(2, { timeout: 10_000 });

    await cards.nth(0).locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="A"]').click();
    await cards.nth(1).locator('[data-testid="quiz-option"][data-question-id="s1"][data-key="B"]').click();

    await expect(cards.nth(0).locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="A"]')).toHaveClass(/on/);
    await expect(cards.nth(1).locator('[data-testid="quiz-option"][data-question-id="s1"][data-key="B"]')).toHaveClass(/on/);
    await expect(cards.nth(0).locator('[data-testid="quiz-option"][data-question-id="s1"]')).toHaveCount(0);
  });

  test('does not leak the subject state to another card with the same question id', async ({ page }) => {
    // 多卡隔离：A 卡草稿交卷后，B 卡（同有题号 q3 的解答题）不得出现状态
    // 徽标 / 得分徽标 / 回显，也不得把 A 卡的作答算进自己的进度。
    // 键 = 指纹:题号，两卡内容不同 → 指纹不同 → 互不串。
    const second = `\n\n\`\`\`quiz
{
  "version": 1,
  "title": "第二组",
  "questions": [
    {
      "id": "q3",
      "type": "subject",
      "stem": "证明：第二组的题目（与第一组题号相同、内容不同）。",
      "answer": ["写出第二组的评分点", "补上边界情形"],
      "explanation": "按评分点逐步给分。",
      "sources": [{ "path": "notes/组合数.md" }]
    }
  ]
}
\`\`\``;

    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: MIXED_QUIZ + second },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'status', label: 'completed' },
      ],
    });
    await mockSecondTurn(page, '【批改·第3题】得分 1/2\n1. 命中｜第一组答对了');
    await gotoHome(page);
    await sendMessage(page, '出两组题');

    const cards = page.locator('[data-testid="quiz-card"]');
    await expect(cards).toHaveCount(2, { timeout: 10_000 });

    // 在第一张卡草稿并交卷（客观题全空 → 走未答完确认条）。
    await cards.nth(0).locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('第一组的作答');
    await cards.nth(0).locator('[data-testid="quiz-submit"]').click();
    await cards.nth(0).locator('[data-testid="quiz-confirm-submit"]').click();
    await expect(cards.nth(0).locator('[data-testid="quiz-subject-score"]')).toHaveText('1/2');

    // 第二张卡：无徽标、无得分、无回显，进度仍是 0（它自己没答）。
    await expect(cards.nth(1).locator('[data-testid="quiz-subject-status"]')).toHaveCount(0);
    await expect(cards.nth(1).locator('[data-testid="quiz-subject-score"]')).toHaveCount(0);
    await expect(cards.nth(1).locator('[data-testid="quiz-subject-echo"]')).toHaveCount(0);
    await expect(cards.nth(1).locator('[data-testid="quiz-progress"]')).toHaveText('已作答 0/1');

    // 第一张卡：进度含解答题（客观题 2 道 + 解答题 1 道 = 3 道）。
    await expect(cards.nth(0).locator('[data-testid="quiz-progress"]')).toHaveText('已作答 1/3');

    await page.unroute('**/api/runs');
    await page.unroute('**/api/runs/run-2/events**');
  });

  test('writes the local answer state under a conversation+fingerprint key', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-submit"]').click();

    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((item) => item.startsWith('molio.quiz.conv-1.'));
      return key ? { key, value: localStorage.getItem(key) } : null;
    });
    expect(stored).not.toBeNull();
    expect(stored!.key).toMatch(/^molio\.quiz\.conv-1\.[0-9a-f]{64}$/);
    expect(JSON.parse(stored!.value!)).toMatchObject({ submitted: true, selections: { q1: ['B'] } });
  });

  test('renders the quiz card even when the fence precedes the last tool call', async ({ page }) => {
    // 回归：splitMessageParts 把最后一个工具之前的文本归入过程叙事，WorkBlock
    // 会剥掉闭合 quiz 围栏 —— 若 Fence 后还有工具调用，题卡在活动会话里消失，
    // 直到整页刷新（历史重载）才回来。
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: QUIZ_MARKDOWN },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'notes/番茄工作法.md' } },
        { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
        { type: 'text_delta', delta: '以上就是题目。' },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'usage', usage: { input_tokens: 100, output_tokens: 80 }, costUsd: 0.01 },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const cards = page.locator('[data-testid="quiz-card"]');
    await expect(cards).toHaveCount(1, { timeout: 10_000 });
    await expect(cards.locator('[data-testid="quiz-title"]')).toHaveText('番茄工作法 · 3 题');
    await expect(page.locator('[data-testid="quiz-generating"]')).toHaveCount(0);
  });

  test('saves the quiz as a markdown file inside 题库/', async ({ page }) => {
    let savedUrl: string | null = null;
    let savedBody: { content?: string } | null = null;

    await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
        });
        return;
      }
      if (request.method() === 'POST') {
        savedUrl = decodeURIComponent(request.url());
        savedBody = JSON.parse(request.postData() || '{}');
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    // 没作答没交卷 → 没有错题 → 默认范围是「全部」。
    await card.locator('[data-testid="quiz-save-kb"]').click();
    await expect(card.locator('[data-testid="quiz-save-panel"]')).toBeVisible();
    await expect(card.locator('[data-testid="quiz-save-target"]')).toBeVisible();
    await expect(card.locator('[data-testid="quiz-save-confirm"]')).toHaveText('保存 3 题');
    await card.locator('[data-testid="quiz-save-confirm"]').click();

    await expect(card.locator('[data-testid="quiz-save-result"]')).toBeVisible();
    await expect.poll(() => savedUrl).not.toBeNull();
    expect(savedUrl!).toContain('/题库/');
    expect(savedUrl!.endsWith('.md')).toBe(true);
    // 文件是人读 markdown + 结构化 frontmatter，不再回写 ```quiz 围栏。
    expect(savedBody?.content).toContain('quiz_fingerprint:');
    expect(savedBody?.content).toContain('quiz_title: "番茄工作法 · 3 题"');
    expect(savedBody?.content).toContain('## 第 1 题');
    expect(savedBody?.content).not.toContain('```quiz');

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });

  test('defaults to saving only the wrong questions', async ({ page }) => {
    let savedBody: { content?: string } | null = null;
    await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
        });
        return;
      }
      if (request.method() === 'POST') savedBody = JSON.parse(request.postData() || '{}');
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    // 第 1 题答错（正确答案 B），第 2、3 题答对。
    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-submit"]').click();

    await card.locator('[data-testid="quiz-save-kb"]').click();
    await expect(card.locator('[data-testid="quiz-scope-wrong"]')).toHaveAttribute('aria-checked', 'true');
    await expect(card.locator('[data-testid="quiz-save-confirm"]')).toHaveText('保存 1 题');
    await card.locator('[data-testid="quiz-save-confirm"]').click();

    await expect.poll(() => savedBody).not.toBeNull();
    expect(savedBody?.content).toContain('quiz_saved_questions: 1');
    expect(savedBody?.content).toContain('**你的答案**：A ✗');
    expect(savedBody?.content).not.toContain('## 第 2 题');

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });

  test('two rapid confirm clicks write one file', async ({ page }) => {
    let postCount = 0;
    await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
        });
        return;
      }
      if (request.method() === 'POST') {
        postCount += 1;
        // 写盘留出窗口：否则第一次点击成功后按钮已卸载，测不到竞态。
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-save-kb"]').click();
    await card.locator('[data-testid="quiz-save-confirm"]').dblclick();

    await expect.poll(() => postCount).toBe(1);

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });

  test('saved result can undo the write', async ({ page }) => {
    let deletedUrl: string | null = null;
    await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
        });
        return;
      }
      if (request.method() === 'DELETE') deletedUrl = decodeURIComponent(request.url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-save-kb"]').click();
    await card.locator('[data-testid="quiz-save-confirm"]').click();

    const result = card.locator('[data-testid="quiz-save-result"]');
    await expect(result).toContainText('已存 3 题');
    await expect(result).toContainText('题库/');
    // 浏览器环境下没有「在资源管理器中显示」——桌面壳专属能力
    await expect(card.locator('[data-testid="quiz-save-reveal"]')).toHaveCount(0);

    await card.locator('[data-testid="quiz-save-undo"]').click();
    await expect.poll(() => deletedUrl).not.toBeNull();
    expect(deletedUrl!).toContain('/题库/');
    await expect(card.locator('[data-testid="quiz-save-result"]')).toHaveCount(0);

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });

  test('saved result actions collapse after the 6s window, leaving the path', async ({ page }) => {
    await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-save-kb"]').click();
    await card.locator('[data-testid="quiz-save-confirm"]').click();

    const result = card.locator('[data-testid="quiz-save-result"]');
    await expect(result).toContainText('已存 3 题');
    await expect(card.locator('[data-testid="quiz-save-open"]')).toBeVisible();

    // 反馈窗 6s（与 SaveToKbButton 一致）：动作收起，只留一行静态路径。
    await expect(card.locator('[data-testid="quiz-save-open"]')).toHaveCount(0, { timeout: 8_000 });
    await expect(card.locator('[data-testid="quiz-save-undo"]')).toHaveCount(0);
    await expect(result).toContainText('已存 3 题');
    await expect(result).toContainText('题库/');

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });

  test('saved result opens the file in the knowledge base', async ({ page }) => {
    // 写盘前的探测必须 404（否则 saveQuizToVault 判定为「同名文件已存在/不可写」而中止），
    // 写盘之后再读文件才返回内容 —— KB 页打开这份文件时才会渲染出正文。
    let savedPath = '';
    await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
      const request = route.request();
      const path = decodeURIComponent(new URL(request.url()).pathname.split('/files/')[1] ?? '');
      if (request.method() === 'GET') {
        if (!savedPath) {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ path, content: '# 题库正文\n\n已保存的题。', size: 20, modifiedAt: 0 }),
        });
        return;
      }
      savedPath = path;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    // KB 页在 treeVaultId 就绪且树非空时才处理 location.state.openFile：树里必须有刚写的文件。
    await page.route('**/api/knowledge/vaults/vault-1/tree', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tree: savedPath
            ? [{
              name: '题库',
              path: '题库',
              type: 'directory',
              children: [{ name: savedPath.split('/').pop(), path: savedPath, type: 'file' }],
            }]
            : [],
        }),
      });
    });
    // beforeEach 的 resolve mock 恒返回 notes/番茄工作法.md，会把这题的开档重定向到别处。
    await page.route('**/api/knowledge/vaults/vault-1/resolve/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: savedPath }),
      });
    });

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-save-kb"]').click();
    await card.locator('[data-testid="quiz-save-confirm"]').click();
    await expect(card.locator('[data-testid="quiz-save-result"]')).toBeVisible();

    await card.locator('[data-testid="quiz-save-open"]').click();
    await page.waitForURL(/\/knowledge/);
    // KB 页消费 location.state.openFile 打开目标文件：文档区渲染出文件内容
    await expect(page.locator('#output')).toContainText('题库正文', { timeout: 10_000 });

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
    await page.unroute('**/api/knowledge/vaults/vault-1/tree');
    await page.unroute('**/api/knowledge/vaults/vault-1/resolve/**');
  });

  test('saves into the conversation vault, not the active vault', async ({ page }) => {
    // 跨库回归：活动库 ≠ 会话所属库时，题库文件必须落进会话那一侧
    //（对话是从某个库里开的，题也是那个库的材料出的）。
    const other = await createTempVault('e2e-quiz-target');
    try {
      await page.route('**/api/knowledge/vaults', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            vaults: [
              { id: VAULT_ID, name: 'Test Vault', path: '/tmp/vault', createdAt: 0, updatedAt: 0 },
              { id: other.id, name: other.name, path: other.path, createdAt: 0, updatedAt: 0 },
            ],
          }),
        });
      });
      await page.route(/\/api\/conversations\/conv-1(\?.*)?$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'conv-1', projectId: 'p', title: null, vaultId: other.id, createdAt: 0, updatedAt: 0,
          }),
        });
      });
      let savedToConversationVault: string | null = null;
      let savedToActiveVault: string | null = null;
      await page.route(`**/api/knowledge/vaults/${other.id}/files/**`, async (route) => {
        const request = route.request();
        if (request.method() === 'GET') {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
          });
          return;
        }
        savedToConversationVault = decodeURIComponent(request.url());
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
        const request = route.request();
        if (request.method() === 'GET') {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
          });
          return;
        }
        savedToActiveVault = decodeURIComponent(request.url());
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
      await gotoHome(page);
      await sendMessage(page, '出几道题');

      const card = page.locator('[data-testid="quiz-card"]');
      await expect(card).toBeVisible({ timeout: 10_000 });
      await card.locator('[data-testid="quiz-save-kb"]').click();
      // 保存目标显示会话库名，而不是活动库名
      await expect(card.locator('[data-testid="quiz-save-target"]')).toContainText('e2e-quiz-target');
      await card.locator('[data-testid="quiz-save-confirm"]').click();

      await expect.poll(() => savedToConversationVault).not.toBeNull();
      expect(savedToConversationVault!).toContain(other.id);
      expect(savedToActiveVault).toBeNull();
    } finally {
      await cleanupTempVault(other);
    }
  });

  for (const path of ['explicit', 'system'] as const) {
    test(`save panel follows the dark theme (${path})`, async ({ page }) => {
      if (path === 'explicit') {
        // 用户在设置里显式选了深色：html[data-theme="dark"]
        await page.addInitScript(() => {
          try { localStorage.setItem('molio.theme', 'dark'); } catch { /* ignore */ }
        });
      } else {
        // 跟随系统：不写 data-theme，靠 prefers-color-scheme
        await page.emulateMedia({ colorScheme: 'dark' });
      }

      await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
      await gotoHome(page);
      await sendMessage(page, '出几道题');

      const card = page.locator('[data-testid="quiz-card"]');
      await expect(card).toBeVisible({ timeout: 10_000 });
      await card.locator('[data-testid="quiz-save-kb"]').click();

      const panel = card.locator('[data-testid="quiz-save-panel"]');
      await expect(panel).toBeVisible();
      // 面板走 token：深色下表面是 --bg（#181816），说明文字是 --text-muted（#a8a6a0）
      expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(24, 24, 22)');
      expect(
        await card.locator('[data-testid="quiz-save-target"]').evaluate((el) => getComputedStyle(el).color),
      ).toBe('rgb(168, 166, 160)');

      // 选中语义在深色下同样生效（aria-checked 驱动的高亮，不靠写死颜色）
      await expect(card.locator('[data-testid="quiz-scope-all"]')).toHaveAttribute('aria-checked', 'true');
      await card.locator('[data-testid="quiz-scope-pick"]').click();
      await expect(card.locator('[data-testid="quiz-scope-pick"]')).toHaveAttribute('aria-checked', 'true');
      await expect(card.locator('[data-testid="quiz-save-list"]')).toBeVisible();
    });
  }

  test('renders markdown in stem and options (image, bold, blank marker)', async ({ page }) => {
    // 题干/选项走受控 markdown：图片语法出 <img>、加粗出 <strong>；
    // `____` 空位标记不得被强调语法吃掉（renderMarkdown 只认 `*`）。
    const markdownQuiz = `\`\`\`quiz
{
  "version": 1,
  "title": "markdown 渲染 · 1 题",
  "questions": [
    {
      "id": "m1",
      "type": "single",
      "stem": "如图 ![温度计](raw/thermometer.png) 所示，标准番茄钟专注 **25 分钟**，即____。",
      "options": [
        { "key": "A", "text": "**25 分钟**" },
        { "key": "B", "text": "45 分钟" }
      ],
      "answer": ["A"],
      "explanation": "解析。",
      "sources": [{ "path": "notes/番茄工作法.md" }]
    }
  ]
}
\`\`\``;
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: markdownQuiz },
        { type: 'turn_end', stopReason: 'end_turn' },
      ],
    });
    await mockRawImage(page);
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    const stem = card.locator('[data-testid="quiz-stem"]');
    // 库内相对路径被改写成 daemon raw URL 且真实加载（KB 查看器同款规则）。
    await expect(stem.locator('img')).toHaveAttribute(
      'src',
      /\/api\/knowledge\/vaults\/vault-1\/raw\/raw%2Fthermometer\.png$/,
    );
    await expect(stem.locator('img')).toHaveJSProperty('naturalWidth', 1);
    await expect(stem.locator('strong')).toHaveText('25 分钟');
    await expect(stem).toContainText('____');

    await expect(
      card.locator('[data-testid="quiz-option"][data-key="A"] .quiz-option-text strong'),
    ).toHaveText('25 分钟');
  });

  test('rewrites chat prose images to loadable raw URLs', async ({ page }) => {
    // 助手正文里的 ![alt](库相对路径) 同样走改写——聊天里模型贴的库内图片能直接看。
    const markdown = `先看示意图：\n\n![质心示意图](图/质心.png)\n\n图中红点即质心位置。`;
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: markdown },
        { type: 'turn_end', stopReason: 'end_turn' },
      ],
    });
    await mockRawImage(page);
    await gotoHome(page);
    await sendMessage(page, '给我画个图');

    const prose = page.locator('[data-testid="assistant-prose"]');
    const img = prose.locator('img');
    await expect(img).toHaveAttribute(
      'src',
      /\/api\/knowledge\/vaults\/vault-1\/raw\/%E5%9B%BE%2F%E8%B4%A8%E5%BF%83\.png$/,
    );
    await expect(img).toHaveJSProperty('naturalWidth', 1);
    await expect(prose).toContainText('图中红点即质心位置');
  });

  test('supports fill-in-blank: submit disabled until text, normalized match, reference answer on wrong', async ({ page }) => {
    const fillQuiz = `\`\`\`quiz
{
  "version": 1,
  "title": "填空 · 1 题",
  "questions": [
    {
      "id": "f1",
      "type": "fill",
      "stem": "标准番茄钟的专注时长为____分钟。",
      "answer": ["25", "二十五"],
      "explanation": "一个番茄钟为 25 分钟。",
      "sources": [{ "path": "notes/番茄工作法.md" }]
    }
  ]
}
\`\`\``;
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: fillQuiz },
      { type: 'turn_end', stopReason: 'end_turn' },
    ] });
    await gotoHome(page);
    await sendMessage(page, '出几道填空题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('[data-testid="quiz-type"]')).toHaveText('填空');

    const input = card.locator('[data-testid="quiz-fill-input"]');
    const submit = card.locator('[data-testid="quiz-submit"]');
    await expect(submit).toBeDisabled();

    // 正确：输入原文带首尾空格 → 规范化判分对，落库保留用户原文。
    await input.fill(' 25 ');
    await expect(submit).toBeEnabled();
    await page.unroute('**/api/quiz/attempts');
    let attemptBody: any = null;
    await page.route('**/api/quiz/attempts', async (route) => {
      attemptBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, inserted: 1 }),
      });
    });
    await submit.click();
    await expect.poll(() => attemptBody?.attempts?.length).toBe(1);
    expect(attemptBody.attempts[0]).toMatchObject({
      questionId: 'f1', chosen: [' 25 '], correct: true,
    });
    await expect(card.locator('[data-testid="quiz-result"]')).toHaveAttribute('data-correct', 'true');

    // 重做后答错：显示参考答案（全部可接受写法）与解析。
    await card.locator('[data-testid="quiz-redo"]').click();
    await input.fill('二十四');
    await submit.click();
    await expect(card.locator('[data-testid="quiz-result"]').locator('nth=0')).toHaveAttribute('data-correct', 'false');
    await expect(card.locator('[data-testid="quiz-answer"]')).toHaveText('正确答案：25 / 二十五');
    // 填空不显示「你的答案」行：作答原文留在上方输入框里可见，再印一行是重复。
    await expect(card.locator('[data-testid="quiz-your-answer"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="quiz-explanation"]')).toContainText('25 分钟');
  });

  test('offers a summoned symbol tray per fill question and folds ascii notation', async ({ page }) => {
    const symbolQuiz = `\`\`\`quiz
{
  "version": 1,
  "title": "填空 · 符号 2 题",
  "questions": [
    {
      "id": "sy1",
      "type": "fill",
      "stem": "求值：cos²(π/8) − sin²(π/8) = ____。",
      "answer": ["√2/2", "sqrt2/2"],
      "explanation": "逆用二倍角公式得 cos(π/4)。",
      "sources": [{ "path": "notes/番茄工作法.md" }]
    },
    {
      "id": "sy2",
      "type": "fill",
      "stem": "特殊角 tan(π/4) = ____。",
      "answer": ["π/4"],
      "explanation": "45° 正切。",
      "sources": [{ "path": "notes/番茄工作法.md" }]
    }
  ]
}
\`\`\``;
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: symbolQuiz },
      { type: 'turn_end', stopReason: 'end_turn' },
    ] });
    await gotoHome(page);
    await sendMessage(page, '出几道填空题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    const inputs = card.locator('[data-testid="quiz-fill-input"]');

    // 默认零占用：托盘要点「符号」才出现。
    await expect(card.locator('[data-testid="quiz-symbol-tray"]')).toHaveCount(0);
    await card.locator('[data-testid="quiz-symbol-trigger"]').nth(0).click();

    const sy1Tray = card.locator('[data-fill-scope="sy1"] [data-testid="quiz-symbol-tray"]');
    await expect(sy1Tray).toBeVisible();
    await expect(sy1Tray.locator('[data-testid="quiz-symbol-btn"][data-char="√"]')).toBeVisible();

    // 点符号插入，托盘保持打开（连续插入多个符号）。
    await sy1Tray.locator('[data-testid="quiz-symbol-btn"][data-char="√"]').click();
    await expect(inputs.nth(0)).toHaveValue('√');
    await expect(sy1Tray).toBeVisible();

    // 直接切第 2 题：第 1 题托盘关、第 2 题开（一次只开一个）。
    await card.locator('[data-testid="quiz-symbol-trigger"]').nth(1).click();
    await expect(sy1Tray).toHaveCount(0);
    await expect(card.locator('[data-fill-scope="sy2"] [data-testid="quiz-symbol-tray"]')).toHaveCount(1);

    // 点外部关闭。
    await card.locator('[data-testid="quiz-title"]').click();
    await expect(card.locator('[data-testid="quiz-symbol-tray"]')).toHaveCount(0);

    await inputs.nth(0).fill('√2/2');

    // 记法折叠：键盘顺手写法 pi/4 判对 π/4。
    await inputs.nth(1).fill('pi/4');

    await page.unroute('**/api/quiz/attempts');
    let attemptBody: any = null;
    await page.route('**/api/quiz/attempts', async (route) => {
      attemptBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, inserted: 2 }),
      });
    });
    await card.locator('[data-testid="quiz-submit"]').click();

    await expect.poll(() => attemptBody?.attempts?.length).toBe(2);
    expect(attemptBody.attempts[0]).toMatchObject({
      questionId: 'sy1', chosen: ['√2/2'], correct: true,
    });
    // 落库保留用户原文 pi/4，判分按折叠等价。
    expect(attemptBody.attempts[1]).toMatchObject({
      questionId: 'sy2', chosen: ['pi/4'], correct: true,
    });
    const results = card.locator('[data-testid="quiz-result"]');
    await expect(results.nth(0)).toHaveAttribute('data-correct', 'true');
    await expect(results.nth(1)).toHaveAttribute('data-correct', 'true');
  });

  test('renders a subject answer area in the card and counts drafts into progress', async ({ page }) => {
    // M1 表单语义：作答区在卡内（textarea + 符号 + 插图），composer 不参与；
    // 非空草稿计入进度（口径 = 整张卷子）；解答题不进本地判分批次。
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: MIXED_QUIZ },
      { type: 'turn_end', stopReason: 'end_turn' },
    ] });
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('[data-testid="quiz-question"]')).toHaveCount(3);

    const subjectRow = card.locator('[data-testid="quiz-question"][data-question-id="q3"]');
    await expect(subjectRow.locator('[data-testid="quiz-type"]')).toHaveText('解答题');
    await expect(subjectRow.locator('[data-testid="quiz-subject-input"]')).toBeVisible();
    await expect(subjectRow.locator('[data-testid="quiz-option"]')).toHaveCount(0);
    await expect(subjectRow.locator('[data-testid="quiz-fill-input"]')).toHaveCount(0);
    // 锚时代的「作答」按钮已退役。
    await expect(card.locator('[data-testid="quiz-answer-btn"]')).toHaveCount(0);

    // 符号托盘：卡内唤起，插入 textarea（无 64 上限——那是填空/daemon chosen 契约）。
    await subjectRow.locator('[data-testid="quiz-subject-symbol"]').click();
    await expect(subjectRow.locator('[data-testid="quiz-subject-symbol-tray"]')).toBeVisible();
    await subjectRow.locator('[data-testid="quiz-symbol-btn"][data-char="√"]').click();
    await expect(subjectRow.locator('[data-testid="quiz-subject-input"]')).toHaveValue('√');
    // 非空草稿计入进度（整卷口径 3 题）：插入一个符号就算已答。
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 1/3');
    // 清空文本 → 回到未答；再输入正文 → 又算已答。
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('');
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 0/3');
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('证明过程……');
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 1/3');
  });

  test('subject-only quiz renders a submit button gated on drafts', async ({ page }) => {
    // 纯 subject 卷也有「提交判卷」（旧版无提交区的特例消失）：0 草稿禁用，
    // 草稿即解锁；进度口径 = 整张卷子。
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: SUBJECT_ONLY_QUIZ },
      { type: 'turn_end', stopReason: 'end_turn' },
    ] });
    await gotoHome(page);
    await sendMessage(page, '出一道解答题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('[data-testid="quiz-question"]')).toHaveCount(1);
    const submit = card.locator('[data-testid="quiz-submit"]');
    await expect(submit).toBeDisabled();
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 0/1');
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="s1"]').fill('论述……');
    await expect(submit).toBeEnabled();
  });

  test('submitting the paper materializes one message and leaves the composer alone', async ({ page }) => {
    // 整卷一次提交：交卷 = 一条消息（首行给人读 + 每题作答块），composer
    // 全程不参与（输入框不收作答，也没有锚 chip）。
    let sentMessage: string | null = null;
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: MIXED_QUIZ },
      { type: 'turn_end', stopReason: 'end_turn' },
    ] });
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') {
        sentMessage = (JSON.parse(route.request().postData() || '{}') as { message?: string }).message ?? null;
      }
      await route.fallback();
    });
    await page.route('**/api/runs/*/messages', async (route) => {
      if (route.request().method() === 'POST') {
        sentMessage = (JSON.parse(route.request().postData() || '{}') as { message?: string }).message ?? null;
      }
      await route.fallback();
    });
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 全卷答完（客观 2 + 解答草稿 1）→ 直接放行，无确认条。
    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('我的解答过程：由帕斯卡法则……');
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 3/3');
    await card.locator('[data-testid="quiz-submit"]').click();
    await expect(card.locator('[data-testid="quiz-submit-confirm"]')).toHaveCount(0);

    await expect.poll(() => sentMessage).not.toBeNull();
    const msg = sentMessage!;
    expect(msg.startsWith('提交判卷：《混合 · 3 题》')).toBe(true);
    expect(msg).toContain('【大题作答·第3题】');
    expect(msg).toContain('题干：证明：从 n 个不同元素中选 k 个的方法数满足帕斯卡法则。');
    expect(msg).toContain('1. 写出帕斯卡法则 C(n,k)=C(n-1,k-1)+C(n-1,k)');
    expect(msg).toContain('出处：notes/组合数.md');
    expect(msg).toContain('题目指纹：');
    expect(msg).toContain('我的解答过程：由帕斯卡法则……');

    // composer 未参与：输入框仍是空的，锚 chip 不存在。
    await expect(page.locator('[data-testid="composer-input"]')).toHaveValue('');
    await expect(page.locator('[data-testid="composer-anchor-chip"]')).toHaveCount(0);
    // 交卷后本地客观题揭晓 + 作答区换只读回显。
    await expect(card.locator('[data-testid="quiz-result"]')).toHaveCount(2);
    await expect(card.locator('[data-testid="quiz-subject-echo"]')).toContainText('我的解答过程');
    // 客观题落库照旧（2 道客观题）。
    await page.unroute('**/api/runs');
    await page.unroute('**/api/runs/*/messages');
  });

  test('fill symbol insert refuses beyond the 64-char limit', async ({ page }) => {
    // 64 上限是 daemon chosen 契约：符号插入必须拒绝（绝不截断——静默截断
    // 会毁掉答案），输入框红一下反馈。
    const fillQuiz = `\`\`\`quiz
{
  "version": 1,
  "title": "填空 · clamp",
  "questions": [{
    "id": "c1",
    "type": "fill",
    "stem": "求值：____。",
    "answer": ["√2"],
    "explanation": "解析。",
    "sources": [{ "path": "notes/番茄工作法.md" }]
  }]
}
\`\`\``;
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: fillQuiz },
      { type: 'turn_end', stopReason: 'end_turn' },
    ] });
    await gotoHome(page);
    await sendMessage(page, '出填空题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-symbol-trigger"]').click();

    const input = card.locator('[data-testid="quiz-fill-input"]');
    await input.fill('a'.repeat(64));
    await card.locator('[data-testid="quiz-symbol-btn"][data-char="√"]').click();

    await expect(input).toHaveValue('a'.repeat(64));
    await expect(input).toHaveClass(/quiz-fill-input--full/);
    // 红边必须真的画出来：可见边框在容器行上（输入框本身 border:none），
    // 浅色主题 --red = #a8322e。只断言类名的版本会假绿。
    await expect(card.locator('.quiz-input-row')).toHaveCSS('border-color', 'rgb(168, 50, 46)');
    // 1.2s 后红色反馈自动消退。
    await page.waitForTimeout(1400);
    await expect(input).not.toHaveClass(/quiz-fill-input--full/);
    await expect(card.locator('.quiz-input-row')).not.toHaveCSS('border-color', 'rgb(168, 50, 46)');
  });

  test('keeps the marker blocks intact when the answer carries an image', async ({ page }) => {
    // 拍照作答（P4）：卡内上传图片 → 交卷消息里图片 markdown 折进该题的作答
    // 块内（指纹行之后），提交判卷首行仍是消息第一行——skill 触发依据不受影响。
    await page.route('**/api/knowledge/vaults/vault-1/assets/upload', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          filePath: 'raw/feishu/2026-10-26/answer.png',
          url: '/api/knowledge/vaults/vault-1/raw/raw%2Ffeishu%2F2026-10-26%2Fanswer.png',
        }),
      });
    });
    await mockRawImage(page);

    let sentMessage: string | null = null;

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: MIXED_QUIZ },
      { type: 'turn_end', stopReason: 'end_turn' },
    ] });
    // Playwright 路由是 LIFO：捕获层必须在 mockChatRun 之后注册才会先执行，
    // fallback 落回 mock 的应答。首发送走 POST /api/runs；同会话追问走
    // POST /api/runs/:id/messages——两条都拦。
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') {
        sentMessage = (JSON.parse(route.request().postData() || '{}') as { message?: string }).message ?? null;
      }
      await route.fallback();
    });
    await page.route('**/api/runs/*/messages', async (route) => {
      if (route.request().method() === 'POST') {
        sentMessage = (JSON.parse(route.request().postData() || '{}') as { message?: string }).message ?? null;
      }
      await route.fallback();
    });
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 卡内上传（隐藏 file input 直灌）→ 缩略图可见。
    await card.locator('[data-testid="quiz-subject-file"][data-question-id="q3"]').setInputFiles({
      name: 'answer.png',
      mimeType: 'image/png',
      buffer: TINY_PNG,
    });
    await expect(card.locator('[data-testid="quiz-answer-assets"] img')).toBeVisible();

    // 草稿文本 + 交卷（客观题未答 → 确认条放行）。
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('看图作答：由图可知……');
    await card.locator('[data-testid="quiz-submit"]').click();
    await card.locator('[data-testid="quiz-confirm-submit"]').click();

    await expect.poll(() => sentMessage).not.toBeNull();
    const msg = sentMessage!;
    // 首行给人读；标记块紧随其后。
    expect(msg.startsWith('提交判卷：《混合 · 3 题》')).toBe(true);
    expect(msg).toContain('【大题作答·第3题】');
    // 图片 markdown 在作答块内（指纹行之后），正文紧随。
    expect(msg).toContain('![作答图片](raw/feishu/2026-10-26/answer.png)');
    expect(msg.indexOf('![作答图片]')).toBeGreaterThan(msg.indexOf('题目指纹：'));
    expect(msg).toContain('看图作答：由图可知……');

    // 草稿图持久化：subjectImages 与 selections/submitted 同键落 localStorage。
    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('molio.quiz.conv-1.'));
      return key ? localStorage.getItem(key) : null;
    });
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).subjectImages).toEqual({ q3: ['raw/feishu/2026-10-26/answer.png'] });
  });

  /** turn_end 后的作答发送会新建 run（不走 /messages 排队），所以二轮批改
   *  用独立 run 供帧：mock-sse 的 sseFrame 格式（id + data{seq,runId,event}）。 */
  function sseFrames(runId: string, reply: string): string {
    const events = [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: reply },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    return events
      .map((event, i) => `id: ${i + 1}\ndata: ${JSON.stringify({ seq: i + 1, runId, event })}\n\n`)
      .join('');
  }

  /** 二轮批改的 mock：第二次 POST /api/runs 应答为 run-2（同会话），
   *  其 events 供给定回复帧。mockChatRun 必须先注册（LIFO 捕获层在后）。 */
  async function mockSecondTurn(page: import('@playwright/test').Page, reply: string): Promise<void> {
    let runPosts = 0;
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST' && (runPosts += 1) === 2) {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ runId: 'run-2', conversationId: 'conv-1' }),
        });
        return;
      }
      await route.fallback();
    });
    await page.route('**/api/runs/run-2/events**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
        body: sseFrames('run-2', reply),
      });
    });
  }

  test('writes the grading back into the subject question row', async ({ page }) => {
    // 批改回写：交卷消息触发批改协议，批改块回流后配对到题卡——得分徽标
    // + 可折叠逐点评定；聊天里的批改文本照常保留。
    const gradingReply = [
      '【批改·第3题】得分 2/3',
      '1. 命中｜写出帕斯卡法则，形式正确',
      '2. 部分｜分成两类但未说明边界情形',
      '3. 未中｜没有指出 C(n,0)=1 的意义',
      '',
      '**错在哪里**：第三点完全没写。',
    ].join('\n');
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: MIXED_QUIZ },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'status', label: 'completed' },
      ],
    });
    await mockSecondTurn(page, gradingReply);
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 卡内草稿 + 交卷（客观题 2 道未答 → amber 确认条 → 仍要交卷）。
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('证明过程……');
    await card.locator('[data-testid="quiz-submit"]').click();
    await expect(card.locator('[data-testid="quiz-submit-confirm"]')).toContainText('还有 2 题');
    await card.locator('[data-testid="quiz-confirm-submit"]').click();

    // 得分徽标出现在解答题行头；未答的客观题不计错（无对错徽标）。
    const score = card.locator('[data-testid="quiz-subject-score"]');
    await expect(score).toHaveText('2/3');
    await expect(card.locator('[data-testid="quiz-subject-status"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="quiz-result"]')).toHaveCount(0);
    // 交卷后进度仍在（口径 = 整张卷子 3 道，此刻答了 1 题）。
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 1/3');
    // 你的作答（只读回显）：草稿镜像立即可见，不等消息落库。
    await expect(card.locator('[data-testid="quiz-subject-echo"]')).toContainText('证明过程……');

    // 逐点评定默认收起，展开后 3 行：判定徽章走 i18n + 依据文本。
    await card.locator('[data-testid="quiz-subject-points-toggle"]').click();
    const points = card.locator('[data-testid="quiz-subject-point"]');
    await expect(points).toHaveCount(3);
    await expect(points.nth(0)).toContainText('命中');
    await expect(points.nth(0)).toContainText('写出帕斯卡法则，形式正确');
    await expect(points.nth(1)).toContainText('部分');
    await expect(points.nth(2)).toContainText('未中');

    // 聊天里的批改文本照常保留（回写是镜像，不是搬运）。
    await expect(page.locator('[data-testid="assistant-prose"]').last()).toContainText('错在哪里');

    await page.unroute('**/api/runs');
    await page.unroute('**/api/runs/run-2/events**');
  });

  test('writes back a fractional score grading', async ({ page }) => {
    // 真机事故（2026-10-27）：模型给了「得分 1.5/5」（部分给分），旧解析器只认
    // 整数分 → 整块批改被丢弃。解析器已宽容小数，这里回归。
    const gradingReply = [
      '【批改·第3题】得分 1.5/5',
      '',
      '1. 未中｜没有按评分点逐条作答',
      '2. 部分｜分成两类了，但没说明边界情形',
      '3. 未中｜没有指出 C(n,0)=1 的意义',
      '',
      '---',
      '',
      '### 错在哪',
      '',
      '- 第一步就没接住题干。',
    ].join('\n');
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: MIXED_QUIZ },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'status', label: 'completed' },
      ],
    });
    await mockSecondTurn(page, gradingReply);
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('证明过程……');
    await card.locator('[data-testid="quiz-submit"]').click();
    await card.locator('[data-testid="quiz-confirm-submit"]').click();

    const score = card.locator('[data-testid="quiz-subject-score"]');
    await expect(score).toHaveText('1.5/5');

    // 逐点评定照常回写；讲解段落里的 bullet 不得混进评分点。
    await card.locator('[data-testid="quiz-subject-points-toggle"]').click();
    const points = card.locator('[data-testid="quiz-subject-point"]');
    await expect(points).toHaveCount(3);
    await expect(points.nth(0)).toContainText('未中');
    await expect(points.nth(1)).toContainText('部分');
    await expect(points.nth(2)).toContainText('未中');

    await page.unroute('**/api/runs');
    await page.unroute('**/api/runs/run-2/events**');
  });

  test('falls back to the submitted pill when the reply has no grading marker', async ({ page }) => {
    // 优雅降级（Review Focus #3）：模型没按批改格式回 → 该题停在「已交卷」
    // （run 结束、无回写），绝不永远「批改中」；聊天批改兜底。
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: MIXED_QUIZ },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'status', label: 'completed' },
      ],
    });
    await mockSecondTurn(page, '总体答得不错，第三点可以再展开说说。');
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('证明过程……');
    await card.locator('[data-testid="quiz-submit"]').click();
    await card.locator('[data-testid="quiz-confirm-submit"]').click();

    await expect(page.locator('[data-testid="assistant-prose"]').last()).toContainText('总体答得不错');
    await expect(card.locator('[data-testid="quiz-subject-score"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="quiz-subject-points-toggle"]')).toHaveCount(0);
    // run 结束仍无回写 → 「已交卷」（中性），不是卡死的「批改中」。
    const status = card.locator('[data-testid="quiz-subject-status"]');
    await expect(status).toHaveAttribute('data-state', 'awaiting');
    await expect(status).toHaveText('已交卷');

    await page.unroute('**/api/runs');
    await page.unroute('**/api/runs/run-2/events**');
  });

  test('redo clears drafts but keeps message-derived answers as read-only echo', async ({ page }) => {
    // 重做（M1）：清草稿 + 判分态，回作答态；交卷消息是事实——推导已答的题
    // 变成只读回显，进度不丢（旧会话语义：重做不动历史消息）。
    const gradingReply = [
      '【批改·第3题】得分 2/3',
      '1. 命中｜写出帕斯卡法则',
      '2. 部分｜没说明边界情形',
      '3. 未中｜没指出 C(n,0)=1',
    ].join('\n');
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: MIXED_QUIZ },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'status', label: 'completed' },
      ],
    });
    await mockSecondTurn(page, gradingReply);
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('证明过程……');
    await card.locator('[data-testid="quiz-submit"]').click();
    await card.locator('[data-testid="quiz-confirm-submit"]').click();
    await expect(card.locator('[data-testid="quiz-subject-score"]')).toHaveText('2/3');

    // 重做 → 草稿与判分态清空；推导已答转只读回显（消息是事实）。
    await card.locator('[data-testid="quiz-redo"]').click();
    await expect(card.locator('[data-testid="quiz-subject-score"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="quiz-subject-input"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="quiz-subject-echo"]')).toContainText('证明过程……');
    const status = card.locator('[data-testid="quiz-subject-status"]');
    await expect(status).toHaveAttribute('data-state', 'graded');
    await expect(status).toHaveText('已批改');
    // 进度并集：草稿没了但推导已答仍在 → 1/3。
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 1/3');
    // 本地草稿态已清：键会被恢复 effect 以空态重写（既有行为），断言内容为空。
    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('molio.quiz.conv-1.'));
      return key ? localStorage.getItem(key) : null;
    });
    expect(stored ? JSON.parse(stored).selections : {}).toEqual({});
    expect(stored ? JSON.parse(stored).submitted : false).toBe(false);

    await page.unroute('**/api/runs');
    await page.unroute('**/api/runs/run-2/events**');
  });

  test('subject-only card: submit exists, grading returns after submission', async ({ page }) => {
    // 纯解答卷也有「提交判卷」（旧版没有提交区的特例消失）：草稿即进度，
    // 交卷 → 批改回流 → 得分 + 回显。
    const gradingReply = [
      '【批改·第1题】得分 1/2',
      '1. 命中｜指出了定理左端是选 k 个元素的计数',
      '2. 未中｜没有说明右端按「是否含某特定元素」分类求和',
    ].join('\n');
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: SUBJECT_ONLY_QUIZ },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'status', label: 'completed' },
      ],
    });
    await mockSecondTurn(page, gradingReply);
    await gotoHome(page);
    await sendMessage(page, '出一道解答题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    const submit = card.locator('[data-testid="quiz-submit"]');
    await expect(submit).toBeDisabled();
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 0/1');

    // 草稿即已答：可交卷（全部已答 → 无确认条直接放行）。
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="s1"]').fill('我的论述……');
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 1/1');
    await submit.click();
    await expect(card.locator('[data-testid="quiz-submit-confirm"]')).toHaveCount(0);

    const score = card.locator('[data-testid="quiz-subject-score"]');
    await expect(score).toHaveText('1/2');
    await expect(card.locator('[data-testid="quiz-subject-echo"]')).toContainText('我的论述……');
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 1/1');
    // 批改已到、无待回题 → foot 回「重做」。
    await expect(card.locator('[data-testid="quiz-redo"]')).toBeVisible();

    await page.unroute('**/api/runs');
    await page.unroute('**/api/runs/run-2/events**');
  });

  test('pure-objective submission grades locally and sends no message', async ({ page }) => {
    // 边界（Review Focus #2）：纯客观卷交卷 = 本地判分，不发消息、不建 run
    // （解答题全空同理——没有作答块就不触发批改协议，避免白跑轮次）。
    let runPosts = 0;
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');
    // 计数层在首发送之后注册（Playwright LIFO）：只统计交卷动作发出的 POST。
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') runPosts += 1;
      await route.fallback();
    });

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-submit"]').click();

    await expect(card.locator('[data-testid="quiz-result"]')).toHaveCount(3);
    // 只有最初那一条提问消息；没有交卷消息，也没有新 run。
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect.poll(() => runPosts).toBe(0);
  });

  test('submitting with unanswered questions shows the amber confirm bar', async ({ page }) => {
    // 未答完交卷（可交白卷）：先 amber 确认条说后果；「继续作答」收条回去，
    // 「仍要交卷」放行——空题标「未作答」、不计错、不发消息（无解答草稿）。
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: MIXED_QUIZ },
        { type: 'turn_end', stopReason: 'end_turn' },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]').click();

    const confirm = card.locator('[data-testid="quiz-submit-confirm"]');
    await card.locator('[data-testid="quiz-submit"]').click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('还有 2 题');
    await card.locator('[data-testid="quiz-confirm-continue"]').click();
    await expect(confirm).toHaveCount(0);

    // 再交 → 仍要交卷：q1 判分揭晓，q3 空题标「未作答」，无交卷消息。
    await card.locator('[data-testid="quiz-submit"]').click();
    await card.locator('[data-testid="quiz-confirm-submit"]').click();
    await expect(card.locator('[data-testid="quiz-result"]')).toHaveCount(1);
    const status = card.locator('[data-testid="quiz-subject-status"]');
    await expect(status).toHaveAttribute('data-state', 'unanswered');
    await expect(status).toHaveText('未作答');
    await expect(card.locator('[data-testid="quiz-progress"]')).toHaveText('已作答 1/3');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
  });

  test('submission bubble collapses to a one-line summary with expand for the full text', async ({ page }) => {
    // 交卷气泡（Q6 拍板 B）：消息流默认紧凑一行「提交判卷：《title》 · 解答 N 题」，
    // 协议墙（题干/评分点/指纹行）点「展开全文」才出现；「收起」还原。
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: MIXED_QUIZ },
      { type: 'turn_end', stopReason: 'end_turn' },
    ] });
    await gotoHome(page);
    await sendMessage(page, '出混合题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]').click();
    await card.locator('[data-testid="quiz-subject-input"][data-question-id="q3"]').fill('我的解答……');
    await card.locator('[data-testid="quiz-submit"]').click();

    const bubble = page.locator('[data-testid="user-message"]').last();
    // 紧凑态：摘要行可见，协议正文不可见。
    const summary = bubble.locator('[data-testid="paper-bubble-summary"]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('提交判卷：《混合 · 3 题》');
    await expect(summary).toContainText('解答 1 题');
    await expect(bubble).not.toContainText('评分点：');

    // 展开 → 协议全文；收起 → 还原摘要。
    await bubble.locator('[data-testid="paper-bubble-expand"]').click();
    await expect(bubble).toContainText('【大题作答·第3题】');
    await expect(bubble).toContainText('评分点：');
    await bubble.locator('[data-testid="paper-bubble-expand"]').click();
    await expect(summary).toBeVisible();
    await expect(bubble).not.toContainText('评分点：');
  });

  test('appends a sequence number when the quiz filename already exists', async ({ page }) => {
    let savedUrl: string | null = null;

    await page.route('**/api/knowledge/vaults/vault-1/files/**', async (route) => {
      const request = route.request();
      const url = decodeURIComponent(request.url());
      if (request.method() === 'GET') {
        const exists = !url.includes('-2.md');
        await route.fulfill({
          status: exists ? 200 : 404,
          contentType: 'application/json',
          body: exists
            ? JSON.stringify({ content: 'existing' })
            : JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }),
        });
        return;
      }
      if (request.method() === 'POST') savedUrl = url;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.locator('[data-testid="quiz-save-kb"]').click();
    await card.locator('[data-testid="quiz-save-confirm"]').click();

    await expect.poll(() => savedUrl).not.toBeNull();
    expect(decodeURIComponent(savedUrl!)).toContain('-2.md');

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });
});

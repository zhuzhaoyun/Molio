import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * Quiz 交互块：模型输出 ```quiz 围栏 JSON 后，聊天内渲染成可作答的题卡。
 * 判分完全在前端完成，不依赖 runtime 工具调用。
 */

const VAULT_ID = 'vault-1';

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

  test('renders questions, options and a disabled submit until every question is answered', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', script: SCRIPT });
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('[data-testid="quiz-title"]')).toHaveText('番茄工作法 · 3 题');
    await expect(card.locator('[data-testid="quiz-question"]')).toHaveCount(3);

    const submit = card.locator('[data-testid="quiz-submit"]');
    await expect(submit).toBeDisabled();

    // q1 single
    await card.locator('[data-testid="quiz-option"][data-question-id="q1"][data-key="B"]').click();
    await expect(submit).toBeDisabled();

    // q2 multiple
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="A"]').click();
    await card.locator('[data-testid="quiz-option"][data-question-id="q2"][data-key="B"]').click();
    await expect(submit).toBeDisabled();

    // q3 judge (B = 错误)
    await card.locator('[data-testid="quiz-option"][data-question-id="q3"][data-key="B"]').click();
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
    await card.locator('[data-testid="quiz-save-kb"]').click();

    await expect(card.locator('[data-testid="quiz-saved-path"]')).toBeVisible();
    await expect.poll(() => savedUrl).not.toBeNull();
    expect(savedUrl!).toContain('/题库/');
    expect(savedUrl!.endsWith('.md')).toBe(true);
    expect(savedBody?.content).toContain('```quiz');
    expect(savedBody?.content).toContain('番茄工作法 · 3 题');

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });

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
    await gotoHome(page);
    await sendMessage(page, '出几道题');

    const card = page.locator('[data-testid="quiz-card"]');
    await expect(card).toBeVisible({ timeout: 10_000 });

    const stem = card.locator('[data-testid="quiz-stem"]');
    await expect(stem.locator('img')).toHaveAttribute('src', 'raw/thermometer.png');
    await expect(stem.locator('strong')).toHaveText('25 分钟');
    await expect(stem).toContainText('____');

    await expect(
      card.locator('[data-testid="quiz-option"][data-key="A"] .quiz-option-text strong'),
    ).toHaveText('25 分钟');
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

    await expect.poll(() => savedUrl).not.toBeNull();
    expect(decodeURIComponent(savedUrl!)).toContain('-2.md');

    await page.unroute('**/api/knowledge/vaults/vault-1/files/**');
  });
});

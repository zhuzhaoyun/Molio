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

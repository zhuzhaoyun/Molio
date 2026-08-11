// apps/web/e2e/kb-chat-resume-multi.spec.ts
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';
import http from 'node:http';

/**
 * @area kb
 * @priority P1
 * 多会话并发的重挂载恢复：两个会话同时流式进行，切页离开再返回，
 * 两个会话都必须恢复直播（只恢复当前显示会话是 bug）。
 * Prerequisites: `pnpm dev`.
 */

function sseFrame(seq: number, runId: string, event: object): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ seq, runId, event })}\n\n`;
}

interface MockRun {
  runId: string;
  conversationId: string;
  userMessage: string;
  script: readonly object[];
  frameDelay: number;
}

const RUN_1: MockRun = {
  runId: 'run-1',
  conversationId: 'conv-1',
  userMessage: '消息一',
  script: [
    { type: 'status', label: 'running' },
    { type: 'text_delta', delta: '第一条回复 ' },
    { type: 'text_delta', delta: '完整内容。' },
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
  ],
  frameDelay: 100,
};

const RUN_2: MockRun = {
  runId: 'run-2',
  conversationId: 'conv-2',
  userMessage: '消息二',
  script: [
    { type: 'status', label: 'running' },
    { type: 'text_delta', delta: '第二条回复 ' },
    { type: 'text_delta', delta: '完整内容。' },
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
  ],
  frameDelay: 100,
};

const streamingServers: http.Server[] = [];

/**
 * 双 run mock：POST /api/runs 按消息内容路由到 run-1/conv-1 或 run-2/conv-2；
 * GET /api/runs 返回两个活跃 run（含 conversationId）；两个 run 的 SSE 各自
 * 用独立端口流式服务器（frameDelay）播完脚本。
 */
async function mockTwoRuns(page: import('@playwright/test').Page) {
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      const run = String(body.message ?? '').includes(RUN_1.userMessage) ? RUN_1 : RUN_2;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ runId: run.runId, conversationId: run.conversationId }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [
            { id: RUN_1.runId, agentId: 'claude', status: 'running', createdAt: 0, lastStopReason: null, conversationId: RUN_1.conversationId },
            { id: RUN_2.runId, agentId: 'claude', status: 'running', createdAt: 0, lastStopReason: null, conversationId: RUN_2.conversationId },
          ],
        }),
      });
    }
  });

  // 每个 run 一个流式 SSE 服务器（route.fulfill 无法真正流式，需真实 http server）
  for (const run of [RUN_1, RUN_2]) {
    const connections = new Set<import('node:net').Socket>();
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const socket = res.socket;
      if (socket) {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
      }
      (async () => {
        for (let i = 0; i < run.script.length; i++) {
          res.write(sseFrame(i + 1, run.runId, run.script[i]!));
          await new Promise((r) => setTimeout(r, run.frameDelay));
        }
        res.end();
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    streamingServers.push(server);
    (server as any).__connections = connections;

    await page.route(`**/api/runs/${run.runId}/events**`, async (route) => {
      const url = new URL(route.request().url());
      const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
      await route.continue({ url: target });
    });
  }

  // 多轮 / tool-result / agents / config
  for (const run of [RUN_1, RUN_2]) {
    await page.route(`**/api/runs/${run.runId}/messages`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.route(`**/api/runs/${run.runId}/tool-result`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  }
  await page.route('**/api/agents', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ agents: [{ id: 'claude', name: 'Claude', available: true, binary: '/usr/bin/claude', source: 'path', version: '1.0.0', models: [], installUrl: 'https://claude.ai' }] }),
    }));
  await page.route('**/api/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ defaultAgentId: 'claude', locale: 'zh' }) }));

  // 两个会话的 DB 持久化历史（各自只有 user 消息 —— assistant 回复未及入库）
  await page.route('**/api/conversations/conv-1/messages', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [{ id: 'um1', role: 'user', content: RUN_1.userMessage, timestamp: Date.now() }] }) }));
  await page.route('**/api/conversations/conv-2/messages', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [{ id: 'um2', role: 'user', content: RUN_2.userMessage, timestamp: Date.now() }] }) }));
}

function sessionMessages(page: import('@playwright/test').Page, index: number) {
  return page.locator('[data-testid="kb-chat-panel"] .file-chat-session').nth(index).locator('.file-chat-messages');
}

let vault: TempVault;

test.describe('KB chat resume multi-session', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-resume-multi');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
    for (const s of streamingServers) {
      const conns = (s as any).__connections as Set<import('node:net').Socket> | undefined;
      if (conns) for (const c of conns) c.destroy();
    }
    await Promise.all(streamingServers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    streamingServers.length = 0;
  });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('两个会话同时流式，切页返回后都恢复直播', async ({ page }) => {
    await mockTwoRuns(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 会话1：发送消息一 → 进入流式
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const input1 = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]:visible');
    await input1.fill(RUN_1.userMessage);
    await page.locator('[data-testid="composer-send"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="kb-chat-session-running"]'))
      .toHaveCount(1, { timeout: 5_000 });

    // 会话2：新建标签，发送消息二 → 两个会话同时流式
    await page.locator('[data-testid="kb-chat-session-new"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2);
    const input2 = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]:visible');
    await input2.fill(RUN_2.userMessage);
    await page.locator('[data-testid="composer-send"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="kb-chat-session-running"]'))
      .toHaveCount(2, { timeout: 5_000 });
    await page.waitForTimeout(150); // 两 run 都 mid-stream（5 帧 × 100ms）

    // 切页离开（卸载 KB 页 → 两个会话的 SSE 都断开）→ 返回
    await page.goto('http://localhost:5173/history');
    await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 两个会话都必须在重挂载后恢复直播，最终各自拿到完整回复
    // （会话1 非当前显示 —— 恢复 bug 会让它停在残缺回复/空助手消息）
    await expect(sessionMessages(page, 0)).toContainText('第一条回复 完整内容。', { timeout: 10_000 });
    await expect(sessionMessages(page, 1)).toContainText('第二条回复 完整内容。', { timeout: 10_000 });
    // 回放结束后 run 被正确接管，running 指示消失（不是永久卡住）
    await expect(page.locator('[data-testid="kb-chat-session-running"]')).toHaveCount(0, { timeout: 5_000 });
  });
});

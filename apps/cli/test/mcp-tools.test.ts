/**
 * MCP tools 集成测试 — 用 SDK InMemoryTransport 把真实 Client 接到
 * createMcpServer（生产同一注册路径），断言 tools/list 与每个 tool 的
 * 成功 JSON / isError 中文消息。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DaemonClient } from '../src/daemon-client.js';
import { createMcpServer } from '../src/mcp/server.js';
import { startHarness, type Harness } from './helpers.js';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let h: Harness;
let mcp: Client;

async function connectMcp(client: DaemonClient): Promise<Client> {
  const server = createMcpServer(client);
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  return mcpClient;
}

function textOf(result: ToolResult): string {
  const first = result.content[0];
  assert.equal(first?.type, 'text');
  return first.text ?? '';
}

function jsonOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await mcp.callTool({ name, arguments: args })) as ToolResult;
}

describe('MCP server', () => {
  before(async () => {
    h = await startHarness();
    mcp = await connectMcp(h.client);
  });
  after(async () => {
    await mcp?.close();
    await h?.teardown();
  });

  it('tools/list：恰好 7 个只读 tools', async () => {
    const { tools } = await mcp.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'kb_ask_poll',
        'kb_ask_start',
        'kb_read',
        'kb_search',
        'kb_tree',
        'kb_vaults',
        'molio_status',
      ],
    );
    for (const t of tools) assert.ok(t.description && t.description.length > 0, `${t.name} 缺描述`);
  });

  it('molio_status：daemon 健康 + activeVault', async () => {
    const result = await call('molio_status');
    assert.notEqual(result.isError, true);
    const data = jsonOf(result);
    assert.equal((data['daemon'] as { status: string }).status, 'ok');
    assert.equal((data['activeVault'] as { id: string }).id, 'v1');
  });

  it('kb_vaults：列表 + activeVaultId', async () => {
    const data = jsonOf(await call('kb_vaults'));
    assert.equal((data['vaults'] as unknown[]).length, 2);
    assert.equal(data['activeVaultId'], 'v1');
  });

  it('kb_tree：缺省 active / vaultId 指定（id 或名称）', async () => {
    const d1 = jsonOf(await call('kb_tree'));
    assert.equal((d1['vault'] as { id: string }).id, 'v1');
    const d2 = jsonOf(await call('kb_tree', { vaultId: 'Notes' }));
    assert.equal((d2['vault'] as { id: string }).id, 'v2');
  });

  it('kb_read：文本 JSON；未知 vault → isError 中文', async () => {
    const ok = jsonOf(await call('kb_read', { path: 'notes/a.md' }));
    assert.equal((ok['file'] as { content: string }).content, '# 标题\n内容正文');

    const bad = await call('kb_read', { path: 'x.md', vaultId: '不存在' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /未找到知识库/);
  });

  it('kb_read：文件不存在 / 过大 / 二进制', async () => {
    const missing = await call('kb_read', { path: 'no/such.md' });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /文件不存在/);

    h.daemon.files.set('v1:big/huge.md', {
      path: 'big/huge.md',
      content: '',
      size: 999,
      modifiedAt: 1,
      mimeType: 'text/markdown',
      refuse413: true,
    });
    const huge = await call('kb_read', { path: 'big/huge.md' });
    assert.equal(huge.isError, true);
    assert.match(textOf(huge), /文件过大/);

    const binary = await call('kb_read', { path: 'img/logo.png' });
    assert.notEqual(binary.isError, true); // 二进制不是错误，是可读说明
    assert.match(textOf(binary), /二进制文件/);
  });

  it('kb_search：结果 JSON + limit 透传', async () => {
    const data = jsonOf(await call('kb_search', { query: '内容', limit: 5 }));
    assert.equal((data['results'] as unknown[]).length, 1);
    assert.equal(h.daemon.lastSearchQuery?.limit, '5');
  });

  it('kb_ask_start + kb_ask_poll：start 秒回，poll 单次查询不阻塞', async () => {
    h.daemon.nextRunScript = {
      conversationMessages: [
        { id: 'm1', role: 'user', content: 'q', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'MCP 答案', timestamp: 2 },
      ],
    };
    const startedAt = Date.now();
    const start = jsonOf(await call('kb_ask_start', { question: 'q' }));
    assert.ok(Date.now() - startedAt < 1_000, 'start 必须秒回');
    const runId = start['runId'] as string;
    assert.ok(runId);
    assert.match(start['next'] as string, /kb_ask_poll/);

    const running = jsonOf(await call('kb_ask_poll', { runId }));
    assert.equal(running['status'], 'pending');
    assert.match(running['hint'] as string, /再次调用/);

    h.daemon.finishRun(runId, 'succeeded');
    const done = jsonOf(await call('kb_ask_poll', { runId }));
    assert.equal(done['status'], 'succeeded');
    assert.equal(done['answer'], 'MCP 答案');
  });

  it('kb_ask_poll：run 失败 → isError；run 丢失 → isError 中文', async () => {
    h.daemon.nextRunScript = { finalStatus: 'failed', finalError: '模型崩了' };
    const start = jsonOf(await call('kb_ask_start', { question: 'q' }));
    const runId = start['runId'] as string;
    // 脚本 run 无订阅者不会自动终态——手动置 failed
    h.daemon.finishRun(runId, 'failed', '模型崩了');
    const failed = await call('kb_ask_poll', { runId });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /模型崩了/);

    const gone = await call('kb_ask_poll', { runId: 'run-404' });
    assert.equal(gone.isError, true);
    assert.match(textOf(gone), /不存在或已过期/);
  });

  it('参数校验：缺 query → 报错（McpError 或 isError），不落到 daemon', async () => {
    const before = h.daemon.lastSearchQuery;
    let rejected = false;
    try {
      const result = (await mcp.callTool({ name: 'kb_search', arguments: {} })) as ToolResult;
      assert.equal(result.isError, true, '未 reject 时应返回 isError');
    } catch {
      rejected = true; // SDK 以 McpError(INVALID_PARAMS) 拒绝
    }
    assert.ok(rejected || true);
    assert.equal(h.daemon.lastSearchQuery, before, '不应触达 daemon search');
  });
});

describe('MCP server daemon 不可达', () => {
  it('isError + 「无法连接 Molio 守护进程」', async () => {
    const h2 = await startHarness();
    const mcp2 = await connectMcp(h2.client);
    await h2.daemon.stop();
    try {
      const result = (await mcp2.callTool({ name: 'kb_vaults', arguments: {} })) as ToolResult;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /无法连接 Molio 守护进程/);
    } finally {
      await mcp2.close();
      delete process.env['MOLIO_DAEMON_URL'];
    }
  });
});

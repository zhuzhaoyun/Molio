/** daemon-client：各端点、URL/查询参数编码、错误映射（404/413/不可达）、SSE 生成器。 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DaemonClient, isTerminalStatus, lastAssistantText } from '../src/daemon-client.js';
import { isDaemonError } from '../src/errors.js';
import { startHarness, type Harness } from './helpers.js';

/** 断言辅助：拒绝为指定 code 的 DaemonError。 */
function rejectsWithDaemonCode(promise: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (err: unknown) => isDaemonError(err) && err.code === code);
}

describe('daemon-client', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.teardown();
  });

  it('health', async () => {
    const health = await h.client.health();
    assert.equal(health.status, 'ok');
    assert.equal(health.version, '0.0.0-fake');
  });

  it('listVaults / getActiveVault', async () => {
    const vaults = await h.client.listVaults();
    assert.equal(vaults.length, 2);
    const active = await h.client.getActiveVault();
    assert.equal(active.vault?.id, 'v1');
  });

  it('getTree；未知 vault → NOT_FOUND', async () => {
    const tree = await h.client.getTree('v1');
    assert.equal(tree[0]!.name, 'notes');
    await rejectsWithDaemonCode(() => h.client.getTree('nope'), 'NOT_FOUND');
  });

  it('readFile：整段 encodeURIComponent + force=1 透传', async () => {
    const file = await h.client.readFile('v1', 'notes/a.md');
    assert.equal(file.content, '# 标题\n内容正文');
    assert.ok(h.daemon.lastFilesUrl?.includes(encodeURIComponent('notes/a.md')));
    assert.ok(!h.daemon.lastFilesUrl?.includes('force'));

    await h.client.readFile('v1', 'notes/a.md', true);
    assert.ok(h.daemon.lastFilesUrl?.endsWith('?force=1'));
  });

  it('readFile：404 → NOT_FOUND；413 → FILE_TOO_LARGE', async () => {
    await rejectsWithDaemonCode(() => h.client.readFile('v1', 'missing.md'), 'NOT_FOUND');
    h.daemon.files.set('v1:big/huge.md', {
      path: 'big/huge.md',
      content: '',
      size: 999,
      modifiedAt: 1,
      mimeType: 'text/markdown',
      refuse413: true,
    });
    await rejectsWithDaemonCode(() => h.client.readFile('v1', 'big/huge.md'), 'FILE_TOO_LARGE');
  });

  it('search：q 中文+空格编码、limit 透传', async () => {
    const res = await h.client.search('v1', '内容 正文', 50);
    assert.equal(res.results.length, 1);
    assert.equal(h.daemon.lastSearchQuery?.q, '内容 正文');
    assert.equal(h.daemon.lastSearchQuery?.limit, '50');
  });

  it('createRun：请求体原样送达；返回 runId/conversationId', async () => {
    const res = await h.client.createRun({
      agentId: 'claude-code',
      message: '问题',
      cwd: 'D:\\vaults\\work',
    });
    assert.equal(res.runId, 'run-1');
    assert.ok(res.conversationId);
    assert.equal(h.daemon.lastCreateRunRequest?.cwd, 'D:\\vaults\\work');
  });

  it('getRun；未知 run → NOT_FOUND', async () => {
    const info = await h.client.getRun('run-1');
    assert.equal(info.status, 'pending');
    await rejectsWithDaemonCode(() => h.client.getRun('run-404'), 'NOT_FOUND');
  });

  it('getMessages：无消息会话返回空数组', async () => {
    assert.deepEqual(await h.client.getMessages('conv-unknown'), []);
  });

  it('runEvents：SSE 帧解析（跳过 ping）、终态关流后生成器结束', async () => {
    h.daemon.nextRunScript = {
      events: [
        { type: 'text_delta', delta: '你' },
        { type: 'text_delta', delta: '好' },
      ],
      eventIntervalMs: 5,
      finalStatus: 'succeeded',
    };
    const { runId } = await h.client.createRun({
      agentId: 'claude-code',
      message: 'q',
      cwd: 'D:\\vaults\\work',
    });
    const seen: string[] = [];
    for await (const envelope of h.client.runEvents(runId)) {
      const event = envelope.event as { delta?: string };
      if (event.delta) seen.push(event.delta);
    }
    assert.deepEqual(seen, ['你', '好']);
    const info = await h.client.getRun(runId);
    assert.equal(info.status, 'succeeded');
  });

  it('daemon 不可达 → DAEMON_UNREACHABLE', async () => {
    const dead = new DaemonClient('http://127.0.0.1:9'); // port 9 (discard) 必然拒连
    await rejectsWithDaemonCode(() => dead.health(), 'DAEMON_UNREACHABLE');
  });
});

describe('daemon-client 纯函数', () => {
  it('isTerminalStatus', () => {
    assert.equal(isTerminalStatus('pending'), false);
    assert.equal(isTerminalStatus('running'), false);
    assert.equal(isTerminalStatus('succeeded'), true);
    assert.equal(isTerminalStatus('failed'), true);
    assert.equal(isTerminalStatus('canceled'), true);
  });

  it('lastAssistantText：取最后一条非空 assistant', () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'q', timestamp: 1 },
      { id: '2', role: 'assistant' as const, content: '第一答', timestamp: 2 },
      { id: '3', role: 'user' as const, content: '追问', timestamp: 3 },
      { id: '4', role: 'assistant' as const, content: '最终答', timestamp: 4 },
    ];
    assert.equal(lastAssistantText(messages), '最终答');
    assert.equal(lastAssistantText([]), null);
    assert.equal(lastAssistantText([{ id: '1', role: 'user', content: 'q', timestamp: 1 }]), null);
  });
});

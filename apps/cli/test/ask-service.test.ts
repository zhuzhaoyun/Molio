/**
 * ask-service 集成测试 — 驱动状态流转（pending→running→终态）、验证负面行为：
 * 超时(7)、run 失败(6)、断连(1)、run 丢失(6)、消息回退取答、waitAsk 轮询。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pollAsk, startAsk, streamAsk, waitAsk } from '../src/ask-service.js';
import { expectCliError, startHarness, type Harness } from './helpers.js';

const VAULT_CWD = 'D:\\vaults\\work';

function assistantMessage(content: string) {
  return { id: 'm2', role: 'assistant' as const, content, timestamp: 2 };
}

describe('startAsk', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.teardown();
  });

  it('默认 agent + cwd 精确等于 vault.path', async () => {
    const start = await startAsk(h.client, { question: '  什么是知识库  ' });
    assert.equal(start.agentId, 'claude-code');
    assert.equal(start.vaultId, 'v1');
    assert.equal(h.daemon.lastCreateRunRequest?.cwd, VAULT_CWD);
    assert.equal(h.daemon.lastCreateRunRequest?.message, '什么是知识库');
    assert.ok(start.runId);
  });

  it('空问题 → CliError(6)', async () => {
    await expectCliError(() => startAsk(h.client, { question: '   ' }), 6);
  });

  it('显式 --agent / --vault 生效', async () => {
    const start = await startAsk(h.client, {
      question: 'q',
      vaultArg: 'Notes',
      agentArg: 'codex',
    });
    assert.equal(start.agentId, 'codex');
    assert.equal(start.vaultId, 'v2');
    assert.equal(h.daemon.lastCreateRunRequest?.cwd, '/vaults/notes');
  });
});

describe('pollAsk', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.teardown();
  });

  it('非终态：只回 status，不取消息', async () => {
    const start = await startAsk(h.client, { question: 'q' });
    const result = await pollAsk(h.client, start.runId);
    assert.equal(result.status, 'pending');
    assert.equal(result.answer, undefined);
  });

  it('succeeded：从会话消息取最后一条 assistant', async () => {
    h.daemon.nextRunScript = {
      finalStatus: 'succeeded',
      conversationMessages: [
        { id: 'm1', role: 'user', content: 'q', timestamp: 1 },
        assistantMessage('最终答案'),
      ],
    };
    const start = await startAsk(h.client, { question: 'q' });
    h.daemon.finishRun(start.runId, 'succeeded');
    const result = await pollAsk(h.client, start.runId);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.answer, '最终答案');
  });

  it('succeeded 但无消息 → answer null（不抛错）', async () => {
    const start = await startAsk(h.client, { question: 'q' });
    h.daemon.finishRun(start.runId, 'succeeded');
    const result = await pollAsk(h.client, start.runId);
    assert.equal(result.answer, null);
  });

  it('failed：带 error；canceled：默认文案', async () => {
    const a = await startAsk(h.client, { question: 'q' });
    h.daemon.finishRun(a.runId, 'failed', '模型超时');
    assert.equal((await pollAsk(h.client, a.runId)).error, '模型超时');

    const b = await startAsk(h.client, { question: 'q' });
    h.daemon.finishRun(b.runId, 'canceled');
    assert.equal((await pollAsk(h.client, b.runId)).error, 'run 已取消');
  });

  it('multiTurn：run 仍 running 但回合完成 → 判定 succeeded 取答并 cancel', async () => {
    // 回归：multiTurn agent（Claude Code）turn_end 后 run 永远停在 'running'，
    // 旧实现只等终态 → poll 永远拿不到答案。完成信号是 lastStopReason。
    h.daemon.nextRunScript = { conversationMessages: [assistantMessage('轮询答案')] };
    const start = await startAsk(h.client, { question: 'q' });
    h.daemon.completeTurn(start.runId, 'end_turn'); // 置 lastStopReason，status 仍 running
    const result = await pollAsk(h.client, start.runId);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.answer, '轮询答案');
    assert.equal(h.daemon.lastCancelRunId, start.runId, 'multiTurn 完成后应主动 cancel 释放进程');
  });

  it('multiTurn：stopReason=tool_use 是中间步，不算完成', async () => {
    h.daemon.nextRunScript = { conversationMessages: [assistantMessage('不该取到')] };
    const start = await startAsk(h.client, { question: 'q' });
    h.daemon.lastCancelRunId = null; // 清掉上一用例的 cancel 记录（共享 daemon 实例）
    h.daemon.completeTurn(start.runId, 'tool_use'); // 回合内还要调工具
    const result = await pollAsk(h.client, start.runId);
    assert.equal(result.status, 'running', 'tool_use 未完成，应继续等待');
    assert.equal(result.answer, undefined);
    assert.equal(h.daemon.lastCancelRunId, null, '未完成不应 cancel');
  });

  it('幂等重查：回合完成后被 cancel 的 run 仍报 succeeded + 答案', async () => {
    // 回归（真 daemon 实测）：pollAsk 完成时主动 cancel 释放 multiTurn 进程，daemon
    // cancel 不清 lastStopReason（status=canceled 但 lastStopReason=end_turn 仍在）。
    // 旧实现先判 canceled → 二次 poll 误报 EXIT=6「run 已取消」丢掉已落库答案。
    // 完成判定必须优先于 canceled，才能幂等。
    h.daemon.nextRunScript = { conversationMessages: [assistantMessage('北京')] };
    const start = await startAsk(h.client, { question: 'q' });
    h.daemon.completeTurn(start.runId, 'end_turn'); // 回合完成：status=running, lastStopReason=end_turn

    const first = await pollAsk(h.client, start.runId);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.answer, '北京');

    // 第一次 poll 已 cancel：status 现为 canceled，但 lastStopReason 保留
    const run = await h.client.getRun(start.runId);
    assert.equal(run.status, 'canceled');
    assert.equal(run.lastStopReason, 'end_turn');

    // 二次 poll 必须幂等地仍报 succeeded + 答案，而非 canceled 失败
    const second = await pollAsk(h.client, start.runId);
    assert.equal(second.status, 'succeeded');
    assert.equal(second.answer, '北京');
    assert.equal(second.error, undefined);
  });

  it('run 不存在（daemon 重启丢失）→ CliError(6)', async () => {
    const message = await expectCliError(() => pollAsk(h.client, 'run-gone'), 6);
    assert.match(message, /不存在或已过期/);
  });
});

describe('streamAsk', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.teardown();
  });

  it('正常流：text_delta 实时回调，终态 succeeded 聚合答案', async () => {
    h.daemon.nextRunScript = {
      events: [
        { type: 'text_delta', delta: '你' },
        { type: 'text_delta', delta: '好' },
      ],
      eventIntervalMs: 5,
      finalStatus: 'succeeded',
    };
    const start = await startAsk(h.client, { question: 'q' });
    const deltas: string[] = [];
    const result = await streamAsk(h.client, start, {
      timeoutMs: 5_000,
      onDelta: (d) => deltas.push(d),
    });
    assert.deepEqual(deltas, ['你', '好']);
    assert.equal(result.answer, '你好');
    assert.equal(result.status, 'succeeded');
  });

  it('multiTurn：turn_end 即完成（run 仍 running、流不关），收尾主动 cancel', async () => {
    // 回归：真实 daemon 不在 run 终止时关在线 SSE 流，且 multiTurn run（Claude Code）
    // turn_end 后进程不退出、永不进终态。旧实现等 EOF/终态 → 同步 ask 挂到超时(7)。
    // 新实现以 turn_end(stopReason≠tool_use) 为完成信号 break，并 cancel 释放挂起进程。
    h.daemon.nextRunScript = {
      multiTurn: true,
      stopReason: 'end_turn',
      events: [{ type: 'text_delta', delta: '多轮答案' }],
    };
    const start = await startAsk(h.client, { question: 'q' });
    const deltas: string[] = [];
    const result = await streamAsk(h.client, start, {
      timeoutMs: 5_000,
      onDelta: (d) => deltas.push(d),
    });
    assert.deepEqual(deltas, ['多轮答案']);
    assert.equal(result.answer, '多轮答案');
    assert.equal(result.status, 'succeeded');
    assert.equal(h.daemon.lastCancelRunId, start.runId, 'turn_end 后 run 仍 running，应主动 cancel');
  });

  it('multiTurn：turn_end(tool_use) 是中间步不收尾，直到 stopReason≠tool_use', async () => {
    h.daemon.nextRunScript = {
      multiTurn: true,
      stopReason: 'end_turn',
      eventIntervalMs: 5,
      events: [
        { type: 'text_delta', delta: '先调工具' },
        { type: 'turn_end', stopReason: 'tool_use' }, // 中间步：不该收尾
        { type: 'text_delta', delta: '，再作答' },
      ],
    };
    const start = await startAsk(h.client, { question: 'q' });
    const result = await streamAsk(h.client, start, { timeoutMs: 5_000 });
    assert.equal(result.answer, '先调工具，再作答');
    assert.equal(result.status, 'succeeded');
  });

  it('error 事件走 onErrorEvent，不中断流', async () => {
    h.daemon.nextRunScript = {
      events: [
        { type: 'error', message: '工具调用失败' },
        { type: 'text_delta', delta: '仍然完成' },
      ],
      eventIntervalMs: 5,
      finalStatus: 'succeeded',
    };
    const start = await startAsk(h.client, { question: 'q' });
    const errors: string[] = [];
    const result = await streamAsk(h.client, start, {
      timeoutMs: 5_000,
      onErrorEvent: (m) => errors.push(m),
    });
    assert.deepEqual(errors, ['工具调用失败']);
    assert.equal(result.answer, '仍然完成');
  });

  it('流空 + succeeded → 回退会话消息取答', async () => {
    h.daemon.nextRunScript = {
      finalStatus: 'succeeded',
      conversationMessages: [assistantMessage('回退答案')],
    };
    const start = await startAsk(h.client, { question: 'q' });
    const result = await streamAsk(h.client, start, { timeoutMs: 5_000 });
    assert.equal(result.answer, '回退答案');
  });

  it('run failed → CliError(6) 带真因', async () => {
    h.daemon.nextRunScript = { finalStatus: 'failed', finalError: '模型配额用尽' };
    const start = await startAsk(h.client, { question: 'q' });
    const message = await expectCliError(
      () => streamAsk(h.client, start, { timeoutMs: 5_000 }),
      6,
    );
    assert.match(message, /模型配额用尽/);
  });

  it('流不关（run 卡住）→ 超时 CliError(7) 提示 kb result 跟进', async () => {
    h.daemon.nextRunScript = {}; // 无事件、无终态：流保持打开
    const start = await startAsk(h.client, { question: 'q' });
    const message = await expectCliError(
      () => streamAsk(h.client, start, { timeoutMs: 300 }),
      7,
    );
    assert.match(message, /问答超时/);
    assert.match(message, new RegExp(`kb result ${start.runId}`));
  });

  it('中途断连 + run 仍非终态 → CliError(1) 提示异步跟进', async () => {
    h.daemon.nextRunScript = { events: [{ type: 'text_delta', delta: '半截' }] }; // 不终态
    const start = await startAsk(h.client, { question: 'q' });
    const pending = h.daemon.waitForSubscriber(start.runId).then(() => {
      h.daemon.destroyEventStreams(start.runId);
    });
    const message = await expectCliError(
      () => streamAsk(h.client, start, { timeoutMs: 5_000 }),
      1,
    );
    await pending;
    assert.match(message, /事件流中断/);
    assert.match(message, /kb result/);
  });

  it('中途断连 + run 已终态 succeeded → 用已聚合内容收尾', async () => {
    h.daemon.nextRunScript = { events: [{ type: 'text_delta', delta: '完整答案' }] };
    const start = await startAsk(h.client, { question: 'q' });
    const pending = h.daemon.waitForSubscriber(start.runId).then(() => {
      h.daemon.finishRun(start.runId, 'succeeded'); // 终态但强拆 socket 前先 end 了流——改用 destroy 模拟竞态
      h.daemon.destroyEventStreams(start.runId);
    });
    // finishRun 已正常关流：streamAsk 走「流自然关闭」路径
    const result = await streamAsk(h.client, start, { timeoutMs: 5_000 });
    await pending;
    assert.equal(result.answer, '完整答案');
  });

  it('断连后 run 丢失（daemon 重启清库）→ CliError(6)', async () => {
    h.daemon.nextRunScript = { events: [{ type: 'text_delta', delta: 'x' }] };
    const start = await startAsk(h.client, { question: 'q' });
    const pending = h.daemon.waitForSubscriber(start.runId).then(() => {
      h.daemon.destroyEventStreams(start.runId);
      h.daemon.runs.delete(start.runId); // run 记录整个丢失 → getRun 404
    });
    const message = await expectCliError(
      () => streamAsk(h.client, start, { timeoutMs: 5_000 }),
      6,
    );
    await pending;
    assert.match(message, /不存在或已过期/);
  });

  it('流被正常关闭但 run 非终态（异常情形）→ CliError(1)', async () => {
    h.daemon.nextRunScript = { events: [{ type: 'text_delta', delta: 'x' }] };
    const start = await startAsk(h.client, { question: 'q' });
    const pending = h.daemon.waitForSubscriber(start.runId).then(() => {
      h.daemon.endEventStreams(start.runId); // end 但状态仍 pending
    });
    const message = await expectCliError(
      () => streamAsk(h.client, start, { timeoutMs: 5_000 }),
      1,
    );
    await pending;
    assert.match(message, /事件流已关闭但 run 仍为/);
  });
});

describe('waitAsk', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.teardown();
  });

  it('轮询到终态返回答案', async () => {
    h.daemon.nextRunScript = { conversationMessages: [assistantMessage('等待到的答案')] };
    const start = await startAsk(h.client, { question: 'q' });
    const statuses: string[] = [];
    setTimeout(() => h.daemon.finishRun(start.runId, 'succeeded'), 150);
    const result = await waitAsk(h.client, start.runId, {
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      onPoll: (r) => statuses.push(r.status),
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.answer, '等待到的答案');
    assert.ok(statuses.includes('pending'), '应先观察到非终态');
  });

  it('超时 → CliError(7)，不泄漏轮询', async () => {
    const start = await startAsk(h.client, { question: 'q' });
    const message = await expectCliError(
      () => waitAsk(h.client, start.runId, { timeoutMs: 250, pollIntervalMs: 50 }),
      7,
    );
    assert.match(message, /等待超时/);
    assert.match(message, /kb result/);
  });
});

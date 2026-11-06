import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelDispatcher, type ChannelDispatcherDeps } from '../../../src/core/channels/dispatcher.js';
import type { RunManager } from '../../../src/core/RunManager.js';
import type { ConversationService } from '../../../src/core/conversations/service.js';
import type { AgentEvent } from '@molio/contracts';

type Handler = (ev: AgentEvent) => void;
const tick = () => new Promise((r) => setImmediate(r));

function makeDeps() {
  const handlers = new Map<string, Handler>();
  const sinkTexts: string[] = [];
  const appended: Array<{ conversationId: string; text: string }> = [];
  let runSeq = 0;
  const deps = {
    channelLabel: 'test',
    runManager: {
      canAcceptMessage: () => false, // 强制每次 dispatch 走 fresh spawn，路径确定
      cancelRun: () => {},
      sendMessage: () => {},
      flushPendingReply: () => {},
      createRun: async () => `run-${++runSeq}`,
      onEvent: (runId: string, h: Handler) => {
        handlers.set(runId, h);
        return () => handlers.delete(runId);
      },
    } as unknown as RunManager,
    conversations: {
      appendUserMessage: () => {},
      appendAssistantMessage: (cid: string, text: string) => { appended.push({ conversationId: cid, text }); },
    } as unknown as ConversationService,
    sink: {
      sendText: async (_to: string, text: string) => { sinkTexts.push(text); },
      sendMediaFile: async () => {},
    },
  } as unknown as ChannelDispatcherDeps;
  return { deps, handlers, sinkTexts, appended };
}

async function dispatchTurn(userId: string): Promise<ReturnType<typeof makeDeps>> {
  const d = makeDeps();
  const dispatcher = new ChannelDispatcher(d.deps);
  await dispatcher.dispatch({
    userId, conversationId: `c-${userId}`, agentId: 'claude', cwd: undefined, rawUserText: 'q', history: [],
  });
  return d;
}

describe('ChannelDispatcher 依据清单', () => {
  test('turn_end 后 sendText 尾部带依据块；落库正文不带（存亡线）', async () => {
    const { handlers, sinkTexts, appended } = await dispatchTurn('u1');
    const h = handlers.get('run-1')!;
    h({ type: 'text_delta', delta: '盗刷的定性如下……' } as AgentEvent);
    h({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'wiki/刑法分则.md' } } as AgentEvent);
    h({ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: '盗刷', path: 'raw' } } as AgentEvent); // 目录不算依据
    h({ type: 'turn_end', stopReason: 'end_turn' } as AgentEvent);
    await tick(); await tick(); // finish 是 fire-and-forget async

    const reply = sinkTexts[sinkTexts.length - 1]!;
    assert.ok(reply.includes('盗刷的定性如下'));
    assert.ok(reply.includes('依据：① 刑法分则.md'));
    assert.ok(!reply.includes('raw'));               // 目录 Grep 未计入
    assert.equal(appended.length, 1);
    assert.ok(!appended[0]!.text.includes('依据：')); // ← 存亡线：落库正文无依据块
  });

  test('无读文件工具 → 无依据块', async () => {
    const { handlers, sinkTexts } = await dispatchTurn('u2');
    handlers.get('run-1')!({ type: 'text_delta', delta: '纯回答' } as AgentEvent);
    handlers.get('run-1')!({ type: 'turn_end', stopReason: 'end_turn' } as AgentEvent);
    await tick(); await tick();
    assert.equal(sinkTexts[sinkTexts.length - 1], '纯回答');
  });

  test('error 收尾不带依据块', async () => {
    const { handlers, sinkTexts } = await dispatchTurn('u3');
    const h = handlers.get('run-1')!;
    h({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } } as AgentEvent);
    h({ type: 'error', message: '炸了' } as AgentEvent);
    await tick(); await tick();
    const last = sinkTexts[sinkTexts.length - 1]!;
    assert.ok(last.includes('Molio 处理失败'));
    assert.ok(!last.includes('依据：'));
  });
});

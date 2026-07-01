import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AcpTransport } from '../../src/core/streams/acp-transport.js';
import type { AgentEvent } from '@molio/contracts';

/** Builds a transport with an in-memory stdin sink, capturing both sent frames and emitted events. */
function harness() {
  const sent: string[] = [];
  const events: AgentEvent[] = [];
  const transport = new AcpTransport(
    (json) => sent.push(json),
    (ev) => events.push(ev),
  );
  return { transport, sent, events };
}

/** Feed a JSON-RPC frame to the transport as if it came from agent stdout. */
function feedLine(transport: AcpTransport, obj: unknown): void {
  transport.feed(JSON.stringify(obj) + '\n');
}

describe('AcpTransport', () => {
  describe('request / response', () => {
    it('resolves with result when matching response arrives', async () => {
      const { transport, sent } = harness();
      const p = transport.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const sentLine = sent[0]!;
      assert.match(sentLine, /"method":"initialize"/);
      const sentObj = JSON.parse(sentLine);
      assert.equal(sentObj.jsonrpc, '2.0');
      assert.equal(sentObj.id, 1);

      feedLine(transport, { jsonrpc: '2.0', id: 1, result: { ok: true } });
      const result = await p;
      assert.deepEqual(result, { ok: true });
    });

    it('rejects on JSON-RPC error response', async () => {
      const { transport } = harness();
      const p = transport.request('session/new', { mcpServers: [] });
      feedLine(transport, {
        jsonrpc: '2.0', id: 1,
        error: { code: -32602, message: 'Invalid params', data: { foo: 'bar' } },
      });
      await assert.rejects(p, /ACP error -32602: Invalid params/);
    });

    it('uses sequential ids', async () => {
      const { transport } = harness();
      const p1 = transport.request('a', {});
      const p2 = transport.request('b', {});
      feedLine(transport, { jsonrpc: '2.0', id: 1, result: 'first' });
      feedLine(transport, { jsonrpc: '2.0', id: 2, result: 'second' });
      assert.deepEqual([await p1, await p2], ['first', 'second']);
    });

    it('rejects on idle timeout when no activity arrives', async () => {
      const { transport } = harness();
      const p = transport.request('slow', {}, { idleTimeoutMs: 50 });
      const start = Date.now();
      await assert.rejects(p, /ACP idle timeout: slow \(no activity for 50ms\)/);
      assert.ok(Date.now() - start >= 45, 'idle timeout should fire after ~50ms');
    });

    it('rejects on absolute timeout (safety net) regardless of activity', async () => {
      const { transport } = harness();
      // Absolute timeout with NO idle timer — should still fire on its own.
      const p = transport.request('capped', {}, { absoluteTimeoutMs: 50 });
      await assert.rejects(p, /ACP absolute timeout: capped \(50ms\)/);
    });

    it('idle timer resets on stdout activity (feed) — slow server stays pending', async () => {
      const { transport, sent } = harness();
      // Idle timeout 60ms; we feed a non-JSON line every 30ms — should NOT time out.
      const p = transport.request('slow-init', {}, { idleTimeoutMs: 60, absoluteTimeoutMs: 5000 });
      const start = Date.now();
      const feeder = setInterval(() => {
        // Non-JSON stdout line — still counts as activity (feed resets idle timer).
        transport.feed('loading plugin x\n');
      }, 30);
      // After 150ms (well past the 60ms idle), feed the actual response.
      setTimeout(() => {
        clearInterval(feeder);
        feedLine(transport, { jsonrpc: '2.0', id: 1, result: 'finally' });
      }, 150);
      const result = await p;
      assert.equal(result, 'finally');
      assert.ok(Date.now() - start >= 150, 'should have waited for the late response');
    });

    it('idle timer resets on noteActivity() (stderr) — slow cold start stays pending', async () => {
      const { transport } = harness();
      // Simulate hermes printing stderr progress without any stdout.
      const p = transport.request('init', {}, { idleTimeoutMs: 60, absoluteTimeoutMs: 5000 });
      const start = Date.now();
      const ticker = setInterval(() => transport.noteActivity(), 30);
      setTimeout(() => {
        clearInterval(ticker);
        feedLine(transport, { jsonrpc: '2.0', id: 1, result: { ok: 1 } });
      }, 150);
      await p;
      assert.ok(Date.now() - start >= 150, 'should have waited despite no stdout');
    });

    it('drops response for unknown id (already timed out) without throwing', async () => {
      const { transport, events } = harness();
      // Send a request, let it time out, then feed a late response
      const p = transport.request('x', {}, { idleTimeoutMs: 30 });
      await assert.rejects(p);
      // Should not throw — just silently dropped
      feedLine(transport, { jsonrpc: '2.0', id: 1, result: 'late' });
      // No raw event either (it's a response, not a notification)
      assert.equal(events.length, 0);
    });
  });

  describe('feed / framing', () => {
    it('handles chunked input split across a frame boundary', () => {
      const { transport, events } = harness();
      transport.feed('{"jsonrpc":"2.0","method":"session/upd');
      transport.feed('ate","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}\n');
      assert.deepEqual(events, [{ type: 'text_delta', delta: 'hi' }]);
    });

    it('handles multiple frames in one chunk', () => {
      const { transport, events } = harness();
      transport.feed(
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a"}}}}\n'
        + '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"b"}}}}\n'
      );
      assert.deepEqual(events, [
        { type: 'text_delta', delta: 'a' },
        { type: 'text_delta', delta: 'b' },
      ]);
    });

    it('flush emits a final frame without trailing newline', () => {
      const { transport, events } = harness();
      transport.feed('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"usage_update","size":1000,"used":50}}}');
      assert.equal(events.length, 0);
      transport.flush();
      // usage_update is ignored in Phase 1 — no event emitted, but no throw either
      assert.equal(events.length, 0);
    });

    it('surfaces invalid JSON as a raw event (not silently lost)', () => {
      const { transport, events } = harness();
      transport.feed('this is not json\n');
      assert.deepEqual(events, [{ type: 'raw', line: 'this is not json' }]);
    });
  });

  describe('session/update mapping', () => {
    it('maps agent_message_chunk → text_delta', () => {
      const { transport, events } = harness();
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } },
      });
      assert.deepEqual(events, [{ type: 'text_delta', delta: 'hello' }]);
    });

    it('maps agent_thought_chunk → thinking_delta', () => {
      const { transport, events } = harness();
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } },
      });
      assert.deepEqual(events, [{ type: 'thinking_delta', delta: 'thinking...' }]);
    });

    it('maps tool_call (start) → tool_use with toolCallId + title + rawInput', () => {
      const { transport, events } = harness();
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1', title: 'Bash', rawInput: { command: 'ls' }, kind: 'terminal',
        } },
      });
      assert.deepEqual(events, [{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } }]);
    });

    it('maps tool_call_update (progress) → tool_result with isError on failed status', () => {
      const { transport, events } = harness();
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1', status: 'failed', rawOutput: { stderr: 'boom' },
        } },
      });
      assert.deepEqual(events, [{
        type: 'tool_result', toolUseId: 'tc-1',
        content: JSON.stringify({ stderr: 'boom' }), isError: true,
      }]);
    });

    it('tool_call_update with string rawOutput passes content through unwrapped', () => {
      const { transport, events } = harness();
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'completed', rawOutput: 'done',
        } },
      });
      assert.deepEqual(events, [{
        type: 'tool_result', toolUseId: 'tc-2', content: 'done', isError: false,
      }]);
    });

    it('ignores available_commands_update, session_info_update, current_mode_update, config_option_update, plan, user_message_chunk', () => {
      const { transport, events } = harness();
      for (const tag of [
        'available_commands_update', 'session_info_update', 'current_mode_update',
        'config_option_update', 'plan', 'user_message_chunk', 'usage_update',
      ]) {
        feedLine(transport, {
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: 's', update: { sessionUpdate: tag, whatever: 'x' } },
        });
      }
      assert.equal(events.length, 0, 'all non-turn variants should be ignored in Phase 1');
    });

    it('surfaces unknown sessionUpdate variant as raw event', () => {
      const { transport, events } = harness();
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'some_new_variant', foo: 'bar' } },
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'raw');
    });
  });

  describe('cancelledSessionIds', () => {
    it('drops session/update notifications for a cancelled session', () => {
      const { transport, events } = harness();
      transport.markCancelled('s-cancelled');
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's-cancelled', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'should be dropped' } } },
      });
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's-other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'should flow' } } },
      });
      assert.deepEqual(events, [{ type: 'text_delta', delta: 'should flow' }]);
      assert.ok(transport.isCancelled('s-cancelled'));
    });

    it('unmarkCancelled restores notification flow', () => {
      const { transport, events } = harness();
      transport.markCancelled('s');
      transport.unmarkCancelled('s');
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'flows again' } } },
      });
      assert.deepEqual(events, [{ type: 'text_delta', delta: 'flows again' }]);
    });
  });

  describe('rejectAll', () => {
    it('rejects all pending requests with the given error', async () => {
      const { transport } = harness();
      const p1 = transport.request('a', {}, { absoluteTimeoutMs: 5000 });
      const p2 = transport.request('b', {}, { absoluteTimeoutMs: 5000 });
      transport.rejectAll(new Error('process exited'));
      await assert.rejects(p1, /process exited/);
      await assert.rejects(p2, /process exited/);
    });

    it('clears pending map so late responses are dropped not resolved', async () => {
      const { transport, events } = harness();
      const p = transport.request('a', {}, { absoluteTimeoutMs: 5000 });
      transport.rejectAll(new Error('exit'));
      await assert.rejects(p);
      // Late response arrives — should be silently dropped (no pending entry to resolve)
      feedLine(transport, { jsonrpc: '2.0', id: 1, result: 'late' });
      assert.equal(events.length, 0);
    });
  });

  describe('notify', () => {
    it('sends a notification frame without id', () => {
      const { transport, sent } = harness();
      transport.notify('some/method', { x: 1 });
      const obj = JSON.parse(sent[0]!);
      assert.equal(obj.jsonrpc, '2.0');
      assert.equal(obj.method, 'some/method');
      assert.equal(obj.id, undefined);
      assert.deepEqual(obj.params, { x: 1 });
    });
  });
});

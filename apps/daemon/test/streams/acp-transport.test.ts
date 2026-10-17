import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AcpTransport } from '../../src/core/streams/acp-transport.js';
import type { AgentEvent } from '@molio/contracts';

/**
 * Builds a transport with an in-memory stdin sink, capturing both sent frames
 * and emitted events. Transport-level diagnostics (hooks.onTransportEvent)
 * and a default registered session 's' both push into the same `events` array
 * — matching the pre-pool behavior where a single run owned everything.
 */
function harness() {
  const sent: string[] = [];
  const events: AgentEvent[] = [];
  const transport = new AcpTransport(
    (json) => sent.push(json),
    { onTransportEvent: (ev) => events.push(ev) },
  );
  transport.registerSession('s', (ev) => events.push(ev));
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
      // Idle timeout 60ms; we feed a JSON notification every 30ms — should NOT time out.
      // (Using JSON, not raw text, because non-JSON stdout is now a protocol
      // violation that rejects pending requests — see the "rejects oldest
      // pending" test below.)
      const p = transport.request('slow-init', {}, { idleTimeoutMs: 60, absoluteTimeoutMs: 5000 });
      const start = Date.now();
      const feeder = setInterval(() => {
        feedLine(transport, { jsonrpc: '2.0', method: 'progress', params: { stage: 'loading' } });
      }, 30);
      // After 150ms (well past the 60ms idle), feed the actual response.
      setTimeout(() => {
        clearInterval(feeder);
        feedLine(transport, { jsonrpc: '2.0', id: 1, result: 'finally' });
      }, 150);
      const result = await p;
      assert.equal(result, 'finally');
      // Lower bound proves we waited for the 150ms response (not an early
      // resolution), with tolerance for Windows CI clock granularity —
      // Date.now() can read ~1ms behind libuv's timer clock, so a full 150ms
      // wait may measure as 149. An early resolution (idle timeout at 60ms or
      // immediate) still falls far below 140 and fails as intended.
      assert.ok(Date.now() - start >= 140, 'should have waited for the late response');
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
      // >= 140 (not 150) for the same Windows clock-granularity reason as the
      // feed-based test above.
      assert.ok(Date.now() - start >= 140, 'should have waited despite no stdout');
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
      transport.registerSession('s1', (ev) => events.push(ev));
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

    it('rejects oldest pending request when stdout delivers non-JSON (Python traceback to stdout)', async () => {
      // D1 fix: previously, non-JSON stdout was a silent raw event and the
      // request waited for the idle timeout (handshake 15s / prompt 5min)
      // before the user saw a diagnostic. Now the oldest pending request is
      // rejected immediately so RunManager's catch handler surfaces the error.
      const { transport, events } = harness();
      const p = transport.request('session/prompt', { x: 1 }, { absoluteTimeoutMs: 5000 });
      // Simulate a Python traceback leaking to stdout (agent crashed, stderr
      // went to stdout instead of stderr).
      transport.feed('Traceback (most recent call last):\n  File "<stdin>", line 1\nModuleNotFoundError: No module named \'acp\'\n');
      await assert.rejects(p, /ACP protocol violation: agent wrote non-JSON to stdout/);
      // Raw event still emitted (truncated) so the line is preserved in events.jsonl for diagnosis.
      const raw = events.find(e => e.type === 'raw' && typeof e.line === 'string' && e.line.includes('Traceback'));
      assert.ok(raw, 'raw event with traceback line should be emitted for diagnosis');
    });

    it('truncates raw line for non-JSON stdout to 500 chars', () => {
      const { transport, events } = harness();
      const huge = 'x'.repeat(2000);
      transport.feed(huge + '\n');
      const raw = events.find(e => e.type === 'raw');
      assert.ok(raw);
      assert.ok((raw as any).line.length <= 501, 'raw line should be truncated to ≤500 chars + ellipsis');
    });

    it('buffer overflow rejects oldest pending and emits error', async () => {
      // D4 fix: previously, buffer overflow dropped everything and only emitted
      // a raw event — the request then waited for the 30-min absolute timeout.
      // Now it rejects the oldest pending request immediately and emits an error.
      const { transport, events } = harness();
      const p = transport.request('session/prompt', {}, { absoluteTimeoutMs: 5000 });
      // 11MB of garbage with no newline — well past the 10MB cap.
      transport.feed('x'.repeat(11 * 1024 * 1024));
      await assert.rejects(p, /ACP buffer overflow — dropped \d+ bytes/);
      const err = events.find(e => e.type === 'error' && typeof e.message === 'string' && e.message.includes('buffer overflow'));
      assert.ok(err, 'error event should be emitted for overflow');
    });

    it('buffer overflow does not trip on large batched frames with newlines', () => {
      // Regression guard: a large chunk that DOES contain newlines is legitimate
      // (batched notifications) and must not trigger overflow. Only the leftover
      // incomplete-frame tail (no trailing newline) counts toward the cap.
      const { transport, events } = harness();
      // 11MB of valid JSON notification frames, each newline-terminated.
      const frame = '{"jsonrpc":"2.0","method":"progress","params":{}}\n';
      const big = frame.repeat(Math.ceil(11 * 1024 * 1024 / frame.length));
      transport.feed(big);
      // No overflow error — all frames parsed (progress is an unknown method,
      // so no events emitted, but no error either).
      const err = events.find(e => e.type === 'error');
      assert.equal(err, undefined, 'batched frames with newlines should not trigger overflow');
    });

    it('buffer overflow preserves subsequent frames fed after overflow', () => {
      // After overflow resets the buffer, subsequent valid frames must still
      // parse normally — the transport isn't permanently broken.
      const { transport, events } = harness();
      // 11MB garbage with no newline — triggers overflow, buffer reset to ''.
      transport.feed('x'.repeat(11 * 1024 * 1024));
      // Now feed a valid frame — should parse normally.
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } } },
      });
      assert.ok(events.some(e => e.type === 'text_delta' && (e as any).delta === 'after'),
        'valid frame after overflow should produce text_delta');
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

    it('mapUpdate throwing does not break subsequent frames', () => {
      // OCR fix: mapUpdate touches an unstable ACP schema. A throw inside it
      // (e.g. downstream onEvent blowing up) used to escape the while loop in
      // feed() and silently drop subsequent buffered frames. Now the throw is
      // caught, surfaced as a raw [mapUpdate error] event for diagnosis, and
      // the buffer keeps draining.
      const events: AgentEvent[] = [];
      const transport = new AcpTransport(
        (_json) => {},
        { onTransportEvent: (ev) => events.push(ev) },
      );
      transport.registerSession('s', (ev) => {
        // Inject a downstream consumer that throws on a specific delta.
        // Real-world analog: emitEvent → eventsLogStream.write throwing
        // after the stream errored out, or any other side effect.
        if (ev.type === 'text_delta' && (ev as any).delta === 'TRIGGER_THROW') {
          throw new Error('synthetic downstream throw');
        }
        events.push(ev);
      });

      // Frame 1: triggers text_delta with TRIGGER_THROW — onEvent throws
      // INSIDE mapUpdate. Without the try/catch, this throw escapes feed()
      // and frame 2 never gets parsed.
      transport.feed(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'TRIGGER_THROW' },
        } },
      }) + '\n');

      // Frame 2: normal frame — should still process, proving feed()'s while
      // loop wasn't broken by the throw in frame 1.
      transport.feed(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's', update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'after' },
        } },
      }) + '\n');

      const mapUpdateErr = events.find(e =>
        e.type === 'raw' && typeof e.line === 'string' && e.line.includes('[mapUpdate error]'));
      assert.ok(mapUpdateErr, 'mapUpdate throw should be surfaced as a raw event for diagnosis');

      const afterDelta = events.find(e =>
        e.type === 'text_delta' && (e as any).delta === 'after');
      assert.ok(afterDelta, 'subsequent frame after the throw should still produce text_delta');

      const throwDelta = events.find(e =>
        e.type === 'text_delta' && (e as any).delta === 'TRIGGER_THROW');
      assert.equal(throwDelta, undefined,
        'frame 1 text_delta should not be emitted (throw happened inside onEvent before push)');
    });
  });

  describe('cancelledSessionIds', () => {
    it('drops session/update notifications for a cancelled session', () => {
      const { transport, events } = harness();
      transport.registerSession('s-cancelled', (ev) => events.push(ev));
      transport.registerSession('s-other', (ev) => events.push(ev));
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

  describe('killChild callback (P1-2)', () => {
    function harnessWithKill() {
      let killCalled = 0;
      const transport = new AcpTransport(
        () => {},
        { killChild: () => { killCalled++; } },
      );
      return { transport, killCalled: () => killCalled };
    }

    it('calls killChild on idle timeout so a hung agent does not leak', async () => {
      const { transport, killCalled } = harnessWithKill();
      const p = transport.request('slow', {}, { idleTimeoutMs: 50 });
      await assert.rejects(p, /ACP idle timeout/);
      assert.equal(killCalled(), 1, 'killChild should fire exactly once on idle timeout');
    });

    it('calls killChild on absolute timeout so a hung agent does not leak', async () => {
      const { transport, killCalled } = harnessWithKill();
      const p = transport.request('capped', {}, { absoluteTimeoutMs: 50 });
      await assert.rejects(p, /ACP absolute timeout/);
      assert.equal(killCalled(), 1, 'killChild should fire exactly once on absolute timeout');
    });

    it('does NOT call killChild on normal response resolution', async () => {
      const { transport, killCalled } = harnessWithKill();
      const p = transport.request('normal', {});
      feedLine(transport, { jsonrpc: '2.0', id: 1, result: 'ok' });
      await p;
      assert.equal(killCalled(), 0, 'killChild must not fire on normal resolution');
    });

    it('does NOT call killChild on rejectAll (process exit owns that path)', async () => {
      const { transport, killCalled } = harnessWithKill();
      const p = transport.request('a', {}, { absoluteTimeoutMs: 5000 });
      transport.rejectAll(new Error('process exited'));
      await assert.rejects(p, /process exited/);
      assert.equal(killCalled(), 0, 'killChild must not fire on rejectAll — child.on(close) handles the lifecycle');
    });
  });

  describe('multi-session demux (pooled process)', () => {
    it('routes interleaved session/update notifications to the owning sink only', () => {
      const sent: string[] = [];
      const transport = new AcpTransport((json) => sent.push(json));
      const s1Events: AgentEvent[] = [];
      const s2Events: AgentEvent[] = [];
      transport.registerSession('s1', (ev) => s1Events.push(ev));
      transport.registerSession('s2', (ev) => s2Events.push(ev));

      const chunk = (sessionId: string, text: string) => feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
      });
      chunk('s1', 'a1');
      chunk('s2', 'b1');
      chunk('s1', 'a2');
      chunk('s2', 'b2');

      assert.deepEqual(s1Events, [
        { type: 'text_delta', delta: 'a1' },
        { type: 'text_delta', delta: 'a2' },
      ]);
      assert.deepEqual(s2Events, [
        { type: 'text_delta', delta: 'b1' },
        { type: 'text_delta', delta: 'b2' },
      ]);
    });

    it('drops updates for unregistered sessions (detached run / foreign session)', () => {
      const transportEvents: AgentEvent[] = [];
      const transport = new AcpTransport(() => {}, { onTransportEvent: (ev) => transportEvents.push(ev) });
      const s1Events: AgentEvent[] = [];
      transport.registerSession('s1', (ev) => s1Events.push(ev));

      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 'unknown-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'nope' } } },
      });
      feedLine(transport, {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yep' } } },
      });

      assert.deepEqual(s1Events, [{ type: 'text_delta', delta: 'yep' }]);
      assert.equal(transportEvents.length, 0, 'dropped updates must not leak to transport-level events');
    });

    it('unregisterSession removes the sink AND clears the cancelled marker', () => {
      const { transport } = harness();
      transport.markCancelled('sx');
      assert.ok(transport.isCancelled('sx'));
      transport.unregisterSession('sx');
      assert.equal(transport.isCancelled('sx'), false,
        'cancelled marker must not accumulate across the long-lived pooled process');
      assert.deepEqual(transport.sessionIds(), ['s']);
    });

    it('routes server-initiated request_permission diagnostics to the owning session sink', () => {
      const sent: string[] = [];
      const s1Events: AgentEvent[] = [];
      const transportEvents: AgentEvent[] = [];
      const transport = new AcpTransport(
        (json) => sent.push(json),
        { onTransportEvent: (ev) => transportEvents.push(ev) },
      );
      transport.registerSession('s1', (ev) => s1Events.push(ev));

      // dsh-style server request WITH sessionId → auto-approve answer + raw log
      // to the session sink (not transport-level).
      feedLine(transport, {
        jsonrpc: '2.0', id: 99, method: 'session/request_permission',
        params: {
          sessionId: 's1',
          toolCall: { title: 'Bash', kind: 'execute' },
          options: [{ optionId: 'allow', kind: 'allow_always', name: 'Allow' }],
        },
      });
      const answer = JSON.parse(sent[0]!);
      assert.equal(answer.id, 99);
      assert.equal(answer.result.outcome.outcome, 'selected');
      assert.equal(answer.result.outcome.optionId, 'allow');
      assert.ok(s1Events.some(e => e.type === 'raw' && (e as any).line.includes('auto-approved')),
        'permission decision log should route to the owning session');
      assert.equal(transportEvents.length, 0);
    });

    it('routes unsupported server requests without sessionId to transport-level', () => {
      const sent: string[] = [];
      const transportEvents: AgentEvent[] = [];
      const transport = new AcpTransport(
        (json) => sent.push(json),
        { onTransportEvent: (ev) => transportEvents.push(ev) },
      );
      feedLine(transport, { jsonrpc: '2.0', id: 7, method: 'weird/method', params: {} });
      const answer = JSON.parse(sent[0]!);
      assert.equal(answer.error.code, -32601);
      assert.ok(transportEvents.some(e => e.type === 'raw' && (e as any).line.includes('unsupported server request')));
    });
  });

  describe('session-scoped vs transport-scoped timeouts', () => {
    function harnessWithKill() {
      let killCalled = 0;
      const transport = new AcpTransport(
        () => {},
        { killChild: () => { killCalled++; } },
      );
      return { transport, killCalled: () => killCalled };
    }

    it('session-scoped idle timeout rejects the request WITHOUT killing the shared child', async () => {
      const { transport, killCalled } = harnessWithKill();
      const p = transport.request('session/prompt', { sessionId: 's1' }, { idleTimeoutMs: 40, sessionId: 's1' });
      await assert.rejects(p, /ACP idle timeout/);
      assert.equal(killCalled(), 0,
        'one hung session prompt must not take down every other conversation');
    });

    it('session-scoped absolute timeout also spares the child', async () => {
      const { transport, killCalled } = harnessWithKill();
      const p = transport.request('session/prompt', {}, { absoluteTimeoutMs: 40, sessionId: 's1' });
      await assert.rejects(p, /ACP absolute timeout/);
      assert.equal(killCalled(), 0);
    });

    it('transport-level (no sessionId) timeout still kills the child', async () => {
      const { transport, killCalled } = harnessWithKill();
      const p = transport.request('initialize', {}, { idleTimeoutMs: 40 });
      await assert.rejects(p, /ACP idle timeout/);
      assert.equal(killCalled(), 1, 'a process that cannot complete a handshake is useless to all sessions');
    });
  });

  describe('hasPendingFor', () => {
    it('reports pending requests per session and clears on resolution', async () => {
      const { transport } = harness();
      const p1 = transport.request('session/prompt', {}, { absoluteTimeoutMs: 5000, sessionId: 's1' });
      const p2 = transport.request('session/prompt', {}, { absoluteTimeoutMs: 5000, sessionId: 's2' });
      p2.catch(() => {}); // settled by the cleanup rejectAll below
      assert.equal(transport.hasPendingFor('s1'), true);
      assert.equal(transport.hasPendingFor('s2'), true);
      assert.equal(transport.hasPendingFor('s3'), false);

      feedLine(transport, { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
      await p1;
      assert.equal(transport.hasPendingFor('s1'), false, 'resolved prompt must no longer count as pending');
      assert.equal(transport.hasPendingFor('s2'), true);
      // Settle the leftover pending request INSIDE the test — an abandoned
      // promise would fire its absolute timeout after the test ends and trip
      // node:test's unhandledRejection guard.
      transport.rejectAll(new Error('test cleanup'));
      await p2.catch(() => {});
    });

    it('transport-level requests are not attributed to any session', async () => {
      const { transport } = harness();
      const p = transport.request('initialize', {}, { absoluteTimeoutMs: 5000 });
      assert.equal(transport.hasPending(), true);
      assert.equal(transport.hasPendingFor('s'), false);
      transport.rejectAll(new Error('test cleanup'));
      await p.catch(() => {});
    });
  });

  describe('rejectAll clears session state', () => {
    it('drops all registered sessions so nothing routes to a dead process', () => {
      const { transport } = harness();
      transport.registerSession('extra', () => {});
      assert.ok(transport.sessionIds().includes('extra'));
      transport.markCancelled('extra');
      transport.rejectAll(new Error('exit'));
      assert.deepEqual(transport.sessionIds(), []);
      assert.equal(transport.isCancelled('extra'), false);
    });
  });
});

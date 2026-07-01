#!/usr/bin/env node
// Fake hermes-acp server for testing RunManager's ACP transport path.
//
// Implements just enough of the ACP JSON-RPC protocol to drive createRun →
// initialize → session/new → session/prompt → session/cancel:
//   - initialize: returns { agentInfo, protocolVersion }
//   - session/new: returns { sessionId, models, modes }
//   - session/prompt: emits session/update notifications (agent_message_chunk,
//     tool_call, tool_call_update), then returns { stopReason: 'end_turn' }
//   - session/cancel: returns ack
//
// Mode flags via env:
//   - FAKE_HERMES_NO_INIT=1: never respond to initialize (for idle-timeout tests)
//   - FAKE_HERMES_INIT_ERROR=1: respond to initialize with JSON-RPC error
//   - FAKE_HERMES_SLOW_INIT_MS=2000: delay initialize response
//   - FAKE_HERMES_INIT_HEARTBEAT=1: print a stderr heartbeat every 100ms while
//     delaying initialize — simulates real hermes printing "loading plugin X"
//     progress, used to verify the idle-timer reset logic
//   - FAKE_HERMES_EXIT_AFTER_INIT=1: exit right after initialize (process-exit test)
//   - FAKE_HERMES_EXIT_DURING_PROMPT=1: exit mid-prompt after streaming some
//     notifications but before responding — used to verify the close handler
//     marks the run as 'failed' (not 'succeeded') when a prompt is in-flight
//   - FAKE_HERMES_PROMPT_MODE=refusal: return stopReason 'refusal' for prompt

import readline from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('0.0.0-fake');
  process.exit(0);
}

const NO_INIT = process.env['FAKE_HERMES_NO_INIT'] === '1';
const INIT_ERROR = process.env['FAKE_HERMES_INIT_ERROR'] === '1';
const SLOW_INIT_MS = Number(process.env['FAKE_HERMES_SLOW_INIT_MS'] ?? '0');
const INIT_HEARTBEAT = process.env['FAKE_HERMES_INIT_HEARTBEAT'] === '1';
const EXIT_AFTER_INIT = process.env['FAKE_HERMES_EXIT_AFTER_INIT'] === '1';
const EXIT_DURING_PROMPT = process.env['FAKE_HERMES_EXIT_DURING_PROMPT'] === '1';
const PROMPT_MODE = process.env['FAKE_HERMES_PROMPT_MODE'] ?? 'normal';

const SESSION_ID = 'fake-session-0001';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleRequest(msg) {
  if (msg.id === undefined) return; // notification — ignore

  if (msg.method === 'initialize') {
    if (NO_INIT) return; // black-hole the request
    if (INIT_ERROR) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'fake init error' } });
      return;
    }
    const respond = () => {
      send({
        jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: 1,
          agentInfo: { name: 'fake-hermes', version: '0.0.0-fake' },
          agentCapabilities: {},
          authMethods: [],
        },
      });
      if (EXIT_AFTER_INIT) setTimeout(() => process.exit(1), 50);
    };
    if (SLOW_INIT_MS > 0) {
      // Optionally print a stderr heartbeat while waiting — mirrors real
      // hermes printing "loading plugin X" during cold start. Used to test
      // that the AcpTransport idle timer resets on stderr activity.
      if (INIT_HEARTBEAT) {
        const ticker = setInterval(() => {
          process.stderr.write(`${new Date().toISOString().replace('T', ' ')} [INFO] fake-hermes: loading...\n`);
        }, 100);
        setTimeout(() => { clearInterval(ticker); respond(); }, SLOW_INIT_MS);
      } else {
        setTimeout(respond, SLOW_INIT_MS);
      }
    } else {
      respond();
    }
    return;
  }

  if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0', id: msg.id, result: {
        sessionId: SESSION_ID,
        models: {
          availableModels: [
            { modelId: 'fake:model-a', name: 'Model A' },
            { modelId: 'fake:model-b', name: 'Model B' },
          ],
          currentModelId: 'fake:model-a',
        },
        modes: { availableModes: [{ id: 'default', name: 'Default' }], currentModeId: 'default' },
      },
    });
    // Session-init notifications (real hermes pushes these on connect)
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: SESSION_ID, update: {
        sessionUpdate: 'available_commands_update', availableCommands: [],
      } },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    if (PROMPT_MODE === 'refusal') {
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });
      return;
    }
    // Stream a text delta + a tool call, then end the turn
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: SESSION_ID, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from fake hermes' },
      } },
    });
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: SESSION_ID, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1', title: 'Bash', rawInput: { command: 'echo hi' },
      } },
    });
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: SESSION_ID, update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1', status: 'completed', rawOutput: 'hi\n',
      } },
    });
    if (EXIT_DURING_PROMPT) {
      // Die mid-prompt: notifications already streamed, but no response.
      // The RunManager close handler must treat this as 'failed', not 'succeeded'.
      setTimeout(() => process.exit(1), 10);
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (msg.method === 'session/cancel') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  // Unknown method
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    handleRequest(msg);
  } catch {
    // ignore bad JSON
  }
});

// Keep stdin open for multi-turn (real hermes-acp is long-running)
process.stdin.on('end', () => { /* allow exit */ });

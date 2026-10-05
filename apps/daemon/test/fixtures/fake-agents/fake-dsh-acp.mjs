#!/usr/bin/env node
// Fake dsh (DeepSeek Harness) ACP server for testing RunManager's ACP path
// against dsh's protocol quirks — which differ from hermes in three ways:
//
//   1. session/new returns `configOptions` (a grouped model select whose option
//      `value` is a JSON-encoded [provider, model] tuple), NOT `models`.
//      RunManager.parseConfigOptionsModels flattens this into the models event.
//   2. Model switching goes through `session/set_config_option` (dsh has no
//      session/set_model). RunManager calls it when createRun passes a model.
//   3. During a prompt, dsh issues a SERVER-INITIATED `session/request_permission`
//      request that the client MUST answer or the agent blocks forever.
//      AcpTransport.handleServerRequest auto-approves with the most permissive
//      allow option.
//
// Mode flags via env:
//   - FAKE_DSH_REQUEST_PERMISSION=1: during session/prompt, send a
//     session/request_permission server request (with allow_always + reject
//     options) and wait for the answer before streaming the turn. Verifies the
//     transport's auto-approve path picks the permissive option.
//   - FAKE_DSH_PERMISSION_NO_OPTIONS=1: send a request_permission with NO
//     selectable options → transport must answer `cancelled` (not hang).
//   - FAKE_DSH_NO_INIT=1: black-hole initialize (idle-timeout test)
//   - FAKE_DSH_EXIT_DURING_PROMPT=1: exit mid-prompt (close-handler 'failed')
//   - FAKE_DSH_MODEL_MISSING=1: session/new advertises only deepseek-v4-flash;
//     a createRun requesting an unavailable model must fail (user-preference
//     no-silent-fallback rule)
//   - FAKE_DSH_STDERR_SAMPLE=1: on session/prompt, write one benign
//     "dsh: warning:" line and one "dsh: error:" line to stderr, then stream
//     the turn normally. Verifies RunManager.handleAcpStderr's dsh branch:
//     warnings → raw events (no streaming:false swallow), explicit errors →
//     error events.
//   - FAKE_DSH_NO_API_KEY=1: session/prompt fails with the VERBATIM -32603
//     error real dsh produces when DEEPSEEK_API_KEY is missing (observed on a
//     real machine). RunManager must annotate it with a Molio-actionable hint
//     (runtimes/error-hints.ts) — dsh's own advice points at its credentials
//     service / web Models page, which don't exist in Molio.

import readline from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('0.2.0-rc.2-fake');
  process.exit(0);
}

const NO_INIT = process.env['FAKE_DSH_NO_INIT'] === '1';
const EXIT_DURING_PROMPT = process.env['FAKE_DSH_EXIT_DURING_PROMPT'] === '1';
const REQUEST_PERMISSION = process.env['FAKE_DSH_REQUEST_PERMISSION'] === '1';
const PERMISSION_NO_OPTIONS = process.env['FAKE_DSH_PERMISSION_NO_OPTIONS'] === '1';
const MODEL_MISSING = process.env['FAKE_DSH_MODEL_MISSING'] === '1';
const STDERR_SAMPLE = process.env['FAKE_DSH_STDERR_SAMPLE'] === '1';
const NO_API_KEY = process.env['FAKE_DSH_NO_API_KEY'] === '1';

const SESSION_ID = 'fake-dsh-session-0001';

// dsh model configOption leaf values are JSON-encoded [provider, model] tuples.
const tuple = (provider, model) => JSON.stringify([provider, model]);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Server-initiated request id counter (distinct namespace from client ids). */
let serverReqId = 1000;

function handleRequest(msg) {
  if (msg.id === undefined) return; // notification — ignore
  if (typeof msg.method !== 'string') return; // stray response — not for us

  if (msg.method === 'initialize') {
    if (NO_INIT) return; // black-hole
    send({
      jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: 1,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.2.0-rc.2-fake' },
        agentCapabilities: {},
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    const modelLeaves = MODEL_MISSING
      ? [{ name: 'DeepSeek V4 Flash', value: tuple('deepseek-official', 'deepseek-v4-flash') }]
      : [
          { name: 'DeepSeek V4 Flash', value: tuple('deepseek-official', 'deepseek-v4-flash') },
          { name: 'DeepSeek-V4-Pro', value: tuple('deepseek-official', 'deepseek-v4-pro') },
        ];
    send({
      jsonrpc: '2.0', id: msg.id, result: {
        sessionId: SESSION_ID,
        // dsh shape: configOptions (grouped select), NOT models.availableModels.
        configOptions: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            name: 'Model',
            currentValue: tuple('deepseek-official', 'deepseek-v4-flash'),
            options: [
              { group: 'DeepSeek Official', name: 'DeepSeek Official', options: modelLeaves },
            ],
          },
          {
            id: 'reasoning_effort',
            category: 'reasoning',
            type: 'select',
            name: 'Reasoning effort',
            currentValue: 'high',
            options: [
              { name: 'high', value: 'high' },
              { name: 'low', value: 'low' },
            ],
          },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    // Ack the model switch. Real dsh returns the updated configOption; RunManager
    // only awaits the request (doesn't inspect the result), so an ack suffices.
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
    return;
  }

  if (msg.method === 'session/prompt') {
    if (NO_API_KEY) {
      // Verbatim production text (dsh 0.2.0-rc.2, missing DEEPSEEK_API_KEY):
      // handshake + session/new succeed WITHOUT a key, so this only fires on
      // the first real prompt — exactly the trap a Molio user hits after
      // "Install → Test OK".
      send({
        jsonrpc: '2.0', id: msg.id,
        error: {
          code: -32603,
          message: 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment',
        },
      });
      return;
    }
    if (STDERR_SAMPLE) {
      process.stderr.write('dsh: warning: 1 entry did not activate\n');
      process.stderr.write('dsh: error: provider key missing\n');
    }
    const streamTurn = () => {
      send({
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: SESSION_ID, update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from fake dsh' },
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
        setTimeout(() => process.exit(1), 10);
        return;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    };

    if (REQUEST_PERMISSION || PERMISSION_NO_OPTIONS) {
      // Server-initiated request: the client MUST answer or we block forever.
      // Stream the turn only after the answer arrives (proves the round-trip).
      const reqId = serverReqId++;
      const options = PERMISSION_NO_OPTIONS
        ? []
        : [
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
            { optionId: 'allow', kind: 'allow_always', name: 'Allow' },
          ];
      pendingServerRequests.set(reqId, streamTurn);
      send({
        jsonrpc: '2.0', id: reqId, method: 'session/request_permission',
        params: {
          sessionId: SESSION_ID,
          toolCall: { title: 'Bash', kind: 'execute' },
          options,
        },
      });
      return;
    }

    streamTurn();
    return;
  }

  if (msg.method === 'session/cancel') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}

/**
 * Server-initiated requests awaiting the client's answer. Keyed by OUR request
 * id; the value is the continuation to run once the answer arrives. When the
 * client responds (a message whose id matches one of our server requests), we
 * resume the turn — proving AcpTransport.handleServerRequest answered it.
 */
const pendingServerRequests = new Map();

function handleResponseToServerRequest(msg) {
  const cont = pendingServerRequests.get(msg.id);
  if (!cont) return false;
  pendingServerRequests.delete(msg.id);
  // The answer's shape doesn't matter to the fake — real dsh would branch on
  // outcome.selected vs cancelled. We just resume to prove it was answered.
  cont();
  return true;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    // A message with an id + result/error but no method is the client's ANSWER
    // to one of our server-initiated requests.
    if (msg.id !== undefined && msg.method === undefined
        && (msg.result !== undefined || msg.error !== undefined)) {
      if (handleResponseToServerRequest(msg)) return;
    }
    handleRequest(msg);
  } catch {
    // ignore bad JSON
  }
});

process.stdin.on('end', () => { /* allow exit */ });

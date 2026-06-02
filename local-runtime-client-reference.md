# Local AI Runtime Desktop Client -- Architecture Reference

> Extracted from Open Design (`https://github.com/nicepkg/open-design`).
> This document is a standalone architectural blueprint for building a desktop
> client that spawns and orchestrates local AI CLI runtimes (Claude Code, Codex,
> Gemini CLI, etc.) and presents them through a unified UI.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Directory Structure](#2-directory-structure)
3. [Core Types](#3-core-types)
4. [Runtime Definitions](#4-runtime-definitions)
5. [Binary Resolution](#5-binary-resolution)
6. [Process Spawn Pipeline](#6-process-spawn-pipeline)
7. [Stream Parsers (feed/flush Pattern)](#7-stream-parsers-feedflush-pattern)
8. [Unified Event Protocol](#8-unified-event-protocol)
9. [SSE Transport Layer](#9-sse-transport-layer)
10. [Client-Side Consumption](#10-client-side-consumption)
11. [Interactive Tool Result Injection](#11-interactive-tool-result-injection)
12. [Platform Gotchas](#12-platform-gotchas)

---

## 1. Architecture Overview

```
+----------------+     HTTP/SSE      +----------------+    spawn/stdio     +-----------------+
|   Desktop UI   | <---------------> |    Daemon      | <----------------> |  CLI Runtimes   |
| (Electron/Tauri|    REST + SSE     |   (Node.js)    |   child_process    |  claude, codex, |
|  /Web)         |                   |                |                    |  gemini, ...    |
+----------------+                   +----------------+                    +-----------------+
```

**Core principle**: UI never calls CLI directly. CLI never talks to UI directly.
The Daemon sits in between, owning process lifecycle, stream parsing, and
protocol translation.

### Data flow (one complete turn)

```
User types prompt
       |
       v
  Client POST /api/runs { agentId, message, model }
       |
       v
  Daemon:
    1. Look up RuntimeAgentDef by agentId
    2. resolveAgentLaunch() -- find binary on PATH / env override
    3. spawnEnvForAgent()  -- build clean env
    4. def.buildArgs()     -- construct CLI arguments
    5. spawn(command, args, { stdio: ['pipe','pipe','pipe'] })
    6. Write prompt to child stdin (if promptViaStdin)
       |
       v
  Child process (claude / codex / gemini / ...)
       |
       v
  child.stdout --> feed/flush stream parser
       |           - claude-stream:   JSONL with stream_event deltas
       |           - json-event-stream: multi-kind dispatcher (codex, gemini, ...)
       |           - qoder-stream / copilot-stream: vendor-specific
       |
       v
  Parser normalizes to unified events:
    status | text_delta | thinking_delta | tool_use | tool_result | usage | error
       |
       v
  SSE text/event-stream --> Client
       |
       v
  UI renders: status badge, streaming text, tool call cards, usage info
```

---

## 2. Directory Structure

Recommended layout for a new project:

```
your-project/
  src/
    runtimes/
      types.ts              # RuntimeAgentDef, AgentEvent, etc.
      registry.ts           # Agent registry + local profile loader
      launch.ts             # Binary resolution (PATH, env override, fallback)
      env.ts                # Spawn environment construction
      defs/
        claude.ts           # Claude Code definition
        codex.ts            # Codex CLI definition
        gemini.ts           # Gemini CLI definition
        # ... add more here
    streams/
      claude-stream.ts      # Claude Code JSONL parser
      json-event-stream.ts  # Multi-kind JSONL parser (codex, gemini, cursor)
      # ... add vendor-specific parsers here
    server.ts               # HTTP server: spawn + SSE
    client.ts               # Frontend: SSE consumer
```

---

## 3. Core Types

```typescript
// ─── Runtime definition ───

type RuntimeModelOption = { id: string; label: string };

type RuntimeBuildOptions = {
  model?: string | null;
  reasoning?: string | null;
};

type RuntimeContext = {
  cwd?: string;
  hasPriorAssistantTurn?: boolean;
};

/**
 * The central abstraction. Every supported AI runtime is one object
 * conforming to this interface. Pure data + one function (buildArgs).
 */
type RuntimeAgentDef = {
  id: string;                   // unique key: 'claude', 'codex', 'gemini'
  name: string;                 // display label: 'Claude Code', 'Codex CLI'
  bin: string;                  // CLI binary name on PATH
  fallbackBins?: string[];      // alternative binary names (forks)
  versionArgs: string[];        // args to probe version, e.g. ['--version']
  versionProbeTimeoutMs?: number;

  // Core: build CLI arguments for a run
  buildArgs: (
    prompt: string,
    imagePaths: string[],
    extraAllowedDirs?: string[],
    options?: RuntimeBuildOptions,
    runtimeContext?: RuntimeContext,
  ) => string[];

  // Stream format selects which parser handles stdout
  streamFormat: string;
  // Sub-parser name for 'json-event-stream' format
  eventParser?: string;

  // Prompt delivery
  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';

  // Model hints
  fallbackModels: RuntimeModelOption[];
  listModels?: {
    args: string[];
    parse: (stdout: string) => RuntimeModelOption[] | null;
    timeoutMs?: number;
  };
  supportsCustomModel?: boolean;

  // Static env vars for the spawned child
  env?: Record<string, string>;

  // Capabilities
  supportsImagePaths?: boolean;
  maxPromptArgBytes?: number;

  // URLs
  installUrl?: string;
  docsUrl?: string;
};

// ─── Unified event types (parser output, SSE payload) ───

type AgentEvent =
  | { type: 'status'; label: string; model?: string; ttftMs?: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; usage?: UsageInfo; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string; raw?: string }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'raw'; line: string };

type UsageInfo = {
  input_tokens?: number;
  output_tokens?: number;
  thought_tokens?: number;
  cached_read_tokens?: number;
  cached_write_tokens?: number;
};
```

---

## 4. Runtime Definitions

### Claude Code

```typescript
const claudeAgentDef: RuntimeAgentDef = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  fallbackBins: ['openclaude'],   // drop-in forks
  versionArgs: ['--version'],

  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'sonnet', label: 'Sonnet (alias)' },
    { id: 'opus', label: 'Opus (alias)' },
    { id: 'haiku', label: 'Haiku (alias)' },
    { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
    { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
  ],

  buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}) => {
    const args = [
      '-p',
      '--input-format', 'stream-json',   // keeps stdin open for tool_result injection
      '--output-format', 'stream-json',   // JSONL streaming output
      '--verbose',
    ];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    const dirs = (extraAllowedDirs || []).filter(d => typeof d === 'string' && d.length > 0);
    if (dirs.length > 0) {
      args.push('--add-dir', ...dirs);
    }
    args.push('--permission-mode', 'bypassPermissions');
    return args;
  },

  promptViaStdin: true,
  promptInputFormat: 'stream-json',       // JSONL so tool_result can be injected later
  streamFormat: 'claude-stream-json',
};
```

Key points:
- `--input-format stream-json` keeps stdin open so the daemon can inject
  `tool_result` blocks mid-conversation (for AskUserQuestion).
- `--output-format stream-json --verbose` produces JSONL on stdout.
- Prompt is delivered via stdin to avoid command-line length limits.

### Codex CLI

```typescript
const codexAgentDef: RuntimeAgentDef = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  versionArgs: ['--version'],

  listModels: {
    args: ['debug', 'models'],
    parse: (stdout) => {
      // Codex exposes models via `debug models` JSON output
      const parsed = JSON.parse(stdout);
      if (!parsed?.models || !Array.isArray(parsed.models)) return null;
      return [
        { id: 'default', label: 'Default' },
        ...parsed.models
          .filter(m => m.visibility !== 'hidden')
          .map(m => ({ id: m.slug || m.id, label: m.display_name || m.name || m.slug })),
      ];
    },
    timeoutMs: 5000,
  },

  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'o3', label: 'o3' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
  ],

  buildArgs: (_prompt, _imagePaths, _extraDirs, options = {}, runtimeContext = {}) => {
    // Windows/WSL needs danger-full-access sandbox; macOS/Linux use workspace-write
    const needsDanger = process.platform === 'win32' || !!process.env.WSL_DISTRO_NAME;
    const args = needsDanger
      ? ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access']
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write'];

    if (runtimeContext.cwd) {
      args.push('-C', runtimeContext.cwd);
    }
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },

  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'codex',
};
```

Key points:
- `exec --json` produces structured JSON events on stdout.
- `--skip-git-repo-check` avoids interactive prompts.
- Sandbox mode differs by platform (Windows has no OS-level sandbox).

---

## 5. Binary Resolution

Multi-strategy resolution: env override -> PATH -> fallback bins -> packaged binary.

```typescript
import { execFileSync } from 'node:child_process';

function resolveAgentBinary(def: RuntimeAgentDef, configuredEnv: Record<string, string> = {}): string | null {
  // 1. Environment variable override (e.g. CLAUDE_BIN, CODEX_BIN)
  const envKey = `${def.id.toUpperCase()}_BIN`;
  const envBin = configuredEnv[envKey] || process.env[envKey];
  if (envBin) return envBin;

  // 2. Primary binary on PATH
  if (isOnPath(def.bin)) return def.bin;

  // 3. Fallback binaries (forks, alternative names)
  for (const fb of def.fallbackBins ?? []) {
    if (isOnPath(fb)) return fb;
  }

  return null;
}

function isOnPath(bin: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function probeVersion(bin: string, args: string[], timeoutMs = 5000): string | null {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
```

---

## 6. Process Spawn Pipeline

The spawn pipeline is the heart of the system. Four steps, strictly ordered:

```typescript
import { spawn, type ChildProcess } from 'node:child_process';

interface RunOptions {
  agentId: string;
  prompt: string;
  model?: string;
  reasoning?: string;
  cwd?: string;
  extraAllowedDirs?: string[];
}

function spawnAgent(def: RuntimeAgentDef, opts: RunOptions): ChildProcess {
  // ── Step 1: Resolve binary ──
  const bin = resolveAgentBinary(def);
  if (!bin) throw new Error(`Binary not found for agent: ${def.id}`);

  // ── Step 2: Build environment ──
  // Strip API keys unless a custom base URL is set (let `claude login` auth
  // win over ANTHROPIC_API_KEY). Merge proxy settings. Add agent-specific env.
  const env = buildSpawnEnv(def);

  // ── Step 3: Build arguments ──
  const args = def.buildArgs(
    opts.prompt,
    [],                           // imagePaths
    opts.extraAllowedDirs,
    { model: opts.model, reasoning: opts.reasoning },
    { cwd: opts.cwd },
  );

  // ── Step 4: Spawn ──
  const stdinMode = def.promptViaStdin ? 'pipe' : 'ignore';
  const child = spawn(bin, args, {
    env,
    stdio: [stdinMode, 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    shell: false,
    // Windows .cmd shims need this to preserve quoted args with spaces
    windowsVerbatimArguments: process.platform === 'win32',
  });

  // ── Step 5: Deliver prompt ──
  if (def.promptViaStdin && child.stdin) {
    if (def.promptInputFormat === 'stream-json') {
      // JSONL format: write one line, keep stdin OPEN for later tool_result
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: opts.prompt },
      });
      child.stdin.write(msg + '\n');
      // Do NOT close stdin -- stream-json needs it open
    } else {
      // Plain text: write and close
      child.stdin.end(opts.prompt);
    }
  }

  return child;
}

function buildSpawnEnv(def: RuntimeAgentDef): NodeJS.ProcessEnv {
  const env = { ...process.env, ...(def.env ?? {}) };
  // Strip ANTHROPIC_API_KEY / OPENAI_API_KEY unless custom base URL is set,
  // so `claude login` / `codex login` auth takes precedence.
  if (!env.ANTHROPIC_BASE_URL) delete env.ANTHROPIC_API_KEY;
  if (!env.OPENAI_BASE_URL) delete env.OPENAI_API_KEY;
  return env;
}
```

---

## 7. Stream Parsers (feed/flush Pattern)

All parsers share the same interface. This is the key abstraction that makes
adding new runtimes trivial:

```typescript
interface StreamHandler {
  feed(chunk: string | Buffer): void;  // Receive stdout data chunk
  flush(): void;                        // Process remaining buffer on process close
}
```

### Generic JSONL feed/flush wrapper

```typescript
function createJsonlParser(handleLine: (line: string) => void): StreamHandler {
  let buffer = '';

  function feed(chunk: string | Buffer): void {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      handleLine(line);
    }
  }

  function flush(): void {
    const rem = buffer.trim();
    buffer = '';
    if (rem) handleLine(rem);
  }

  return { feed, flush };
}
```

### Claude Code stream parser

Parses `--output-format stream-json --verbose` JSONL:

```typescript
function createClaudeStreamHandler(onEvent: (ev: AgentEvent) => void): StreamHandler {
  type BlockState = { type?: string; name?: string; id?: string; input: string };
  const blocks = new Map<string, BlockState>();
  const streamedToolUseIds = new Set<string>();
  let currentMessageId: string | null = null;
  const textStreamed = new Set<string>();
  const thinkingStreamed = new Set<string>();

  function blockKey(index: unknown): string {
    return `${currentMessageId ?? 'anon'}:${index}`;
  }

  function handleObject(obj: Record<string, unknown>): void {
    // ── system/init -> status ──
    if (obj.type === 'system' && obj.subtype === 'init') {
      onEvent({ type: 'status', label: 'initializing', model: obj.model as string });
      return;
    }

    // ── stream_event -> content_block deltas ──
    if (obj.type === 'stream_event' && typeof obj.event === 'object') {
      handleStreamEvent(obj.event as Record<string, unknown>);
      return;
    }

    // ── assistant wrapper (block finished / fallback for older builds) ──
    if (obj.type === 'assistant' && typeof obj.message === 'object') {
      const msg = obj.message as Record<string, unknown>;
      const msgId = typeof msg.id === 'string' ? msg.id : null;
      if (msgId) currentMessageId = msgId;

      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;

        if (b.type === 'tool_use' && typeof b.id === 'string') {
          // Suppress duplicates from streamed input_json_delta
          if (streamedToolUseIds.has(b.id)) {
            streamedToolUseIds.delete(b.id);
            continue;
          }
          onEvent({ type: 'tool_use', id: b.id, name: b.name as string, input: b.input ?? null });
        } else if (b.type === 'text' && typeof b.text === 'string') {
          if (!textStreamed.has(msgId ?? '')) {
            onEvent({ type: 'text_delta', delta: b.text });
          }
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          if (!thinkingStreamed.has(msgId ?? '')) {
            onEvent({ type: 'thinking_delta', delta: b.thinking });
          }
        }
      }

      if (typeof msg.stop_reason === 'string') {
        onEvent({ type: 'turn_end', stopReason: msg.stop_reason });
      }
      return;
    }

    // ── user messages -> tool_result from prior turns ──
    if (obj.type === 'user' && typeof obj.message === 'object') {
      const msg = obj.message as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result') {
          onEvent({
            type: 'tool_result',
            toolUseId: b.tool_use_id as string,
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
            isError: Boolean(b.is_error),
          });
        }
      }
      return;
    }

    // ── result -> usage ──
    if (obj.type === 'result') {
      onEvent({
        type: 'usage',
        usage: obj.usage as UsageInfo,
        costUsd: obj.total_cost_usd as number,
        durationMs: obj.duration_ms as number,
      });
      return;
    }
  }

  function handleStreamEvent(ev: Record<string, unknown>): void {
    if (ev.type === 'message_start') {
      const msg = typeof ev.message === 'object' ? ev.message as Record<string, unknown> : {};
      currentMessageId = typeof msg.id === 'string' ? msg.id : null;
      if (typeof ev.ttft_ms === 'number') {
        onEvent({ type: 'status', label: 'streaming', ttftMs: ev.ttft_ms });
      }
      return;
    }

    if (ev.type === 'content_block_start' && typeof ev.content_block === 'object') {
      const block = ev.content_block as Record<string, unknown>;
      blocks.set(blockKey(ev.index), {
        type: block.type as string,
        name: block.name as string,
        id: block.id as string,
        input: '',
      });
      if (block.type === 'thinking') {
        onEvent({ type: 'thinking_start' });
      }
      return;
    }

    if (ev.type === 'content_block_delta' && typeof ev.delta === 'object') {
      const delta = ev.delta as Record<string, unknown>;
      const state = blocks.get(blockKey(ev.index));

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'text_delta', delta: delta.text });
        return;
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        if (currentMessageId) thinkingStreamed.add(currentMessageId);
        onEvent({ type: 'thinking_delta', delta: delta.thinking });
        return;
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && state) {
        state.input += delta.partial_json;
        return;
      }
    }

    if (ev.type === 'content_block_stop') {
      const state = blocks.get(blockKey(ev.index));
      if (state?.type === 'tool_use' && state.id && state.input.trim()) {
        try {
          onEvent({ type: 'tool_use', id: state.id, name: state.name ?? '', input: JSON.parse(state.input) });
          streamedToolUseIds.add(state.id);
        } catch {
          // Malformed JSON -- let the assistant wrapper handle it
        }
      }
      blocks.delete(blockKey(ev.index));
      return;
    }
  }

  return createJsonlParser((line) => {
    try {
      handleObject(JSON.parse(line));
    } catch {
      onEvent({ type: 'raw', line });
    }
  });
}
```

### Codex CLI stream parser

Codex uses `exec --json` which produces a different JSONL schema:

```typescript
function createCodexStreamHandler(onEvent: (ev: AgentEvent) => void): StreamHandler {
  const toolUseIds = new Set<string>();
  let errorEmitted = false;

  function handleObject(obj: Record<string, unknown>): void {
    // ── Errors ──
    if (obj.type === 'error') {
      const message = typeof obj.message === 'string' ? obj.message : 'Codex error';
      if (!errorEmitted) {
        errorEmitted = true;
        onEvent({ type: 'error', message });
      }
      return;
    }

    if (obj.type === 'turn.failed') {
      if (!errorEmitted) {
        errorEmitted = true;
        onEvent({ type: 'error', message: 'Codex turn failed' });
      }
      return;
    }

    // ── Lifecycle ──
    if (obj.type === 'thread.started') {
      onEvent({ type: 'status', label: 'initializing' });
      return;
    }
    if (obj.type === 'turn.started') {
      onEvent({ type: 'status', label: 'running' });
      return;
    }

    // ── Tool use (command_execution) ──
    if (obj.type === 'item.started' && typeof obj.item === 'object') {
      const item = obj.item as Record<string, unknown>;
      if (item.type === 'command_execution' && typeof item.id === 'string' && !toolUseIds.has(item.id)) {
        toolUseIds.add(item.id);
        onEvent({
          type: 'tool_use',
          id: item.id,
          name: 'Bash',
          input: { command: typeof item.command === 'string' ? item.command : '' },
        });
      }
      return;
    }

    if (obj.type === 'item.completed' && typeof obj.item === 'object') {
      const item = obj.item as Record<string, unknown>;

      // Tool result
      if (item.type === 'command_execution' && typeof item.id === 'string') {
        if (!toolUseIds.has(item.id)) {
          toolUseIds.add(item.id);
          onEvent({
            type: 'tool_use',
            id: item.id,
            name: 'Bash',
            input: { command: typeof item.command === 'string' ? item.command : '' },
          });
        }
        onEvent({
          type: 'tool_result',
          toolUseId: item.id,
          content: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
          isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : false,
        });
        return;
      }

      // Agent text message
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        onEvent({ type: 'text_delta', delta: item.text });
        return;
      }
    }

    // ── Usage ──
    if (obj.type === 'turn.completed' && typeof obj.usage === 'object') {
      const u = obj.usage as Record<string, unknown>;
      const usage: UsageInfo = {};
      if (typeof u.input_tokens === 'number') usage.input_tokens = u.input_tokens;
      if (typeof u.output_tokens === 'number') usage.output_tokens = u.output_tokens;
      if (typeof u.cached_input_tokens === 'number') usage.cached_read_tokens = u.cached_input_tokens;
      onEvent({ type: 'usage', usage });
      return;
    }
  }

  return createJsonlParser((line) => {
    try {
      handleObject(JSON.parse(line));
    } catch {
      onEvent({ type: 'raw', line });
    }
  });
}
```

### Multi-kind dispatcher (for runtimes sharing JSONL transport)

When multiple runtimes use similar JSONL transport, one parser can dispatch by kind:

```typescript
function createJsonEventStreamHandler(
  kind: string,
  onEvent: (ev: AgentEvent) => void,
): StreamHandler {
  function handleLine(line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      onEvent({ type: 'raw', line });
      return;
    }

    // Dispatch to kind-specific handler
    if (kind === 'codex' && handleCodexEvent(obj, onEvent)) return;
    if (kind === 'gemini' && handleGeminiEvent(obj, onEvent)) return;
    if (kind === 'opencode' && handleOpenCodeEvent(obj, onEvent)) return;

    // Unrecognized -> pass through as raw
    onEvent({ type: 'raw', line });
  }

  return createJsonlParser(handleLine);
}
```

---

## 8. Unified Event Protocol

The parser output is a small set of normalized events. The UI only needs to
understand these -- it never touches runtime-specific JSON:

| Event Type        | When                                           | Payload                                      |
|-------------------|------------------------------------------------|----------------------------------------------|
| `status`          | Lifecycle change                               | `{ label, model?, ttftMs? }`                 |
| `text_delta`      | Assistant text chunk                           | `{ delta: string }`                          |
| `thinking_delta`  | Extended thinking chunk                        | `{ delta: string }`                          |
| `thinking_start`  | Thinking block begins                          | `{}`                                         |
| `tool_use`        | Tool call input complete                       | `{ id, name, input }`                        |
| `tool_result`     | Tool execution result                          | `{ toolUseId, content, isError? }`           |
| `usage`           | Token/cost summary (end of turn)               | `{ usage?, costUsd?, durationMs? }`          |
| `error`           | Fatal or user-visible error                    | `{ message, raw? }`                          |
| `turn_end`        | Turn finished (stop_reason available)          | `{ stopReason }`                             |
| `raw`             | Unrecognized JSONL line                        | `{ line: string }`                           |

### How each runtime maps to these events

| Runtime       | streamFormat          | Raw format                                         |
|---------------|-----------------------|----------------------------------------------------|
| Claude Code   | `claude-stream-json`  | Anthropic streaming API JSONL                      |
| Codex CLI     | `json-event-stream`   | `exec --json` thread/turn/item events              |
| Gemini CLI    | `json-event-stream`   | init/message/result JSON                           |
| OpenCode      | `json-event-stream`   | step_start/text/tool_use/step_finish/error         |
| Cursor Agent  | `json-event-stream`   | system/assistant/result                            |
| Qoder         | `qoder-stream-json`   | system/assistant/result wrappers                   |
| Copilot       | `copilot-stream-json` | Dotted-type JSONL (session.tools_updated, etc.)    |

---

## 9. SSE Transport Layer

The daemon serves SSE at `GET /api/runs/:runId/events`. The wire format is
standard `text/event-stream`:

```typescript
// Server side: send SSE event
function sendSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// SSE event envelope
type SseEvent<T> = { event: string; data: T };

// Transport events
type ChatSseEvent =
  | SseEvent<'start', { runId: string; agentId: string; bin: string; model?: string }>
  | SseEvent<'agent', AgentEvent>           // the unified events from parsers
  | SseEvent<'stdout', { chunk: string }>   // raw stdout passthrough
  | SseEvent<'stderr', { chunk: string }>   // raw stderr passthrough
  | SseEvent<'error', { message: string }>
  | SseEvent<'end', { code: number | null; status: 'succeeded' | 'failed' | 'canceled' }>;
```

Server wire-up:

```typescript
// In the chat route handler
app.post('/api/runs', async (req, res) => {
  const { agentId, message, model, cwd } = req.body;
  const def = getAgentDef(agentId);
  if (!def) return res.status(404).json({ error: 'Unknown agent' });

  const runId = crypto.randomUUID();
  res.json({ runId });

  // Spawn agent and pipe events to SSE channel (stored in memory or Redis)
  const child = spawnAgent(def, { agentId, prompt: message, model, cwd });
  const parser = selectParser(def, (ev) => publishEvent(runId, { event: 'agent', data: ev }));

  child.stdout.on('data', (chunk) => parser.feed(chunk));
  child.stderr.on('data', (chunk) => publishEvent(runId, { event: 'stderr', data: { chunk: chunk.toString() } }));
  child.on('close', (code) => {
    parser.flush();
    publishEvent(runId, { event: 'end', data: { code, status: code === 0 ? 'succeeded' : 'failed' } });
  });
});

// SSE endpoint
app.get('/api/runs/:runId/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  subscribeToRun(req.params.runId, (event) => {
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  });
});
```

---

## 10. Client-Side Consumption

```typescript
interface RunHandlers {
  onStatus: (label: string, model?: string) => void;
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onToolUse: (id: string, name: string, input: unknown) => void;
  onToolResult: (toolUseId: string, content: string, isError?: boolean) => void;
  onUsage: (usage: UsageInfo, costUsd?: number, durationMs?: number) => void;
  onError: (message: string) => void;
  onEnd: (code: number | null, status: string) => void;
  onStderr: (chunk: string) => void;
}

async function streamRun(baseUrl: string, runId: string, handlers: RunHandlers, signal?: AbortSignal): Promise<void> {
  const url = `${baseUrl}/api/runs/${runId}/events`;
  const response = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } });
  if (!response.ok) throw new Error(`SSE connection failed: ${response.status}`);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE frames: "event: xxx\ndata: {...}\n\n"
    let frameEnd;
    while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);

      const eventMatch = frame.match(/^event:\s*(.+)$/m);
      const dataMatch = frame.match(/^data:\s*(.+)$/m);
      if (!eventMatch || !dataMatch) continue;

      const event = eventMatch[1].trim();
      const data = JSON.parse(dataMatch[1].trim());

      switch (event) {
        case 'agent':
          switch (data.type) {
            case 'status':         handlers.onStatus(data.label, data.model); break;
            case 'text_delta':     handlers.onText(data.delta); break;
            case 'thinking_delta': handlers.onThinking(data.delta); break;
            case 'tool_use':       handlers.onToolUse(data.id, data.name, data.input); break;
            case 'tool_result':    handlers.onToolResult(data.toolUseId, data.content, data.isError); break;
            case 'usage':          handlers.onUsage(data.usage, data.costUsd, data.durationMs); break;
            case 'error':          handlers.onError(data.message); break;
          }
          break;
        case 'stderr':  handlers.onStderr(data.chunk); break;
        case 'error':   handlers.onError(data.message); break;
        case 'end':     handlers.onEnd(data.code, data.status); return;
      }
    }
  }
}

// ── Usage example ──

async function runAgent(baseUrl: string, agentId: string, prompt: string): Promise<void> {
  // 1. Create run
  const res = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, message: prompt }),
  });
  const { runId } = await res.json();

  // 2. Stream events
  const controller = new AbortController();
  await streamRun(baseUrl, runId, {
    onStatus: (label, model) => console.log(`[${label}]${model ? ` model=${model}` : ''}`),
    onText: (delta) => process.stdout.write(delta),
    onThinking: (delta) => process.stdout.write(`[thinking] ${delta}`),
    onToolUse: (id, name, input) => console.log(`\n> Tool: ${name}(${JSON.stringify(input)})`),
    onToolResult: (toolUseId, content, isError) => console.log(`\n< Result: ${content}`),
    onUsage: (usage, cost) => console.log(`\n--- Usage: ${JSON.stringify(usage)} cost=$${cost}`),
    onError: (msg) => console.error(`\nERROR: ${msg}`),
    onEnd: (code, status) => console.log(`\n=== Done: ${status} (exit ${code})`),
    onStderr: (chunk) => process.stderr.write(chunk),
  }, controller.signal);
}
```

---

## 11. Interactive Tool Result Injection

This is the most advanced pattern: the runtime pauses mid-turn to ask the user
a question, the UI collects the answer, and the daemon injects it back into
the running child process's stdin. Only supported by runtimes with
`promptInputFormat: 'stream-json'` (currently Claude Code).

### Flow

```
Claude CLI (stdin open)
  -> emits tool_use: AskUserQuestion { id: "tool_123", ... }
  -> Daemon records pendingHostAnswers.add("tool_123"), keeps stdin open
  -> SSE forwards tool_use event to client
  -> Client renders option chips / input form
  -> User selects an option
  -> Client POST /api/runs/:runId/tool-result { toolUseId: "tool_123", content: "option_a" }
  -> Daemon writes JSONL tool_result to child stdin:
       { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_123", content: "option_a" }] } }
  -> Daemon removes "tool_123" from pendingHostAnswers
  -> Claude CLI continues execution
```

### Daemon endpoint

```typescript
// POST /api/runs/:runId/tool-result
app.post('/api/runs/:runId/tool-result', (req, res) => {
  const { toolUseId, content, isError } = req.body;
  const run = activeRuns.get(req.params.runId);
  if (!run?.child?.stdin?.writable) {
    return res.status(400).json({ error: 'Run not active or stdin closed' });
  }

  // Write a JSONL user message with tool_result content block
  const msg = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: content,
        is_error: isError ?? false,
      }],
    },
  });
  run.child.stdin.write(msg + '\n');
  run.pendingHostAnswers.delete(toolUseId);

  res.json({ ok: true });
});
```

### Stdin close strategy

Critical: stdin must NOT close while there are pending answers or while the
model is still generating (stop_reason === 'tool_use' means "paused for tool
result", not "done"):

```typescript
// Only close stdin when BOTH conditions are met:
//   1. pendingHostAnswers is empty (all tool_results have been delivered)
//   2. The latest turn_end had a non-tool_use stop_reason
function maybeCloseStdin(run: RunState): void {
  if (run.pendingHostAnswers.size > 0) return;
  if (run.lastStopReason === 'tool_use') return;
  if (run.child?.stdin?.writable) {
    run.child.stdin.end();
  }
}
```

---

## 12. Platform Gotchas

### Windows

| Issue | Cause | Fix |
|-------|-------|-----|
| `ENAMETOOLONG` on spawn | `CreateProcess` 32KB limit, .cmd shim 8KB limit | Always use `promptViaStdin: true` |
| `.cmd` shim arg corruption | cmd.exe mangles quotes | Set `windowsVerbatimArguments: true` in spawn options |
| Codex sandbox rejection | No OS-level sandbox on Windows | Use `--sandbox danger-full-access` for Codex |
| `corepack enable` EPERM | Cannot write shims to Program Files | Use `npm install -g pnpm` instead |
| PATH key case sensitivity | Windows uses `Path`, not `PATH` | Case-insensitive key lookup when prepending to PATH |

### Cross-platform

| Issue | Cause | Fix |
|-------|-------|-----|
| `E2BIG` on Linux | `MAX_ARG_STRLEN` caps single argv at ~128KB | Use `promptViaStdin: true` |
| Stale API keys in env | `ANTHROPIC_API_KEY` overrides `claude login` auth | Strip API keys from spawn env unless custom base URL is set |
| Forked CLI detection | Users install `openclaude` etc. | Use `fallbackBins` in def + try each one |
| Older CLI missing flags | `--include-partial-messages` etc. | Probe `--help` first, gate flags on capability detection |

### Stream parsing

| Issue | Cause | Fix |
|-------|-------|-----|
| Duplicate text | `stream_event` deltas + `assistant` wrapper both carry text | Track `textStreamed` set per message ID |
| Duplicate tool_use | `input_json_delta` assembly + `assistant` wrapper repeat | Track `streamedToolUseIds` set |
| Truncated JSON | `input_json_delta` partial JSON may be incomplete on `content_block_stop` | Try-catch JSON.parse, let `assistant` wrapper handle fallback |
| Mixed line endings | `\r\n` vs `\n` in stdout | Trim each line before JSON.parse |

### Capability probing

```typescript
// Probe CLI --help to detect available flags
function probeCapabilities(bin: string, helpArgs: string[]): Record<string, boolean> {
  const caps: Record<string, boolean> = {};
  try {
    const stdout = execFileSync(bin, helpArgs, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Check for known flag strings in help output
    // Example: '--include-partial-messages' -> caps.partialMessages = true
  } catch {
    // Older builds may exit non-zero on unknown flags
  }
  return caps;
}
```

---

## Quick Start: Adding a New Runtime

1. **Create the definition file** (`src/runtimes/defs/my-agent.ts`):

```typescript
const myAgentDef: RuntimeAgentDef = {
  id: 'my-agent',
  name: 'My Agent',
  bin: 'my-agent',
  versionArgs: ['--version'],
  fallbackModels: [{ id: 'default', label: 'Default' }],
  buildArgs: (prompt, _images, _dirs, options) => {
    const args = ['run', '--json'];
    if (options?.model && options.model !== 'default') args.push('--model', options.model);
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'my-agent',
};
```

2. **Register it** (`src/runtimes/registry.ts`):

```typescript
import { myAgentDef } from './defs/my-agent.js';
const AGENT_DEFS = [claudeAgentDef, codexAgentDef, myAgentDef, ...];
```

3. **Write the parser** (add to `src/streams/json-event-stream.ts` or create a standalone file):

```typescript
function handleMyAgentEvent(obj: unknown, onEvent: StreamEventHandler): boolean {
  if (!isRecord(obj)) return false;
  if (obj.type === 'text') { onEvent({ type: 'text_delta', delta: obj.content }); return true; }
  if (obj.type === 'done') { onEvent({ type: 'usage', usage: obj.usage }); return true; }
  return false;
}
```

4. Done. The existing spawn pipeline, SSE transport, and client consumption all work unchanged.

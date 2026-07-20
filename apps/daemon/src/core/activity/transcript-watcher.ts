/**
 * Live subagent/workflow activity, derived from the agent runtime's transcript
 * files on disk.
 *
 * Why this exists: while a Workflow / background Task runs, the parent agent's
 * stream is SILENT (the turn ended; the parent only speaks again on completion
 * notification). The Molio UI would show a dead conversation for an hour. But
 * Claude Code writes every session — parent AND each subagent — to transcript
 * JSONLs under ~/.claude/projects/<slug>/ (agent-<id>.jsonl per worker; this is
 * also what Workflow resume relies on). Watching those files gives us exactly
 * what the Claude Code terminal shows: who's running, what they're doing now.
 *
 * Design: 2s-poll (a handful of files, cheap), incremental byte-offset parsing
 * (never re-reads), throttled emissions. The parent transcript supplies the
 * top-level calls (Task/Workflow spawns: label + running→done lifecycle);
 * agent-<id> transcripts supply the workers (live lastAction from their most
 * recent tool call). Both render as one activity tree in the UI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActivityInfo, SubagentActivity } from '@molio/contracts';

const POLL_MS = 2000;
const EMIT_THROTTLE_MS = 1500;
const LABEL_MAX = 60;
/** Tools that spawn background workers worth tracking. */
const SPAWN_TOOLS = new Set(['Task', 'Agent', 'Workflow']);

/**
 * Claude Code maps a project cwd to a transcript dir by replacing every
 * non-alphanumeric char with '-'. Verified empirically:
 *   D:\work\02-code\Molio → D--work-02-code-Molio
 *   D:\work\长文本测试     → D--work------   (each CJK char → '-')
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeProjectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd));
}

function trunc(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** Short human description of a tool call from its input. */
function briefToolAction(name: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      if (typeof obj[k] === 'string') return trunc(obj[k] as string, 50);
    }
    return '';
  };
  const arg =
    pick('file_path', 'command', 'pattern', 'url', 'description') ||
    (typeof input === 'string' ? trunc(input, 50) : '');
  return arg ? `${name} ${arg}` : name;
}

/** Workflow label from its script's meta block (name/description). */
function workflowLabel(input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (typeof obj['script'] === 'string') {
    const ds = obj['script'].match(/description:\s*['"]([^'"]+)['"]/)?.[1];
    const nm = obj['script'].match(/name:\s*['"]([^'"]+)['"]/)?.[1];
    if (ds || nm) return trunc(ds || nm!, LABEL_MAX);
  }
  if (typeof obj['scriptPath'] === 'string') {
    return trunc(String(obj['scriptPath']).split(/[\\/]/).pop() ?? 'workflow', LABEL_MAX);
  }
  if (typeof obj['name'] === 'string') return trunc(obj['name'] as string, LABEL_MAX);
  return 'workflow';
}

export class TranscriptWatcher {
  private agents = new Map<string, SubagentActivity>();
  private offsets = new Map<string, number>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private stopped = false;

  constructor(
    private readonly projectDir: string,
    /** Parent session transcript filename, e.g. <sessionId>.jsonl */
    private readonly sessionFile: string,
    private readonly onActivity: (info: ActivityInfo) => void,
    private readonly throttleMs = EMIT_THROTTLE_MS,
  ) {}

  start(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.scanOnce(), POLL_MS);
    this.scanOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }

  /** Terminal snapshot: everything running is declared done. */
  finalize(): ActivityInfo {
    for (const a of this.agents.values()) {
      if (a.status === 'running') {
        a.status = 'done';
        a.updatedAt = Date.now();
      }
    }
    return this.snapshot();
  }

  /** One scan pass — public for tests (deterministic, no timers needed). */
  scanOnce(): void {
    if (this.stopped) return;
    let files: string[];
    try {
      files = fs.readdirSync(this.projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return; // project dir may not exist yet (first run in this vault)
    }
    for (const f of files) {
      if (f !== this.sessionFile && !f.startsWith('agent-')) continue;
      this.ingestFile(path.join(this.projectDir, f), f === this.sessionFile, f.replace(/\.jsonl$/, ''));
    }
    if (this.dirty) this.scheduleEmit();
  }

  snapshot(): ActivityInfo {
    const agents = [...this.agents.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return { active: agents.some((a) => a.status === 'running'), agents };
  }

  // ─── internals ───

  private ingestFile(file: string, isParent: boolean, key: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    const offset = this.offsets.get(file) ?? 0;
    if (stat.size <= offset) return;

    let chunk: Buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        chunk = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    const text = chunk.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return; // no complete line yet — wait for more
    const complete = text.slice(0, lastNl);
    this.offsets.set(file, offset + Buffer.byteLength(complete, 'utf8') + 1);

    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleLine(obj as Record<string, unknown>, isParent, key);
    }
    this.dirty = true;
  }

  private touch(id: string, label: string): SubagentActivity {
    let a = this.agents.get(id);
    if (!a) {
      a = { id, label, status: 'running', updatedAt: Date.now() };
      this.agents.set(id, a);
    }
    return a;
  }

  private handleLine(obj: Record<string, unknown>, isParent: boolean, fileKey: string): void {
    const type = obj['type'];
    const msg = obj['message'] as Record<string, unknown> | undefined;
    const now = Date.now();

    if (isParent) {
      // Assistant tool_use blocks → spawn events; user tool_result blocks → completion.
      if (type === 'assistant' && msg && Array.isArray(msg['content'])) {
        for (const block of msg['content'] as Array<Record<string, unknown>>) {
          if (block['type'] !== 'tool_use') continue;
          const name = String(block['name'] ?? '');
          if (!SPAWN_TOOLS.has(name)) continue;
          const id = `spawn:${String(block['id'] ?? `${name}-${now}`)}`;
          const input = block['input'];
          const label = name === 'Workflow'
            ? workflowLabel(input)
            : this.subagentLabel(input);
          const a = this.touch(id, label);
          a.status = 'running';
          a.lastAction = 'spawned';
          a.updatedAt = now;
        }
      }
      if (type === 'user' && msg && Array.isArray(msg['content'])) {
        for (const block of msg['content'] as Array<Record<string, unknown>>) {
          if (block['type'] !== 'tool_result') continue;
          const id = `spawn:${String(block['tool_use_id'] ?? '')}`;
          const a = this.agents.get(id);
          if (!a) continue;
          a.status = block['is_error'] ? 'error' : 'done';
          a.lastAction = block['is_error'] ? 'failed' : 'completed';
          a.updatedAt = now;
        }
      }
      return;
    }

    // ── agent-<id>.jsonl: one background worker ──
    const a = this.touch(fileKey, '');
    if (type === 'user' && msg && !a.label) {
      // First user message = the worker's task prompt → label.
      const content = msg['content'];
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as Array<Record<string, unknown>>)
              .map((b) => (b['type'] === 'text' ? String(b['text'] ?? '') : ''))
              .join(' ')
          : '';
      if (text) a.label = trunc(text, LABEL_MAX);
    }
    if (type === 'assistant' && msg) {
      if (Array.isArray(msg['content'])) {
        for (const block of msg['content'] as Array<Record<string, unknown>>) {
          if (block['type'] === 'tool_use') {
            a.lastAction = briefToolAction(String(block['name'] ?? 'tool'), block['input']);
            a.status = 'running';
            a.updatedAt = now;
          }
        }
      }
      const usage = msg['usage'] as Record<string, unknown> | undefined;
      if (usage && typeof usage['output_tokens'] === 'number') {
        a.tokens = (a.tokens ?? 0) + (usage['output_tokens'] as number);
      }
    }
    if (type === 'result') {
      // Worker transcript ends with a result line — it's done.
      a.status = 'done';
      a.updatedAt = now;
    }
    if (!a.label) a.label = fileKey; // fallback until the prompt line arrives
  }

  private subagentLabel(input: unknown): string {
    const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (typeof obj['description'] === 'string' && obj['description']) {
      return trunc(obj['description'] as string, LABEL_MAX);
    }
    if (typeof obj['prompt'] === 'string') return trunc(obj['prompt'] as string, LABEL_MAX);
    return 'subagent';
  }

  private scheduleEmit(): void {
    this.dirty = false;
    if (this.emitTimer || this.stopped) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (this.stopped) return;
      this.onActivity(this.snapshot());
    }, this.throttleMs);
  }
}

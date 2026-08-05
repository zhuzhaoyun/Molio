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
 * top-level calls (Task/Workflow spawns: label + lifecycle). Task/Agent are
 * synchronous — their tool_result means done. Workflow is ASYNC — its
 * tool_result returns immediately ("launched in background") and true
 * completion arrives later as a <task-notification> user message in the same
 * transcript; the spawn entry stays 'running' until that notification.
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

/**
 * Normalize a user message's content to content-block shape. User messages
 * appear both as plain strings and as block arrays in real transcripts;
 * task-notifications can arrive in either shape.
 */
function userContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
  return [];
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
  /**
   * Spawn entry ids (`spawn:<tool_use_id>`) created by the Workflow tool.
   * Workflow is async: its tool_result only means "launched in background",
   * so these entries stay 'running' until the <task-notification> arrives
   * (unlike Task/Agent, whose tool_result means completion).
   */
  private workflowSpawns = new Set<string>();
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
          if (name === 'Workflow') this.workflowSpawns.add(id);
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
      if (type === 'user' && msg) {
        for (const block of userContentBlocks(msg['content'])) {
          // Background-task completion notifications arrive as user text
          // blocks — the authoritative "done" signal for async Workflow
          // spawns (see applyTaskNotifications).
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            this.applyTaskNotifications(block['text'] as string, now);
            continue;
          }
          if (block['type'] !== 'tool_result') continue;
          const id = `spawn:${String(block['tool_use_id'] ?? '')}`;
          const a = this.agents.get(id);
          if (!a) continue;
          if (block['is_error']) {
            // Tool failure — also covers a Workflow that failed to launch.
            a.status = 'error';
            a.lastAction = 'failed';
          } else if (this.workflowSpawns.has(id)) {
            // Workflow's tool_result returns immediately ("launched in
            // background") — it does NOT mean the workflow finished. Stay
            // running until the <task-notification> arrives.
            a.lastAction = 'running in background';
          } else {
            // Task/Agent are synchronous: tool_result means completion.
            a.status = 'done';
            a.lastAction = 'completed';
          }
          a.updatedAt = now;
        }
      }
      // Queued background-task notifications: when a Workflow finishes while
      // the model is mid-turn, Claude Code does NOT deliver the notification
      // as a user message — it enqueues it (queue-operation) and attaches it
      // to a later turn as a queued_command attachment. Scan both carriers so
      // async spawns still flip to done/error (fast-path guard inside
      // applyTaskNotifications ignores non-notification content).
      if (type === 'attachment') {
        const att = obj['attachment'] as Record<string, unknown> | undefined;
        if (att && att['type'] === 'queued_command' && typeof att['prompt'] === 'string') {
          this.applyTaskNotifications(att['prompt'] as string, now);
        }
      }
      if (type === 'queue-operation' && typeof obj['content'] === 'string') {
        this.applyTaskNotifications(obj['content'] as string, now);
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

  /**
   * Parse <task-notification> blocks out of a parent user text line and apply
   * them to the matching Workflow spawn entries. Format (verified on disk):
   *
   *   <task-notification>
   *   <task-id>wszm3wyda</task-id>
   *   <tool-use-id>toolu_xxx</tool-use-id>
   *   ...
   *   <status>completed|failed</status>
   *   <summary>...</summary>
   *   </task-notification>
   *
   * A notification is terminal by definition ("you will be notified when it
   * completes"), so any status other than 'failed' maps to 'done' — leaving
   * the entry 'running' on an unknown status would strand it until finalize().
   * Notifications for ids without a spawn entry (e.g. background Bash) are
   * ignored.
   */
  private applyTaskNotifications(text: string, now: number): void {
    if (!text.includes('<task-notification>')) return;
    for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = m[1] ?? '';
      const toolUseId = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(body)?.[1]?.trim();
      if (!toolUseId) continue;
      const a = this.agents.get(`spawn:${toolUseId}`);
      if (!a) continue;
      const status = /<status>([\s\S]*?)<\/status>/.exec(body)?.[1]?.trim();
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim();
      a.status = status === 'failed' ? 'error' : 'done';
      a.lastAction = summary
        ? trunc(summary, 50)
        : status === 'failed' ? 'failed' : 'completed';
      a.updatedAt = now;
    }
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

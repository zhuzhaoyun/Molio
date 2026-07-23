import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TranscriptWatcher,
  claudeProjectSlug,
  claudeProjectDir,
} from '../../../src/core/activity/transcript-watcher.js';
import type { ActivityInfo } from '@molio/contracts';

/**
 * Unit tests for the transcript watcher — the mechanism that makes background
 * subagent/workflow activity visible while the parent stream is silent.
 * Drives scanOnce() manually (no timers) against synthetic transcript JSONLs
 * in the exact shape Claude Code writes them.
 */

describe('claudeProjectSlug', () => {
  it('maps non-alphanumerics to dashes (verified against real Claude dirs)', () => {
    // Both observed on this machine:
    assert.equal(claudeProjectSlug('D:\\work\\02-code\\Molio'), 'D--work-02-code-Molio');
    assert.equal(claudeProjectSlug('D:\\work\\长文本测试'), 'D--work------');
    assert.equal(claudeProjectSlug('/Users/x/my vault'), '-Users-x-my-vault');
  });

  it('claudeProjectDir lands under ~/.claude/projects', () => {
    const dir = claudeProjectDir('D:\\work\\02-code\\Molio');
    assert.ok(dir.endsWith(path.join('.claude', 'projects', 'D--work-02-code-Molio')));
  });
});

describe('TranscriptWatcher', () => {
  let dir: string;
  let watcher: TranscriptWatcher;
  const SESSION = 'sess-123.jsonl';

  const parentLine = (obj: unknown) =>
    fs.appendFileSync(path.join(dir, SESSION), JSON.stringify(obj) + '\n', 'utf8');
  const agentLine = (file: string, obj: unknown) =>
    fs.appendFileSync(path.join(dir, file), JSON.stringify(obj) + '\n', 'utf8');

  // ── Workflow fixtures ──
  /** Real on-disk <task-notification> shape (newlines preserved after JSON.parse). */
  const taskNotification = (toolUseId: string, status: string, summary = 'Dynamic workflow finished') =>
    `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>C:\\x\\tasks\\t1.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
  const wfSpawn = (id: string, description = 'demo workflow') => ({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name: 'Workflow',
        input: { script: `export const meta = {\n  name: 'demo',\n  description: '${description}',\n};` },
      }],
    },
  });
  /** Workflow's immediate "launched in background" tool_result. */
  const wfLaunchResult = (toolUseId: string, isError = false) => ({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'Workflow launched in background. Task ID: t1\nSummary: demo',
        is_error: isError,
      }],
    },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-watcher-test-'));
    watcher = new TranscriptWatcher(dir, SESSION, () => {}, 10);
  });
  afterEach(() => {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a missing project dir (first run in a fresh vault)', () => {
    watcher = new TranscriptWatcher(path.join(dir, 'nonexistent'), SESSION, () => {});
    watcher.scanOnce(); // must not throw
    assert.deepEqual(watcher.snapshot(), { active: false, agents: [] });
  });

  it('tracks a Task spawn from the parent transcript', () => {
    parentLine({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_task_1',
          name: 'Task',
          input: { description: 'L1 章节 digest：R001', prompt: '读范围…' },
        }],
      },
    });
    watcher.scanOnce();

    const snap = watcher.snapshot();
    assert.equal(snap.active, true);
    assert.equal(snap.agents.length, 1);
    assert.equal(snap.agents[0]!.label, 'L1 章节 digest：R001');
    assert.equal(snap.agents[0]!.status, 'running');
  });

  it('labels Workflow spawns from the script meta block', () => {
    parentLine({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_wf_1',
          name: 'Workflow',
          input: {
            script: "export const meta = {\n  name: 'fanren-l1-digests',\n  description: '凡人修仙传 L1：每个处理范围一个 subagent 生成章节 digest',\n};",
          },
        }],
      },
    });
    watcher.scanOnce();
    const snap = watcher.snapshot();
    assert.equal(snap.agents[0]!.label, '凡人修仙传 L1：每个处理范围一个 subagent 生成章节 digest');
  });

  it('derives live worker state from agent-<id> transcripts', () => {
    agentLine('agent-a1.jsonl', {
      type: 'user',
      message: { role: 'user', content: '为范围 R001（第一章~第四十五章）生成 digest，输出到 digests/R001.md' },
    });
    agentLine('agent-a1.jsonl', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'transcode-凡人修仙传.txt', offset: 1, limit: 2000 } }],
        usage: { output_tokens: 321 },
      },
    });
    watcher.scanOnce();

    const snap = watcher.snapshot();
    const worker = snap.agents.find((a) => a.id === 'agent-a1');
    assert.ok(worker, 'worker entry must exist');
    assert.equal(worker!.status, 'running');
    assert.equal(worker!.label, '为范围 R001（第一章~第四十五章）生成 digest，输出到 digests/R001.md');
    assert.equal(worker!.lastAction, 'Read transcode-凡人修仙传.txt');
    assert.equal(worker!.tokens, 321);

    // Worker finishes with a result line.
    agentLine('agent-a1.jsonl', { type: 'result', subtype: 'success' });
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents.find((a) => a.id === 'agent-a1')!.status, 'done');
  });

  it('marks parent spawns done on tool_result (error → error)', () => {
    parentLine({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'ok task' } }] },
    });
    parentLine({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Task', input: { description: 'bad task' } }] },
    });
    watcher.scanOnce();
    parentLine({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'finished' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true },
      ] },
    });
    watcher.scanOnce();

    const byId = Object.fromEntries(watcher.snapshot().agents.map((a) => [a.id, a.status]));
    assert.equal(byId['spawn:toolu_1'], 'done');
    assert.equal(byId['spawn:toolu_2'], 'error');
    assert.equal(watcher.snapshot().active, false);
  });

  // ── Workflow async completion: tool_result ≠ done; task-notification = done ──

  it('keeps a Workflow spawn running on tool_result, completes on task-notification', () => {
    parentLine(wfSpawn('toolu_wf_1'));
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents[0]!.status, 'running');

    // Immediate "launched in background" tool_result — must NOT flip to done.
    parentLine(wfLaunchResult('toolu_wf_1'));
    watcher.scanOnce();
    const mid = watcher.snapshot();
    assert.equal(mid.active, true, 'workflow still active after launch result');
    assert.equal(mid.agents[0]!.status, 'running');
    assert.equal(mid.agents[0]!.lastAction, 'running in background');

    // The real completion signal: <task-notification> in the parent transcript.
    parentLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: taskNotification('toolu_wf_1', 'completed') }] },
    });
    watcher.scanOnce();
    const end = watcher.snapshot();
    assert.equal(end.active, false);
    assert.equal(end.agents[0]!.status, 'done');
  });

  it('task-notification with status=failed marks the Workflow spawn error', () => {
    parentLine(wfSpawn('toolu_wf_1'));
    parentLine(wfLaunchResult('toolu_wf_1'));
    watcher.scanOnce();
    parentLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: taskNotification('toolu_wf_1', 'failed', 'Dynamic workflow crashed') }] },
    });
    watcher.scanOnce();
    const snap = watcher.snapshot();
    assert.equal(snap.agents[0]!.status, 'error');
    assert.equal(snap.agents[0]!.lastAction, 'Dynamic workflow crashed');
    assert.equal(snap.active, false);
  });

  it('parses task-notification from string content (not block array)', () => {
    parentLine(wfSpawn('toolu_wf_1'));
    parentLine(wfLaunchResult('toolu_wf_1'));
    watcher.scanOnce();
    parentLine({
      type: 'user',
      message: { role: 'user', content: taskNotification('toolu_wf_1', 'completed') },
    });
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents[0]!.status, 'done');
    assert.equal(watcher.snapshot().active, false);
  });

  it('applies multiple task-notifications in one text block', () => {
    parentLine(wfSpawn('toolu_wf_a'));
    parentLine(wfSpawn('toolu_wf_b'));
    parentLine(wfLaunchResult('toolu_wf_a'));
    parentLine(wfLaunchResult('toolu_wf_b'));
    watcher.scanOnce();
    assert.equal(watcher.snapshot().active, true);
    parentLine({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: taskNotification('toolu_wf_a', 'completed') + '\n' + taskNotification('toolu_wf_b', 'failed'),
        }],
      },
    });
    watcher.scanOnce();
    const byId = Object.fromEntries(watcher.snapshot().agents.map((a) => [a.id, a.status]));
    assert.equal(byId['spawn:toolu_wf_a'], 'done');
    assert.equal(byId['spawn:toolu_wf_b'], 'error');
    assert.equal(watcher.snapshot().active, false);
  });

  it('ignores task-notification for an unknown tool_use_id', () => {
    parentLine(wfSpawn('toolu_wf_1'));
    parentLine(wfLaunchResult('toolu_wf_1'));
    watcher.scanOnce();
    parentLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: taskNotification('toolu_never_spawned', 'completed') }] },
    });
    watcher.scanOnce();
    const snap = watcher.snapshot();
    assert.equal(snap.agents.length, 1, 'no phantom entry');
    assert.equal(snap.agents[0]!.status, 'running', 'unrelated notification must not touch the live spawn');
  });

  it('maps an unknown notification status to done (never strands running)', () => {
    parentLine(wfSpawn('toolu_wf_1'));
    parentLine(wfLaunchResult('toolu_wf_1'));
    watcher.scanOnce();
    parentLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: taskNotification('toolu_wf_1', 'cancelled') }] },
    });
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents[0]!.status, 'done');
    assert.equal(watcher.snapshot().active, false);
  });

  it('flips a Workflow spawn from a queued_command attachment (mid-turn failure)', () => {
    // Real shape: a Workflow that fails while the model is still mid-turn
    // never gets a user-message notification — it arrives attached to a
    // later turn as a queued_command attachment.
    parentLine(wfSpawn('toolu_wf_1'));
    parentLine(wfLaunchResult('toolu_wf_1'));
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents[0]!.status, 'running');
    parentLine({
      type: 'attachment',
      isSidechain: false,
      attachment: { type: 'queued_command', prompt: taskNotification('toolu_wf_1', 'failed', 'Dynamic workflow failed') },
    });
    watcher.scanOnce();
    const snap = watcher.snapshot();
    assert.equal(snap.agents[0]!.status, 'error');
    assert.equal(snap.active, false);
  });

  it('flips a Workflow spawn from a queue-operation enqueue line', () => {
    parentLine(wfSpawn('toolu_wf_1'));
    parentLine(wfLaunchResult('toolu_wf_1'));
    watcher.scanOnce();
    parentLine({
      type: 'queue-operation',
      operation: 'enqueue',
      content: taskNotification('toolu_wf_1', 'completed'),
    });
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents[0]!.status, 'done');
    assert.equal(watcher.snapshot().active, false);
  });

  it('ignores queued content that is not a task-notification', () => {
    parentLine(wfSpawn('toolu_wf_1'));
    parentLine(wfLaunchResult('toolu_wf_1'));
    watcher.scanOnce();
    parentLine({ type: 'queue-operation', operation: 'enqueue', content: '用户排队发的普通消息' });
    parentLine({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', prompt: '另一条普通消息' } });
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents[0]!.status, 'running', 'non-notification queue content must not flip the spawn');
  });

  it('Workflow tool_result with is_error marks error without waiting for a notification', () => {
    parentLine(wfSpawn('toolu_wf_1'));
    watcher.scanOnce();
    parentLine(wfLaunchResult('toolu_wf_1', true));
    watcher.scanOnce();
    const snap = watcher.snapshot();
    assert.equal(snap.agents[0]!.status, 'error');
    assert.equal(snap.agents[0]!.lastAction, 'failed');
    assert.equal(snap.active, false);
  });

  it('parses incrementally — appended lines picked up, no double counting', () => {
    agentLine('agent-a1.jsonl', { type: 'user', message: { role: 'user', content: '任务 A' } });
    watcher.scanOnce();
    // Partial line (no trailing newline) must be held back, not parsed.
    fs.appendFileSync(path.join(dir, 'agent-a1.jsonl'), '{"type":"assistant","mess', 'utf8');
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents.length, 1);
    assert.equal(watcher.snapshot().agents[0]!.lastAction, undefined);

    // Complete the line → now it parses.
    fs.appendFileSync(path.join(dir, 'agent-a1.jsonl'),
      'age":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Write","input":{"file_path":"digests/R001.md"}}]}}\n', 'utf8');
    watcher.scanOnce();
    assert.equal(watcher.snapshot().agents[0]!.lastAction, 'Write digests/R001.md');
  });

  it('emits throttled activity snapshots to the callback', async () => {
    const events: ActivityInfo[] = [];
    const w = new TranscriptWatcher(dir, SESSION, (a) => events.push(a), 10);
    agentLine('agent-a1.jsonl', { type: 'user', message: { role: 'user', content: '任务' } });
    w.scanOnce();
    await new Promise((r) => setTimeout(r, 50));
    w.stop();
    assert.ok(events.length >= 1, 'at least one throttled emission');
    assert.equal(events[events.length - 1]!.active, true);
  });

  it('finalize flips running workers to done', () => {
    agentLine('agent-a1.jsonl', { type: 'user', message: { role: 'user', content: '任务' } });
    watcher.scanOnce();
    const final = watcher.finalize();
    assert.equal(final.active, false);
    assert.equal(final.agents[0]!.status, 'done');
  });
});

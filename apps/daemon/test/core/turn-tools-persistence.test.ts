// 工具事件随 turn 持久化（历史会话产出恢复的数据链）：
// ① TurnTextCollector 装配 use/result 对、flush 快照交付、turn 间隔离
// ② upsertMessage(tools) → listMessages 往返解析（events_json 通道）
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnTextCollector } from '../../src/core/turn-text-collector.js';
import { openDatabase, closeDatabase, createProject, createConversation, upsertMessage, listMessages } from '../../src/core/db.js';
import type { ChatMessage } from '@molio/contracts';

describe('TurnTextCollector — tool event assembly', () => {
  it('assembles use/result pairs and delivers them with the turn text', () => {
    const seen: Array<{ text: string; tools: unknown[]; runId: string }> = [];
    const c = new TurnTextCollector('run-1', (text, tools, runId) => seen.push({ text, tools, runId }));

    c.append('归档完成。');
    c.addToolUse({ id: 'w1', name: 'Write', input: { file_path: '/vault/wiki/hot.md' } });
    c.addToolUse({ id: 'w2', name: 'Edit', input: { file_path: '/vault/wiki/INDEX.md' } });
    c.addToolResult({ toolUseId: 'w1', content: '已写入', isError: false });
    c.addToolResult({ toolUseId: 'w2', content: 'boom', isError: true });
    assert.equal(c.flush(), true);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.text, '归档完成。');
    assert.deepEqual(seen[0]!.tools.map((t: any) => [t.id, t.status, t.isError ?? null]), [
      ['w1', 'done', null],
      ['w2', 'done', true],
    ]);
    assert.equal((seen[0]!.tools[0] as any).result, '已写入');
    assert.equal(seen[0]!.runId, 'run-1');
  });

  it('tool-only turns deliver without text; empty turns do not fire', () => {
    const seen: Array<{ text: string; tools: unknown[] }> = [];
    const c = new TurnTextCollector('run-2', (text, tools) => seen.push({ text, tools }));

    // 纯噪音：无文本无工具 → 不触发
    c.append('   ');
    assert.equal(c.flush(), false);

    // 只有工具没有正文 → 照常交付（写文件但不说话的 turn 也该有过程记录）
    c.addToolUse({ id: 't1', name: 'Write', input: {} });
    c.addToolResult({ toolUseId: 't1', content: 'ok' });
    assert.equal(c.flush(), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.text, '');
    assert.equal(seen[0]!.tools.length, 1);
  });

  it('snapshot + clear per flush keeps multi-turn runs turn-scoped', () => {
    const seen: number[] = [];
    const c = new TurnTextCollector('run-3', (_t, tools) => seen.push(tools.length));

    c.addToolUse({ id: 'a', name: 'Read', input: {} });
    c.addToolResult({ toolUseId: 'a', content: 'x' });
    c.append('第一轮');
    c.flush();
    // 第二轮从零开始，不携带第一轮的工具
    c.addToolUse({ id: 'b', name: 'Grep', input: {} });
    c.addToolResult({ toolUseId: 'b', content: 'y' });
    c.append('第二轮');
    c.flush();

    assert.deepEqual(seen, [1, 1]);
  });

  it('orphan results (use never seen) are ignored; duplicate uses dedupe in place', () => {
    const seen: unknown[][] = [];
    const c = new TurnTextCollector('run-4', (_t, tools) => seen.push(tools));
    c.addToolResult({ toolUseId: 'ghost', content: '??' }); // 无主结果
    c.addToolUse({ id: 'dup', name: 'Bash', input: {} });
    c.addToolUse({ id: 'dup', name: 'Bash', input: {} }); // 重放同 id
    c.addToolResult({ toolUseId: 'dup', content: 'done' });
    c.flush();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.length, 1); // ghost 未计入、dup 未重复
  });
});

describe('assistant message tools roundtrip through events_json', () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-turn-tools-'));
    db = openDatabase(dir);
  });
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('upsertMessage stores tools; listMessages parses them back', () => {
    const project = createProject(db, 'p');
    const conv = createConversation(db, project.id!, 't');

    upsertMessage(db, conv.id, {
      id: 'a1',
      role: 'assistant',
      content: '完成。',
      timestamp: Date.now(),
      runId: 'r1',
      tools: [
        { id: 'w1', name: 'Write', input: { file_path: '/vault/wiki/hot.md' }, status: 'done', result: '已写入', isError: true },
      ],
    } as ChatMessage);

    const msgs = listMessages(db, conv.id);
    const a1 = msgs.find((m) => m.id === 'a1');
    assert.ok(a1?.tools);
    assert.equal(a1.tools!.length, 1);
    assert.equal(a1.tools![0]!.name, 'Write');
    assert.equal(a1.tools![0]!.status, 'done');
    assert.equal(a1.tools![0]!.isError, true);
  });
});

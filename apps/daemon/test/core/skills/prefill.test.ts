import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePrefillResponse, prefillFromContent } from '../../../src/core/skills/prefill.js';
import type { RunManager } from '../../../src/core/RunManager.js';

const FALLBACK_CONTENT = 'original message content';

describe('skills/prefill parsePrefillResponse', () => {
  it('parses direct JSON', () => {
    const raw = JSON.stringify({ name: '排版', description: '排版文章', instructions: '用 doocs 排版' });
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, '排版');
    assert.equal(result.description, '排版文章');
    assert.equal(result.instructions, '用 doocs 排版');
    assert.ok(!result.fallback);
  });

  it('parses JSON inside a ```json code fence', () => {
    const raw = '```json\n{"name":"A","description":"B","instructions":"C"}\n```';
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, 'A');
    assert.equal(result.instructions, 'C');
  });

  it('parses JSON inside a bare ``` code fence', () => {
    const raw = '```\n{"name":"A","description":"B","instructions":"C"}\n```';
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, 'A');
  });

  it('extracts JSON embedded in prose (first { to last })', () => {
    const raw = '好的，这是技能定义：{"name":"X","description":"Y","instructions":"Z"} 希望有用。';
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, 'X');
    assert.equal(result.instructions, 'Z');
  });

  it('falls back when JSON is malformed', () => {
    const result = parsePrefillResponse('{ this is not json', FALLBACK_CONTENT);
    assert.ok(result.fallback);
    assert.equal(result.instructions, FALLBACK_CONTENT);
    assert.equal(result.name, '未命名技能');
  });

  it('falls back on empty input', () => {
    const result = parsePrefillResponse('   ', FALLBACK_CONTENT);
    assert.ok(result.fallback);
    assert.equal(result.instructions, FALLBACK_CONTENT);
  });

  it('uses fallback instructions when the instructions field is empty', () => {
    const raw = JSON.stringify({ name: 'N', description: 'D', instructions: '' });
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, 'N');
    assert.equal(result.instructions, FALLBACK_CONTENT);
  });
});

describe('skills/prefill prefillFromContent', () => {
  it('falls back to os.tmpdir() as the run cwd when the scratch dir is uncreatable', async () => {
    // Regression: a corrupted ~/.molio (a regular FILE where the dir should be)
    // made mkdirSync throw ENOTDIR inside the promise executor — the throw
    // rejected the prefill promise and the route 500'd instead of returning the
    // editable fallback form. ensureScratchCwd must degrade to os.tmpdir().
    const blockedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-prefill-block-'));
    const blockedAsFile = path.join(blockedHome, 'molio');
    fs.writeFileSync(blockedAsFile, 'blocked', 'utf8'); // a file, not a dir
    try {
      let capturedCwd: string | undefined;
      const cancelled: string[] = [];
      const runManager = {
        createRun: (o: { cwd?: string; onTurnComplete?: (text: string) => void }) => {
          capturedCwd = o.cwd;
          // 真实 RunManager 的 onTurnComplete 由流事件驱动，永远在 createRun
          // 返回之后异步触发。这里若同步触发，settle() 会赶在 prefill 内部
          // timeout 定时器赋值之前执行，留下 30s 悬挂定时器拖住测试进程
          // （此文件曾在全量并行下因此撞上 --test-timeout=30000 被判 flaky）。
          queueMicrotask(() =>
            o.onTurnComplete?.(JSON.stringify({ name: 'N', description: 'D', instructions: 'I' })),
          );
          return Promise.resolve('run-1');
        },
        onEvent: () => () => {},
        cancelRun: (id: string) => {
          cancelled.push(id);
        },
      } as unknown as RunManager;

      const result = await prefillFromContent('content', runManager, { molioHome: blockedAsFile });
      // queueMicrotask 排在 createRun 返回的 .then() 反应之前：settle()
      // 执行时 runId 仍是 null，cancel 实际走 .then() 里的孤儿取消分支
      // （与修复前同一条路径，覆盖不变）。真实 RunManager 的回调是宏任务，
      // 排在 .then() 之后，走 settle 内的正常取消路径——该路径目前无测试
      // 覆盖（既有空洞，不在本文件范围）。drain 队列让 cancel 对断言可见。
      await new Promise((r) => setImmediate(r));

      assert.equal(capturedCwd, os.tmpdir(), 'scratch cwd falls back to os.tmpdir()');
      assert.equal(result.name, 'N');
      assert.equal(result.instructions, 'I');
      assert.ok(!result.fallback, 'a good AI reply still parses');
      // settle() cancels the throwaway run once it has an id.
      assert.deepEqual(cancelled, ['run-1']);
    } finally {
      fs.rmSync(blockedHome, { recursive: true, force: true });
    }
  });
});

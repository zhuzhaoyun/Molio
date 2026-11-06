/**
 * CLI 端到端集成测试 — 直调 runCli（含顶层错误映射），断言 stdout/stderr/退出码。
 * 负面用例全覆盖：daemon down→1、文件 404→3、413→4、run failed→6、用法错→5、超时→7。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { runCliCaptured, startHarness, type Harness } from './helpers.js';

/** stdout 按单个 JSON 值解析（输出约定的硬断言）。 */
function parseStdoutJson(stdout: string): Record<string, unknown> & { [k: string]: unknown } {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe('CLI 顶层', () => {
  it('--version / help / 未知命令', async () => {
    const v = await runCliCaptured(['--version']);
    assert.equal(v.code, 0);
    assert.match(v.stdout, /^\d+\.\d+\.\d+/);

    const help = await runCliCaptured(['help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /molio kb/);

    const unknown = await runCliCaptured(['nope']);
    assert.equal(unknown.code, 5);
    assert.match(unknown.stderr, /未知命令/);
  });

  it('kb 无子命令 / kb help', async () => {
    const none = await runCliCaptured(['kb']);
    assert.equal(none.code, 5);
    assert.match(none.stdout, /molio kb — 知识库操作/);

    const help = await runCliCaptured(['kb', 'help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /kb ask/);
  });
});

describe('CLI + fake daemon', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.teardown();
  });

  it('status：文本与 --json', async () => {
    const text = await runCliCaptured(['status']);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /daemon: ok/);
    assert.match(text.stdout, /工作库/);

    const json = await runCliCaptured(['status', '--json']);
    const data = parseStdoutJson(json.stdout);
    assert.equal((data['daemon'] as { status: string }).status, 'ok');
    assert.equal((data['activeVault'] as { id: string }).id, 'v1');
  });

  it('kb vaults：表格与 --json', async () => {
    const text = await runCliCaptured(['kb', 'vaults']);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /工作库/);
    assert.match(text.stdout, /\(当前\)/);

    const json = await runCliCaptured(['kb', 'vaults', '--json']);
    const data = parseStdoutJson(json.stdout);
    assert.equal((data['vaults'] as unknown[]).length, 2);
  });

  it('kb tree：默认 active vault；--vault 按名称', async () => {
    const text = await runCliCaptured(['kb', 'tree']);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /知识库「工作库」文件树/);
    assert.match(text.stdout, /notes\//);

    const byName = await runCliCaptured(['kb', 'tree', '--vault', 'notes', '--json']);
    assert.equal(byName.code, 0);
    assert.equal((parseStdoutJson(byName.stdout)['vault'] as { id: string }).id, 'v2');
  });

  it('kb read：文本内容进 stdout', async () => {
    const text = await runCliCaptured(['kb', 'read', 'notes/a.md']);
    assert.equal(text.code, 0);
    assert.equal(text.stdout, '# 标题\n内容正文\n');
  });

  it('kb read --json：完整 FileContent', async () => {
    const json = await runCliCaptured(['kb', 'read', 'notes/a.md', '--json']);
    const data = parseStdoutJson(json.stdout);
    const file = data['file'] as { content: string; mimeType?: string };
    assert.equal(file.content, '# 标题\n内容正文');
    assert.equal(file.mimeType, 'text/markdown');
  });

  it('kb read：404 → 3；413 → 4；200+tooLarge → 4 提示 --force；二进制 → 0 + stderr', async () => {
    const missing = await runCliCaptured(['kb', 'read', 'no/such.md']);
    assert.equal(missing.code, 3);
    assert.match(missing.stderr, /文件不存在/);

    h.daemon.files.set('v1:big/huge.md', {
      path: 'big/huge.md',
      content: '',
      size: 999,
      modifiedAt: 1,
      mimeType: 'text/markdown',
      refuse413: true,
    });
    const refused = await runCliCaptured(['kb', 'read', 'big/huge.md']);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /文件过大/);

    h.daemon.files.set('v1:big/soft.md', {
      path: 'big/soft.md',
      content: '',
      size: 888,
      modifiedAt: 1,
      mimeType: 'text/markdown',
      tooLarge: true,
    });
    const tooLarge = await runCliCaptured(['kb', 'read', 'big/soft.md']);
    assert.equal(tooLarge.code, 4);
    assert.match(tooLarge.stderr, /--force/);

    const binary = await runCliCaptured(['kb', 'read', 'img/logo.png']);
    assert.equal(binary.code, 0);
    assert.equal(binary.stdout, '');
    assert.match(binary.stderr, /二进制文件/);
  });

  it('kb read：缺路径参数 → 5', async () => {
    const usage = await runCliCaptured(['kb', 'read']);
    assert.equal(usage.code, 5);
    assert.match(usage.stderr, /缺少文件相对路径/);
  });

  it('kb search：行格式、空结果、截断提示、limit 透传', async () => {
    const ok = await runCliCaptured(['kb', 'search', '内容 正文', '--limit', '5']);
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout, 'notes/a.md: …内容正文…\n');
    assert.equal(h.daemon.lastSearchQuery?.limit, '5');

    h.daemon.searchResponse = { results: [], truncated: false };
    const empty = await runCliCaptured(['kb', 'search', '没有']);
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, '');
    assert.match(empty.stderr, /未找到/);

    h.daemon.searchResponse = {
      results: [{ filePath: 'a.md', fileName: 'a.md', snippet: 'x' }],
      truncated: true,
    };
    const truncated = await runCliCaptured(['kb', 'search', 'x']);
    assert.match(truncated.stderr, /已截断/);
    h.daemon.searchResponse = {
      results: [{ filePath: 'notes/a.md', fileName: 'a.md', snippet: '…内容正文…' }],
      truncated: false,
    };
  });

  it('kb search --json / 非法 limit → 5', async () => {
    const json = await runCliCaptured(['kb', 'search', '内容', '--json']);
    const data = parseStdoutJson(json.stdout);
    assert.equal(data['query'], '内容');
    assert.equal((data['results'] as unknown[]).length, 1);

    const bad = await runCliCaptured(['kb', 'search', 'x', '--limit', 'abc']);
    assert.equal(bad.code, 5);
    assert.match(bad.stderr, /正整数/);
  });

  it('kb ask 同步：流式增量实时进 stdout', async () => {
    h.daemon.nextRunScript = {
      events: [
        { type: 'text_delta', delta: '答案' },
        { type: 'text_delta', delta: '正文' },
      ],
      eventIntervalMs: 5,
      finalStatus: 'succeeded',
    };
    const r = await runCliCaptured(['kb', 'ask', '什么 是知识库']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '答案正文\n'); // 增量 + 结尾补换行
    assert.equal(h.daemon.lastCreateRunRequest?.message, '什么 是知识库');
  });

  it('kb ask --json：终态汇总单个 JSON 值', async () => {
    h.daemon.nextRunScript = {
      events: [{ type: 'text_delta', delta: 'JSON 答案' }],
      eventIntervalMs: 5,
      finalStatus: 'succeeded',
    };
    const r = await runCliCaptured(['kb', 'ask', 'q', '--json']);
    assert.equal(r.code, 0);
    const data = parseStdoutJson(r.stdout);
    assert.equal(data['status'], 'succeeded');
    assert.equal(data['answer'], 'JSON 答案');
    assert.ok(data['runId']);
  });

  it('kb ask --async：秒回 runId + stderr 取答提示', async () => {
    h.daemon.nextRunScript = { finalStatus: 'succeeded' };
    const r = await runCliCaptured(['kb', 'ask', 'q', '--async']);
    assert.equal(r.code, 0);
    const runId = r.stdout.trim();
    assert.match(runId, /^run-\d+$/);
    assert.match(r.stderr, new RegExp(`kb result ${runId} --wait`));

    const j = await runCliCaptured(['kb', 'ask', 'q', '--async', '--json']);
    const data = parseStdoutJson(j.stdout);
    assert.ok(data['runId']);
    assert.ok(data['conversationId']);
  });

  it('kb ask：run 失败 → 6', async () => {
    h.daemon.nextRunScript = { finalStatus: 'failed', finalError: '模型配额用尽' };
    const r = await runCliCaptured(['kb', 'ask', 'q']);
    assert.equal(r.code, 6);
    assert.match(r.stderr, /模型配额用尽/);
  });

  it('kb ask：流卡死 → --timeout 超时退出 7', async () => {
    h.daemon.nextRunScript = {}; // 永不终态
    const r = await runCliCaptured(['kb', 'ask', 'q', '--timeout', '1']);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /问答超时/);
  });

  it('kb result：非终态单次查询 → 打印状态退出 0', async () => {
    h.daemon.nextRunScript = { finalStatus: 'succeeded' };
    const started = await runCliCaptured(['kb', 'ask', 'q', '--async']);
    const runId = started.stdout.trim();
    const r = await runCliCaptured(['kb', 'result', runId]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'pending');
    assert.match(r.stderr, /仍在执行/);
  });

  it('kb result --wait：轮询到终态取答；--json 输出完整结果', async () => {
    h.daemon.nextRunScript = {
      finalStatus: 'succeeded',
      conversationMessages: [
        { id: 'm1', role: 'user', content: 'q', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: '等到的答案', timestamp: 2 },
      ],
    };
    const started = await runCliCaptured(['kb', 'ask', 'q', '--async']);
    assert.equal(started.code, 0, `ask --async 应成功: ${started.stderr}`);
    const runId = started.stdout.trim();
    assert.match(runId, /^run-\d+$/, `stdout 应为裸 runId，实际: ${JSON.stringify(started.stdout)}`);
    // 300ms 后置终态；--wait 以 2s 间隔轮询，首轮 pending 后应等到
    setTimeout(() => h.daemon.finishRun(runId, 'succeeded'), 300);
    const r = await runCliCaptured(['kb', 'result', runId, '--wait', '--json']);
    assert.equal(r.code, 0, `result --wait 应成功: ${r.stderr}`);
    const data = parseStdoutJson(r.stdout);
    assert.equal(data['status'], 'succeeded');
    assert.equal(data['answer'], '等到的答案');
  });

  it('kb result：run 失败 → 6；run 丢失 → 6', async () => {
    h.daemon.nextRunScript = { finalStatus: 'failed', finalError: '崩了' };
    const started = await runCliCaptured(['kb', 'ask', 'q', '--async']);
    assert.equal(started.code, 0, `ask --async 应成功: ${started.stderr}`);
    const runId = started.stdout.trim();
    assert.match(runId, /^run-\d+$/, `stdout 应为裸 runId，实际: ${JSON.stringify(started.stdout)}`);
    h.daemon.finishRun(runId, 'failed', '崩了');
    const failed = await runCliCaptured(['kb', 'result', runId]);
    assert.equal(failed.code, 6);
    assert.match(failed.stderr, /崩了/);

    const gone = await runCliCaptured(['kb', 'result', 'run-404']);
    assert.equal(gone.code, 6);
    assert.match(gone.stderr, /不存在或已过期/);
  });
});

describe('CLI daemon 不可达', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    await h.daemon.stop(); // 保留 env 指向已关闭端口
  });
  after(async () => {
    delete process.env['MOLIO_DAEMON_URL'];
  });

  it('status / kb vaults → 退出码 1 + 可读提示', async () => {
    for (const argv of [['status'], ['kb', 'vaults'], ['kb', 'tree']]) {
      const r = await runCliCaptured(argv);
      assert.equal(r.code, 1, `argv=${argv.join(' ')}`);
      assert.match(r.stderr, /无法连接 Molio 守护进程/);
    }
  });
});

/**
 * dsh-plugin-molio 工具集成测试 — FakeDaemon（真实 HTTP）驱动每个工具的
 * execute：成功路径 + daemon 不可达 + 404/413 + vault 解析 + limit 校验。
 * 遵循仓库「集成测试要求」：mock 外部依赖的行为而非返回值。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { DaemonClient } from '../src/daemon-client.js';
import { DaemonError, daemonErrorMessage } from '../src/errors.js';
import { apply, inject, name as pluginName } from '../src/index.js';
import { FakeDaemon } from './fake-daemon.js';
import { capturingContext, fakeExec, getTool } from './helpers.js';

const daemon = new FakeDaemon();
let client: DaemonClient;
let tools: ToolDefinition[];

async function run(toolName: string, args: unknown): Promise<unknown> {
  return getTool(tools, toolName).execute(args, fakeExec(toolName, args));
}

async function runFails(toolName: string, args: unknown): Promise<string> {
  try {
    await run(toolName, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`${toolName} 应当失败但成功了`);
}

before(async () => {
  const baseUrl = await daemon.start();
  client = new DaemonClient(baseUrl);
  const cap = capturingContext();
  // apply 内部自建 DaemonClient（走 env），测试改为直接逐个注册同一套工具函数
  // 到捕获 ctx —— 与 apply 相同的注册面，只是 client 可注入。
  const { registerMolioStatus } = await import('../src/tools/molio-status.js');
  const { registerKbVaults } = await import('../src/tools/kb-vaults.js');
  const { registerKbTree } = await import('../src/tools/kb-tree.js');
  const { registerKbSearch } = await import('../src/tools/kb-search.js');
  const { registerKbRead } = await import('../src/tools/kb-read.js');
  registerMolioStatus(cap.ctx, client);
  registerKbVaults(cap.ctx, client);
  registerKbTree(cap.ctx, client);
  registerKbSearch(cap.ctx, client);
  registerKbRead(cap.ctx, client);
  tools = cap.registered;
});

after(async () => {
  await daemon.stop();
});

describe('插件入口', () => {
  it('导出 cordis 约定字段', () => {
    assert.equal(pluginName, 'molio-kb');
    assert.deepEqual(inject, ['tools']);
    assert.equal(typeof apply, 'function');
  });

  it('apply 注册全部 5 个只读工具', () => {
    const cap = capturingContext();
    apply(cap.ctx);
    assert.deepEqual(
      cap.registered.map((t) => t.name).sort(),
      [
        'molio_kb_read',
        'molio_kb_search',
        'molio_kb_tree',
        'molio_kb_vaults',
        'molio_status',
      ],
    );
  });

  it('每个工具都声明 output.render 与并发安全分类', () => {
    // defineTool 的 isConcurrencySafe 包装器先做参数 schema 校验（不合法参数
    // 一律 false），所以这里必须按工具传各自合法的最小参数。
    const validArgs: Record<string, unknown> = {
      molio_kb_search: { query: 'x' },
      molio_kb_read: { path: 'notes/a.md' },
    };
    for (const t of tools) {
      assert.equal(typeof t.output.render, 'function', `${t.name} 缺 output.render`);
      const blocks = t.output.render({}, { ok: 1 });
      assert.equal(blocks[0]?.type, 'text', `${t.name} render 应产出 text block`);
      assert.equal(
        t.isConcurrencySafe?.(validArgs[t.name] ?? {}),
        true,
        `${t.name} 只读工具应并发安全`,
      );
      assert.ok((t.timeoutMs ?? 0) > 0, `${t.name} 应声明 timeoutMs`);
    }
  });
});

describe('molio_status', () => {
  it('返回 daemon 健康 + 激活知识库', async () => {
    const value = (await run('molio_status', {})) as {
      daemon: { status: string; version: string };
      activeVault: { id: string } | null;
    };
    assert.equal(value.daemon.status, 'ok');
    assert.equal(value.daemon.version, '0.1.0-test');
    assert.equal(value.activeVault?.id, 'v1');
  });

  it('daemon 不可达 → 可操作中文错误（含 MOLIO_DAEMON_URL 提示）', async () => {
    const dead = new DaemonClient('http://127.0.0.1:1');
    const cap = capturingContext();
    const { registerMolioStatus } = await import('../src/tools/molio-status.js');
    registerMolioStatus(cap.ctx, dead);
    const tool = getTool(cap.registered, 'molio_status');
    await assert.rejects(
      () => tool.execute({}, fakeExec('molio_status', {})),
      (err: Error) => {
        assert.match(err.message, /无法连接 Molio 守护进程/);
        assert.match(err.message, /MOLIO_DAEMON_URL/);
        return true;
      },
    );
  });
});

describe('molio_kb_vaults', () => {
  it('列出全部知识库 + activeVaultId', async () => {
    const value = (await run('molio_kb_vaults', {})) as {
      vaults: Array<{ id: string }>;
      activeVaultId: string | null;
    };
    assert.equal(value.vaults.length, 2);
    assert.equal(value.activeVaultId, 'v1');
  });
});

describe('molio_kb_tree', () => {
  it('缺省用激活知识库', async () => {
    const value = (await run('molio_kb_tree', {})) as {
      vault: { id: string; name: string };
      tree: unknown[];
    };
    assert.equal(value.vault.id, 'v1');
    assert.equal(value.vault.name, '工作库');
    assert.equal(value.tree.length, 1);
  });

  it('vaultId 参数接受名称（忽略大小写）', async () => {
    const value = (await run('molio_kb_tree', { vaultId: 'notes' })) as {
      vault: { id: string };
    };
    assert.equal(value.vault.id, 'v2');
  });

  it('未知知识库 → 错误列出可用库', async () => {
    const msg = await runFails('molio_kb_tree', { vaultId: '不存在' });
    assert.match(msg, /未找到知识库「不存在」/);
    assert.match(msg, /工作库/);
  });

  it('无激活库且未指定 → 明确提示', async () => {
    const prev = daemon.activeVaultId;
    daemon.activeVaultId = null;
    try {
      const msg = await runFails('molio_kb_tree', {});
      assert.match(msg, /没有打开的知识库/);
    } finally {
      daemon.activeVaultId = prev;
    }
  });
});

describe('molio_kb_search', () => {
  it('返回命中结果', async () => {
    const value = (await run('molio_kb_search', { query: '内容' })) as {
      vault: { id: string };
      query: string;
      results: Array<{ filePath: string }>;
      truncated: boolean;
    };
    assert.equal(value.query, '内容');
    assert.equal(value.results[0]?.filePath, 'notes/a.md');
    assert.equal(value.truncated, false);
  });

  it('truncated 时附带 hint', async () => {
    const prev = daemon.searchResponse;
    daemon.searchResponse = { results: prev.results, truncated: true };
    try {
      const value = (await run('molio_kb_search', { query: 'x' })) as { hint?: string };
      assert.match(value.hint ?? '', /结果已截断/);
    } finally {
      daemon.searchResponse = prev;
    }
  });

  it('limit 越界 → 校验错误（不发请求）', async () => {
    const msg = await runFails('molio_kb_search', { query: 'x', limit: 999 });
    assert.match(msg, /limit 必须是 1\.\.100/);
  });

  it('同名多库 → 要求用 id 指定', async () => {
    const prev = daemon.vaults;
    daemon.vaults = [
      { id: 'a1', name: 'Dup', path: '/p1', fileCount: 0, createdAt: 1 },
      { id: 'a2', name: 'dup', path: '/p2', fileCount: 0, createdAt: 2 },
    ];
    try {
      const msg = await runFails('molio_kb_search', { query: 'x', vaultId: 'DUP' });
      assert.match(msg, /有多个匹配/);
    } finally {
      daemon.vaults = prev;
    }
  });
});

describe('molio_kb_read', () => {
  it('读文本文件', async () => {
    const value = (await run('molio_kb_read', { path: 'notes/a.md' })) as {
      kind: string;
      file: { content: string };
    };
    assert.equal(value.kind, 'text');
    assert.match(value.file.content, /内容正文/);
  });

  it('二进制文件 → 说明而非内容', async () => {
    const value = (await run('molio_kb_read', { path: 'img/logo.png' })) as {
      kind: string;
      message: string;
    };
    assert.equal(value.kind, 'binary');
    assert.match(value.message, /image\/png/);
  });

  it('文件不存在 → 中文错误', async () => {
    const msg = await runFails('molio_kb_read', { path: 'nope.md' });
    assert.match(msg, /文件不存在: nope\.md/);
  });

  it('413 拒绝档 → 文件过大错误', async () => {
    const msg = await runFails('molio_kb_read', { path: 'big/refuse.md' });
    assert.match(msg, /文件过大/);
  });

  it('200+tooLarge 降级档 → 提示 force，force:true 可读', async () => {
    const msg = await runFails('molio_kb_read', { path: 'big/huge.md' });
    assert.match(msg, /force:true/);
    const value = (await run('molio_kb_read', { path: 'big/huge.md', force: true })) as {
      kind: string;
    };
    assert.equal(value.kind, 'text');
  });
});

describe('错误映射', () => {
  it('TIMEOUT → 带原始信息的中文消息', () => {
    const msg = daemonErrorMessage(new DaemonError('TIMEOUT', 'GET /api/health 超过 5000ms'));
    assert.match(msg, /请求 Molio 守护进程超时/);
  });

  it('NOT_FOUND / HTTP_ERROR → 原样消息', () => {
    assert.equal(daemonErrorMessage(new DaemonError('NOT_FOUND', '文件不存在')), '文件不存在');
  });
});

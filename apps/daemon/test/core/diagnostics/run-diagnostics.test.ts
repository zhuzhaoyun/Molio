import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  createDiagnosticsDeps,
  renderDiagnosticsBody,
  renderDiagnosticsText,
  runDiagnostics,
  withTimeout,
} from '../../../src/core/diagnostics/run-diagnostics.js';
import { EXIT_KILLED, START, UPD_FAIL, WATCH_FAIL, makeDeps } from './fixtures.js';

/**
 * 体检编排（runDiagnostics）与纯文本渲染的单测：
 * 依赖全部走 fixtures.makeDeps（毫秒级超时、固定时间），不碰真实文件系统与网络。
 * 渲染断言按 task brief 的纯文本样例逐行比对。
 */

describe('runDiagnostics 编排', () => {
  it('runDiagnostics: 各检查项按级别排序，error 在前', async () => {
    const r = await runDiagnostics(makeDeps({ readMainLog: () => [UPD_FAIL, UPD_FAIL, UPD_FAIL, EXIT_KILLED] }));
    assert.deepEqual(r.items.slice(0, 2).map((i) => [i.code, i.level]), [['update.channel', 'error'], ['daemon.exits', 'error']]);
  });

  it('runDiagnostics: 没有主进程日志时更新与后台退出项为 skip，其余照常', async () => {
    const r = await runDiagnostics(makeDeps({ readMainLog: () => null }));
    assert.equal(r.items.find((i) => i.code === 'update.channel')?.level, 'skip');
    assert.equal(r.items.find((i) => i.code === 'daemon.exits')?.level, 'skip');
    assert.equal(r.items.find((i) => i.code === 'vaults')?.level, 'ok');
  });

  it('runDiagnostics: 日志文件为空同样按没有日志处理', async () => {
    const r = await runDiagnostics(makeDeps({ readMainLog: () => [] }));
    assert.equal(r.items.find((i) => i.code === 'update.channel')?.level, 'skip');
    assert.equal(r.items.find((i) => i.code === 'daemon.exits')?.level, 'skip');
  });

  it('runDiagnostics: 安全软件查询挂起 → 该项 skip，其余项不受影响', async () => {
    const r = await runDiagnostics(makeDeps({ listSecuritySoftware: () => new Promise(() => {}) }));
    assert.equal(r.items.find((i) => i.code === 'system.security-software')?.level, 'skip');
    assert.equal(r.items.find((i) => i.code === 'runtime.agents')?.level, 'ok');
  });

  it('runDiagnostics: 本次启动有监听失败记录的知识库报 vault.watch', async () => {
    const watchVault = { id: '3edb6697-1', name: '示例', path: '/vaults/demo', fileCount: 3, createdAt: 0 };
    // Starting daemon 之后的监听失败才算本次启动的
    const r = await runDiagnostics(makeDeps({ readMainLog: () => [START, WATCH_FAIL], listVaults: () => [watchVault] }));
    const item = r.items.find((i) => i.code === 'vault.watch');
    assert.ok(item);
    assert.equal(item.level, 'warn');
    assert.equal(item.subject, '示例');

    // 监听失败在 Starting daemon 之前 → 上一次启动留下的，不算
    const r2 = await runDiagnostics(makeDeps({ readMainLog: () => [WATCH_FAIL, START], listVaults: () => [watchVault] }));
    assert.equal(r2.items.find((i) => i.code === 'vault.watch'), undefined);
  });

  it('runDiagnostics: 报告带版本、平台与安装目录', async () => {
    const withLog = await runDiagnostics(makeDeps({ env: { MOLIO_APP_VERSION: '0.4.7', MOLIO_MAIN_LOG_DIR: '/x' } }));
    assert.equal(withLog.version, '0.4.7');
    assert.equal(withLog.installDir, path.dirname(process.execPath));
    assert.equal(withLog.platform, 'win32 x64');
    assert.equal((await runDiagnostics(makeDeps())).installDir, null);
  });

  it('runDiagnostics: 同步探测自身抛错按 null 处理', async () => {
    const r = await runDiagnostics(makeDeps({ pathExists: () => { throw new Error('boom'); } }));
    assert.equal(r.items.find((i) => i.code === 'vault.missing'), undefined);
    assert.notEqual(r.items.find((i) => i.code === 'vaults')?.level, 'error');
  });

  it('runDiagnostics: listVaults 抛错按空列表处理', async () => {
    // 体检正是为「生病的机器」准备的：DB 锁死/损坏时报告必须照常出，
    // 只是没有库相关条目——单项失败或超时不得影响其他项
    const r = await runDiagnostics(makeDeps({ listVaults: () => { throw new Error('boom'); } }));
    assert.equal(r.items.find((i) => i.code === 'vault.missing'), undefined);
    assert.equal(r.items.find((i) => i.code === 'vault.readonly'), undefined);
    assert.equal(r.items.find((i) => i.code === 'vault.watch'), undefined);
    assert.equal(r.items.find((i) => i.code === 'vaults'), undefined);
    // 数据目录的磁盘项照常产出
    assert.ok(r.items.find((i) => i.code === 'system.disk'));
  });

  it('runDiagnostics: readMainLog 抛错按没有日志处理', async () => {
    // 与 listVaults 同一条兜底约定的对称面：日志读不出 = 没有日志
    const r = await runDiagnostics(makeDeps({ readMainLog: () => { throw new Error('boom'); } }));
    assert.equal(r.items.find((i) => i.code === 'update.channel')?.level, 'skip');
    assert.equal(r.items.find((i) => i.code === 'daemon.exits')?.level, 'skip');
    assert.equal(r.items.find((i) => i.code === 'runtime.agents')?.level, 'ok');
  });
});

describe('withTimeout', () => {
  it('withTimeout: 超时返回兜底值，正常完成返回原值', async () => {
    assert.equal(await withTimeout(Promise.resolve(1), 1000, 0), 1);
    assert.equal(await withTimeout(new Promise<number>(() => {}), 10, 0), 0);
  });
});

describe('纯文本渲染', () => {
  it('renderDiagnosticsText: 分节输出，正常项只列标题，空的节省略', async () => {
    const report = await runDiagnostics(makeDeps({ readMainLog: () => [UPD_FAIL, UPD_FAIL, UPD_FAIL], env: { MOLIO_APP_VERSION: '0.4.7' }, listSecuritySoftware: async () => null, now: () => new Date(2026, 10, 24, 15, 2).getTime() }));
    const text = renderDiagnosticsText(report);
    assert.ok(text.startsWith('Molio 体检结果（2026-11-24 15:02）\n版本：0.4.7 · 平台：win32 x64 · 后台服务已运行 1 小时 2 分\n\n'));
    assert.match(text, /【需要处理】\n1\. 自动更新一直连不上：已连续失败 3 次：网络无法解析更新服务器（断网、代理或 DNS 问题）\n   要做的事：\n   1\) 检查电脑的网络或代理设置是否正常/);
    assert.match(text, /【正常】版本 · 后台服务 · AI 运行时 · 知识库 · 磁盘空间/);
    assert.match(text, /【未能检查】安全软件/);
    assert.ok(!text.includes('【提醒】'));
    // 默认不带 detail；detail 字段是给支持人员看的原始报错
    assert.ok(!text.includes('详情：'));
  });

  it('renderDiagnosticsText: 没有需要处理的项时写「无」', async () => {
    const text = renderDiagnosticsText(await runDiagnostics(makeDeps()));
    assert.match(text, /【需要处理】\n无/);
    // 默认 env 没有版本号 → 版本行写「未知」
    assert.ok(text.includes('版本：未知'));
  });

  it('renderDiagnosticsBody: detail 选项为每个有条目详情的项追加「详情：」行', async () => {
    const report = await runDiagnostics(makeDeps({ readMainLog: () => [UPD_FAIL, UPD_FAIL, UPD_FAIL] }));
    const body = renderDiagnosticsBody(report, { detail: true });
    assert.match(body, /详情：net::ERR_NAME_NOT_RESOLVED/);
    // 正文从【需要处理】起，不含标题两行
    assert.ok(body.startsWith('【需要处理】'));
    assert.ok(!body.includes('Molio 体检结果（'));
  });
});

describe('createDiagnosticsDeps', () => {
  it('createDiagnosticsDeps: 未配置 MOLIO_MAIN_LOG_DIR 时 readMainLog 返回 null', () => {
    const prev = process.env['MOLIO_MAIN_LOG_DIR'];
    delete process.env['MOLIO_MAIN_LOG_DIR'];
    try {
      // readMainLog 不碰 db 与 runManager，最小桩即可
      const deps = createDiagnosticsDeps({ db: {} as Database.Database, runManager: { detectAgentsAsync: async () => [] } });
      assert.equal(deps.readMainLog(), null);
    } finally {
      if (prev === undefined) delete process.env['MOLIO_MAIN_LOG_DIR'];
      else process.env['MOLIO_MAIN_LOG_DIR'] = prev;
    }
  });

  it(
    'createDiagnosticsDeps: 目录不可写时 pathWritable 返回 false',
    { skip: process.platform === 'win32' || process.getuid?.() === 0 },
    () => {
      const deps = createDiagnosticsDeps({ db: {} as Database.Database, runManager: { detectAgentsAsync: async () => [] } });
      const readonly = mkdtempSync(path.join(os.tmpdir(), 'molio-doctor-readonly-'));
      const writable = mkdtempSync(path.join(os.tmpdir(), 'molio-doctor-writable-'));
      chmodSync(readonly, 0o500);
      try {
        assert.equal(deps.pathWritable(readonly), false);
        assert.equal(deps.pathWritable(writable), true);
      } finally {
        chmodSync(readonly, 0o700);
        rmSync(readonly, { recursive: true, force: true });
        rmSync(writable, { recursive: true, force: true });
      }
    },
  );
});

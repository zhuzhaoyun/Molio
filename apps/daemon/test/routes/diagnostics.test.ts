/**
 * GET /api/diagnostics route tests — JSON / 纯文本 / 采集抛错回 500。
 *
 * 编排逻辑（runDiagnostics）的测试在 test/core/diagnostics/；这里只验证
 * HTTP 层：路径与查询分发、content-type、以及出错时显式 500 不悬空。
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { DiagnosticLevel, DiagnosticsReport, SupportBundleResult } from '@molio/contracts';
import { diagnosticsRoutes } from '../../src/routes/diagnostics.js';
import type { DiagnosticsDeps } from '../../src/core/diagnostics/run-diagnostics.js';
import { L, makeDeps } from '../core/diagnostics/fixtures.js';

// 与 contracts 的 DiagnosticLevel 一致：error 最靠前，skip 最后
const LEVEL_RANK: Record<DiagnosticLevel, number> = { error: 0, warn: 1, ok: 2, skip: 3 };

// 子应用要先挂到父应用上再请求，与 server.ts 的挂载方式一致（写法照 test/routes/agents-provider.test.ts）：
// 直接对子应用 request('/api/diagnostics') 会 404——子应用只注册了 '/'。
const makeApp = (overrides?: Partial<DiagnosticsDeps>, routeOpts?: { bundleDir?: string }) =>
  new Hono().route('/api/diagnostics', diagnosticsRoutes(makeDeps(overrides), routeOpts));

describe('GET /api/diagnostics', () => {
  it('GET /api/diagnostics 返回按级别排序的体检报告', async () => {
    const res = await makeApp().request('/api/diagnostics');
    assert.equal(res.status, 200);
    const report = await res.json() as DiagnosticsReport;
    assert.ok(report.items.length > 0);
    assert.ok(LEVEL_RANK[report.items[0]!.level] <= LEVEL_RANK[report.items.at(-1)!.level]);
  });

  it('format=text 返回纯文本', async () => {
    const res = await makeApp().request('/api/diagnostics?format=text');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    assert.ok((await res.text()).startsWith('Molio 体检结果'));
  });

  it('采集过程抛错时返回 500 而不是让连接悬空', async () => {
    // 单项采集抛错（listVaults / readMainLog…）在编排层已按兜底值处理；
    // 这里改用编排本身会抛的依赖（now 在守卫之外同步调用），
    // 保持「编排级失败 → 显式 500」的用例意图不变。
    const res = await makeApp({ now: () => { throw new Error('boom'); } }).request('/api/diagnostics');
    assert.equal(res.status, 500);
  });
});

// 支持包落盘目录：真实写文件，用完即删
const bundleTmp = mkdtempSync(path.join(os.tmpdir(), 'molio-support-bundle-route-'));
after(() => rmSync(bundleTmp, { recursive: true, force: true }));

describe('POST /api/diagnostics/support-bundle', () => {
  it('返回已写好的文件路径', async () => {
    const res = await makeApp(undefined, { bundleDir: bundleTmp }).request('/api/diagnostics/support-bundle', { method: 'POST' });
    assert.equal(res.status, 200);
    const { path: bundlePath } = await res.json() as SupportBundleResult;
    assert.ok(existsSync(bundlePath) && readFileSync(bundlePath, 'utf8').includes('== 体检结果 =='));
  });

  it('只带出末尾 BUNDLE_LOG_LINES 行日志', async () => {
    const lines = Array.from({ length: 305 }, (_, i) =>
      L('2026-11-23T07:40:00.000Z', `[INFO] [main] mark-${String(i).padStart(3, '0')}`),
    );
    const res = await makeApp({ readMainLog: () => lines }, { bundleDir: bundleTmp }).request('/api/diagnostics/support-bundle', { method: 'POST' });
    assert.equal(res.status, 200);
    const { path: bundlePath } = await res.json() as SupportBundleResult;
    const text = readFileSync(bundlePath, 'utf8');
    assert.ok(text.includes('最近 300 行'));
    assert.ok(!text.includes('mark-004') && text.includes('mark-005') && text.includes('mark-304'));
  });

  it('未注入 bundleDir 时用 MOLIO_DOCUMENTS_DIR', async () => {
    const prev = process.env['MOLIO_DOCUMENTS_DIR'];
    process.env['MOLIO_DOCUMENTS_DIR'] = bundleTmp;
    try {
      const res = await makeApp().request('/api/diagnostics/support-bundle', { method: 'POST' });
      assert.equal(res.status, 200);
      const { path: bundlePath } = await res.json() as SupportBundleResult;
      assert.ok(existsSync(bundlePath));
      assert.ok(path.resolve(bundlePath).startsWith(path.resolve(bundleTmp)));
    } finally {
      if (prev === undefined) delete process.env['MOLIO_DOCUMENTS_DIR'];
      else process.env['MOLIO_DOCUMENTS_DIR'] = prev;
    }
  });

  it('生成失败时回 500，形状同 GET', async () => {
    const res = await makeApp({ readMainLog: () => { throw new Error('boom'); } }).request('/api/diagnostics/support-bundle', { method: 'POST' });
    assert.equal(res.status, 500);
    const body = await res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'INTERNAL');
    assert.equal(body.error.message, 'boom');
  });
});

/**
 * GET /api/diagnostics route tests — JSON / 纯文本 / 采集抛错回 500。
 *
 * 编排逻辑（runDiagnostics）的测试在 test/core/diagnostics/；这里只验证
 * HTTP 层：路径与查询分发、content-type、以及出错时显式 500 不悬空。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { DiagnosticLevel, DiagnosticsReport } from '@molio/contracts';
import { diagnosticsRoutes } from '../../src/routes/diagnostics.js';
import type { DiagnosticsDeps } from '../../src/core/diagnostics/run-diagnostics.js';
import { makeDeps } from '../core/diagnostics/fixtures.js';

// 与 contracts 的 DiagnosticLevel 一致：error 最靠前，skip 最后
const LEVEL_RANK: Record<DiagnosticLevel, number> = { error: 0, warn: 1, ok: 2, skip: 3 };

// 子应用要先挂到父应用上再请求，与 server.ts 的挂载方式一致（写法照 test/routes/agents-provider.test.ts）：
// 直接对子应用 request('/api/diagnostics') 会 404——子应用只注册了 '/'。
const makeApp = (overrides?: Partial<DiagnosticsDeps>) => new Hono().route('/api/diagnostics', diagnosticsRoutes(makeDeps(overrides)));

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
    const res = await makeApp({ listVaults: () => { throw new Error('boom'); } }).request('/api/diagnostics');
    assert.equal(res.status, 500);
  });
});

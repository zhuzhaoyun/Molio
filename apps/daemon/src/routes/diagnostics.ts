/**
 * /api/diagnostics — 自助诊断端点。
 *
 * 采集与判定都在 core/diagnostics/（只读、确定性产出）；这里只负责 HTTP：
 * GET 默认回 JSON 供 web 渲染，?format=text 回面向非技术用户的纯文本；
 * POST /support-bundle 生成支持包文件并回落盘路径。
 * 采集抛错必须显式回 500，绝不让连接悬空。
 */

import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { renderDiagnosticsText, runDiagnostics } from '../core/diagnostics/run-diagnostics.js';
import type { DiagnosticsDeps } from '../core/diagnostics/run-diagnostics.js';
import { BUNDLE_LOG_LINES, buildSupportBundle, writeSupportBundle } from '../core/diagnostics/support-bundle.js';

// 支持包落盘目录：测试显式注入 → 用户文档目录（MOLIO_DOCUMENTS_DIR）→ ~/.molio/support
function resolveBundleDir(opts?: { bundleDir?: string }): string {
  const injected = opts?.bundleDir?.trim();
  if (injected) return injected;
  const fromEnv = process.env['MOLIO_DOCUMENTS_DIR']?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.molio', 'support');
}

export function diagnosticsRoutes(deps: DiagnosticsDeps, opts?: { bundleDir?: string }): Hono {
  const app = new Hono();

  const handle = async (c: Context) => {
    try {
      const report = await runDiagnostics(deps);
      if (c.req.query('format') === 'text') return c.text(renderDiagnosticsText(report));
      return c.json(report);
    } catch (err) {
      // 单项采集抛错在编排层已按兜底值处理（listVaults→[]、readMainLog→null、
      // 同步探测→null）；走到这里是编排本身失败（如 now/uptime 都拿不到），
      // 必须回 500 让调用方拿到确定的结果。
      const message = err instanceof Error ? err.message : 'Failed to run diagnostics';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  };

  // server.ts 把本子应用挂在 /api/diagnostics 下 → '/' 就是对外路径
  app.get('/', handle);

  // 生成支持包：同一套体检 + 过滤后的日志尾部落成一个本地文件，回路径给界面展示。
  // 只写这一个文件（core/diagnostics/support-bundle.ts），不自动上传
  app.post('/support-bundle', async (c: Context) => {
    try {
      const report = await runDiagnostics(deps);
      const logLines = (deps.readMainLog() ?? []).slice(-BUNDLE_LOG_LINES);
      const bundlePath = writeSupportBundle(buildSupportBundle(report, logLines), resolveBundleDir(opts), Date.now());
      return c.json({ path: bundlePath });
    } catch (err) {
      // 与 GET 同一约定：失败必须显式 500，绝不悬空
      const message = err instanceof Error ? err.message : 'Failed to write support bundle';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  return app;
}

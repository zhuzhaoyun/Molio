/**
 * GET /api/diagnostics — 自助诊断体检端点。
 *
 * 采集与判定都在 core/diagnostics/（只读、确定性产出）；这里只负责 HTTP：
 * 默认回 JSON 供 web 渲染，?format=text 回面向非技术用户的纯文本。
 * 采集抛错必须显式回 500，绝不让连接悬空。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { renderDiagnosticsText, runDiagnostics } from '../core/diagnostics/run-diagnostics.js';
import type { DiagnosticsDeps } from '../core/diagnostics/run-diagnostics.js';

export function diagnosticsRoutes(deps: DiagnosticsDeps): Hono {
  const app = new Hono();

  const handle = async (c: Context) => {
    try {
      const report = await runDiagnostics(deps);
      if (c.req.query('format') === 'text') return c.text(renderDiagnosticsText(report));
      return c.json(report);
    } catch (err) {
      // 单项采集抛错在编排层已按「未能检查」兜底；走到这里是编排本身失败
      // （如 vault 清单读不出来），必须回 500 让调用方拿到确定的结果。
      const message = err instanceof Error ? err.message : 'Failed to run diagnostics';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  };

  // server.ts 把本子应用挂在 /api/diagnostics 下 → '/' 就是对外路径
  app.get('/', handle);

  return app;
}

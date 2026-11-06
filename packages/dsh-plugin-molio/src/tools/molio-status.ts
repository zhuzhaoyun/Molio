/** dsh tool: molio_status — daemon 健康 + 当前激活知识库（连通性自检入口）。 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { DaemonClient } from '../daemon-client.js';
import { guarded, json, renderJson } from './common.js';

export function registerMolioStatus(ctx: Context, client: DaemonClient): void {
  ctx.tools.register(
    defineTool({
      name: 'molio_status',
      description:
        '返回 Molio daemon 健康状态（版本、活跃 run 数、uptime）与当前激活知识库。连不上时说明 Molio 桌面版（或 daemon）未运行。',
      parameters: {},
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderJson(value),
      },
      execute: async (_args, exec) =>
        guarded(async () => {
          const daemon = await client.health(exec.signal);
          const { vault } = await client.getActiveVault(exec.signal);
          return json({ daemon, activeVault: vault });
        }),
    }),
  );
}

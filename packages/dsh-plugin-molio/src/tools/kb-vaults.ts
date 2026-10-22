/** dsh tool: molio_kb_vaults — 列出全部知识库 + 当前激活库。 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { DaemonClient } from '../daemon-client.js';
import { guarded, json, renderJson } from './common.js';

export function registerKbVaults(ctx: Context, client: DaemonClient): void {
  ctx.tools.register(
    defineTool({
      name: 'molio_kb_vaults',
      description:
        '列出本机 Molio 的全部知识库（id、名称、文件数、路径）以及当前激活的知识库。调用其他 molio_kb_* 工具前可先用它确认 vaultId。',
      parameters: {},
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderJson(value),
      },
      execute: async (_args, exec) =>
        guarded(async () => {
          const vaults = await client.listVaults(exec.signal);
          const { vault } = await client.getActiveVault(exec.signal);
          return json({ vaults, activeVaultId: vault?.id ?? null });
        }),
    }),
  );
}

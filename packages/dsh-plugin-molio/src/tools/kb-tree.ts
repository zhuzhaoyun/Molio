/** dsh tool: molio_kb_tree — 知识库文件树。 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { DaemonClient } from '../daemon-client.js';
import { resolveVault } from '../vault-resolver.js';
import { guarded, json, renderJson } from './common.js';

export function registerKbTree(ctx: Context, client: DaemonClient): void {
  ctx.tools.register(
    defineTool({
      name: 'molio_kb_tree',
      description:
        '返回知识库的完整文件树（目录层级 + 文件相对路径），用于了解库内结构、挑选要读取的文件。',
      parameters: {
        vaultId: {
          type: 'string',
          description: '知识库 id 或名称，缺省用当前激活知识库',
        },
      },
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderJson(value),
      },
      execute: async (args, exec) =>
        guarded(async () => {
          const vault = await resolveVault(client, args.vaultId, exec.signal);
          const tree = await client.getTree(vault.id, exec.signal);
          return json({ vault: { id: vault.id, name: vault.name }, tree });
        }),
    }),
  );
}

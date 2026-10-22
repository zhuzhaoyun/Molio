/** dsh tool: molio_kb_search — 知识库全文搜索。 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { DaemonClient } from '../daemon-client.js';
import { resolveVault } from '../vault-resolver.js';
import { guarded, json, renderJson } from './common.js';

export function registerKbSearch(ctx: Context, client: DaemonClient): void {
  ctx.tools.register(
    defineTool({
      name: 'molio_kb_search',
      description:
        '在知识库中全文搜索关键词，返回命中文件的相对路径与上下文摘录（snippet）。适合先定位再用 molio_kb_read 读原文。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词' },
        vaultId: {
          type: 'string',
          description: '知识库 id 或名称，缺省用当前激活知识库',
        },
        limit: {
          type: 'integer',
          description: '最多返回条数（1..100，默认 20）',
        },
      },
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => renderJson(value),
      },
      execute: async (args, exec) =>
        guarded(async () => {
          // dsh 的 ValueSchemaSpec 无 min/max 约束，边界在 execute 内校验（与 MCP zod 版语义一致）
          if (
            args.limit !== undefined &&
            (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)
          ) {
            throw new Error(`limit 必须是 1..100 的整数（收到 ${String(args.limit)}）`);
          }
          const vault = await resolveVault(client, args.vaultId, exec.signal);
          const { results, truncated } = await client.search(
            vault.id,
            args.query,
            args.limit,
            exec.signal,
          );
          return json({
            vault: { id: vault.id, name: vault.name },
            query: args.query,
            results,
            truncated,
            ...(truncated
              ? { hint: '结果已截断，可调大 limit（最大 100）或用更精确的关键词' }
              : {}),
          });
        }),
    }),
  );
}

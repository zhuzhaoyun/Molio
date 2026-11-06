/** MCP tool: kb_search — 知识库全文搜索。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DaemonClient } from '../../daemon-client.js';
import { resolveVault } from '../../vault-resolver.js';
import { runTool, toolOk } from './common.js';

export function registerKbSearch(server: McpServer, client: DaemonClient): void {
  server.registerTool(
    'kb_search',
    {
      title: '知识库全文搜索',
      description:
        '在知识库中全文搜索关键词，返回命中文件的相对路径与上下文摘录（snippet）。适合先定位再用 kb_read 读原文。',
      inputSchema: {
        query: z.string().describe('搜索关键词'),
        vaultId: z.string().optional().describe('知识库 id 或名称，缺省用当前激活知识库'),
        limit: z.number().int().min(1).max(100).optional().describe('最多返回条数（1..100，默认 20）'),
      },
    },
    (args) =>
      runTool(async () => {
        const vault = await resolveVault(client, args.vaultId);
        const { results, truncated } = await client.search(vault.id, args.query, args.limit);
        return toolOk({
          vault: { id: vault.id, name: vault.name },
          query: args.query,
          results,
          truncated,
          ...(truncated ? { hint: '结果已截断，可调大 limit（最大 100）或用更精确的关键词' } : {}),
        });
      }),
  );
}

/** MCP tool: kb_tree — 知识库文件树。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DaemonClient } from '../../daemon-client.js';
import { resolveVault } from '../../vault-resolver.js';
import { runTool, toolOk } from './common.js';

export function registerKbTree(server: McpServer, client: DaemonClient): void {
  server.registerTool(
    'kb_tree',
    {
      title: '知识库文件树',
      description: '返回知识库的完整文件树（目录层级 + 文件相对路径），用于了解库内结构、挑选要读取的文件。',
      inputSchema: {
        vaultId: z.string().optional().describe('知识库 id 或名称，缺省用当前激活知识库'),
      },
    },
    (args) =>
      runTool(async () => {
        const vault = await resolveVault(client, args.vaultId);
        const tree = await client.getTree(vault.id);
        return toolOk({ vault: { id: vault.id, name: vault.name }, tree });
      }),
  );
}

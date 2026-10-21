/** MCP tool: kb_vaults — 列出全部知识库 + 当前激活库。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from '../../daemon-client.js';
import { runTool, toolOk } from './common.js';

export function registerKbVaults(server: McpServer, client: DaemonClient): void {
  server.registerTool(
    'kb_vaults',
    {
      title: '列出知识库',
      description:
        '列出本机 Molio 的全部知识库（id、名称、文件数、路径）以及当前激活的知识库。调用其他 kb_* 工具前可先用它确认 vaultId。',
      inputSchema: {},
    },
    () =>
      runTool(async () => {
        const vaults = await client.listVaults();
        const { vault } = await client.getActiveVault();
        return toolOk({ vaults, activeVaultId: vault?.id ?? null });
      }),
  );
}

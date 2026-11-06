/** MCP tool: molio_status — daemon 健康 + 当前激活知识库（连通性自检入口）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from '../../daemon-client.js';
import { runTool, toolOk } from './common.js';

export function registerMolioStatus(server: McpServer, client: DaemonClient): void {
  server.registerTool(
    'molio_status',
    {
      title: 'Molio 状态',
      description:
        '返回 Molio daemon 健康状态（版本、活跃 run 数、uptime）与当前激活知识库。连不上时说明 Molio 桌面版（或 daemon）未运行。',
      inputSchema: {},
    },
    () =>
      runTool(async () => {
        const daemon = await client.health();
        const { vault } = await client.getActiveVault();
        return toolOk({ daemon, activeVault: vault });
      }),
  );
}

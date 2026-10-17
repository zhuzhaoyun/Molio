/** MCP tool: kb_read — 读知识库文件（与 CLI kb read 共用 read-service 语义）。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DaemonClient } from '../../daemon-client.js';
import { readVaultFile } from '../../read-service.js';
import { runTool, toolOk, toolText } from './common.js';

export function registerKbRead(server: McpServer, client: DaemonClient): void {
  server.registerTool(
    'kb_read',
    {
      title: '读知识库文件',
      description:
        '按相对路径读取知识库中的文本文件内容。文件不存在、文件过大会返回错误消息（过大可用 force:true 重试）；二进制文件返回说明而非内容。',
      inputSchema: {
        path: z.string().describe('文件相对路径（相对知识库根目录），如 notes/2026/总结.md'),
        vaultId: z.string().optional().describe('知识库 id 或名称，缺省用当前激活知识库'),
        force: z.boolean().optional().describe('文件过大时是否强制读取（默认 false）'),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await readVaultFile(client, {
          vaultArg: args.vaultId,
          relPath: args.path,
          force: args.force,
        });
        const { vault, file } = result;
        if (result.kind === 'binary') {
          return toolText(
            `二进制文件（${file.mimeType}，${file.size} 字节），无文本内容。绝对路径: ${vault.path}/${file.path}`,
          );
        }
        return toolOk({ vault: { id: vault.id, name: vault.name }, file });
      }),
  );
}

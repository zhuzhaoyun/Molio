/** dsh tool: molio_kb_read — 读知识库文件（与 @molio/cli 的 kb_read 共用 read-service 语义）。 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { DaemonClient } from '../daemon-client.js';
import { readVaultFile } from '../read-service.js';
import { guarded, json, renderJson } from './common.js';

export function registerKbRead(ctx: Context, client: DaemonClient): void {
  ctx.tools.register(
    defineTool({
      name: 'molio_kb_read',
      description:
        '按相对路径读取知识库中的文本文件内容。文件不存在、文件过大会返回错误消息（过大可用 force:true 重试）；二进制文件返回说明而非内容。',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: '文件相对路径（相对知识库根目录），如 notes/2026/总结.md',
        },
        vaultId: {
          type: 'string',
          description: '知识库 id 或名称，缺省用当前激活知识库',
        },
        force: {
          type: 'boolean',
          description: '文件过大时是否强制读取（默认 false）',
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
          const result = await readVaultFile(client, {
            vaultArg: args.vaultId,
            relPath: args.path,
            force: args.force,
            signal: exec.signal,
          });
          const { vault, file } = result;
          if (result.kind === 'binary') {
            return json({
              kind: 'binary',
              message: `二进制文件（${file.mimeType}，${file.size} 字节），无文本内容。绝对路径: ${vault.path}/${file.path}`,
            });
          }
          return json({ kind: 'text', vault: { id: vault.id, name: vault.name }, file });
        }),
    }),
  );
}

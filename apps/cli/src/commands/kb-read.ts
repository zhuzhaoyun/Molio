/**
 * molio kb read <relPath> — 读知识库文件。
 * 文本文件：content 原样进 stdout（--json 时为完整 FileContent）。
 * 二进制文件：content 为空，stderr 提示（退出码 0，文件确实存在）。
 * 过大：daemon 413（refuse）或 200+tooLarge（降级档）→ 退出码 4。
 * vault 解析与错误语义在 read-service.ts，与 MCP tool kb_read 共用。
 */
import { EXIT_OK } from '../exit-codes.js';
import { errLog, out, outJson } from '../output.js';
import { readVaultFile } from '../read-service.js';
import type { CmdContext } from './types.js';

export async function kbReadCmd(
  ctx: CmdContext,
  opts: { vault?: string; force?: boolean; relPath: string },
): Promise<number> {
  const result = await readVaultFile(ctx.client, {
    vaultArg: opts.vault,
    relPath: opts.relPath,
    force: opts.force,
  });
  const { vault, file } = result;

  if (ctx.json) {
    outJson({ vault: { id: vault.id, name: vault.name }, file });
    return EXIT_OK;
  }
  if (result.kind === 'binary') {
    errLog(
      `二进制文件（${file.mimeType}，${file.size} 字节），无文本内容。路径: ${vault.path}/${file.path}`,
    );
    return EXIT_OK;
  }
  out(file.content);
  return EXIT_OK;
}

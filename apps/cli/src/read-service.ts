/**
 * 读文件共享内核 — CLI（kb-read.ts）与 MCP tool（kb_read）共用同一套
 * vault 解析 + 错误语义（不存在→3、过大→4），保证两种出口行为一致。
 */
import type { FileContent, Vault } from '@molio/contracts';
import type { DaemonClient } from './daemon-client.js';
import { CliError, isDaemonError } from './errors.js';
import { EXIT_FILE_NOT_FOUND, EXIT_FILE_TOO_LARGE } from './exit-codes.js';
import { resolveVault } from './vault-resolver.js';

export type ReadOutcome =
  | { kind: 'text'; vault: Vault; file: FileContent }
  | { kind: 'binary'; vault: Vault; file: FileContent };

export async function readVaultFile(
  client: DaemonClient,
  opts: { vaultArg?: string; relPath: string; force?: boolean },
): Promise<ReadOutcome> {
  const vault = await resolveVault(client, opts.vaultArg);
  let file: FileContent;
  try {
    file = await client.readFile(vault.id, opts.relPath, opts.force === true);
  } catch (err) {
    if (isDaemonError(err)) {
      if (err.code === 'NOT_FOUND') {
        throw new CliError(EXIT_FILE_NOT_FOUND, `文件不存在: ${opts.relPath}`);
      }
      if (err.code === 'FILE_TOO_LARGE') {
        throw new CliError(
          EXIT_FILE_TOO_LARGE,
          `文件过大，拒绝读取: ${opts.relPath}（${err.message}）`,
        );
      }
    }
    throw err;
  }

  if (file.tooLarge) {
    throw new CliError(
      EXIT_FILE_TOO_LARGE,
      `文件过大（${file.size} 字节）: ${opts.relPath}${opts.force ? '' : '，可尝试强制读取（CLI --force / MCP force:true）'}`,
    );
  }

  const kind =
    !file.content && file.mimeType && !isTextMime(file.mimeType) ? 'binary' : 'text';
  return { kind, vault, file };
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json';
}

/**
 * 读文件共享内核 — 移植自 apps/cli/src/read-service.ts（同一套语义：
 * 不存在 / 过大 / 二进制判定）。dsh 侧无退出码，失败抛可读中文 Error。
 */
import type { FileContent, Vault } from '@molio/contracts';
import type { DaemonClient } from './daemon-client.js';
import { isDaemonError } from './errors.js';
import { resolveVault } from './vault-resolver.js';

export type ReadOutcome =
  | { kind: 'text'; vault: Vault; file: FileContent }
  | { kind: 'binary'; vault: Vault; file: FileContent };

export async function readVaultFile(
  client: DaemonClient,
  opts: { vaultArg?: string; relPath: string; force?: boolean; signal?: AbortSignal },
): Promise<ReadOutcome> {
  const vault = await resolveVault(client, opts.vaultArg, opts.signal);
  let file: FileContent;
  try {
    file = await client.readFile(vault.id, opts.relPath, opts.force === true, opts.signal);
  } catch (err) {
    if (isDaemonError(err)) {
      if (err.code === 'NOT_FOUND') {
        throw new Error(`文件不存在: ${opts.relPath}`);
      }
      if (err.code === 'FILE_TOO_LARGE') {
        throw new Error(`文件过大，拒绝读取: ${opts.relPath}（${err.message}）`);
      }
    }
    throw err;
  }

  if (file.tooLarge) {
    throw new Error(
      `文件过大（${file.size} 字节）: ${opts.relPath}${opts.force ? '' : '，可尝试 force:true 强制读取'}`,
    );
  }

  const kind =
    !file.content && file.mimeType && !isTextMime(file.mimeType) ? 'binary' : 'text';
  return { kind, vault, file };
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json';
}

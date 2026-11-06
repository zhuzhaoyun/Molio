/**
 * Vault 解析 — `vaultId` 参数接受 id（精确）或 name（忽略大小写）；
 * 未传时用 daemon 的 active vault。移植自 apps/cli/src/vault-resolver.ts；
 * dsh 侧无退出码，失败直接抛带可读中文消息的 Error（管线归一化为 isError）。
 */
import type { Vault } from '@molio/contracts';
import type { DaemonClient } from './daemon-client.js';

export class VaultNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultNotFoundError';
  }
}

export async function resolveVault(
  client: DaemonClient,
  vaultArg?: string,
  signal?: AbortSignal,
): Promise<Vault> {
  if (vaultArg !== undefined && vaultArg.trim() !== '') {
    const vaults = await client.listVaults(signal);
    const arg = vaultArg.trim();

    const byId = vaults.filter((v) => v.id === arg);
    if (byId.length === 1) return byId[0]!;

    const lower = arg.toLowerCase();
    const byName = vaults.filter((v) => v.name.toLowerCase() === lower);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      const list = byName.map((v) => `  ${v.id}  ${v.name}`).join('\n');
      throw new VaultNotFoundError(
        `知识库名称「${arg}」有多个匹配，请用 vaultId 参数指定 id：\n${list}`,
      );
    }
    const available = vaults.length
      ? vaults.map((v) => `  ${v.id}  ${v.name}`).join('\n')
      : '  （当前没有任何知识库）';
    throw new VaultNotFoundError(`未找到知识库「${arg}」。可用知识库：\n${available}`);
  }

  const { vault } = await client.getActiveVault(signal);
  if (!vault) {
    throw new VaultNotFoundError(
      '未指定知识库，且 Molio 当前没有打开的知识库。请在 Molio 中选择一个知识库，或用 vaultId 参数指定',
    );
  }
  return vault;
}

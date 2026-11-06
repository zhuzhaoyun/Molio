/**
 * Vault 解析 — `--vault` 接受 id（精确）或 name（忽略大小写）；
 * 未传时用 daemon 的 active vault（与 Chrome 扩展剪藏「存到当前打开的库」
 * 语义一致）。解析失败抛 CliError(EXIT_VAULT_NOT_FOUND)。
 *
 * ⚠️ 返回的 Vault.path 用作 POST /api/runs 的 cwd —— daemon 的
 * getVaultByPath 是 SQL 精确匹配，绝不能用用户手输的路径替代。
 */
import type { Vault } from '@molio/contracts';
import type { DaemonClient } from './daemon-client.js';
import { CliError } from './errors.js';
import { EXIT_USAGE, EXIT_VAULT_NOT_FOUND } from './exit-codes.js';

export async function resolveVault(
  client: DaemonClient,
  vaultArg?: string,
): Promise<Vault> {
  if (vaultArg !== undefined && vaultArg.trim() !== '') {
    const vaults = await client.listVaults();
    const arg = vaultArg.trim();

    const byId = vaults.filter((v) => v.id === arg);
    if (byId.length === 1) return byId[0]!;

    const lower = arg.toLowerCase();
    const byName = vaults.filter((v) => v.name.toLowerCase() === lower);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      const list = byName.map((v) => `  ${v.id}  ${v.name}`).join('\n');
      throw new CliError(
        EXIT_VAULT_NOT_FOUND,
        `知识库名称「${arg}」有多个匹配，请用 --vault <id> 指定：\n${list}`,
      );
    }
    const available = vaults.length
      ? vaults.map((v) => `  ${v.id}  ${v.name}`).join('\n')
      : '  （当前没有任何知识库）';
    throw new CliError(
      EXIT_VAULT_NOT_FOUND,
      `未找到知识库「${arg}」。可用知识库：\n${available}`,
    );
  }

  const { vault } = await client.getActiveVault();
  if (!vault) {
    throw new CliError(
      EXIT_VAULT_NOT_FOUND,
      '未指定知识库，且 Molio 当前没有打开的知识库。请在 Molio 中选择一个知识库，或用 --vault <id|名称> 指定',
    );
  }
  return vault;
}

/**
 * ask 的 agentId 选择：显式 --agent 优先（校验存在性，不校验可用性——
 * daemon 会在 run 失败时给出真因）；否则取第一个 available 的 runtime。
 */
export async function resolveAgentId(
  client: DaemonClient,
  agentArg?: string,
): Promise<string> {
  if (agentArg !== undefined && agentArg.trim() !== '') return agentArg.trim();
  const agents = await client.listAgents();
  const available = agents.find((a) => a.available);
  if (!available) {
    throw new CliError(
      EXIT_USAGE,
      '本机没有检测到可用的 AI runtime（Claude Code / Codex 等）。请在 Molio 桌面版的「运行时」页安装后重试，或用 --agent <id> 指定',
    );
  }
  return available.id;
}

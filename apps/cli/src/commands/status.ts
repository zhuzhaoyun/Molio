/** molio status — daemon 健康 + 当前知识库。也是 WorkBuddy CLI 方案的 status 语义基础。 */
import { EXIT_OK } from '../exit-codes.js';
import { out, outJson } from '../output.js';
import type { CmdContext } from './types.js';

export async function statusCmd(ctx: CmdContext): Promise<number> {
  const health = await ctx.client.health();
  const { vault } = await ctx.client.getActiveVault();
  if (ctx.json) {
    outJson({ daemon: health, activeVault: vault });
    return EXIT_OK;
  }
  out(`daemon: ${health.status} v${health.version} (uptime ${health.uptime}s, 活跃 run ${health.activeRuns})`);
  out(
    vault
      ? `当前知识库: ${vault.name} (${vault.id})`
      : '当前知识库: （无 — 请在 Molio 中打开一个知识库）',
  );
  return EXIT_OK;
}

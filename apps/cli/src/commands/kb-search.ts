/** molio kb search <关键词> — 知识库全文搜索（daemon 侧 snippet ±30 字符）。 */
import { EXIT_OK } from '../exit-codes.js';
import { errLog, out, outJson } from '../output.js';
import { resolveVault } from '../vault-resolver.js';
import type { CmdContext } from './types.js';

export async function kbSearchCmd(
  ctx: CmdContext,
  opts: { vault?: string; limit?: number; query: string },
): Promise<number> {
  const vault = await resolveVault(ctx.client, opts.vault);
  const { results, truncated } = await ctx.client.search(vault.id, opts.query, opts.limit);
  if (ctx.json) {
    outJson({ vault: { id: vault.id, name: vault.name }, query: opts.query, results, truncated });
    return EXIT_OK;
  }
  if (results.length === 0) {
    errLog(`知识库「${vault.name}」中未找到「${opts.query}」`);
    return EXIT_OK;
  }
  for (const r of results) {
    out(`${r.filePath}: ${r.snippet}`);
  }
  if (truncated) {
    errLog(`（结果已截断，可加 --limit 调整，最大 100）`);
  }
  return EXIT_OK;
}

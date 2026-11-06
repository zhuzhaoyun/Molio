/** molio kb tree — 知识库文件树（默认 active vault，--vault 指定）。 */
import { EXIT_OK } from '../exit-codes.js';
import { out, outJson, renderTree } from '../output.js';
import { resolveVault } from '../vault-resolver.js';
import type { CmdContext } from './types.js';

export async function kbTreeCmd(
  ctx: CmdContext,
  opts: { vault?: string },
): Promise<number> {
  const vault = await resolveVault(ctx.client, opts.vault);
  const tree = await ctx.client.getTree(vault.id);
  if (ctx.json) {
    outJson({ vault: { id: vault.id, name: vault.name }, tree });
    return EXIT_OK;
  }
  out(`知识库「${vault.name}」文件树：`);
  out(renderTree(tree));
  return EXIT_OK;
}

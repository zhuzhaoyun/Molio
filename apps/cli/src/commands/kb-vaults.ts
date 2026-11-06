/** molio kb vaults — 列出全部知识库。 */
import { EXIT_OK } from '../exit-codes.js';
import { formatTable, out, outJson } from '../output.js';
import type { CmdContext } from './types.js';

export async function kbVaultsCmd(ctx: CmdContext): Promise<number> {
  const vaults = await ctx.client.listVaults();
  if (ctx.json) {
    outJson({ vaults });
    return EXIT_OK;
  }
  if (vaults.length === 0) {
    out('（没有知识库 — 请先在 Molio 中创建）');
    return EXIT_OK;
  }
  const { vault: active } = await ctx.client.getActiveVault();
  out(
    formatTable(
      ['ID', '名称', '文件数', '路径', ''],
      vaults.map((v) => [
        v.id,
        v.name,
        String(v.fileCount),
        v.path,
        v.id === active?.id ? '(当前)' : '',
      ]),
    ),
  );
  return EXIT_OK;
}

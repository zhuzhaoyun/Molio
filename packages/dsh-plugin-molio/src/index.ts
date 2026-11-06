/**
 * dsh-plugin-molio — Molio 知识库插件（DeepSeek Harness）。
 *
 * Cordis 插件约定：导出 `name`（加载诊断用）、`inject`（依赖的宿主服务，
 * 全部就绪后框架才调用 apply）、`apply(ctx)`（注册工具）。
 *
 * 全部工具只读（与 @molio/cli 的第一版红线一致）：列库 / 文件树 / 全文
 * 搜索 / 读文件 / 状态自检。数据经 Molio daemon HTTP API（默认
 * http://127.0.0.1:3100，MOLIO_DAEMON_URL / MOLIO_PORT 可覆盖）。
 *
 * @module dsh-plugin-molio
 */
import type { Context } from '@deepseek-ai/cordis';
import { DaemonClient } from './daemon-client.js';
import { registerKbRead } from './tools/kb-read.js';
import { registerKbSearch } from './tools/kb-search.js';
import { registerKbTree } from './tools/kb-tree.js';
import { registerKbVaults } from './tools/kb-vaults.js';
import { registerMolioStatus } from './tools/molio-status.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'molio-kb';

/** 宿主服务依赖：tools 注册表就绪后才 apply。 */
export const inject = ['tools'];

/** 注册全部 Molio 知识库工具（5 个，全只读）。 */
export function apply(ctx: Context): void {
  const client = new DaemonClient();
  registerMolioStatus(ctx, client);
  registerKbVaults(ctx, client);
  registerKbTree(ctx, client);
  registerKbSearch(ctx, client);
  registerKbRead(ctx, client);
}

#!/usr/bin/env node
/**
 * molio — Molio 知识库 CLI 入口。
 * daemon HTTP 薄客户端：不含任何知识库逻辑，安全边界全在 daemon 侧。
 * 双出口共享内核：`molio kb ...`（shell 型 agent）与 `molio mcp`（WorkBuddy 等 MCP 连接器）。
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DaemonClient } from './daemon-client.js';
import { CliError, daemonErrorMessage, isDaemonError } from './errors.js';
import { EXIT_OK, EXIT_USAGE } from './exit-codes.js';
import { errLine, out } from './output.js';
import { kbCmd } from './commands/kb.js';
import { statusCmd } from './commands/status.js';
import type { CmdContext } from './commands/types.js';
import { CLI_VERSION } from './version.js';

export { CLI_VERSION };

const USAGE = `molio — Molio 知识库 CLI（daemon 本地 HTTP 薄客户端）

用法:
  molio status [--json]        daemon 健康 + 当前知识库
  molio kb <子命令>            知识库操作（molio kb help 查看子命令）
  molio mcp                    启动 stdio MCP server（供 WorkBuddy 等外部 agent 连接）
  molio help                   显示本帮助
  molio --version              显示版本

退出码:
  0 成功 | 1 daemon 不可达 | 2 知识库未找到或歧义 | 3 文件不存在
  4 文件过大 | 5 用法错误 | 6 run 失败 | 7 超时

环境变量:
  MOLIO_DAEMON_URL   显式指定 daemon 地址（覆盖端口推断，支持远程/NAS 部署）
  MOLIO_PORT         daemon 端口（默认 3100）

输出约定:
  数据走 stdout（--json 时为单个 JSON 值），日志与错误走 stderr
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const client = new DaemonClient();
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return EXIT_OK;
    case '--version':
    case '-V':
      out(CLI_VERSION);
      return EXIT_OK;
    case 'status': {
      const ctx = parseStatusArgs(args, client);
      return statusCmd(ctx);
    }
    case 'kb': {
      // --json 由各子命令自行解析（kb vaults --json / kb tree --json ...）
      return kbCmd({ client, json: false }, args);
    }
    case 'mcp': {
      // 懒加载：只有 mcp 子命令才拉 @modelcontextprotocol/sdk
      const { runMcpServer } = await import('./mcp/server.js');
      return runMcpServer();
    }
    default:
      out(USAGE);
      throw new CliError(EXIT_USAGE, `未知命令: ${cmd}`);
  }
}

function parseStatusArgs(args: string[], client: DaemonClient): CmdContext {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: false }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT_USAGE, `${message}（molio help 查看用法）`);
  }
  return { client, json: values['json'] === true };
}

/**
 * 完整 CLI 入口（含顶层错误映射）→ 返回进程退出码。
 * 导出供集成测试直调（node:test 内 import 本模块不会触发 main 自执行）。
 */
export async function runCli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    return reportFailure(err);
  }
}

// 仅在作为可执行入口直接运行时自执行（node dist/src/index.js / tsx src/index.ts / bin 软链）
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

/** 顶层错误出口：CliError 用自身退出码；DaemonError 兜底映射；其余视为 1。 */
function reportFailure(err: unknown): number {
  if (err instanceof CliError) {
    errLine(err.message);
    return err.exitCode;
  }
  if (isDaemonError(err)) {
    errLine(daemonErrorMessage(err));
    // 漏到顶层的 DaemonError 未被命令层语义化——保守归 1（daemon 通信失败）
    return err.code === 'TIMEOUT' ? 7 : 1;
  }
  errLine(err instanceof Error ? err.message : String(err));
  return 1;
}

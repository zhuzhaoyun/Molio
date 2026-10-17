/**
 * molio kb <子命令> 路由 — util.parseArgs 逐子命令解析选项。
 * 约定：数据一律 stdout（--json 时单个 JSON 值），日志/错误 stderr；
 * 未知 flag / 缺参数 → CliError(5) 带可读中文提示。
 */
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { CliError } from '../errors.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { out } from '../output.js';
import type { CmdContext } from './types.js';
import { kbAskCmd } from './kb-ask.js';
import { kbReadCmd } from './kb-read.js';
import { kbResultCmd } from './kb-result.js';
import { kbSearchCmd } from './kb-search.js';
import { kbTreeCmd } from './kb-tree.js';
import { kbVaultsCmd } from './kb-vaults.js';

const KB_USAGE = `molio kb — 知识库操作

用法:
  molio kb vaults [--json]                                  列出全部知识库
  molio kb tree [--vault <id|名称>] [--json]                文件树
  molio kb read <相对路径> [--vault X] [--force] [--json]   读文件（二进制/过大有专门提示）
  molio kb search <关键词> [--vault X] [--limit N] [--json] 全文搜索（limit 1..100，默认 20）
  molio kb ask <问题> [--vault X] [--agent <id>] [--timeout 秒] [--async] [--json]
                                                            AI 问答（默认流式；--async 秒回 runId）
  molio kb result <runId> [--wait] [--timeout 秒] [--json]  查询异步问答结果

通用:
  --vault 缺省用当前激活知识库；可传 id 或名称（名称忽略大小写）
`;

/** parseArgs values 的联合值类型 → 逐 key 收窄（TS 不按 options 配置做类型推断）。 */
type ParsedValues = ReturnType<typeof parseArgs>['values'];

function optString(values: ParsedValues, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

function optBoolean(values: ParsedValues, key: string): boolean | undefined {
  const v = values[key];
  return typeof v === 'boolean' ? v : undefined;
}

export async function kbCmd(ctx: CmdContext, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'vaults': {
      const { values } = parse(rest, 'vaults', { json: { type: 'boolean' } });
      return kbVaultsCmd(withJson(ctx, values));
    }
    case 'tree': {
      const { values } = parse(rest, 'tree', {
        vault: { type: 'string' },
        json: { type: 'boolean' },
      });
      return kbTreeCmd(withJson(ctx, values), { vault: optString(values, 'vault') });
    }
    case 'read': {
      const { values, positionals } = parse(rest, 'read', {
        vault: { type: 'string' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
      });
      const relPath = joinPositionals(positionals, 'read', '文件相对路径');
      return kbReadCmd(withJson(ctx, values), {
        vault: optString(values, 'vault'),
        force: optBoolean(values, 'force'),
        relPath,
      });
    }
    case 'search': {
      const { values, positionals } = parse(rest, 'search', {
        vault: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
      });
      const query = joinPositionals(positionals, 'search', '搜索关键词');
      const limitRaw = optString(values, 'limit');
      return kbSearchCmd(withJson(ctx, values), {
        vault: optString(values, 'vault'),
        limit: limitRaw === undefined ? undefined : parsePositiveInt('limit', limitRaw),
        query,
      });
    }
    case 'ask': {
      const { values, positionals } = parse(rest, 'ask', {
        vault: { type: 'string' },
        agent: { type: 'string' },
        timeout: { type: 'string' },
        async: { type: 'boolean' },
        json: { type: 'boolean' },
      });
      const question = joinPositionals(positionals, 'ask', '问题');
      const timeoutRaw = optString(values, 'timeout');
      return kbAskCmd(withJson(ctx, values), {
        question,
        vault: optString(values, 'vault'),
        agent: optString(values, 'agent'),
        timeoutSec: timeoutRaw === undefined ? undefined : parsePositiveInt('timeout', timeoutRaw),
        async: optBoolean(values, 'async'),
      });
    }
    case 'result': {
      const { values, positionals } = parse(rest, 'result', {
        wait: { type: 'boolean' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
      });
      const runId = joinPositionals(positionals, 'result', 'runId');
      const timeoutRaw = optString(values, 'timeout');
      return kbResultCmd(withJson(ctx, values), {
        runId,
        wait: optBoolean(values, 'wait'),
        timeoutSec: timeoutRaw === undefined ? undefined : parsePositiveInt('timeout', timeoutRaw),
      });
    }
    case 'help':
    case '--help':
    case '-h':
      out(KB_USAGE);
      return EXIT_OK;
    case undefined:
      out(KB_USAGE);
      throw new CliError(EXIT_USAGE, '缺少 kb 子命令');
    default:
      out(KB_USAGE);
      throw new CliError(EXIT_USAGE, `未知的 kb 子命令: ${sub}`);
  }
}

function parse(
  args: string[],
  sub: string,
  options: NonNullable<ParseArgsConfig['options']>,
): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT_USAGE, `${message}（molio kb ${sub} --help 查看用法）`);
  }
}

function withJson(ctx: CmdContext, values: ParsedValues): CmdContext {
  return { ...ctx, json: values['json'] === true };
}

/** 位置参数拼接：允许不加引号的多词（"总结 一下 XX"），至少要有内容。 */
function joinPositionals(positionals: string[], sub: string, what: string): string {
  const joined = positionals.join(' ').trim();
  if (!joined) throw new CliError(EXIT_USAGE, `molio kb ${sub} 缺少${what}`);
  return joined;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(EXIT_USAGE, `--${name} 必须是正整数，收到: ${raw}`);
  }
  return n;
}

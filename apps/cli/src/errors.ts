/**
 * 错误类型与映射 — CLI 退出码 / MCP isError 消息共用语义。
 * 消息面向最终用户与外部 agent，一律可读中文。
 */
import {
  EXIT_DAEMON_UNREACHABLE,
  EXIT_FILE_NOT_FOUND,
  EXIT_FILE_TOO_LARGE,
  EXIT_RUN_FAILED,
  EXIT_TIMEOUT,
  EXIT_USAGE,
} from './exit-codes.js';

/** 带退出码的 CLI 错误：index.ts 顶层 catch 后打印 stderr 并设置 process.exitCode。 */
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** DaemonClient 抛出的类型化错误。 */
export type DaemonErrorCode =
  | 'DAEMON_UNREACHABLE'
  | 'NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'TIMEOUT'
  | 'HTTP_ERROR';

export class DaemonError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

export function isDaemonError(err: unknown): err is DaemonError {
  return err instanceof Error && err.name === 'DaemonError';
}

const UNREACHABLE_MSG =
  '无法连接 Molio 守护进程，请确认 Molio 桌面版（或 daemon）正在运行';

/**
 * DaemonError → 中文可读消息。CLI stderr 与 MCP isError 共用，保证两种出口
 * 对同一故障说法一致。
 */
export function daemonErrorMessage(err: DaemonError): string {
  switch (err.code) {
    case 'DAEMON_UNREACHABLE':
      return UNREACHABLE_MSG;
    case 'TIMEOUT':
      return `请求 Molio 守护进程超时：${err.message}`;
    default:
      return err.message;
  }
}

/**
 * DaemonError → CliError。NOT_FOUND 的语义依赖调用点上下文（文件？run？），
 * 由调用方传 `notFoundExit` + `notFoundMessage` 决定。
 */
export function toCliError(
  err: unknown,
  ctx: { notFoundExit: number; notFoundMessage: (e: DaemonError) => string },
): CliError {
  if (err instanceof CliError) return err;
  if (isDaemonError(err)) {
    switch (err.code) {
      case 'DAEMON_UNREACHABLE':
        return new CliError(EXIT_DAEMON_UNREACHABLE, UNREACHABLE_MSG);
      case 'TIMEOUT':
        return new CliError(EXIT_TIMEOUT, daemonErrorMessage(err));
      case 'NOT_FOUND':
        return new CliError(ctx.notFoundExit, ctx.notFoundMessage(err));
      case 'FILE_TOO_LARGE':
        return new CliError(EXIT_FILE_TOO_LARGE, err.message);
      default:
        return new CliError(EXIT_DAEMON_UNREACHABLE, daemonErrorMessage(err));
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new CliError(EXIT_USAGE, message);
}

/** 文件读取上下文的 NOT_FOUND 映射。 */
export const fileNotFoundCtx = {
  notFoundExit: EXIT_FILE_NOT_FOUND,
  notFoundMessage: (e: DaemonError) => e.message,
};

/** run 查询上下文的 NOT_FOUND 映射（daemon 重启 / TTL 过期 → run 丢失）。 */
export const runNotFoundCtx = {
  notFoundExit: EXIT_RUN_FAILED,
  notFoundMessage: () => 'run 不存在或已过期（daemon 可能已重启），请重新发起提问',
};

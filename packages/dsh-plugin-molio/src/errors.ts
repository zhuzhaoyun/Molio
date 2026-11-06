/**
 * 错误类型与中文消息映射 — 移植自 apps/cli/src/errors.ts（同一套文案红线：
 * 面向外部 agent 的错误一律可读中文，不靠解析文本）。
 *
 * dsh 侧无退出码概念：工具 execute 抛出 Error，dsh tool 管线会归一化为
 * isError 结果并把 message 呈现给模型，因此这里只需要 DaemonError +
 * daemonErrorMessage 两层。
 */

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
  '无法连接 Molio 守护进程，请确认 Molio 桌面版（或 daemon / Docker 服务）正在运行；' +
  '若 Molio 部署在其他地址，请为 dsh 进程设置环境变量 MOLIO_DAEMON_URL（如 http://nas:3100）';

/** DaemonError → 中文可读消息（与 @molio/cli 的 MCP 出口同一套说法）。 */
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

/** 任意异常 → 面向模型的可读中文消息。 */
export function errorMessage(err: unknown): string {
  if (isDaemonError(err)) return daemonErrorMessage(err);
  return err instanceof Error ? err.message : String(err);
}

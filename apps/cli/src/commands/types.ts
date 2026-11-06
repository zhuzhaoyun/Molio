import type { DaemonClient } from '../daemon-client.js';

/** 命令处理器的共享上下文。返回进程退出码（成功 = EXIT_OK）。 */
export interface CmdContext {
  client: DaemonClient;
  /** --json：stdout 只输出单个 JSON 值。 */
  json: boolean;
}

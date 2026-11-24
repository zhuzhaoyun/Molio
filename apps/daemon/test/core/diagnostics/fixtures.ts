import type { AgentInfo } from '@molio/contracts';
import type { DiagnosticsDeps } from '../../../src/core/diagnostics/run-diagnostics.js';

/**
 * 主进程日志行夹具 — 一律取自真实日志格式（main.log / updater.log）。
 * 后续诊断任务的测试继续往这里加，避免各测试文件自带行字符串。
 */

export const L = (ts: string, body: string) => `[${ts}] ${body}`;

export const EXIT_OK = L('2026-11-23T03:06:43.041Z', '[ERROR] [main] daemon exited with code=0 signal=null');
export const EXIT_KILLED = L('2026-11-23T07:39:02.508Z', '[ERROR] [main] daemon exited with code=3758096392 signal=null');
export const EXIT_KILLED_OLD = L('2026-11-20T07:39:02.508Z', '[ERROR] [main] daemon exited with code=3758096392 signal=null');
export const TASKKILL = L('2026-11-18T03:05:17.994Z', '[INFO] [main] force taskkill sent for daemon pid=37616');
export const EXIT_1 = L('2026-11-18T03:05:18.084Z', '[ERROR] [main] daemon exited with code=1 signal=null');
export const UPD_FAIL = L('2026-11-23T07:29:34.141Z', '[ERROR] [updater] check failed: net::ERR_NAME_NOT_RESOLVED');
export const UPD_OK = L('2026-11-23T07:29:34.141Z', '[INFO] [updater] no update available');
export const UPD_AVAIL = L('2026-11-23T07:29:34.141Z', '[INFO] [updater] update available: v0.4.8');
export const START = L('2026-11-23T07:51:50.858Z', '[INFO] [main] Starting daemon: D:\\molio\\resources\\daemon\\daemon.mjs');
export const WATCH_FAIL = L('2026-11-18T14:42:24.839Z', "[INFO] [daemon] [vault-watcher] failed to watch 3edb6697-1 (/Volumes/My Passport/demo): ENOENT: no such file or directory, watch '/Volumes/My Passport/demo'");

// —— 支持包隐私夹具 ——

// 账号标识行：支持包绝不能把它（或它的续行）带出去
export const ACCOUNT_LINE = L('2026-11-23T07:40:00.000Z', '[INFO] [auth-status-watch] user logged in (id=u_abc123)');
// daemon stdout 转发：首行带标签，后续行不带时间戳前缀（续行）
export const TAIL_HEAD = L('2026-11-23T07:39:02.509Z', '[ERROR] [main] daemon stdout tail:');
export const TAIL_CONT = 'Molio daemon listening on http://localhost:3100';

// —— runDiagnostics 依赖夹具 ——

// 完整的可用 Claude Code 探测结果（models / installable 是 AgentInfo 必填字段）
const CLAUDE_AGENT: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  available: true,
  version: '2.1.0',
  models: [],
  installable: false,
};

/**
 * runDiagnostics 的默认依赖：全绿、时间固定、超时毫秒级（测试不会真等）。
 * 单条用例只覆写自己关心的那一两项。
 */
export function makeDeps(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    now: () => Date.parse('2026-11-23T12:00:00Z'),
    env: {},
    platform: 'win32',
    arch: 'x64',
    uptimeSec: () => 3725,
    listVaults: () => [{ id: 'v1', name: '示例', path: '/vaults/demo', fileCount: 3, createdAt: 0 }],
    pathExists: () => true,
    pathWritable: () => true,
    diskUsage: () => ({ freeBytes: 50 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }),
    detectAgents: async () => [CLAUDE_AGENT],
    listSecuritySoftware: async () => ['Windows Defender'],
    readMainLog: () => null,
    timeouts: { agentProbeMs: 20, securitySoftwareMs: 20 },
    ...overrides,
  };
}

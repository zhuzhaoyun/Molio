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

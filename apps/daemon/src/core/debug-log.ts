import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Shared diagnostic logger for SSE / RunManager reliability investigation.
 *
 * Writes to ~/.molio/debug/sse-debug.log AND stdout. The file is the reliable
 * channel in packaged desktop mode (daemon stdout may be swallowed by the
 * Electron parent); stdout is for dev (tsx watch) where it's visible.
 *
 * NOTE: use console.log (stdout), NOT console.warn/error (stderr). Cloud log
 * collectors (e.g. SLS) classify stderr as ERROR level, so routing routine
 * diagnostics through stderr floods the monitor with false-positive errors.
 *
 * Call only on low-frequency points (stream start/cancel, ping enqueue
 * failure, subscribe/unsubscribe, listeners=0) — never per-event.
 */
const DEBUG_LOG_PATH = path.join(os.homedir(), '.molio', 'debug', 'sse-debug.log');

export function dbgLog(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
    fs.appendFileSync(DEBUG_LOG_PATH, line, { flag: 'a' });
  } catch { /* best-effort */ }
  console.log('[sse-daemon] ' + msg);
}

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
 *
 * Rotation: when the log exceeds MAX_DEBUG_LOG_BYTES it is renamed to
 * sse-debug.log.old (overwriting any previous rotation) before the write
 * continues. The previous implementation appended forever — the file grew
 * without bound across weeks of runtime (1.4MB+ observed and climbing).
 *
 * Level gating: dbgLog is a DEBUG-level diagnostic channel. In production
 * builds it is SILENT by default — no file writes, no console output — so a
 * long-running daemon doesn't accumulate log state. Set `MOLIO_DEBUG=1` to
 * enable it when investigating an issue (ask the reporter to reproduce with
 * the flag set). Read at module load; tests set the env before importing.
 *
 * The directory is overridable via MOLIO_DEBUG_LOG_DIR (used by tests to
 * avoid writing into the real homedir).
 */
export function isDebugEnabled(): boolean {
  return process.env['MOLIO_DEBUG'] === '1';
}

const DEBUG_LOG_DIR = process.env['MOLIO_DEBUG_LOG_DIR']
  || path.join(os.homedir(), '.molio', 'debug');
const DEBUG_LOG_PATH = path.join(DEBUG_LOG_DIR, 'sse-debug.log');

/** Rotate past this size. Kept small: this is a diagnostic channel, not an audit trail. */
export const MAX_DEBUG_LOG_BYTES = 1 * 1024 * 1024; // 1 MB

/** Rename the log to .old if it exceeds the size cap. Best-effort. */
function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(DEBUG_LOG_PATH);
    if (st.size > MAX_DEBUG_LOG_BYTES) {
      fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_PATH + '.old');
    }
  } catch {
    // ENOENT (no file yet) or a transient FS error — just keep appending.
  }
}

export function dbgLog(msg: string): void {
  if (!isDebugEnabled()) return;
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(DEBUG_LOG_PATH, line, { flag: 'a' });
  } catch { /* best-effort */ }
  console.log('[sse-daemon] ' + msg);
}

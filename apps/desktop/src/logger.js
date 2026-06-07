/**
 * Simple file logger for the desktop app.
 *
 * Writes to {logDir}/updater.log with automatic rotation.
 * Uses only Node.js built-in `fs` — no external dependencies.
 *
 * By default the log directory is `{userData}/logs/` (from Electron).
 * Call `setLogDir(dir)` before first use to override (e.g. for testing).
 */

import { appendFileSync, renameSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const MAX_LOG_SIZE = 1024 * 1024; // 1 MB
let customLogDir = null;
let logDir = null;
let logFile = null;

/**
 * Override the log directory (for testing or custom deployments).
 * Must be called before the first `log()` or `getLogPath()` call.
 *
 * @param {string} dir — absolute path to log directory
 */
export function setLogDir(dir) {
  customLogDir = dir;
  logDir = null;
  logFile = null;
}

/** Initialize log directory and file path. Safe to call multiple times. */
function ensureLogPath() {
  if (logFile) return;

  if (customLogDir) {
    logDir = customLogDir;
  } else {
    // Lazy import electron only when needed (avoids error in plain Node.js tests)
    const require = createRequire(import.meta.url);
    const { app } = require('electron');
    logDir = path.join(app.getPath('userData'), 'logs');
  }

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  logFile = path.join(logDir, 'updater.log');

  // Rotate if existing log is too large
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_SIZE) {
      const rotated = logFile + '.old';
      renameSync(logFile, rotated);
    }
  } catch {
    // Ignore rotation errors — just keep appending
  }
}

/**
 * Write a log line. Always appends.
 * @param {'info'|'warn'|'error'} level
 * @param {string} tag  — e.g. "updater", "main", "daemon"
 * @param {string} message
 */
export function log(level, tag, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${message}\n`;

  // Always mirror to console for dev experience
  const consoleFn = level === 'error' ? console.error : console.log;
  consoleFn(line.trimEnd());

  try {
    ensureLogPath();
    appendFileSync(logFile, line, 'utf-8');
  } catch {
    // File logging failure must never crash the app
  }
}

/**
 * Return the log file path (for diagnostics / IPC).
 * @returns {string | null}
 */
export function getLogPath() {
  ensureLogPath();
  return logFile;
}

/** @internal Reset state for testing */
export function _reset() {
  customLogDir = null;
  logDir = null;
  logFile = null;
}

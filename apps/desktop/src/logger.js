/**
 * Simple file logger for the desktop app.
 *
 * Writes to {userData}/logs/updater.log with automatic rotation.
 * Uses only Node.js built-in `fs` — no external dependencies.
 */

import { app } from 'electron';
import { appendFileSync, renameSync, statSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const MAX_LOG_SIZE = 1024 * 1024; // 1 MB
let logDir = null;
let logFile = null;

/** Initialize log directory and file path. Safe to call multiple times. */
function ensureLogPath() {
  if (logFile) return;
  logDir = path.join(app.getPath('userData'), 'logs');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  logFile = path.join(logDir, 'updater.log');

  // Rotate if existing log is too large
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_SIZE) {
      const rotated = logFile + '.old';
      if (existsSync(rotated)) {
        // Silently discard old rotated file
      }
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

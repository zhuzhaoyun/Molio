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
/** Tracked size of the live log file — avoids a statSync per write. */
let currentSize = 0;
/** Cached console-mirror decision (null = not resolved yet). */
let mirrorConsole = null;

/**
 * Mirror log lines to the console ONLY in development. In packaged builds
 * the main-process console goes nowhere useful, and error-level lines get
 * captured by the ARMS consoleError collector — flooding 异常统计 with
 * routine daemon stderr forwards. File logging (with rotation) remains the
 * single source of truth in production.
 *
 * Plain Node.js (tests, scripts) has no electron — fall back to mirroring
 * so the dev/test experience keeps console output.
 */
function shouldMirrorConsole() {
  if (mirrorConsole !== null) return mirrorConsole;
  try {
    const require = createRequire(import.meta.url);
    const { app } = require('electron');
    mirrorConsole = !app.isPackaged;
  } catch {
    mirrorConsole = true;
  }
  return mirrorConsole;
}

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
    if (existsSync(logFile)) {
      const size = statSync(logFile).size;
      if (size > MAX_LOG_SIZE) {
        renameSync(logFile, logFile + '.old');
        currentSize = 0;
      } else {
        currentSize = size;
      }
    } else {
      currentSize = 0;
    }
  } catch {
    // Ignore rotation errors — just keep appending
    currentSize = 0;
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

  // Console mirror: dev only (see shouldMirrorConsole). Production keeps
  // everything in the rotated log file.
  if (shouldMirrorConsole()) {
    const consoleFn = level === 'error' ? console.error : console.log;
    consoleFn(line.trimEnd());
  }

  try {
    ensureLogPath();
    // In-session rotation: the startup-only check let a long-running session
    // (a day of daemon log forwards) grow the file unbounded. Track size in
    // memory — no extra statSync per write.
    if (currentSize > MAX_LOG_SIZE) {
      renameSync(logFile, logFile + '.old');
      currentSize = 0;
    }
    appendFileSync(logFile, line, 'utf-8');
    currentSize += Buffer.byteLength(line, 'utf-8');
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
  currentSize = 0;
  mirrorConsole = null;
}

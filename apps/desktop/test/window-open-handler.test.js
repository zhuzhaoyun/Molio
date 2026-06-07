/**
 * Regression test for Issue #18 — publish opens in Electron instead of system browser.
 *
 * Verifies that main.js registers a setWindowOpenHandler that calls
 * shell.openExternal() and denies the window action. This prevents
 * window.open() from creating Electron child windows — instead the URL
 * is opened in the user's system browser where the COSE extension lives.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');

describe('main.js window.open handler (regression #18)', () => {
  it('should register setWindowOpenHandler on webContents', () => {
    assert.ok(
      mainSource.includes('setWindowOpenHandler'),
      'main.js must register setWindowOpenHandler to intercept window.open() calls',
    );
  });

  it('should call shell.openExternal for intercepted URLs', () => {
    // The handler must forward the URL to the system browser
    assert.ok(
      mainSource.includes('shell.openExternal'),
      'setWindowOpenHandler must call shell.openExternal(url) to open in system browser',
    );
  });

  it('should deny the window action to prevent Electron child windows', () => {
    // The handler must return { action: 'deny' } so Electron doesn't open a new window
    assert.match(
      mainSource,
      /action:\s*['"]deny['"]/,
      'setWindowOpenHandler must return { action: "deny" } to block Electron child windows',
    );
  });

  it('should extract url from handler params', () => {
    // Verify the handler destructures { url } from the params
    assert.match(
      mainSource,
      /setWindowOpenHandler\s*\(\s*\(\s*\{\s*url\s*\}/,
      'setWindowOpenHandler should destructure { url } from the handler params',
    );
  });
});

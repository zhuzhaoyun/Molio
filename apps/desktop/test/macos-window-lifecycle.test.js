/**
 * Regression test for: macOS dock click gets stuck on splash screen after
 * closing the window.
 *
 * Root cause: On macOS, closing the window destroys it but the app stays alive
 * (window-all-closed skips quit on darwin). Clicking the dock icon fires the
 * activate event, which calls createWindow(). Since commit 83c6eca introduced
 * the splash screen, createWindow() loads splash.html in production, but
 * loadApp() was never called again — the daemon was already running, so the
 * splash spinner spun forever.
 *
 * Fix: macOS hide-on-close pattern — prevent window destruction on close,
 * hide instead. Dock click shows the existing window instantly without any
 * reload. A forceQuit flag ensures Cmd+Q / dock-quit still properly closes
 * the window.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mainJs = readFileSync(
  path.resolve(import.meta.dirname, '../src/main.js'),
  'utf-8'
);

describe('main.js: macOS hide-on-close (regression: dock reopen stuck on splash)', () => {
  it('should define forceQuit flag to distinguish hide-on-close from real quit', () => {
    assert.ok(
      mainJs.includes('let forceQuit = false'),
      'forceQuit flag must exist so the close handler knows when the app is truly quitting'
    );
  });

  it('should set forceQuit = true in before-quit handler', () => {
    const beforeQuitPos = mainJs.indexOf("app.on('before-quit'");
    assert.ok(beforeQuitPos !== -1, 'before-quit handler must exist');

    const beforeQuitEnd = mainJs.indexOf('\napp.on(', beforeQuitPos + 10);
    const beforeQuitBlock = mainJs.slice(beforeQuitPos, beforeQuitEnd > beforeQuitPos ? beforeQuitEnd : beforeQuitPos + 500);

    assert.ok(
      beforeQuitBlock.includes('forceQuit = true'),
      'before-quit must set forceQuit = true so the window close handler allows the window to actually close'
    );

    // forceQuit must be set BEFORE event.preventDefault() so the daemon kill
    // path also benefits from it
    const forceQuitIdx = beforeQuitBlock.indexOf('forceQuit = true');
    const preventDefaultIdx = beforeQuitBlock.indexOf('event.preventDefault()');
    if (preventDefaultIdx !== -1) {
      assert.ok(
        forceQuitIdx < preventDefaultIdx,
        'forceQuit = true must be set before event.preventDefault() so all quit paths have it'
      );
    }
  });

  it('should have a macOS close handler that hides instead of destroying the window', () => {
    // The close handler must be registered on the window inside createWindow()
    const closeHandler = mainJs.match(/win\.on\('close',\s*\(event\)\s*=>\s*\{[\s\S]*?\}/);
    assert.ok(closeHandler, 'createWindow must register a close event handler on the window');

    const handlerBody = closeHandler[0];

    // Must check platform and forceQuit flag
    assert.ok(
      handlerBody.includes("process.platform === 'darwin'"),
      'close handler must check for macOS platform'
    );
    assert.ok(
      handlerBody.includes('!forceQuit'),
      'close handler must check !forceQuit so Cmd+Q properly closes the window'
    );
    assert.ok(
      handlerBody.includes('event.preventDefault()'),
      'close handler must call event.preventDefault() to stop window destruction on macOS'
    );
    assert.ok(
      handlerBody.includes('win.hide()'),
      'close handler must hide the window instead of destroying it'
    );
  });

  it('should have a closed handler that drops the window from appWindows', () => {
    assert.ok(
      mainJs.includes("win.on('closed'") || mainJs.includes('win.on("closed"'),
      'createWindow must register a closed event handler for cleanup'
    );

    const closedMatch = mainJs.match(/win\.on\('closed',\s*\(\)\s*=>\s*\{[\s\S]*?appWindows\.delete\(win\)[\s\S]*?\}\)/);
    assert.ok(
      closedMatch,
      'closed handler must appWindows.delete(win) so the window is dropped from the collection on real destroy'
    );
  });

  it('should still quit on non-macOS when all windows are closed', () => {
    const allClosedPos = mainJs.indexOf("app.on('window-all-closed'");
    assert.ok(allClosedPos !== -1, 'window-all-closed handler must exist');

    const allClosedEnd = mainJs.indexOf('\n\n', allClosedPos + 20);
    const allClosedBlock = mainJs.slice(allClosedPos, allClosedEnd > allClosedPos ? allClosedEnd : allClosedPos + 300);

    assert.ok(
      allClosedBlock.includes("process.platform !== 'darwin'"),
      'window-all-closed must quit on non-macOS platforms'
    );
    assert.ok(
      allClosedBlock.includes('app.quit()'),
      'window-all-closed must call app.quit() on non-macOS'
    );
  });

  it('activate should restore hidden/minimized window instead of ignoring it', () => {
    // The activate handler must handle windows that exist but are hidden
    // (hide-on-close) or minimized. Without this, macOS dock click does
    // NOT automatically show hidden Electron windows.
    const activatePos = mainJs.indexOf("app.on('activate'");
    assert.ok(activatePos !== -1, 'activate handler must exist');

    const activateEnd = mainJs.indexOf('\n  });', activatePos + 10);
    const activateBlock = mainJs.slice(activatePos, activateEnd > activatePos ? activateEnd : activatePos + 500);

    assert.ok(
      activateBlock.includes('appWindows.size === 0'),
      'activate must still create a window when none exist (cold start)'
    );
    assert.ok(
      activateBlock.includes('win.isMinimized()'),
      'activate must check isMinimized() to restore dock-minimized windows'
    );
    assert.ok(
      activateBlock.includes('win.restore()'),
      'activate must call restore() for minimized windows'
    );
    assert.ok(
      activateBlock.includes('!win.isVisible()'),
      'activate must check isVisible() for hidden windows (hide-on-close)'
    );
    assert.ok(
      activateBlock.includes('win.show()'),
      'activate must call win.show() for hidden windows'
    );
    assert.ok(
      activateBlock.includes('win.focus()'),
      'activate must call focus() to bring window to front'
    );
  });
});

describe('main.js: second-instance must restore hidden windows (macOS hide-on-close compat)', () => {
  it('should restore hidden windows via isVisible() check', () => {
    const secondInstancePos = mainJs.indexOf("app.on('second-instance'");
    assert.ok(secondInstancePos !== -1, 'second-instance handler must exist');

    const secondInstanceEnd = mainJs.indexOf('\n  });', secondInstancePos + 20);
    const secondInstanceBlock = mainJs.slice(secondInstancePos, secondInstanceEnd > secondInstancePos ? secondInstanceEnd : secondInstancePos + 600);

    // Must handle hidden windows (not just minimized)
    assert.ok(
      secondInstanceBlock.includes('isVisible()'),
      'second-instance must check isVisible() to restore hidden windows from macOS hide-on-close'
    );
    assert.ok(
      secondInstanceBlock.includes('win.show()'),
      'second-instance must call win.show() for hidden windows'
    );
    assert.ok(
      secondInstanceBlock.includes('isMinimized()'),
      'second-instance must still check isMinimized() for dock-minimized windows'
    );
  });
});

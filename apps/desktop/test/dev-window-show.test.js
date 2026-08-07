/**
 * Regression test — dev-mode main window never shown.
 *
 * #183 removed the shared `ready-to-show` handler from createWindow() to fix
 * the ARMS Browser SDK double-injection problem (splash → app navigation).
 * That was correct for production — loadApp() / showDaemonErrorPage() show
 * the window after the single app navigation — but dev mode has no loadApp()
 * call, so nothing ever called show(): `pnpm dev:desktop` left every process
 * healthy (daemon up, vite up, renderer ready) with an invisible window.
 *
 * Dev mode skips ARMS init entirely, so a dev-only ready-to-show → show()
 * handler is safe and restores the pre-#183 behaviour.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');

/** Extract the createWindow() function body (up to the next top-level function). */
function createWindowSource() {
  const start = mainSource.indexOf('function createWindow()');
  assert.notEqual(start, -1, 'createWindow() must exist in main.js');
  const end = mainSource.indexOf('function loadApp()', start);
  assert.notEqual(end, -1, 'loadApp() must follow createWindow() in main.js');
  return mainSource.slice(start, end);
}

/** Extract the dev-mode branch inside createWindow(). */
function devBranchSource() {
  const body = createWindowSource();
  const start = body.indexOf('if (isDevMode())');
  assert.notEqual(start, -1, 'createWindow() must have a dev-mode branch');
  // Take everything from the dev branch to the end of createWindow — the
  // dev branch is the last statement in the function.
  return body.slice(start);
}

describe('main.js dev-mode window visibility (regression: dev window never shown)', () => {
  it('dev branch registers a ready-to-show handler that shows the window', () => {
    const dev = devBranchSource();
    assert.match(
      dev,
      /ready-to-show[\s\S]*?\.show\(\)/,
      'dev mode must show the window via ready-to-show — without it nothing ' +
        'ever calls show() and the window stays hidden forever',
    );
  });

  it('dev branch still loads the Vite dev server', () => {
    const dev = devBranchSource();
    assert.ok(
      dev.includes('http://localhost:5173'),
      'dev mode must load the Vite dev server URL',
    );
  });

  it('production show paths (loadApp / error page) are untouched', () => {
    // The ARMS one-navigation-one-injection design requires production to
    // keep showing the window only after the real app URL finishes loading.
    const loadAppStart = mainSource.indexOf('function loadApp()');
    assert.notEqual(loadAppStart, -1, 'loadApp() must exist');
    const loadAppSrc = mainSource.slice(
      loadAppStart,
      mainSource.indexOf('function showDaemonErrorPage()', loadAppStart),
    );
    assert.match(
      loadAppSrc,
      /once\(\s*['"]did-finish-load['"]\s*,\s*onFinish\s*\)/,
      'loadApp() must keep showing the window via did-finish-load',
    );
    assert.match(
      loadAppSrc,
      /onFinish\s*=[\s\S]*?\.show\(\)/,
      'loadApp() onFinish must call mainWindow.show()',
    );
  });
});

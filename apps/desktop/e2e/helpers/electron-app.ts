import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { waitForDaemon, waitForDaemonShutdown } from './daemon-health';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  /** Daemon port this instance is bound to (3100 in CI, an ephemeral port locally). */
  daemonPort: number;
}

/** CI runners are clean — keep the historical fixed port there. */
const CI_DAEMON_PORT = 3100;

/**
 * Pick a free daemon port for a local E2E run.
 *
 * Locally the installed Molio may be running: it holds :3100 *and* the
 * single-instance lock (a second daemon on 3100 would also be auto-killed by
 * `isKillablePortOccupant`, taking the user's app down). So local runs bind an
 * ephemeral port instead. The ephemeral range (49152–65535) is reserved by the
 * OS for dynamic assignment, so a static occupant is practically impossible —
 * a fixed 3101–3199 scan would instead collide between parallel worktrees.
 *
 * CI keeps the fixed port: runners are clean, and a stable port keeps the
 * nightly logs/diagnostics comparable across runs.
 */
export async function pickDaemonPort(): Promise<number> {
  if (process.env.CI === 'true') return CI_DAEMON_PORT;

  const tryBind = (remaining: number): Promise<number> => {
    if (remaining <= 0) {
      return Promise.reject(new Error('[e2e] could not find a free daemon port'));
    }
    // Ephemeral range — reserved by the OS for dynamic assignment, so a static
    // occupant is practically impossible. Random start also keeps parallel
    // worktrees from racing for the same port.
    const port = 49152 + Math.floor(Math.random() * (65535 - 49152));
    return new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', (err: NodeJS.ErrnoException) => {
        // EADDRINUSE → try another port; anything else is unexpected.
        probe.close(() => {});
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          resolve(tryBind(remaining - 1));
        } else {
          reject(err);
        }
      });
      probe.listen(port, () => {
        probe.close(() => resolve(port));
      });
    });
  };

  return tryBind(10);
}

/**
 * Create an isolated data directory for E2E tests.
 * Daemon reads MOLIO_DATA_DIR (see apps/daemon/src/core/db.ts) — pointing it at
 * a temp dir prevents E2E runs from touching the user's real ~/.molio data.
 */
export function createE2EDataDir(): string {
  const dir = path.join(os.tmpdir(), `molio-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Launch the packaged Electron app and wait for daemon to be ready.
 *
 * @param exePath - Path to Molio.exe (defaults to MOLIO_EXE_PATH env var)
 * @param daemonTimeout - Max ms to wait for daemon health (default 45s)
 * @returns { electronApp, page } — the main BrowserWindow page
 */
export async function launchMolioApp(
  exePath?: string,
  daemonTimeout = 45_000,
): Promise<LaunchedApp> {
  const executablePath = exePath ?? process.env.MOLIO_EXE_PATH;
  if (!executablePath) {
    throw new Error(
      'No executable path provided. Set MOLIO_EXE_PATH env var or pass exePath.',
    );
  }

  // Isolated data dir — daemon writes app.sqlite, config.json, runs/, etc.
  // to this temp dir instead of the user's real ~/.molio.
  const dataDir = createE2EDataDir();
  // Local runs use an ephemeral port so they can coexist with an installed
  // Molio; CI keeps the fixed 3100.
  const daemonPort = await pickDaemonPort();

  // Launch the Electron app
  const electronApp = await _electron.launch({
    executablePath,
    args: [
      // Disable hardware acceleration for CI/headless stability
      '--disable-gpu',
      '--no-sandbox',
      // Separate userData → separate single-instance lock. Without this a
      // second instance bails immediately while the user's app is running.
      `--user-data-dir=${dataDir}`,
    ],
    env: {
      ...process.env,
      // Prevent auto-updater from firing during tests
      MOLIO_DISABLE_UPDATER: '1',
      // Isolated data directory — see createE2EDataDir
      MOLIO_DATA_DIR: dataDir,
      // Daemon port (main.js reads it; defaults to 3100 for real users)
      MOLIO_PORT: String(daemonPort),
      // Runtime homes + debug logs follow the daemon's env hooks (data-dir.ts),
      // same isolation set the web E2E injects — keeps runs off the developer's
      // real ~/.claude / ~/.codex.
      MOLIO_CLAUDE_HOME: path.join(dataDir, 'claude'),
      MOLIO_CODEX_HOME: path.join(dataDir, 'codex'),
      MOLIO_DEBUG_LOG_DIR: path.join(dataDir, 'debug'),
    },
  });

  // Get the main BrowserWindow
  const page = await electronApp.firstWindow();

  // Wait for the window to be ready
  await page.waitForLoadState('domcontentloaded');

  // Wait for daemon to become healthy
  const healthy = await waitForDaemon(daemonPort, daemonTimeout);
  if (!healthy) {
    // Don't throw here — let the test decide if this is fatal.
    // Some tests may want to verify splash screen behavior during startup.
    console.warn('[e2e] Daemon did not become healthy within timeout');
  }

  // Give the UI a moment to fully render after daemon is ready
  await page.waitForTimeout(1_000);

  return { electronApp, page, daemonPort };
}

/**
 * Gracefully close the Electron app and wait for daemon shutdown.
 *
 * After close(), actively polls for remaining Molio.exe processes to ensure
 * the single-instance lock is fully released. If processes linger beyond
 * the timeout, force-kills them with taskkill.
 *
 * Process cleanup only runs in CI (process.env.CI === 'true') to avoid
 * killing the user's locally-running Molio instance during development.
 */
export async function closeMolioApp(
  app: LaunchedApp,
  shutdownTimeout = 10_000,
): Promise<void> {
  try {
    await app.electronApp.close();
  } catch {
    // App may already be closed
  }

  // Wait for daemon process to exit
  await waitForDaemonShutdown(app.daemonPort, shutdownTimeout);

  // Process cleanup only in CI — locally we don't want to kill the user's
  // running Molio instance (e.g. they might have it open while running tests).
  if (process.env.CI !== 'true') return;

  await ensureNoMolioProcesses();
}

/**
 * Actively poll for lingering Molio.exe processes and force-kill if needed.
 *
 * Electron's single-instance lock is held by the main process — if it lingers
 * after close(), the next spec file's requestSingleInstanceLock() returns false
 * and the app immediately exits. This helper polls for processes and force-kills
 * after a grace period.
 */
export async function ensureNoMolioProcesses(): Promise<void> {
  const cleanupTimeout = 5_000; // 5s to gracefully exit
  const pollInterval = 500;
  const start = Date.now();

  while (Date.now() - start < cleanupTimeout) {
    if (!hasMolioProcess()) return; // Clean exit
    await new Promise(r => setTimeout(r, pollInterval));
  }

  // Timeout — force kill any remaining processes
  console.warn('[e2e] Molio processes still running after 5s, force-killing');
  forceKillMolioProcesses();
  await new Promise(r => setTimeout(r, 1000));
}

/**
 * Check if any Molio.exe processes are still running.
 * Uses tasklist to detect Electron main process and renderer processes.
 * Matches the process name in the output (more robust than counting lines,
 * which can vary by Windows locale).
 */
export function hasMolioProcess(): boolean {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq Molio.exe" /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // /NH removes the header; if output is empty or whitespace, no processes
    return output.trim().length > 0;
  } catch {
    return false; // tasklist failed — assume no processes
  }
}

/**
 * Force-kill all Molio.exe processes.
 * Use when graceful shutdown fails or as a last-resort cleanup.
 */
export function forceKillMolioProcesses(): void {
  try {
    execSync('taskkill /F /IM Molio.exe', { stdio: 'ignore' });
  } catch {
    // taskkill returns non-zero if no matching process found — ignore
  }
}

/**
 * Wait for daemon to become healthy (re-export for convenience).
 */
export { waitForDaemon } from './daemon-health';

/**
 * SPA-navigate to the full-page chat (`/chat`), without a full page reload.
 *
 * `/chat` is no longer reachable from the nav rail — #293 moved the app entry
 * to `/` → `/knowledge`, and the chat page became the floating panel's
 * fullscreen form. `[data-view="home"]` therefore no longer exists.
 * pushState + popstate is what react-router treats as an SPA navigation,
 * matching the path a nav-rail click used to take (same convention as the web
 * layer's `gotoChatSpa`).
 */
export async function gotoChatSpa(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.history.pushState({}, '', '/chat');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

/**
 * Assert at least one of the given locators is visible within timeout.
 *
 * Extracts the repetitive pattern: declare locators → Promise.race waitFor →
 * isVisible checks → final expect. Callers pass an array of locators; this
 * helper handles the race and the final assertion.
 *
 * @param locators - Playwright locators to check (at least one must be visible)
 * @param timeout - Max ms to wait for any locator to become visible (default 5000)
 */
export async function expectAnyVisible(
  locators: Array<ReturnType<Page['locator']>>,
  timeout = 5_000,
): Promise<void> {
  // Race: wait for the first locator to become visible
  await Promise.race(
    locators.map((loc) => loc.waitFor({ state: 'visible', timeout }).catch(() => {})),
  );

  // Assert: at least one is actually visible (race may resolve without any visible)
  const visibleFlags = await Promise.all(
    locators.map((loc) => loc.isVisible().catch(() => false)),
  );
  if (!visibleFlags.some(Boolean)) {
    throw new Error(
      `Expected at least one locator to be visible, but none were. ` +
        `Checked ${locators.length} locator(s).`,
    );
  }
}

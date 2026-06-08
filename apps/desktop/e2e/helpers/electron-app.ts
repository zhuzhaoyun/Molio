import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { waitForDaemon } from './daemon-health';

export interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
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

  // Launch the Electron app
  const electronApp = await _electron.launch({
    executablePath,
    args: [
      // Disable hardware acceleration for CI/headless stability
      '--disable-gpu',
      '--no-sandbox',
    ],
    env: {
      ...process.env,
      // Prevent auto-updater from firing during tests
      MOLIO_DISABLE_UPDATER: '1',
    },
  });

  // Get the main BrowserWindow
  const page = await electronApp.firstWindow();

  // Wait for the window to be ready
  await page.waitForLoadState('domcontentloaded');

  // Wait for daemon to become healthy
  const healthy = await waitForDaemon(3100, daemonTimeout);
  if (!healthy) {
    // Don't throw here — let the test decide if this is fatal.
    // Some tests may want to verify splash screen behavior during startup.
    console.warn('[e2e] Daemon did not become healthy within timeout');
  }

  // Give the UI a moment to fully render after daemon is ready
  await page.waitForTimeout(1_000);

  return { electronApp, page };
}

/**
 * Gracefully close the Electron app and wait for daemon shutdown.
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
  await waitForDaemonShutdown(3100, shutdownTimeout);
}

/**
 * Wait for daemon to become healthy (re-export for convenience).
 */
export { waitForDaemon } from './daemon-health';

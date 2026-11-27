/**
 * Poll the daemon health endpoint until it responds 200 or timeout.
 *
 * In production mode, the daemon starts as a child process of Electron
 * and takes a few seconds to initialize (SQLite, HTTP server, etc.).
 */
export async function waitForDaemon(
  port = 3100,
  timeoutMs = 45_000,
): Promise<boolean> {
  const url = `http://localhost:${port}/api/health`;
  const start = Date.now();
  const pollInterval = 1_000;

  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        return true;
      }
    } catch {
      // Daemon not ready yet — retry
    }

    await sleep(pollInterval);
  }

  return false;
}

/**
 * Wait for the daemon to become unreachable (e.g., after app quit).
 */
export async function waitForDaemonShutdown(
  port = 3100,
  timeoutMs = 15_000,
): Promise<boolean> {
  const url = `http://localhost:${port}/api/health`;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      // Still reachable — wait and retry
    } catch {
      return true; // Unreachable = shut down
    }

    await sleep(500);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

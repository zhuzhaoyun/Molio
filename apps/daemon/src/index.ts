import { serve } from '@hono/node-server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, db, runManager, weixinService, feishuService, vaultWatcher, preloadManager, authClient } from './server.js';
import { initSkillLibrary } from './core/skills/builtin.js';
import { reconcileAllVaultsAsync, cleanupLegacyGlobalSync } from './core/skills/vault-config.js';
import { isKillablePortOccupant } from './core/port-check.js';
import { startMemoryMonitor } from './core/memory-monitor.js';
import { pruneRunLogsAsync } from './core/runs-log-prune.js';
import { maybeCreateDefaultVault } from './core/default-vault.js';

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const port = Number(process.env['MOLIO_PORT'] ?? 3100);

/**
 * Delay between "listening" and the deferred startup chores. The web UI fires
 * its first-screen request storm the moment the desktop shell sees the
 * "listening on" line; running prune (~4s cold) + skill fan-out (~1.2s/vault)
 * + vault polling immediately competes with those requests for CPU/IO.
 * Configurable for tests/tuning; 0 restores the old run-immediately behaviour.
 */
const CHORES_DELAY_MS = Number(process.env['MOLIO_CHORES_DELAY_MS'] ?? 3000);

/** Startup timing baseline — [startup] phase logs are relative to module eval. */
const startupT0 = Date.now();
const elapsedMs = () => Date.now() - startupT0;

async function runNetstatListening(port_: number): Promise<string> {
  const { stdout } = await execFileAsync('netstat', ['-ano'], { encoding: 'utf-8' });
  return stdout
    .split('\n')
    .filter((l) => l.includes('LISTENING') && l.includes(`:${port_}`))
    .join('\n');
}

/**
 * Kill a stale daemon occupying our port. Async throughout (execFile + sleep
 * polling, no execSync/busy-wait): this only runs from the EADDRINUSE retry
 * path, and blocking the event loop here would delay the very retry that
 * recovers startup. Only kills processes that look like a previous daemon
 * (node/tsx or packaged Molio.exe/electron.exe running daemon via
 * ELECTRON_RUN_AS_NODE) — never arbitrary user software.
 */
async function checkAndKillPortOccupant(port_: number): Promise<void> {
  const platform = process.platform;

  try {
    let pid: number | null = null;
    let processName = '';

    if (platform === 'win32') {
      const listing = await runNetstatListening(port_).catch(() => '');
      const match = listing.match(/\s+(\d+)\s*$/m);
      if (match) {
        pid = Number(match[1]);
        try {
          const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
            encoding: 'utf-8',
          });
          processName = stdout.trim();
        } catch { /* ignore */ }
      }
    } else {
      // Unix: lsof -ti :PORT
      try {
        const { stdout } = await execFileAsync('lsof', ['-ti', `:${port_}`], { encoding: 'utf-8' });
        const match = stdout.match(/\d+/);
        if (match) {
          pid = Number(match[0]);
          try {
            const { stdout: ps } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], {
              encoding: 'utf-8',
            });
            processName = ps.trim();
          } catch { /* ignore */ }
        }
      } catch {
        // lsof exits non-zero when nothing holds the port
      }
    }

    if (!pid) return;

    if (isKillablePortOccupant(processName)) {
      console.log(`Port ${port_} occupied by Node process (PID ${pid}), killing it...`);
      try {
        process.kill(pid, 'SIGTERM');
        // Wait (async) for the port to be released, up to 2s.
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await sleep(200);
          const listing = platform === 'win32'
            ? await runNetstatListening(port_).catch(() => '')
            : await execFileAsync('lsof', ['-ti', `:${port_}`], { encoding: 'utf-8' })
              .then((r) => r.stdout)
              .catch(() => '');
          if (!listing.trim()) break; // 端口已释放
        }
      } catch {
        console.warn(`Failed to kill process ${pid}, trying SIGKILL...`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* ignore */ }
      }
    } else {
      console.error(
        `⚠️  Port ${port_} is occupied by "${processName}" (PID ${pid}).\n` +
        `   This doesn't look like a Node.js process. Please stop it manually or use a different port:\n` +
        `   MOLIO_PORT=3101 pnpm dev:daemon`
      );
      process.exit(1);
    }
  } catch {
    // 命令执行失败说明端口没被占用，正常继续
  }
}

// Seed built-in skills into the `skills` table — the master switch source
// (bundled: docling/wiki-*/wechat) and retire the removed core writing trio.
// Must run before any vault reconcile reads the table. Fast (SQLite upserts)
// and kept before listen so API requests never observe an unseeded library.
const skillsSeeded = initSkillLibrary(db);

// ⚠️ The port-occupant check is NO LONGER done preemptively here. It used to
// run execSync netstat/tasklist (+ up to 2s busy-wait) on every start even
// when the port was free. Now we just try to bind; the EADDRINUSE handler in
// startServer() does the (async) kill + retry only when actually needed.

// ⚠️ Everything HEAVY (vault watching, preload detection, run-log prune,
// per-vault skill fan-out, legacy cleanup) runs in runDeferredStartupChores
// AFTER the port is bound AND after a short delay so the web UI's first-screen
// requests get the machine to themselves. Regression context: on a first launch
// after packaging, a cold prune sweep (~600 run dirs ≈ 4s) plus skill fan-out
// into every vault (≈1.2s/vault) pushed "listening" past the desktop shell's
// startup timeout, showing "后端服务启动失败" even though the daemon would have
// come up seconds later. Bind first, then catch up.
async function runDeferredStartupChores(): Promise<void> {
  // Every chore is best-effort and ISOLATED: one failing must never skip the
  // rest (a throwing prune used to silently kill fan-out + cleanup + preload).

  // Watch all vaults for external file changes (Chrome extension clippings,
  // weixin media, external edits). Moved out of server.ts module scope: on
  // Windows chokidar runs in polling mode (libuv fs.watch crash workaround)
  // and walks every vault tree — no reason to do that before first paint.
  try {
    vaultWatcher.start();
  } catch (err) {
    console.error('[startup] vault watcher start failed:', err instanceof Error ? err.message : err);
  }

  // Check which heavy skill tools are already installed. Results are stored in
  // the PreloadManager and served via GET /api/preload/status so the web UI can
  // show a preload suggestion toast. The UI fetches the status once (+ one
  // retry after 3s) and ignores 'unchecked'; with CHORES_DELAY_MS=3000 the
  // check still lands inside that window (fetch at ~0s, retry at ~3s, check
  // starts at ~3s) — if toast reliability regresses, tune the delay down or
  // move this single chore earlier.
  // Independent of the skills table/fan-out (probes system binaries only).
  try {
    const t = Date.now();
    preloadManager.checkSkills();
    console.log(`[startup] phase=preload-check elapsedMs=${Date.now() - t} atMs=${elapsedMs()}`);
  } catch (err) {
    console.error('[startup] preload check failed:', err instanceof Error ? err.message : err);
  }

  // Delete per-run JSONL logs older than 7 days (nothing cleaned them up
  // before; they accumulate indefinitely under ~/.molio/runs). The async
  // variant yields to the event loop in chunks.
  try {
    const t = Date.now();
    await pruneRunLogsAsync();
    console.log(`[startup] phase=run-log-prune elapsedMs=${Date.now() - t} atMs=${elapsedMs()}`);
  } catch (err) {
    console.error('[startup] run-log prune failed:', err instanceof Error ? err.message : err);
  }

  // Fan the effective skills into every vault's <vault>/.claude/skills/ —
  // bundled (whole-dir) + library (molio-- single file) + CLAUDE.md rules.
  // Per-vault, best-effort, yielding between vaults. Covers what the old
  // installBuiltinSkills loop did. Guarded on a successful seed: reconciling
  // against a (partially) empty table would treat missing built-ins as disabled
  // and delete already-synced skills.
  if (skillsSeeded) {
    try {
      const t = Date.now();
      await reconcileAllVaultsAsync(db);
      console.log(`[startup] phase=skill-fanout elapsedMs=${Date.now() - t} atMs=${elapsedMs()}`);
    } catch (err) {
      console.error('[startup] vault skill fan-out failed:', err instanceof Error ? err.message : err);
    }

    // Remove the legacy global ~/.claude/skills/molio--* sync left over from
    // the pre-per-vault design — ONLY now that the per-vault replacement is in
    // place. When seeding fails the fan-out above is skipped, and deleting the
    // legacy sync too would leave the user with NO skills at all until the
    // next successful restart.
    try {
      cleanupLegacyGlobalSync();
    } catch (err) {
      console.error('[startup] legacy skill cleanup failed:', err instanceof Error ? err.message : err);
    }
  } else {
    console.warn(
      '[skills] Seeding failed — skipping vault skill fan-out and legacy cleanup; ' +
        'vaults keep their previously synced skills.',
    );
  }
}

function startServicesAfterListen(): void {
  // First-boot provisioning for Docker/NAS one-click deploy: on an empty
  // install, auto-create the default vault pointing at the mounted docs dir
  // (/vaults or MOLIO_DEFAULT_VAULT_PATH) so users land inside a vault, not
  // the welcome screen. No-op once any vault exists. Failures must never crash
  // the daemon. Runs BEFORE vaultWatcher.start() (a deferred chore) so a
  // freshly created default vault is picked up by the initial watch sweep.
  try {
    const created = maybeCreateDefaultVault(db, vaultWatcher);
    if (created) {
      console.log(`[default-vault] auto-created default vault "${created.name}" at ${created.path}`);
    }
  } catch (err) {
    console.error('[default-vault] failed to auto-create default vault:', err);
  }

  // Channel services — both are async and network-bound (feishu fetches a
  // tenant token + opens a WS long connection; weixin resumes polling when
  // credentials exist). Moved out of server.ts module scope: they never block
  // listen, but starting them there made import order load-bearing.
  weixinService.start().catch((err) => {
    console.error('[startup] weixin service start failed:', err instanceof Error ? err.message : err);
  });
  feishuService.start().catch((err) => {
    console.error('[startup] feishu service start failed:', err instanceof Error ? err.message : err);
  });
}

function startServer(): void {
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`Molio daemon listening on http://localhost:${port}`);
    console.log(`[startup] phase=listen atMs=${elapsedMs()}`);
    // 登录态恢复（读本地 token → 云端 refresh 验证 → 拉权益快照）必须在
    // listen 之后异步执行——重活挂 listen 前会拖垮桌面壳的启动超时（教训）。
    void authClient.restoreSession();
    startServicesAfterListen();
    // The desktop shell gates readiness on the "listening on" line above —
    // heavy chores must only start after it is printed, and after a short
    // delay so the web UI's first-screen request storm isn't starved.
    const timer = setTimeout(() => {
      runDeferredStartupChores().catch((err) => {
        console.error(
          '[startup] deferred chores failed:',
          err instanceof Error ? err.stack : err,
        );
      });
    }, CHORES_DELAY_MS);
    timer.unref?.();
  });

  server.on('error', async (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, checking for old daemon process...`);
      await checkAndKillPortOccupant(port);
      setTimeout(() => startServer(), 500);
      return;
    }
    console.error('Failed to start daemon:', err.message);
    process.exit(1);
  });
}

startServer();

// Periodic memory sampling → ~/.molio/debug/sse-debug.log + stdout.
// Threshold configurable via MOLIO_MEMORY_THRESHOLD_MB (default 1024).
const thresholdMB = Number(process.env['MOLIO_MEMORY_THRESHOLD_MB']) || undefined;
const stopMemoryMonitor = startMemoryMonitor({
  thresholdMB,
  getContext: () => `activeRuns=${runManager.getActiveRunCount()}`,
});

// Graceful shutdown
function shutdown(): void {
  console.log('\nShutting down, canceling active runs...');
  stopMemoryMonitor();
  weixinService.stop();
  void vaultWatcher.stop();
  runManager.cancelAll();
  preloadManager.stopAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// [DEBUG] catch uncaught exceptions to diagnose daemon crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err?.stack ?? err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});

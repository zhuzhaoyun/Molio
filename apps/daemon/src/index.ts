import { serve } from '@hono/node-server';
import { execSync } from 'node:child_process';
import { app, db, runManager, weixinService, vaultWatcher, preloadManager } from './server.js';
import { initSkillLibrary } from './core/skills/builtin.js';
import { reconcileAllVaultsAsync, cleanupLegacyGlobalSync } from './core/skills/vault-config.js';
import { isKillablePortOccupant } from './core/port-check.js';
import { startMemoryMonitor } from './core/memory-monitor.js';
import { pruneRunLogsAsync } from './core/runs-log-prune.js';

const port = Number(process.env['MOLIO_PORT'] ?? 3100);

function checkAndKillPortOccupant(port: number): void {
  const platform = process.platform;

  try {
    let pid: number | null = null;
    let processName = '';

    if (platform === 'win32') {
      // Windows: netstat -ano | findstr :PORT
      const result = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = result.match(/\s+(\d+)\s*$/m);
      if (match) {
        pid = Number(match[1]);
        try {
          processName = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch { /* ignore */ }
      }
    } else {
      // Unix: lsof -ti :PORT
      const result = execSync(`lsof -ti :${port}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = result.match(/\d+/);
      if (match) {
        pid = Number(match[0]);
        try {
          processName = execSync(`ps -p ${pid} -o comm=`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch { /* ignore */ }
      }
    }

    if (!pid) return;

    // 只自动杀掉可能是上次没退出的 daemon（node/tsx 或打包后的
    // Molio.exe / electron.exe，后者以 ELECTRON_RUN_AS_NODE=1 跑 daemon）。
    // 其他进程不杀，避免误杀用户软件。
    if (isKillablePortOccupant(processName)) {
      console.log(`Port ${port} occupied by Node process (PID ${pid}), killing it...`);
      try {
        process.kill(pid, 'SIGTERM');
        // 等待端口释放
        const start = Date.now();
        while (Date.now() - start < 2000) {
          try {
            execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, {
              stdio: 'ignore',
            });
          } catch {
            break; // 端口已释放
          }
        }
      } catch {
        console.warn(`Failed to kill process ${pid}, trying SIGKILL...`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* ignore */ }
      }
    } else {
      console.error(
        `⚠️  Port ${port} is occupied by "${processName}" (PID ${pid}).\n` +
        `   This doesn't look like a Node.js process. Please stop it manually or use a different port:\n` +
        `   MOLIO_PORT=3101 pnpm dev:daemon`
      );
      process.exit(1);
    }
  } catch {
    // 命令执行失败说明端口没被占用，正常继续
  }
}

checkAndKillPortOccupant(port);

// Seed built-in skills into the `skills` table — the master switch source
// (bundled: docling/wiki-*/wechat) and retire the removed core writing trio.
// Must run before any vault reconcile reads the table. Fast (SQLite upserts)
// and kept before listen so API requests never observe an unseeded library.
const skillsSeeded = initSkillLibrary(db);

// ⚠️ Everything below that is HEAVY (run-log prune, per-vault skill fan-out,
// legacy cleanup, preload detection) runs in runDeferredStartupChores AFTER the
// port is bound. Regression context: on a first launch after packaging, a cold
// prune sweep (~600 run dirs ≈ 4s) plus skill fan-out into every vault
// (≈1.2s/vault) pushed "listening" past the desktop shell's startup timeout,
// showing "后端服务启动失败" even though the daemon would have come up seconds
// later. Bind first, then catch up.
async function runDeferredStartupChores(): Promise<void> {
  // Every chore is best-effort and ISOLATED: one failing must never skip the
  // rest (a throwing prune used to silently kill fan-out + cleanup + preload).

  // Check which heavy skill tools are already installed. Results are stored in
  // the PreloadManager and served via GET /api/preload/status so the web UI can
  // show a preload suggestion toast. Runs FIRST: the UI fetches the status once
  // (+ one retry after 3s) and ignores 'unchecked', so the check must land
  // before that window closes — it used to run after prune (~4s cold) + fan-out
  // (~1.2s/vault), so multi-vault cold starts never showed the toast.
  // Independent of the skills table/fan-out (probes system binaries only).
  try {
    preloadManager.checkSkills();
  } catch (err) {
    console.error('[startup] preload check failed:', err instanceof Error ? err.message : err);
  }

  // Delete per-run JSONL logs older than 7 days (nothing cleaned them up
  // before; they accumulate indefinitely under ~/.molio/runs). The async
  // variant yields to the event loop in chunks.
  try {
    await pruneRunLogsAsync();
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
      await reconcileAllVaultsAsync(db);
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

function startServer(): void {
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`Molio daemon listening on http://localhost:${port}`);
    // The desktop shell gates readiness on the "listening on" line above —
    // heavy chores must only start after it is printed.
    setImmediate(() => {
      runDeferredStartupChores().catch((err) => {
        console.error(
          '[startup] deferred chores failed:',
          err instanceof Error ? err.stack : err,
        );
      });
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, checking for old daemon process...`);
      checkAndKillPortOccupant(port);
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

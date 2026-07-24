import { serve } from '@hono/node-server';
import { execSync } from 'node:child_process';
import { app, db, runManager, weixinService, vaultWatcher, preloadManager } from './server.js';
import { listVaults } from './core/db.js';
import { installBuiltinSkills } from './core/skill-installer.js';
import { ensureWikiSysPromptFiles } from './core/wiki-prompts.js';
import { isKillablePortOccupant } from './core/port-check.js';

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

// Ensure all existing vaults have built-in skills installed (idempotent, <1ms per vault if already installed).
for (const vault of listVaults(db)) {
  installBuiltinSkills(vault.path);
}

// Materialize the feishu wiki role frame (the only channel still delivered via
// --append-system-prompt-file; weixin prepends its frame, see weixin/dispatcher).
ensureWikiSysPromptFiles();

// Check which heavy skill tools are already installed. Results are stored in
// the PreloadManager and served via GET /api/preload/status so the web UI can
// show a preload suggestion toast without blocking daemon startup.
preloadManager.checkSkills();

function startServer(): void {
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`Molio daemon listening on http://localhost:${port}`);
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

// Graceful shutdown
function shutdown(): void {
  console.log('\nShutting down, canceling active runs...');
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

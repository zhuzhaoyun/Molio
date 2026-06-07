import { serve } from '@hono/node-server';
import { execSync } from 'child_process';
import { app, runManager } from './server.js';

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

    // 只自动杀掉 Node.js 进程（可能是上次没退出的 daemon）
    const isNodeProcess = processName.toLowerCase().includes('node') ||
                          processName.toLowerCase().includes('tsx');

    if (isNodeProcess) {
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

serve({ fetch: app.fetch, port }, () => {
  console.log(`Molio daemon listening on http://localhost:${port}`);
});

// Graceful shutdown
function shutdown(): void {
  console.log('\nShutting down, canceling active runs...');
  runManager.cancelAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

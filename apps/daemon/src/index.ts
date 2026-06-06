import { serve } from '@hono/node-server';
import { execSync } from 'node:child_process';
import { app, runManager } from './server.js';

const port = Number(process.env['KGE_PORT'] ?? 3100);

/** Find and kill processes bound to the given port (Windows) */
function killPortUsers(p: number): boolean {
  try {
    const raw = execSync(`netstat -ano | findstr ":${p}" | findstr "LISTENING"`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
    let killed = false;
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid > 0 && pid !== process.pid) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 });
          console.log(`Killed old daemon process (PID ${pid})`);
          killed = true;
        } catch { /* ignore */ }
      }
    }
    return killed;
  } catch {
    return false;
  }
}

function startServer(): void {
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`KGE daemon listening on http://localhost:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, terminating old process...`);
      if (killPortUsers(port)) {
        setTimeout(() => startServer(), 500);
        return;
      }
    }
    console.error('Failed to start daemon:', err.message);
    process.exit(1);
  });
}

startServer();

// Graceful shutdown
function shutdown(): void {
  console.log('\nShutting down, canceling active runs...');
  runManager.cancelAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import { serve } from '@hono/node-server';
import { app, runManager } from './server.js';

const port = Number(process.env['KGE_PORT'] ?? 3100);

serve({ fetch: app.fetch, port }, () => {
  console.log(`KGE daemon listening on http://localhost:${port}`);
});

// Graceful shutdown
function shutdown(): void {
  console.log('\nShutting down, canceling active runs...');
  runManager.cancelAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

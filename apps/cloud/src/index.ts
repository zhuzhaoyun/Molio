import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createMailer } from './mailer.js';
import { AuthService } from './service.js';
import { MemoryAuthStore } from './store/memory.js';
import { PgAuthStore } from './store/pg.js';
import type { AuthStore } from './store/types.js';

const config = loadConfig();

// 无 DATABASE_URL → 内存模式（本地开发，重启丢登录态，§十七 L7）
let store: AuthStore;
let storeKind: 'memory' | 'pg';
if (config.databaseUrl) {
  store = new PgAuthStore(new pg.Pool({ connectionString: config.databaseUrl }));
  storeKind = 'pg';
} else {
  store = new MemoryAuthStore();
  storeKind = 'memory';
}

const mailer = createMailer(config);
const service = new AuthService({
  store,
  config,
  sendMail: (to, code) => mailer.send(to, code),
  now: () => Date.now(),
});
const app = createApp({ service, config, storeKind, now: () => Date.now() });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[cloud] listening :${info.port} env=${config.env} store=${storeKind}`);
});

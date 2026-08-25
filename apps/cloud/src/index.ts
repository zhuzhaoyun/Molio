import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createMailer } from './mailer.js';
import type { MarketRoutesDeps } from './market/routes.js';
import { MarketService } from './market/service.js';
import { OssSigner } from './market/signer.js';
import { AuthService } from './service.js';
import { MemoryMarketStore } from './store/market-memory.js';
import { PgMarketStore } from './store/market-pg.js';
import type { MarketStore } from './store/market-types.js';
import { MemoryAuthStore } from './store/memory.js';
import { PgAuthStore } from './store/pg.js';
import type { AuthStore } from './store/types.js';

const config = loadConfig();

// 无 DATABASE_URL → 内存模式（本地开发，重启丢登录态，§十七 L7）；prod 禁止（loadConfig 已 fail-fast，此处双保险）
let store: AuthStore;
let storeKind: 'memory' | 'pg';
let pool: pg.Pool | undefined;
if (config.databaseUrl) {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  // 空闲连接错误（DB 重启/断连）以 'error' 事件到达；无监听会变 uncaught exception 拖垮进程
  pool.on('error', (err) => {
    console.error('[cloud] pg pool idle error:', err);
  });
  store = new PgAuthStore(pool);
  storeKind = 'pg';
} else if (config.env === 'prod') {
  throw new Error('[cloud] prod 环境必须设置 DATABASE_URL（禁止内存模式）');
} else {
  store = new MemoryAuthStore();
  storeKind = 'memory';
}

const mailer = createMailer(config);
// service 与 app 共用同一时钟实例（app.ts 契约：两处 now 必须同源）
const now = () => Date.now();
const service = new AuthService({
  store,
  config,
  sendMail: (to, code) => mailer.send(to, code),
  now,
});

// 资源市场装配：仅当 OSS 凭证齐全（config.market 有值）；缺失 → /market 不挂载（404）
let marketDeps: MarketRoutesDeps | undefined;
if (config.market) {
  const marketStore: MarketStore = pool ? new PgMarketStore(pool) : new MemoryMarketStore();
  const signer = new OssSigner(config.market.oss);
  marketDeps = {
    service: new MarketService({ store: marketStore, users: store, signer, config: { market: config.market }, now }),
  };
  console.log(`[cloud] market enabled (bucket=${config.market.oss.bucket})`);
}
const app = createApp({ service, config, storeKind, now, market: marketDeps });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[cloud] listening :${info.port} env=${config.env} store=${storeKind}`);
});

// 优雅关停（FC 实例回收 / 滚动部署发 SIGTERM）：停止接新请求 → 等在途请求排空 →
// 释放 DB 连接池。不做的话进程直接退出，会掉在途请求并泄漏连接。
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cloud] ${sig} received, shutting down...`);
    // 兜底强退：关停排空卡住时不能无限挂着（FC 回收有硬超时，本地 Ctrl+C 二次按也走这里）
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      const done = () => process.exit(0);
      if (pool) {
        pool.end().then(done, (err) => {
          console.error('[cloud] pg pool close error:', err);
          done();
        });
      } else {
        done();
      }
    });
  });
}

/** Run with apps/cloud/node_modules/.bin/tsx after preparing the Harness resources. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../../apps/cloud/src/app.ts';
import { loadConfig } from '../../../../apps/cloud/src/config.ts';
import { AuthService } from '../../../../apps/cloud/src/service.ts';
import { MarketService } from '../../../../apps/cloud/src/market/service.ts';
import { OssSigner } from '../../../../apps/cloud/src/market/signer.ts';
import { MemoryAuthStore } from '../../../../apps/cloud/src/store/memory.ts';
import { MemoryMarketStore } from '../../../../apps/cloud/src/store/market-memory.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const cloud = createRequire(join(root, 'apps/cloud/package.json'));
const config = loadConfig({
  MOLIO_ENV: 'local', MOLIO_OSS_AK: 'fixture', MOLIO_OSS_SK: 'fixture', MOLIO_OSS_BUCKET: 'fixture',
});
const users = new MemoryAuthStore();
const now = Date.now;
const api = createApp({
  config, now, storeKind: 'memory',
  service: new AuthService({ store: users, config, now, sendMail: async () => {} }),
  market: { service: new MarketService({
    store: new MemoryMarketStore(), users, signer: new OssSigner(config.market!.oss),
    config: { market: config.market! }, now,
  }) },
});
const server = cloud('@hono/node-server').serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => server.listening ? resolve(true) : server.once('listening', resolve));
const authUrl = 'http://127.0.0.1:' + server.address().port;
try {
  const child = spawn(process.execPath, [join(root, 'distribution/test/desktop/harness/host-smoke.mjs'), ...process.argv.slice(2)], {
    env: { ...process.env, MOLIO_SMOKE_AUTH_URL: authUrl }, stdio: 'inherit',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Desktop smoke exited with ' + code)));
  });
} finally {
  server.close();
}

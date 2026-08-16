import type { Hono } from 'hono';
import { createApp } from '../src/app.js';
import type { CloudConfig, RateLimits } from '../src/config.js';
import { AuthService } from '../src/service.js';
import { MemoryAuthStore } from '../src/store/memory.js';

export interface SentMail {
  to: string;
  code: string;
}

/** 可控时钟：限频/过期/宽限窗测试不依赖真实时间 */
export function makeClock(start = 1_750_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** rate 支持部分覆盖（深合并），其余字段与 Partial<CloudConfig> 一致 */
export type TestConfigOverrides = Omit<Partial<CloudConfig>, 'rate'> & { rate?: Partial<RateLimits> };

export function testConfig(overrides: TestConfigOverrides = {}): CloudConfig {
  // rate 深合并：只覆盖传入的限频项，其余保持默认（浅展开会把缺省项丢成 undefined）
  const { rate, ...rest } = overrides;
  return {
    env: 'daily',
    port: 0,
    jwtSecret: 'test-secret',
    accessTtlSec: 15 * 60,
    codePepper: 'test-pepper',
    codeTtlSec: 5 * 60,
    codeMaxAttempts: 5,
    refreshTtlSec: 30 * 24 * 60 * 60,
    rotationGraceSec: 30,
    rate: { emailResendSec: 60, emailDailyMax: 10, ipDailyMax: 30, ...(rate ?? {}) },
    ...rest,
  };
}

export function setup(overrides: TestConfigOverrides = {}) {
  const clock = makeClock();
  const store = new MemoryAuthStore();
  const sent: SentMail[] = [];
  const config = testConfig(overrides);
  const service = new AuthService({
    store,
    config,
    sendMail: async (to, code) => {
      sent.push({ to, code });
    },
    now: clock.now,
  });
  const app = createApp({ service, config, storeKind: 'memory', now: clock.now });
  return { clock, store, sent, config, service, app };
}

export function post(app: Hono, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

export function del(app: Hono, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'DELETE',
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function get(app: Hono, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'GET', headers });
}

/** 走完 send-code → verify 全链路，返回 token 对 + 用户 */
export async function register(app: Hono, email = 'user@example.com') {
  const r1 = await post(app, '/auth/send-code', { email });
  if (r1.status !== 202) throw new Error(`send-code failed: ${r1.status}`);
  const { devCode } = (await r1.json()) as { devCode?: string };
  if (!devCode) throw new Error('devCode 缺失：devCode 仅非 prod 环境返回，检查 setup() 是否覆盖了 env');
  const r2 = await post(app, '/auth/verify', { email, code: devCode });
  if (r2.status !== 200) throw new Error(`verify failed: ${r2.status}`);
  return (await r2.json()) as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; createdAt: string };
  };
}

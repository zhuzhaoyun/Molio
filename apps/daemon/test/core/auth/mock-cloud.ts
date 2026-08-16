import type { Entitlement, User } from '@molio/contracts';

/**
 * 行为可编程的 mock 云端（@molio/cloud 6 端点的行为模拟，非仅返回值 mock）。
 * 设计 §十四：daemon 测试要 mock 云端**行为**——轮换、吊销、断网、限频都要能编排。
 *
 * 语义对齐 apps/cloud：
 * - verify/refresh 轮换：refresh 必须携带**当前** refreshToken（旧的→401，模拟轮换）
 * - access 是 JWT（daemon 的 decodeAccessExp 可解出 exp）；服务端有效性由
 *   validAccess 集合控制，invalidateAccess() 模拟"本地看没过期、云端已失效"
 * - queue() 可对指定 (method, path) 预排响应/网络错误，测 5xx 退避、瞬时断网与 4xx 不重试
 */

export interface CloudCall {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

export interface MockCloudOptions {
  baseUrl?: string;
  user?: User;
  entitlement?: Entitlement;
  /** access 寿命（秒），默认 900（与云端 15min 一致）。 */
  accessTtlSec?: number;
  /** 与 AuthClient 共享的时钟（epoch ms）；mint 出的 JWT exp 用它，保证主动刷新可测。 */
  now?: () => number;
}

type QueuedResponse = { status: number; body?: unknown } | 'network-error';

export interface MockCloud {
  baseUrl: string;
  fetchImpl: typeof fetch;
  calls: CloudCall[];
  user: User;
  entitlement: Entitlement;
  /** down = fetch 直接抛错（断网）。 */
  setMode(mode: 'ok' | 'down'): void;
  /** invalid = /auth/refresh 一律 401（refresh token 被云端吊销）。 */
  setRefreshOutcome(outcome: 'ok' | 'invalid'): void;
  /** invalid_code = /auth/verify 一律 401。 */
  setVerifyOutcome(outcome: 'ok' | 'invalid_code'): void;
  /** invalid_token = /auth/account 一律 401（模拟 token 已被吊销）。 */
  setAccountOutcome(outcome: 'ok' | 'invalid_token'): void;
  /** 清空已签发 access 的有效性（模拟过期/吊销；本地 exp 看起来仍有效）。 */
  invalidateAccess(): void;
  /** 预排一个响应（按入队顺序消费）；'network-error' = 该次请求 fetch 抛错。 */
  queue(method: string, path: string, resp: QueuedResponse): void;
  countCalls(method: string, path: string): number;
  lastCall(method: string, path: string): CloudCall | undefined;
}

function mintJwt(payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${h}.${p}.mocksig`;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** 与 apps/cloud 一致：scheme 大小写不敏感（`bearer x` 同样有效）。 */
function bearerToken(auth: string | null): string | null {
  if (!auth) return null;
  const m = /^bearer (.+)$/i.exec(auth);
  return m ? m[1]! : null;
}

export function makeMockCloud(opts: MockCloudOptions = {}): MockCloud {
  const baseUrl = opts.baseUrl ?? 'http://mock.cloud';
  const user: User = opts.user ?? {
    id: '01J5MOCKUSER00000000000000',
    email: 'user@example.com',
    createdAt: '2026-08-01T00:00:00.000Z',
  };
  const entitlement: Entitlement = opts.entitlement ?? { plan: 'free' };
  const accessTtlSec = opts.accessTtlSec ?? 900;
  const nowMs = opts.now ?? Date.now;

  let mode: 'ok' | 'down' = 'ok';
  let refreshOutcome: 'ok' | 'invalid' = 'ok';
  let verifyOutcome: 'ok' | 'invalid_code' = 'ok';
  let accountOutcome: 'ok' | 'invalid_token' = 'ok';
  let refreshCounter = 0;
  let currentRefresh: string | null = null;
  const validAccess = new Set<string>();
  const queues = new Map<string, QueuedResponse[]>();
  const calls: CloudCall[] = [];

  function mintAccess(): string {
    const nowSec = Math.floor(nowMs() / 1000);
    const token = mintJwt({
      sub: user.id,
      email: user.email,
      jti: `jti-${refreshCounter}`,
      iat: nowSec,
      exp: nowSec + accessTtlSec,
    });
    validAccess.add(token);
    return token;
  }

  function nextRefresh(): string {
    refreshCounter += 1;
    currentRefresh = `refresh-${refreshCounter}`;
    return currentRefresh;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function queueKey(method: string, path: string): string {
    return `${method} ${path}`;
  }

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(requestUrl(input)).pathname;
    let body: unknown;
    if (typeof init?.body === 'string' && init.body !== '') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    // Headers 归一化：调用方可能传 Headers 实例/数组/大小写混合的对象
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ method, path, body, auth });

    if (mode === 'down') throw new TypeError('fetch failed');

    const queue = queues.get(queueKey(method, path));
    const queued = queue?.shift();
    if (queued !== undefined) {
      if (queued === 'network-error') throw new TypeError('fetch failed');
      return json(queued.status, queued.body ?? {});
    }

    if (method === 'POST' && path === '/auth/send-code') {
      return json(202, { ok: true, resendAfterSec: 60, devCode: '123456' });
    }

    if (method === 'POST' && path === '/auth/verify') {
      if (verifyOutcome === 'invalid_code') return json(401, { error: 'invalid_code' });
      return json(200, {
        accessToken: mintAccess(),
        refreshToken: nextRefresh(),
        user,
      });
    }

    if (method === 'POST' && path === '/auth/refresh') {
      if (refreshOutcome === 'invalid') return json(401, { error: 'invalid_token' });
      const b = body as { refreshToken?: string } | undefined;
      // 轮换语义：只认当前 refresh token（重放旧的 = 401，与云端 D1 行为一致）
      if (!b || b.refreshToken !== currentRefresh) return json(401, { error: 'invalid_token' });
      return json(200, { accessToken: mintAccess(), refreshToken: nextRefresh() });
    }

    if (method === 'GET' && path === '/auth/me') {
      const token = bearerToken(auth);
      if (!token || !validAccess.has(token)) return json(401, { error: 'invalid_token' });
      return json(200, { user, entitlement });
    }

    if (method === 'DELETE' && path === '/auth/session') {
      const token = bearerToken(auth);
      if (!token || !validAccess.has(token)) return json(401, { error: 'invalid_token' });
      // 与云端一致：吊销 body 携带的 refresh token（本设备 session）。
      // 吊销后再拿它 refresh → 401（daemon 若误传已轮换旧 token，这里能照出云端真实行为）
      const b = body as { refreshToken?: string } | undefined;
      if (b && typeof b.refreshToken === 'string' && b.refreshToken === currentRefresh) {
        currentRefresh = null;
      }
      return json(200, { ok: true });
    }

    if (method === 'DELETE' && path === '/auth/account') {
      if (accountOutcome === 'invalid_token') return json(401, { error: 'invalid_token' });
      const token = bearerToken(auth);
      if (!token || !validAccess.has(token)) return json(401, { error: 'invalid_token' });
      // 云端注销后该用户全部 access 失效（吊销全部 session 语义）
      validAccess.clear();
      return json(200, { ok: true });
    }

    return json(404, { error: 'not_found' });
  }) as typeof fetch;

  return {
    baseUrl,
    fetchImpl,
    calls,
    user,
    entitlement,
    setMode: (m) => {
      mode = m;
    },
    setRefreshOutcome: (o) => {
      refreshOutcome = o;
    },
    setVerifyOutcome: (o) => {
      verifyOutcome = o;
    },
    setAccountOutcome: (o) => {
      accountOutcome = o;
    },
    invalidateAccess: () => {
      validAccess.clear();
    },
    queue: (method, path, resp) => {
      const key = queueKey(method.toUpperCase(), path);
      const q = queues.get(key) ?? [];
      q.push(resp);
      queues.set(key, q);
    },
    countCalls: (method, path) =>
      calls.filter((c) => c.method === method.toUpperCase() && c.path === path).length,
    lastCall: (method, path) =>
      [...calls].reverse().find((c) => c.method === method.toUpperCase() && c.path === path),
  };
}

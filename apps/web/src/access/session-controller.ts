import type { AccessSession, AdminLoginRequest } from '@molio/contracts';
import type { SessionResources } from './resources.ts';

export type EndReason = 'expired' | 'signed-out' | 'revoked' | 'session-changed';
export type CheckReason = 'startup' | 'focus' | 'poll' | 'expiry' | 'http-error' | 'stream-error' | 'asset-error' | 'peer';
export type AccessState =
  | { status: 'checking' }
  | { status: 'local' }
  | { status: 'anonymous'; reason?: EndReason }
  | { status: 'authenticated'; expiresAt: number; csrfToken: string; health: 'ok' | 'unreachable'; epoch: number; expiresSoon?: boolean }
  | { status: 'logging-out'; phase: 'pending' | 'unconfirmed'; message?: string }
  | { status: 'retiring'; reason: EndReason }
  | { status: 'unavailable'; message: string };
export type AccessContext = { mode: 'local'; resources: SessionResources }
  | { mode: 'server'; expiresAt: number; csrfToken: string; resources: SessionResources };
export interface AccessDependencies {
  baseUrl: string; rawFetch: typeof fetch; now: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
  createResources: (epoch: number) => SessionResources;
  retire: (reason: EndReason) => void; notifyPeer: () => void;
  isVisible?: () => boolean;
}
export interface AccessController {
  getSnapshot(): AccessState; getContext(): AccessContext | null;
  subscribe(listener: () => void): () => void; start(): () => void;
  revalidate(reason: CheckReason): Promise<AccessState>;
  login(input: AdminLoginRequest): Promise<void>; logout(): Promise<void>;
  resumeAfterFailedLogout(): Promise<void>;
}
export class AdminAccessError extends Error {
  status: number | null; code: string; retryAt: number | null;
  constructor(code: string, status: number | null = null, retryAt: number | null = null) {
    super(code); this.name = 'AdminAccessError'; this.code = code; this.status = status; this.retryAt = retryAt;
  }
}

export function createAccessController(deps: AccessDependencies): AccessController {
  let state: AccessState = { status: 'checking' };
  let session: Extract<AccessSession, { authenticated: true }> | null = null;
  let resources: SessionResources | null = null;
  let epoch = 0; let version = 0; let hosts = 0; let blocked = false; let offset = 0;
  let pending: Promise<AccessState> | null = null; let signingIn = false; let signingOut: Promise<void> | null = null;
  const listeners = new Set<() => void>(); const requests = new Set<AbortController>();
  let timers: Array<() => void> = [];
  const emit = (next: AccessState) => { state = next; for (const fn of listeners) fn(); };
  const clearTimers = () => { for (const cancel of timers) cancel(); timers = []; };
  const invalidate = () => { version++; pending = null; for (const request of requests) request.abort(); };
  const terminal = () => state.status === 'retiring';

  async function request(path: string, init?: RequestInit, json = true) {
    const abort = new AbortController(); requests.add(abort); const began = deps.now();
    let cancel = () => {}; let onAbort = () => {};
    try {
      const timeout = new Promise<never>((_, reject) => {
        onAbort = () => reject(new AdminAccessError('unreachable'));
        abort.signal.addEventListener('abort', onAbort, { once: true });
        cancel = deps.schedule(() => abort.abort(), 5000);
      });
      const result = await Promise.race([timeout, (async () => {
        const response = await deps.rawFetch(new URL(`/api/access/${path}`, deps.baseUrl), { ...init, credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
        const data: unknown = json ? await response.json().catch(() => null) : null;
        return { response, data };
      })()]);
      if (path === 'session') {
        const date = Date.parse(result.response.headers.get('date') ?? '');
        if (Number.isFinite(date)) offset = date + (deps.now() - began) / 2 - deps.now();
      }
      return result;
    } finally { cancel(); requests.delete(abort); abort.signal.removeEventListener('abort', onAbort); }
  }
  function parse(data: unknown): AccessSession {
    if (!data || typeof data !== 'object') throw new AdminAccessError('invalid_response');
    const s = data as Record<string, unknown>;
    if (s.mode === 'local' && s.authenticated === false) return { mode: 'local', authenticated: false };
    if (s.mode !== 'server') throw new AdminAccessError('invalid_response');
    if (s.authenticated === false) return { mode: 'server', authenticated: false };
    if (s.authenticated !== true || typeof s.expiresAt !== 'number' || !Number.isFinite(s.expiresAt) || s.expiresAt <= 0 || typeof s.csrfToken !== 'string' || !/^[a-f0-9]{64}$/.test(s.csrfToken)) throw new AdminAccessError('invalid_response');
    return { mode: 'server', authenticated: true, expiresAt: s.expiresAt, csrfToken: s.csrfToken };
  }
  function finish(reason: EndReason) {
    if (terminal()) return;
    resources?.close(); clearTimers(); invalidate(); blocked = true;
    emit({ status: 'retiring', reason });
    if (reason === 'signed-out' || reason === 'session-changed') deps.notifyPeer();
    deps.retire(reason);
  }
  function arm() {
    clearTimers(); if (!hosts || state.status !== 'authenticated' || !session) return;
    timers.push(deps.schedule(() => { if (deps.isVisible?.() !== false) void controller.revalidate('poll'); else arm(); }, 30_000));
    const remaining = session.expiresAt - (deps.now() + offset);
    if (remaining > 300_000) timers.push(deps.schedule(() => { if (state.status === 'authenticated') emit({ ...state, expiresSoon: true }); }, remaining - 300_000));
    timers.push(deps.schedule(() => { void controller.revalidate('expiry'); }, Math.max(1000, remaining)));
  }
  function accept(s: AccessSession, reason: CheckReason) {
    if (s.mode === 'local') {
      if (!resources || resources.closed) resources = deps.createResources(++epoch);
      session = null; blocked = false; emit({ status: 'local' }); clearTimers(); return;
    }
    if (!s.authenticated) {
      if (session) finish(reason === 'expiry' ? 'expired' : state.status === 'logging-out' ? 'signed-out' : 'revoked');
      else { blocked = false; emit({ status: 'anonymous' }); clearTimers(); }
      return;
    }
    if (session && session.csrfToken !== s.csrfToken) { finish('session-changed'); return; }
    session = s;
    if (!resources || resources.closed) resources = deps.createResources(++epoch);
    blocked = false; emit({ status: 'authenticated', expiresAt: s.expiresAt, csrfToken: s.csrfToken, health: 'ok', epoch: resources.epoch, expiresSoon: s.expiresAt - (deps.now() + offset) <= 300_000 }); arm();
  }
  const controller: AccessController = {
    getSnapshot: () => state,
    getContext() {
      if (!resources || resources.closed || blocked) return null;
      if (state.status === 'local') return { mode: 'local', resources };
      if (state.status === 'authenticated' && state.health === 'ok' && session) return { mode: 'server', expiresAt: session.expiresAt, csrfToken: session.csrfToken, resources };
      return null;
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start() {
      if (++hosts === 1) { if (state.status === 'checking' || state.status === 'unavailable') void controller.revalidate('startup'); else arm(); }
      let stopped = false;
      return () => { if (stopped) return; stopped = true; if (--hosts === 0) { clearTimers(); invalidate(); } };
    },
    revalidate(reason) {
      if (terminal() || state.status === 'logging-out') return Promise.resolve(state);
      if (pending && ['peer', 'expiry'].includes(reason)) invalidate();
      if (session && ['expiry', 'http-error', 'stream-error', 'peer'].includes(reason)) { blocked = true; emit({ ...state }); }
      if (pending) return pending;
      const seq = version;
      let task!: Promise<AccessState>;
      task = (async () => {
        try {
          const { response, data } = await request('session');
          if (!response.ok) throw new AdminAccessError('unreachable', response.status);
          if (seq === version) accept(parse(data), reason);
        } catch {
          if (seq === version && !terminal()) {
            blocked = true;
            emit(state.status === 'authenticated' ? { ...state, health: 'unreachable' } : { status: 'unavailable', message: 'unreachable' }); arm();
          }
        } finally { if (pending === task) pending = null; }
        return state;
      })();
      pending = task; return task;
    },
    async login(input) {
      if (state.status === 'local' || state.status === 'authenticated' || terminal() || signingIn || state.status === 'logging-out') throw new AdminAccessError('invalid_state');
      signingIn = true; invalidate(); const seq = version;
      try {
        const { response, data } = await request('login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        if (seq !== version) throw new AdminAccessError('superseded');
        if (!response.ok) {
          const header = response.headers.get('retry-after'); const seconds = header && /^\d+$/.test(header) ? Number(header) : null;
          const retryAt = seconds !== null ? deps.now() + seconds * 1000 : header ? Date.parse(header) : NaN;
          throw new AdminAccessError(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `http_${response.status}`, response.status, Number.isFinite(retryAt) ? retryAt : null);
        }
        // A focus/poll request may have started before POST applied its cookie.
        invalidate();
        await controller.revalidate('startup');
        if (controller.getSnapshot().status !== 'authenticated') throw new AdminAccessError('session_unconfirmed');
        deps.notifyPeer();
      } finally { signingIn = false; }
    },
    logout() {
      if (signingOut) return signingOut;
      if (!session || terminal()) return Promise.reject(new AdminAccessError('invalid_state'));
      invalidate(); const seq = version; const csrf = session.csrfToken;
      resources?.close(); clearTimers(); blocked = true; emit({ status: 'logging-out', phase: 'pending' });
      const task = (async () => {
        try {
          const { response } = await request('logout', { method: 'POST', headers: { 'x-molio-csrf': csrf } }, false);
          if (seq !== version) return;
          if (response.status === 204) { finish('signed-out'); return; }
        } catch { /* verify lost response before declaring a logout */ }
        if (seq !== version) return;
        try {
          const { response, data } = await request('session');
          if (seq !== version) return;
          if (response.ok) {
            const next = parse(data);
            if (next.mode === 'server' && !next.authenticated) { finish('signed-out'); return; }
            if (next.mode === 'server' && next.authenticated && next.csrfToken !== csrf) { finish('session-changed'); return; }
          }
        } catch { /* remains unconfirmed */ }
        if (seq === version) emit({ status: 'logging-out', phase: 'unconfirmed', message: 'logout_unconfirmed' });
      })().finally(() => { if (signingOut === task) signingOut = null; });
      signingOut = task; return task;
    },
    async resumeAfterFailedLogout() {
      if (state.status !== 'logging-out' || state.phase !== 'unconfirmed') return;
      const seq = version;
      try { const { response, data } = await request('session'); if (seq === version && response.ok) accept(parse(data), 'focus'); }
      catch { /* user stays in explicit unconfirmed state */ }
    },
  };
  return controller;
}

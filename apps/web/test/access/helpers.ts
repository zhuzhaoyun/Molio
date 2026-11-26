import { createSessionResources } from '../../src/access/resources.ts';
import { createAccessController } from '../../src/access/session-controller.ts';

export function clock() {
  let now = 1_800_000_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>(); let id = 0;
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) { const key = ++id; timers.set(key, { at: now + ms, fn }); return () => { timers.delete(key); }; },
    advance(ms: number) { now += ms; for (const [key, job] of [...timers]) if (job.at <= now) { timers.delete(key); job.fn(); } },
    count: () => timers.size,
  };
}
export const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
export function fixture() {
  const time = clock(); const calls: Array<{ url: string; init?: RequestInit }> = []; const retired: string[] = [];
  let session: object = { mode: 'server', authenticated: false };
  let handler = async (url: string, _init?: RequestInit): Promise<Response> => json(url.endsWith('/session') ? session : { authenticated: true });
  function json(data: object, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(data), { status, headers: { Date: new Date(time.now()).toUTCString(), ...headers } }); }
  const rawFetch = (async (input: unknown, init?: RequestInit) => { calls.push({ url: String(input), init }); return handler(String(input), init); }) as typeof fetch;
  const controller = createAccessController({ baseUrl: 'https://molio.test', rawFetch, now: time.now, schedule: time.schedule, createResources: createSessionResources, retire: reason => { retired.push(reason); }, notifyPeer: () => {} });
  const authenticated = (csrf = 'a'.repeat(64)) => ({ mode: 'server', authenticated: true, csrfToken: csrf, expiresAt: time.now() + 43_200_000 });
  return { time, calls, retired, rawFetch, controller, json, authenticated, setSession(value: object) { session = value; }, setHandler(fn: typeof handler) { handler = fn; } };
}

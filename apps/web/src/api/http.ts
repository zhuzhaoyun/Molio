import { AdminAccessError, type AccessController } from '../access/session-controller.ts';

const responseSignals = new WeakMap<Response, AbortSignal>();
export function getDaemonResponseSignal(response: Response): AbortSignal {
  const signal = responseSignals.get(response);
  if (!signal) throw new TypeError('Response was not created by daemonFetch');
  return signal;
}

export function isDaemonApiUrl(input: string | URL, baseUrl = globalThis.location?.origin ?? 'http://localhost'): boolean {
  try { const url = new URL(input, baseUrl); return url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/api/'); } catch { return false; }
}
export function isAccessInterruption(error: unknown): boolean {
  return error instanceof AdminAccessError || (error instanceof Error && error.name === 'AbortError');
}
export function createDaemonFetch(controller: AccessController, rawFetch: typeof fetch, baseUrl: string) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (!isDaemonApiUrl(input, baseUrl)) throw new TypeError('daemonFetch requires a same-origin /api/ URL');
    const context = controller.getContext();
    if (!context) throw new AdminAccessError('session_unconfirmed');
    const scope = context.resources;
    const signal = init?.signal ? AbortSignal.any([scope.signal, init.signal]) : scope.signal;
    signal.throwIfAborted();
    const headers = new Headers(init?.headers); headers.delete('x-molio-csrf');
    if (context.mode === 'server' && !['GET', 'HEAD', 'OPTIONS'].includes((init?.method ?? 'GET').toUpperCase())) headers.set('X-Molio-CSRF', context.csrfToken);
    const response = await rawFetch(new URL(input, baseUrl), { ...init, signal, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (scope.closed) throw new AdminAccessError('session_ended');
    if (context.mode === 'server' && (response.status === 401 || response.status === 403)) await controller.revalidate('http-error');
    if (scope.closed || controller.getContext()?.resources !== scope) throw new AdminAccessError('session_ended');
    responseSignals.set(response, signal);
    return response;
  };
}
// Keep the factory independent of browser setup for node:test and document utilities.
let productionFetch: ReturnType<typeof createDaemonFetch> | undefined;
export async function daemonFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (!productionFetch) {
    const { accessController } = await import('../access/runtime');
    productionFetch = createDaemonFetch(accessController, (...args) => fetch(...args), window.location.origin);
  }
  return productionFetch(input, init);
}

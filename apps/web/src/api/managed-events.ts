import { AdminAccessError, type AccessController, type AccessDependencies } from '../access/session-controller.ts';

export type ManagedTransportState = 'open' | 'checking' | 'reconnecting' | 'paused' | 'closed';
export interface ManagedEventSubscription { close(): void; reconnect(): void }
export interface ManagedEventsOptions {
  url: () => string; onMessage: (event: MessageEvent<string>) => void;
  onState?: (state: ManagedTransportState) => void; onError?: (event: Event) => void; onLocalClosed?: () => void;
}
export function createManagedEvents(deps: { controller: AccessController; createNative: (url: string) => EventSource; schedule: AccessDependencies['schedule'] }) {
  return (options: ManagedEventsOptions): ManagedEventSubscription => {
    const initial = deps.controller.getContext();
    if (!initial) throw new AdminAccessError('session_unconfirmed');
    const mode = initial.mode;
    const scope = initial.resources; let native: EventSource | null = null;
    let stopped = false; let checking = false; let waitingForAuth = false; let resetAfterRecovery = false; let retries = 0;
    let cancelRetry = () => {}; let unsubscribe = () => {}; let unregister = () => {};
    const setState = (state: ManagedTransportState) => options.onState?.(state);
    const usable = () => !stopped && !scope.closed && deps.controller.getContext()?.resources === scope;
    const detach = () => { cancelRetry(); cancelRetry = () => {}; if (native) { const old = native; native = null; old.onopen = old.onmessage = old.onerror = null; old.close(); } };
    const close = () => { if (stopped) return; stopped = true; detach(); unsubscribe(); unregister(); setState('closed'); };
    const retry = () => {
      if (!usable()) return;
      if (retries >= 4) { setState('paused'); return; }
      const ms = 1000 * 2 ** retries++; setState('reconnecting');
      cancelRetry = deps.schedule(() => { cancelRetry = () => {}; if (usable()) connect(); }, ms);
    };
    async function failed(source: EventSource, event: Event) {
      if (stopped || native !== source || checking) return;
      if (mode === 'local') {
        options.onError?.(event);
        if (source.readyState === 2) { close(); options.onLocalClosed?.(); }
        else setState('reconnecting');
        return;
      }
      checking = true; detach(); setState('checking');
      await deps.controller.revalidate('stream-error');
      checking = false; if (stopped || scope.closed) return;
      if (!usable()) {
        waitingForAuth = true;
        const state = deps.controller.getSnapshot();
        resetAfterRecovery ||= state.status === 'authenticated' && state.health === 'unreachable';
        setState('paused'); return;
      }
      options.onError?.(event); if (!stopped) retry();
    }
    function connect() {
      if (!usable()) return;
      detach(); setState('reconnecting');
      const source = deps.createNative(options.url()); native = source;
      source.onopen = () => { if (native === source && usable()) setState('open'); };
      source.onmessage = event => { if (native !== source || !usable()) return; retries = 0; options.onMessage(event); };
      source.onerror = event => { void failed(source, event); };
    }
    unsubscribe = deps.controller.subscribe(() => {
      if (stopped || checking) return;
      if (scope.closed) { close(); return; }
      if (!usable()) {
        const state = deps.controller.getSnapshot();
        if (state.status === 'authenticated' && state.health === 'unreachable') resetAfterRecovery = true;
        detach(); waitingForAuth = true; setState('paused');
      }
      else if (waitingForAuth) { waitingForAuth = false; if (resetAfterRecovery) retries = 0; resetAfterRecovery = false; retry(); }
    });
    unregister = scope.track(close); connect();
    return { close, reconnect() { if (!usable() || checking) return; retries = 0; waitingForAuth = false; connect(); } };
  };
}
export function createDeferredManagedEvents(load: () => Promise<AccessController>, makeOpen: (controller: AccessController) => ReturnType<typeof createManagedEvents>) {
  return (options: ManagedEventsOptions): ManagedEventSubscription => {
    let subscription: ManagedEventSubscription | undefined; let closed = false;
    let controller: AccessController | undefined; let unsubscribe = () => {};
    const initialize = () => {
      if (closed || subscription || !controller?.getContext()) return;
      subscription = makeOpen(controller)(options); unsubscribe();
    };
    void load().then(value => {
      if (closed) return;
      controller = value;
      unsubscribe = controller.subscribe(initialize);
      initialize();
      if (!subscription) options.onState?.('paused');
    }).catch(() => { if (!closed) options.onState?.('paused'); });
    return {
      close() { if (closed) return; closed = true; unsubscribe(); subscription?.close(); },
      reconnect() { if (closed) return; if (subscription) subscription.reconnect(); else initialize(); },
    };
  };
}
let productionOpen: ReturnType<typeof createManagedEvents> | undefined;
export const openManagedEvents = createDeferredManagedEvents(
  async () => (await import('../access/runtime')).accessController,
  controller => productionOpen ??= createManagedEvents({ controller, createNative: url => new EventSource(url), schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } }),
);

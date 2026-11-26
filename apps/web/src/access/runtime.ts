import { createAccessController, type EndReason } from './session-controller.ts';
import { createSessionResources } from './resources.ts';

const NOTICE = 'molio.admin.access.notice';
export const REASON_KEY = 'molio.admin.access.reason';
let channel: BroadcastChannel | null = null;
function notifyPeer() {
  const message = { type: 'session-changed', nonce: crypto.randomUUID(), at: Date.now() };
  if (channel) channel.postMessage(message);
  else try { localStorage.setItem(NOTICE, JSON.stringify(message)); localStorage.removeItem(NOTICE); } catch { /* focus checks remain available */ }
}
function retire(reason: EndReason) {
  try { sessionStorage.setItem(REASON_KEY, reason); } catch { /* optional notice */ }
  const shell = document.querySelector<HTMLElement>('.admin-private-shell');
  if (shell) { shell.hidden = true; shell.inert = true; }
  window.location.replace(window.location.pathname + window.location.search + window.location.hash);
}
export const accessController = createAccessController({
  baseUrl: globalThis.location?.origin ?? 'http://localhost', rawFetch: (...args) => fetch(...args), now: Date.now,
  schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  createResources: createSessionResources, retire, notifyPeer,
  isVisible: () => document.visibilityState !== 'hidden',
});
let hosts = 0; let cleanup = () => {};
export function startAccessRuntime(): () => void {
  if (++hosts === 1) {
    const stop = accessController.start();
    const focus = () => { if (document.visibilityState !== 'hidden') void accessController.revalidate('focus'); };
    const peer = (data: unknown) => {
      if (data && typeof data === 'object' && (data as {type?:unknown}).type === 'session-changed') void accessController.revalidate('peer');
    };
    const storage = (event: StorageEvent) => { if (event.key === NOTICE && event.newValue) try { peer(JSON.parse(event.newValue)); } catch { /* invalid external notice */ } };
    const pagehide = () => {
      const shell = document.querySelector<HTMLElement>('.admin-private-shell');
      if (shell) { shell.hidden = true; shell.inert = true; }
      accessController.getContext()?.resources.close();
    };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    try { if (typeof BroadcastChannel !== 'undefined') { channel = new BroadcastChannel(NOTICE); channel.onmessage = event => peer(event.data); } } catch { channel = null; }
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    window.addEventListener('storage', storage); window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', pageshow);
    cleanup = () => {
      stop(); channel?.close(); channel = null;
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('storage', storage); window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow);
    };
  }
  let stopped = false;
  return () => { if (!stopped) { stopped = true; if (--hosts === 0) cleanup(); } };
}

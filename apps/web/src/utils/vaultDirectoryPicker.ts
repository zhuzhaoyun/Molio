import { harnessMode } from '../harnessMode';

const desktopPanel = harnessMode && window.parent !== window &&
  new URLSearchParams(window.location.search).get('molioDesktop') === '1';

export function vaultDirectoryPicker(): (() => Promise<string | null>) | undefined {
  if (window.__electron__?.showDirectoryPicker) return () => window.__electron__!.showDirectoryPicker();
  if (!desktopPanel) return;
  const origin = window.location.ancestorOrigins?.[0] || (document.referrer && new URL(document.referrer).origin);
  if (!origin || origin === 'null') return;
  return () => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      channel.port1.close();
      if (data.error) reject(new Error(data.error));
      else resolve(typeof data.path === 'string' ? data.path : null);
    };
    window.parent.postMessage({ type: 'molio-pick-directory' }, origin, [channel.port2]);
  });
}

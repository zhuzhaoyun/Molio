/**
 * Milkdown image proxy plugin — swaps image src for anti-hotlinking hosts.
 */
import { $view } from '@milkdown/kit/utils';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

const PROXIED_HOSTS = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'];

function shouldProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return PROXIED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function proxyUrl(url: string): string {
  return `${window.location.origin}/api/proxy/image?url=${encodeURIComponent(url)}`;
}

export function imageProxyPlugin() {
  return $view('image' as unknown as AnyNode, () => (node: AnyNode) => {
    const img = document.createElement('img');
    const attrs: Record<string, string> = node.attrs || {};
    const src = attrs.url || attrs.src || '';

    img.alt = attrs.alt || '';
    img.loading = 'lazy';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.borderRadius = '4px';
    img.style.display = 'block';
    img.style.margin = '0.5em auto';

    if (src) {
      img.src = shouldProxy(src) ? proxyUrl(src) : src;
    }

    img.onerror = () => {
      img.dataset.error = '1';
    };

    return {
      dom: img,
      update: (updatedNode: AnyNode) => {
        const n: Record<string, string> = updatedNode.attrs || {};
        const newSrc = n.url || n.src || '';
        const resolved = shouldProxy(newSrc) ? proxyUrl(newSrc) : newSrc;
        if (img.src !== resolved) img.src = resolved;
        img.alt = n.alt || '';
        return true;
      },
    };
  });
}

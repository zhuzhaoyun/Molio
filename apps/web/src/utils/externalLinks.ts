/**
 * External link handling.
 *
 * Rendered markdown (KB viewer, chat messages) contains plain
 * `<a href="https://…">` links without target="_blank". Clicking one
 * navigates the whole window in place — in the Electron shell that replaces
 * the app with the external site and strands the user outside Molio.
 *
 * A delegated document click listener intercepts those clicks and opens the
 * URL via window.open(): in a normal browser this opens a new tab; in the
 * Electron shell setWindowOpenHandler forwards it to the system browser.
 */

/** True for absolute http(s) URLs pointing at a different origin. */
export function isExternalHttpUrl(href: string, currentOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(href, currentOrigin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.origin !== currentOrigin;
}

/**
 * 该点击是否应由本处理器接管。带修饰键的点击保持浏览器原生语义
 * （Ctrl/Cmd = 后台新标签、Shift = 新窗口），不要一律抢成前台新标签；
 * 非左键（中键 / 右键）同理交给原生处理。Electron 下原生路径同样由
 * setWindowOpenHandler 转交系统浏览器。
 */
export function shouldHandleExternalClick(event: {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey);
}

/**
 * Install a delegated click handler that opens external links in a new tab /
 * the system browser instead of navigating the current window. Returns an
 * uninstall function.
 */
export function installExternalLinkHandler(
  currentOrigin: string = window.location.origin,
): () => void {
  const onClick = (event: MouseEvent) => {
    if (!shouldHandleExternalClick(event)) return;
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    // anchor.href is the resolved absolute URL (unlike getAttribute('href')).
    if (!isExternalHttpUrl(anchor.href, currentOrigin)) return;
    event.preventDefault();
    window.open(anchor.href, '_blank', 'noopener');
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}

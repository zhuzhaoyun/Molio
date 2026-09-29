/**
 * 应用窗口的导航放行策略（will-navigate 兜底）。
 *
 * 背景：KB / 聊天渲染出的普通 <a href> 点击后会让 Electron 窗口原地导航，
 * 应用被外部网站替换、知识库不可用。运行时副作用（event.preventDefault /
 * shell.openExternal）留在 main.js；这里只做纯判定，单测可以直接喂 URL，
 * 不必加载 Electron。
 *
 * 返回值：
 *   allow    — 应用自身页面（daemon / vite dev origin）与 file:（错误页），原地导航
 *   external — http(s) 与 mailto/tel：拦下原地导航，交给系统浏览器 / 邮件客户端
 *   block    — 其余协议（javascript:、data:、molio:// 等）与无法解析的 URL：
 *              拦下且不外发（shell.openExternal 会把这些交给 OS，不做）
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function decideNavigation(targetUrl, appOrigins) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    // 无法解析的 URL 一律不外发，也不允许替换应用窗口。
    return 'block';
  }
  if (appOrigins.has(parsed.origin) || parsed.protocol === 'file:') return 'allow';
  if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) return 'external';
  return 'block';
}

/**
 * did-start-navigation 是否应该清掉 renderer readiness。
 *
 * 事件顺序是 did-start-navigation → will-navigate，而 will-navigate 随后会把
 * 外链导航 cancel 掉（改交系统浏览器）。这次导航不会真的替换文档，React 树
 * 还在；若此时清了 readiness，取消后既没有 did-navigate 也没有路由变化，
 * 没有任何事件能恢复它——之后每次 molio:// 剪藏都会退化成整页重载、打断
 * 流式输出（见 renderer-readiness.js 的清空规则）。
 *
 * 只有会被放行的主框架跨文档导航（应用 origin / file:）才真的销毁旧树。
 */
export function shouldClearReadiness(details, appOrigins) {
  if (!details || !details.isMainFrame || details.isSameDocument) return false;
  return decideNavigation(details.url, appOrigins) === 'allow';
}

/**
 * 顶层路由地址常量。
 *
 * `/` 是应用**入口**而不是页面：它只决定去哪（恢复上次访问的路由，否则落到默认落点），
 * 见 `App.tsx` 的 `EntryRedirect`。原「首页」（占满整屏的对话）因此搬到 `CHAT_ROUTE`，
 * 它仍是完整可达的页面——深链、导航栏、历史页回跳都走它，只是不再是应用入口。
 */
export const DEFAULT_ROUTE = '/knowledge';
export const CHAT_ROUTE = '/chat';

/**
 * 是否处于「全屏态」—— `/chat` 是悬浮对话面板的**显式全屏形态**（L2b）。
 *
 * 三处消费者必须共用同一个判据，否则「全屏态下谁让位」会各说各话：
 * 面板整体的早返回、`/chat` 上收起面板的 effect、以及不渲染悬浮按钮的例外。
 * 语义是「全屏 shell 承担了会话呈现，别的入口全部让位」—— 而不是
 * 「主页是个特例」。同一会话不能被渲染两份（勾选态 / 草稿 / 滚动位置都会打架）。
 */
export function isFullscreenRoute(pathname: string): boolean {
  return pathname === CHAT_ROUTE;
}

/**
 * 入口可恢复的路由白名单。写进 `localStorage` 的历史值只有落在其中才认，
 * 否则回落 `DEFAULT_ROUTE`。
 *
 * `/` 不在其中——老版本里 `/` 就是首页、会被写进记忆，把它当合法目标会让入口自我重定向。
 * 带子路径的值（如 `/resources/xxx`）也接受，见 `EntryRedirect` 的 `startsWith` 判断。
 */
export const RESTORABLE_ROUTES = [
  DEFAULT_ROUTE,
  CHAT_ROUTE,
  '/history',
  '/settings',
  '/me',
  '/resources',
];

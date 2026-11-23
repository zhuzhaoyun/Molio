import type { APIRequestContext } from '@playwright/test';

/**
 * 确保 daemon 侧无残留会话。
 *
 * ⚠️ 为什么「全新浏览器上下文」不等于「未登录」：local 模式的 daemon 会话是
 * **服务端全局**的——前一个用例 loginViaDevCode 之后，`GET /api/auth/status`
 * 对**不带 token 的新上下文**也返回上一个用户的登录态（实测 2026-11-23，
 * admin2@test.local 残留导致按权限显隐的上架按钮在「未登录」用例里渲染）。
 * 所以凡是有「未登录」前提的断言，必须先显式登出，不能指望 context 隔离。
 */
export async function ensureLoggedOut(request: APIRequestContext) {
  const status = (await (await request.get('/api/auth/status')).json()) as { loggedIn?: boolean };
  if (status.loggedIn) await request.post('/api/auth/logout');
}

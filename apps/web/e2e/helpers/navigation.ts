/**
 * Navigation helpers for E2E tests.
 * Centralises common page.goto + wait patterns.
 */
import type { Page } from '@playwright/test';

/**
 * Navigate to the full-page chat (原「首页」) and wait for network idle.
 *
 * 走 `/chat` 而不是入口 `/`：`/` 只做重定向，落点取决于 localStorage 里的上次路由
 * （见 src/routes.ts），把它当「整页对话」用会随机落到别处。地址写死是有意的——
 * e2e 对应用做黑盒，不 import `src/`；这条契约由 default-landing.spec.ts 钉住。
 *
 * 名字保留 `gotoHome`：它指的仍是同一个页面，只是地址变了，省掉 50+ 个 spec 的机械改名。
 */
export async function gotoHome(page: Page) {
  await page.goto('/chat');
  // networkidle can hang when persistent connections (SSE, HMR) keep the network busy.
  // Race with a 5s timeout so we never block indefinitely.
  await Promise.race([
    page.waitForLoadState('networkidle'),
    page.waitForTimeout(5_000),
  ]);
}

/**
 * SPA 内导航到整页对话（`/chat`），**不触发整页重载**。
 *
 * 为什么要它：`/chat` 已从导航栏移除（原「首页」不再是并列目的地），但有一批
 * spec 需要在应用内切到整页对话、观察 **SPA 卸载**行为——图谱引擎的 destroy、
 * 闲聊面板在到达主页时收起、切库后旧对话被清空。这些断言若改用 `gotoHome`
 * （整页 goto）就会因为页面被整个换掉而**假通过**：卸载是真的发生了，但发生
 * 的原因是重载，不是被测代码。那条路径测不到任何东西。
 *
 * pushState + popstate 是 react-router 认的 SPA 导航信号，
 * 与用户点击导航项走同一条路径（session-output.spec.ts 已有先例）。
 */
export async function gotoChatSpa(page: Page) {
  await page.evaluate(() => {
    window.history.pushState({}, '', '/chat');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

/** Click a NavRail button by its data-view attribute. */
export async function clickNav(page: Page, view: string) {
  await page.locator(`[data-view="${view}"]`).click();
  // SPA navigation is instant — no need for networkidle.
  // Callers should assert on specific elements for readiness.
}

/** Type a message into the composer and press Enter. */
export async function sendMessage(page: Page, text: string) {
  const textarea = page.locator('[data-testid="composer-input"]');
  await textarea.fill(text);
  await textarea.press('Enter');
}

/** Wait for the landing page to be fully rendered. */
export async function waitForLanding(page: Page) {
  await page.waitForSelector('.home-landing', { state: 'visible' });
}

/** Wait for the chat-active view to appear (after sending a message). */
export async function waitForChatActive(page: Page) {
  await page.waitForSelector('.chat-active', { state: 'visible' });
}

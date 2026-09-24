import { test, expect, type Page } from '@playwright/test';
import { launchMolioApp, closeMolioApp, type LaunchedApp } from '../helpers/electron-app';

/**
 * Per-window title E2E — taskbar hover previews must distinguish windows.
 *
 * The main process sets each window's native title from the vault in its URL
 * (「知识库名 — Molio」, fallback plain 「Molio」 for non-vault pages).
 * Guards the end-to-end chain that source-assertion unit tests cannot see:
 * navigation events → daemon vault-name resolution → win.setTitle, plus the
 * page-title-updated override pitfall (the page's static <title>Molio</title>
 * would clobber setTitle on every full load without preventDefault).
 *
 * Prerequisites:
 *   pnpm package:dir     (win-unpacked build; CI/release resolves the exe)
 */

let app: LaunchedApp;
let page: Page;

interface ElectronBridge {
  openNewWindow: (url: string) => Promise<unknown>;
}

function nativeTitles(): Promise<string[]> {
  return app.electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.getTitle()),
  );
}

test.beforeAll(async () => {
  app = await launchMolioApp();
  // Playwright may report a DevTools window as firstWindow — prefer the page
  // actually showing the app UI.
  page =
    app.electronApp.windows().find((p) => p.url().startsWith('http://localhost:3100')) ??
    app.page;
});

test.afterAll(async () => {
  await closeMolioApp(app);
});

test('窗口标题跟随知识库名：两个库窗口各显示库名，首页回退 Molio', async () => {
  // Vault fixtures come from the app's own daemon — no hardcoded ids.
  const res = await page.request.get('http://localhost:3100/api/knowledge/vaults');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const vaults = (Array.isArray(body.vaults) ? body.vaults : []) as Array<{
    id: string;
    name?: string;
  }>;
  test.skip(vaults.length < 2, '需要至少两个知识库才能验证标题区分');

  const [v1, v2] = vaults;
  const nameOf = (v: { id: string; name?: string }) => v.name || v.id;

  for (const v of [v1, v2]) {
    await page.evaluate(
      (u) =>
        (window as unknown as { __electron__: ElectronBridge }).__electron__.openNewWindow(u),
      `/knowledge?vault=${encodeURIComponent(v.id)}`,
    );
  }

  // Titles update asynchronously (navigation + daemon vault-name fetch).
  await expect.poll(nativeTitles, { timeout: 20_000 }).toContainEqual(`${nameOf(v1)} — Molio`);
  await expect.poll(nativeTitles, { timeout: 20_000 }).toContainEqual(`${nameOf(v2)} — Molio`);

  // The original home window (no vault param) keeps the plain app name.
  expect(await nativeTitles()).toContain('Molio');
});

import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area settings
 * @priority P1
 *
 * E2E tests for the Settings page.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Settings', () => {
  // #3: 语言切换测试会把切换后的 locale 持久化到共享 daemon config。若不恢复，
  // 后续断言中文文案的 spec 只有在 config=zh 时才绿 → 全量套件变成顺序相关。
  // 这里统一恢复为默认 zh，保证「full green」可复现。测试自身断言不受影响。
  test.afterEach(async ({ request }) => {
    await request.put('/api/config', { data: { locale: 'zh' } }).catch(() => {});
  });

  test('page loads with language section visible', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="lang-zh"]')).toBeVisible();
  });

  test('language pills are displayed with one active', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    // Language pills: zh + en, exactly one active
    await expect(page.locator('[data-testid^="lang-"]')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('[data-testid^="lang-"].is-active')).toHaveCount(1);
  });

  test('switching language changes active pill', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    const inactiveLang = page.locator('[data-testid^="lang-"]:not(.is-active)').first();
    if (await inactiveLang.isVisible()) {
      const testid = await inactiveLang.getAttribute('data-testid');
      await inactiveLang.click();
      await page.waitForTimeout(500);

      // The clicked pill should now be active
      await expect(page.locator(`[data-testid="${testid}"]`)).toHaveClass(/is-active/);
    }
  });

  test('theme section shows three options with system active by default', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    await expect(page.locator('[data-testid="theme-system"]')).toBeVisible();
    await expect(page.locator('[data-testid="theme-light"]')).toBeVisible();
    await expect(page.locator('[data-testid="theme-dark"]')).toBeVisible();
    await expect(page.locator('[data-testid="theme-system"]')).toHaveClass(/is-active/);
    await expect(page.locator('[data-testid^="theme-"].is-active')).toHaveCount(1);
  });

  test('selecting dark theme applies data-theme=dark to html', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="theme-dark"]').click();
    await expect(page.locator('[data-testid="theme-dark"]')).toHaveClass(/is-active/);
    const attr = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(attr).toBe('dark');
  });

  test('selecting light theme applies data-theme=light to html', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="theme-light"]').click();
    await expect(page.locator('[data-testid="theme-light"]')).toHaveClass(/is-active/);
    const attr = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(attr).toBe('light');
  });

  test('selecting system theme removes data-theme attribute', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    // 先锁定深色，再切回跟随系统
    await page.locator('[data-testid="theme-dark"]').click();
    await expect(page.locator('[data-testid="theme-dark"]')).toHaveClass(/is-active/);
    await page.locator('[data-testid="theme-system"]').click();
    await expect(page.locator('[data-testid="theme-system"]')).toHaveClass(/is-active/);
    const attr = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(attr).toBeNull();
  });
});

/**
 * 版本卡片：外链入口 + 状态驱动的主动作。
 *
 * web E2E 里没有 window.updater，卡片会走「仅桌面端可用」分支；凡是需要验证
 * 按钮行为的用例，都先用 addInitScript 注入一个假的 Electron updater 桥。
 * 只桩 window.updater、不桩 window.__electron__ —— 后者被 App 多处读取，
 * 桩不全容易连带打挂别的渲染。
 */
test.describe('Update card', () => {
  const REPO_URL = 'https://github.com/zhuzhaoyun/Molio';
  const RELEASES_URL = `${REPO_URL}/releases`;

  async function stubUpdater(page: import('@playwright/test').Page, state: unknown) {
    await page.addInitScript((st) => {
      (window as unknown as Record<string, unknown>).updater = {
        getState: async () => st,
        checkForUpdates: async () => st,
        installUpdate: async () => st,
        onStateChanged: () => () => {},
        onUpdateAvailable: () => () => {},
        onDownloadProgress: () => () => {},
        onUpdateDownloaded: () => () => {},
        onUpdateError: () => () => {},
        getLogPath: async () => null,
      };
    }, state);
  }

  async function openSettings(page: import('@playwright/test').Page) {
    await gotoHome(page);
    await clickNav(page, 'settings');
    await expect(page.locator('.settings-update-card')).toBeVisible({ timeout: 5_000 });
  }

  test('external links point at repo, site and releases', async ({ page }) => {
    await openSettings(page);

    const github = page.locator('[data-testid="update-link-github"]');
    await expect(github).toHaveAttribute('href', REPO_URL);
    await expect(github).toHaveAttribute('target', '_blank');
    await expect(github).toHaveAttribute('rel', /noopener/);

    await expect(page.locator('[data-testid="update-link-site"]'))
      .toHaveAttribute('href', 'https://molio.cn');
    // 未知版本时更新日志落在 releases 索引页
    await expect(page.locator('[data-testid="update-link-changelog"]'))
      .toHaveAttribute('href', RELEASES_URL);

    await expect(page.locator('.settings-update-card__logo')).toBeVisible();
  });

  test('changelog deep-links to the tag once a version is known', async ({ page }) => {
    await stubUpdater(page, {
      ok: true, status: 'downloaded', currentVersion: '0.3.59', latestVersion: '0.3.60',
    });
    await openSettings(page);

    await expect(page.locator('[data-testid="update-link-changelog"]'))
      .toHaveAttribute('href', `${RELEASES_URL}/tag/v0.3.60`);
  });

  test('idle state offers an enabled check button with a still icon', async ({ page }) => {
    await stubUpdater(page, { ok: true, status: 'up-to-date', currentVersion: '0.3.59' });
    await openSettings(page);

    const btn = page.locator('[data-testid="update-check-btn"]');
    await expect(btn).toHaveText(/检查更新|Check for updates/);
    await expect(btn).toBeEnabled();
    // 非忙碌时图标不该转 —— 转了就是在骗用户「正在检查」
    await expect(btn.locator('svg.is-spinning')).toHaveCount(0);
  });

  test('downloading disables the button and spins the icon', async ({ page }) => {
    await stubUpdater(page, {
      ok: true, status: 'downloading', currentVersion: '0.3.59',
      latestVersion: '0.3.60', downloading: true, percent: 42,
    });
    await openSettings(page);

    const btn = page.locator('[data-testid="update-check-btn"]');
    await expect(btn).toBeDisabled();
    await expect(btn.locator('svg.is-spinning')).toHaveCount(1);
    await expect(page.locator('.settings-progress__label')).toContainText('42%');
  });

  test('downloaded state turns the card action into restart, with a single CTA', async ({ page }) => {
    await stubUpdater(page, {
      ok: true, status: 'downloaded', currentVersion: '0.3.59', latestVersion: '0.3.60',
    });
    await openSettings(page);

    const btn = page.locator('[data-testid="update-check-btn"]');
    await expect(btn).toHaveText(/立即重启|Restart now/);
    await expect(btn).toBeEnabled();
    // 就绪态只该有一个主 CTA —— 旧的下方 .settings-ready 面板已折叠进卡片
    await expect(page.locator('.settings-ready')).toHaveCount(0);
  });

  test('web build without updater shows the desktop-only hint', async ({ page }) => {
    await openSettings(page);

    await expect(page.locator('[data-testid="update-desktop-only"]')).toBeVisible();
    await expect(page.locator('[data-testid="update-check-btn"]')).toHaveCount(0);
  });
});

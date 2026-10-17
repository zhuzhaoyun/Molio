import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

async function openSettings(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await clickNav(page, 'settings');
  await expect(page.locator('.settings-update-card')).toBeVisible({ timeout: 5_000 });
}

/** WCAG 2.x 对比度 —— 给「字看不看得清」这类断言一个可量化的判据。 */
function contrastRatio(fg: string, bg: string): number {
  const luminance = (css: string) => {
    const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lin = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
  };
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

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

  test('star CTA is a full footer row, not a fourth action button', async ({ page }) => {
    await openSettings(page);

    const star = page.locator('[data-testid="update-star-cta"]');
    await expect(star).toBeVisible();
    await expect(star).toHaveAttribute('href', REPO_URL);
    await expect(star).toHaveAttribute('target', '_blank');
    await expect(star).toHaveAttribute('rel', /noopener/);
    await expect(star).toHaveText(/点个 Star|star the project on GitHub/);

    // 版式意图：引导条要自成一行、铺满卡片宽度。混进操作区就成了第二个 CTA，
    // 挤在同一行则不叫「顺便」。这两条断言就是钉住这个意图。
    const actions = await page.locator('.settings-update-card__actions').boundingBox();
    const starBox = await star.boundingBox();
    expect(actions).not.toBeNull();
    expect(starBox).not.toBeNull();
    expect(starBox!.y).toBeGreaterThanOrEqual(actions!.y + actions!.height);
    expect(starBox!.width).toBeGreaterThan(actions!.width);

    // 页脚 band 必须**左右对称**地铺到卡片内缘。flex-basis 的百分比按内容盒解析、
    // 外边距算完宽度之后才扣，只写 100% 时左边被负外边距推出去、右边却缩不回来，
    // 视觉上是「半边高亮」。实测踩过一次，用几何断言钉住（左右各留 1px 卡片边框）。
    const card = await page.locator('.settings-update-card').boundingBox();
    expect(card).not.toBeNull();
    const insetLeft = starBox!.x - card!.x;
    const insetRight = card!.x + card!.width - (starBox!.x + starBox!.width);
    expect(Math.abs(insetLeft - insetRight)).toBeLessThanOrEqual(1);
    expect(insetLeft).toBeLessThanOrEqual(2);
  });

  test('hovering the star row lights up the whole row, not just the words', async ({ page }) => {
    await openSettings(page);

    const star = page.locator('[data-testid="update-star-cta"]');
    const restBg = await star.evaluate((el) => getComputedStyle(el).backgroundColor);

    await star.hover();
    // 等 140ms 过渡走完再读，否则读到的是中间帧
    await page.waitForTimeout(300);
    const hoverBg = await star.evaluate((el) => getComputedStyle(el).backgroundColor);

    // 整行是**一个** <a>，反馈就得是整行的 —— 只改文字颜色在这条 1000+px 宽的行上
    // 肉眼看不出来，等于把这块点击区藏起来
    expect(hoverBg).not.toBe(restBg);
    // 底色要铺满行宽，不能只有文字那么长
    const box = await star.boundingBox();
    expect(box!.width).toBeGreaterThan(600);
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

  test('known version but not yet downloading offers download, not re-check', async ({ page }) => {
    // 主进程 updater.js 会上报 available:true + downloading:false 的组合
    await stubUpdater(page, {
      ok: true, status: 'idle', currentVersion: '0.3.59',
      available: true, latestVersion: '0.3.60', downloading: false,
    });
    await openSettings(page);

    const btn = page.locator('[data-testid="update-check-btn"]');
    // 状态行已经说了「发现新版本」，按钮再说「检查更新」就是自相矛盾：
    // 检查已经做完了，此刻缺的是下载
    await expect(page.locator('.settings-update-card__status')).toHaveText(/v0\.3\.60/);
    await expect(btn).toHaveText(/下载更新|Download update/);
    await expect(btn).toBeEnabled();
    await expect(btn.locator('svg.is-spinning')).toHaveCount(0);
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

/**
 * 深色有两条路，都要成立，且**只有第二条盖得住**：
 *
 *   [data-theme="dark"]                  用户手动选「深色」→ html 带属性
 *   @media (prefers-color-scheme: dark)  「跟随系统」+ 深色系统 → html 无属性
 *
 * 上面那些用例跑在默认浅色下，一条都碰不到这里。tokens.css 的媒体查询那份曾经漏掉
 * amber/red/green/blue/purple 五组语义色，于是这条路上 --amber-bg 回落到浅色 #fdf5e8，
 * Star 引导条 hover 成了浅底 + 浅字（对比度 1.11，字看不见）。默认设置恰恰是「跟随系统」，
 * 手动深色只是显式选择 —— 只在手动深色下截图，就会看到一切正常。
 */
test.describe('Star CTA on a dark OS', () => {
  test.use({ colorScheme: 'dark' });

  test('hover keeps the row readable when the theme follows the system', async ({ page }) => {
    await openSettings(page);

    // 新上下文没有 molio.theme → 默认「跟随系统」→ 走媒体查询那条路
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();

    const star = page.locator('[data-testid="update-star-cta"]');
    await star.hover();
    // 等 140ms 过渡走完，否则量到的是中间帧
    await page.waitForTimeout(300);

    const { color, background } = await star.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor };
    });
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5);
  });
});

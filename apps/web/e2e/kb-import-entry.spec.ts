/**
 * @area kb-import
 * @priority P0
 *
 * 「导入文件」必须是看得见的动作。
 * 背景：曾经全 UI 没有任何导入按钮，唯一进库路径是「拖文件到左侧面板」这一隐式交互，
 * 导致客户反馈「不知道怎么把文件加进知识库」。本 spec 锁死该入口的常驻可见性。
 */

import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;
let emptyVault: TempVault;

/** 导入弹窗 = 带拖拽区的那个 kb-modal（同页还有 vault 管理器等其他 modal）。 */
function importDialog(page: import('@playwright/test').Page) {
  return page.locator('.kb-modal').filter({ has: page.locator('.kb-dropzone') });
}

test.describe('KB 导入入口', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-import-entry');
    emptyVault = await createTempVault('e2e-kb-import-entry-empty');
    fs.unlinkSync(path.join(emptyVault.path, 'test.md'));
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
    if (emptyVault) await cleanupTempVault(emptyVault);
  });

  /**
   * 「英文语系」那条用例必须还原 daemon 的 locale。
   *
   * 坑：App 在 activeVault 的 path 与 config.defaultCwd 不一致时，会把**整份 config 快照**
   * PUT 回 daemon（App.tsx 里为对齐 defaultCwd 的那次写入）。于是我们 mock 出来的
   * `{locale:'en'}` 会被真实落盘，后续所有用例（乃至手动跑的 dev app）都变成英文。
   * settings.spec.ts 踩过同一个坑，同样是 afterEach 还原。
   */
  test.afterEach(async ({ request }) => {
    await request.put('/api/config', { data: { locale: 'zh' } }).catch(() => {});
  });

  test('文件面板工具栏有常驻的「导入」按钮', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-btn-import"]')).toBeVisible({ timeout: 5_000 });
  });

  test('「导入」按钮在工具栏里是醒目的，不是一颗普通灰图标', async ({ page }) => {
    // 这个按钮的全部价值就是「能被一眼看到」。工具栏基色规则
    // `.kb-file-toolbar button:not(.kb-sort-item):not(.kb-create-item)` 的特异度是 (0,3,1)，
    // 早先写的 accent 规则只有 (0,2,0)，被静默盖掉——按钮渲染成了跟旁边一样的灰图标，
    // 代码看着像做了高亮，实际完全没生效（截图才发现）。这条断言锁死「它必须跟邻居不同色」。
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('[data-testid="kb-btn-import"]')).toBeVisible({ timeout: 5_000 });

    const { importColor, neighborColor } = await page.evaluate(() => {
      const pick = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).color : null;
      };
      return {
        importColor: pick('[data-testid="kb-btn-import"]'),
        neighborColor: pick('[data-testid="kb-btn-locate"]'),
      };
    });

    expect(neighborColor).toBeTruthy();
    expect(importColor).toBeTruthy();
    expect(importColor).not.toBe(neighborColor);
  });

  test('点「导入」按钮打开导入弹窗', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-import"]').click();

    const dialog = importDialog(page);
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator('.kb-dropzone')).toBeVisible();
  });

  test('「＋」菜单第一条就是导入文件，点击打开导入弹窗', async ({ page }) => {
    // ＋ 是通用的「添加」形状、又是工具栏第一颗按钮，想要导文件的人第一反应是点它。
    // 菜单里如果只有「新建笔记/新建文件夹/新窗口」，用户会在最显眼的控件上再次走进死胡同。
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-create"]').click();
    const dropdown = page.locator('[data-testid="kb-create-dropdown"]');
    await expect(dropdown).toBeVisible({ timeout: 5_000 });

    // 必须排在「新建笔记」之前 —— 否则「找已有的文件」的人得先越过两条无关项
    const firstItem = dropdown.locator('.kb-create-item').first();
    await expect(firstItem).toContainText('导入');

    await page.locator('[data-testid="kb-create-import"]').click();
    await expect(importDialog(page)).toBeVisible({ timeout: 5_000 });
  });

  test('导入弹窗是中文的，并标明文件会落到哪个库', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await page.locator('[data-testid="kb-btn-import"]').click();

    const dialog = importDialog(page);
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // 逐处断言，别用整个 dialog 的 toContainText —— 弹窗里别的中文（拖拽提示、
    // 提交按钮）会把标题的英文兜住，那样断言就抓不到回归了（实测过）。
    const title = dialog.locator('h2');
    await expect(title).toContainText('导入到');
    await expect(title).toContainText(vault.name);
    await expect(dialog.locator('.kb-dropzone')).toContainText(/拖|导入/);
    await expect(dialog.locator('[data-testid="kb-import-submit"]')).toContainText(/导入/);
  });

  test('一个知识库都没有时，知识库页空态给出建库入口（不是死胡同）', async ({ page }) => {
    await page.route('**/api/knowledge/vaults', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { vaults: [] } }) : route.continue(),
    );
    await page.goto('http://localhost:5173/knowledge');

    const cta = page.locator('[data-testid="kb-empty-create-vault-cta"]');
    await expect(cta).toBeVisible({ timeout: 10_000 });

    await cta.click();
    await expect(page.locator('[data-testid="vault-manager-modal"]')).toBeVisible({ timeout: 5_000 });
  });

  test('空库的文件树空态给出拖拽/导入提示（不是英文空话）', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${emptyVault.id}`);

    const hint = page.locator('[data-testid="kb-tree-empty-hint"]');
    await expect(hint).toBeVisible({ timeout: 5_000 });
    // 提示必须指向一个真实存在的动作，否则跟原来那句英文一样无用
    await expect(hint).toContainText(/导入|拖/);
  });

  test('有文件但未建 Wiki 时，空态给出「导入文件」次级出口', async ({ page }) => {
    // 这屏的语境是「已经有文件、还没建 Wiki」——正是「我看了一下，还想再补几个文件」
    // 最自然的时刻，而原来这里只有「建 Wiki」和「问答」两条路，想补素材得回头找工具栏图标。
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const build = page.locator('[data-testid="kb-empty-build-cta"]');
    const imp = page.locator('[data-testid="kb-empty-import-cta"]');
    await expect(build).toBeVisible({ timeout: 5_000 });
    await expect(imp).toBeVisible({ timeout: 5_000 });

    // 这屏的主推仍是建 Wiki，导入是次级——主次必须看得出来（用户拍板「次级描边」）
    await expect(build).not.toHaveClass(/wiki-cta-btn--outline/);
    await expect(imp).toHaveClass(/wiki-cta-btn--outline/);

    await imp.click();
    await expect(importDialog(page)).toBeVisible({ timeout: 5_000 });
  });

  test('这屏的中文里不再冒出英文 vault', async ({ page }) => {
    // 术语统一成「知识库」是同一批修复的一部分，但这行文案漏网过
    //（术语守卫 spec 当时只覆盖了仓库管理器）。中文句子里夹一个 vault 很扎眼。
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);

    const state = page.locator('.kb-empty-state').first();
    await expect(state).toBeVisible({ timeout: 5_000 });
    await expect(state).toContainText('知识库');
    await expect(state).not.toContainText('vault');
  });

  test('英文语系下空态是英文的（这几个空态原来硬编码中文）', async ({ page }) => {
    // config 的 locale 优先于 localStorage（App 里 cfgLocale 先判），所以要
    // 从 daemon 响应那一层换成 en，光写 localStorage 会被 config 快照盖回去。
    await page.route('**/api/config', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { locale: 'en' } })
        : route.continue(),
    );
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);

    const state = page.locator('.kb-empty-state').first();
    await expect(state).toBeVisible({ timeout: 10_000 });
    // 整屏不许残留中文——硬编码中文时这条必红
    await expect(state).not.toContainText(/[一-鿿]/);
  });

  test('空库首屏的主 CTA 是「导入文件」，且「构建 Wiki」不可点', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${emptyVault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const cta = page.locator('[data-testid="kb-empty-import-cta"]');
    await expect(cta).toBeVisible({ timeout: 5_000 });
    // 一个文件都没有时构建 Wiki 不成立（AI 没素材可读）——它必须被置灰，
    // 否则用户会点进去、什么也没发生，然后卡住。
    await expect(page.locator('[data-testid="kb-empty-build-cta"]')).toBeDisabled();

    await cta.click();
    await expect(importDialog(page)).toBeVisible({ timeout: 5_000 });
  });
});

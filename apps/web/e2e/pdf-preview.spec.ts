/**
 * @area kb
 * @priority P1
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('知识库 PDF 预览', () => {
  let vault: TempVault;

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const writes: string[] = [];
      (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites = writes;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (text: string) => { writes.push(text); return Promise.resolve(); } },
        configurable: true,
      });
    });
  });

  test.beforeAll(async () => {
    vault = await createTempVault('e2e-pdf-preview');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'), path.join(vault.path, 'sample.pdf'));
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('文件树点击 PDF → 内嵌查看器渲染', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await page.locator('.kb-tree-item').filter({ hasText: 'sample.pdf' }).click({ timeout: 10_000 });

    const viewer = page.locator('[data-testid="pdf-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 15_000 });
    // 首页 canvas 渲染
    await expect(viewer.locator('[data-testid="pdf-canvas-1"]')).toBeVisible();
    // 状态条显示第 1 / 3 页
    await expect(viewer.locator('[data-testid="pdf-statusbar"]')).toContainText('第 1 / 3');
    // 文本层有真实文本（1 个 span）
    await expect(viewer.locator('[data-testid="pdf-text-layer-1"] span')).toHaveCount(1);
  });

  test('翻页与缩放按钮生效', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    // 状态条仅就绪后渲染：等它就绪，避免按钮点击发生在加载完成前（no-op）
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 1 / 3');

    await page.getByTestId('kb-btn-pdf-next').click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 2 / 3');

    const before = await page.getByTestId('pdf-statusbar').textContent();
    await page.getByTestId('kb-btn-pdf-zoom-in').click();
    await expect(page.getByTestId('pdf-statusbar')).not.toHaveText(before ?? '');
    // 头栏缩放读数（− % + 之间）随缩放更新
    const zoomReadout = page.getByTestId('pdf-zoom-readout');
    const zoomBefore = await zoomReadout.textContent();
    await page.getByTestId('kb-btn-pdf-zoom-in').click();
    await expect(zoomReadout).not.toHaveText(zoomBefore ?? '');
  });

  test('选区右键复制为纯文本', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    // 文本层异步填充：先等 "Page 1" 渲染完成，再构建选区
    await expect(page.locator('[data-testid="pdf-text-layer-1"]')).toContainText('Page 1');
    // 选中第 1 页文本层中的 "Page 1"，并返回其屏幕矩形中心（供右键定位）
    const sel = await page.locator('[data-testid="pdf-text-layer-1"]').evaluate((el) => {
      const text = (el as HTMLElement).textContent ?? '';
      const idx = text.indexOf('Page 1');
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null; let startNode: Node | null = null; let startOff = 0; let endNode: Node | null = null; let endOff = 0; let acc = 0;
      while ((node = walker.nextNode())) {
        const len = (node as Text).length;
        if (!startNode && acc + len > idx) { startNode = node; startOff = idx - acc; }
        if (acc + len >= idx + 'Page 1'.length) { endNode = node; endOff = idx + 'Page 1'.length - acc; break; }
        acc += len;
      }
      if (startNode && endNode) {
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(range);
        const r = range.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    });
    // 在选中文本上右键，点「复制」（右键须落在选区文本上，选区才保留）
    if (!sel) throw new Error('未能在文本层中建立选区');
    await page.mouse.click(sel.x, sel.y, { button: 'right' });
    await page.getByText('复制', { exact: true }).click();
    const writes = await page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites);
    expect(writes.join('\n')).toContain('Page 1');
  });

  test('搜索高亮与导航', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('kb-btn-pdf-search').click();
    const input = page.getByTestId('pdf-search-input');
    await input.fill('Hello');
    await expect(page.getByTestId('pdf-search-count')).toContainText('1 / 2', { timeout: 10_000 });
    // 页1 当前匹配 → 包了 <mark class="pdf-search-hl">（含 -current）
    await expect(page.locator('[data-testid="pdf-text-layer-1"] .pdf-search-hl')).toHaveCount(1);
    await page.getByTestId('pdf-search-next').click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 2 / 3');
    // 导航后当前匹配移到页2
    await expect(page.locator('[data-testid="pdf-text-layer-2"] .pdf-search-hl-current')).toHaveCount(1);
    // 回归：当前匹配必须出现在视口内（issue 2 —— 跳页后能看到匹配内容，而非停在页顶）
    await expect
      .poll(() => page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="pdf-scroll"]') as HTMLElement | null;
        const mark = document.querySelector('.pdf-search-hl-current') as HTMLElement | null;
        if (!scroller || !mark) return false;
        const sr = scroller.getBoundingClientRect();
        const mr = mark.getBoundingClientRect();
        return mr.top >= sr.top && mr.bottom <= sr.bottom + 5;
      }))
      .toBe(true);
  });

  test('大纲与缩略图侧栏', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('kb-btn-pdf-sidebar').click();
    const sidebar = page.getByTestId('pdf-sidebar');
    await expect(sidebar).toBeVisible();
    // 大纲：fixture 有 Page 1 / Page 2 两条，点击 Page 2 跳到第 2 页
    await expect(sidebar.getByTestId('pdf-outline-item')).toHaveCount(2);
    await sidebar.getByTestId('pdf-outline-item').filter({ hasText: 'Page 2' }).click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 2 / 3');
    // 缩略图：切 tab → 点击第 3 张 → 跳到第 3 页
    await page.getByTestId('pdf-sidebar-tab-thumbs').click();
    await expect(sidebar.locator('canvas').first()).toBeVisible();
    await sidebar.locator('.pdf-thumb').nth(2).click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 3 / 3');
  });

  test('旋转文本文本层带 rotate', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="pdf-scroll"]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('[data-testid="pdf-text-layer-3"] span').first()).toBeVisible();
    // pdf.js 文本层用 --rotate CSS 变量驱动旋转（非 inline transform）
    const rot = await page.locator('[data-testid="pdf-text-layer-3"] span').first().evaluate((el) => (el as HTMLElement).style.getPropertyValue('--rotate'));
    expect(rot.trim()).not.toBe('');
  });

  test('ES2025 Map 方法缺失时 polyfill 补齐且语义正确（Electron 40 / Chromium 144 兼容）', async ({ page }) => {
    // pdf.js v6 依赖 ES2025 `Map.prototype.getOrInsert` / `getOrInsertComputed`，
    // 而 Electron 40（Chromium 144）尚未实现 —— 无 polyfill 时主线程 display 层与
    // worker 的 chunked stream / 渲染管线会抛
    // `this._requestsByChunk.getOrInsertComputed is not a function`，所有 PDF 加载失败。
    //
    // 注意：addInitScript 跑在 isolated world（与 app 的 main world 各自独立 realm），
    // 删不到 app 的 Map.prototype；playwright 的 Chromium 148 worker 自带原生实现，也
    // 无法在 worker 里模拟缺失。这里在 main world 删除方法，直接验证 map-polyfills.ts
    // 补齐后的行为契约（幂等、presence 优先、callback 收到 key、只算一次）。
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(async () => {
      const { installMapPolyfills } = await import('/src/components/kb/map-polyfills.ts');
      if (typeof installMapPolyfills !== 'function') {
        throw new Error('map-polyfills 模块缺少 installMapPolyfills 导出');
      }
      // 模拟运行时缺失（Chromium 144）
      // @ts-expect-error 模拟缺失
      delete Map.prototype.getOrInsert;
      // @ts-expect-error
      delete Map.prototype.getOrInsertComputed;
      if (typeof Map.prototype.getOrInsertComputed !== 'undefined') {
        throw new Error('模拟失败：Map.prototype.getOrInsertComputed 未能删除');
      }
      // 幂等安装
      installMapPolyfills();
      installMapPolyfills();
      if (typeof Map.prototype.getOrInsertComputed !== 'function') {
        throw new Error('polyfill 未补齐 getOrInsertComputed');
      }
      if (typeof Map.prototype.getOrInsert !== 'function') {
        throw new Error('polyfill 未补齐 getOrInsert');
      }
      // getOrInsert：现值优先，不覆盖
      const a = new Map();
      if (a.getOrInsert('k', 1) !== 1) throw new Error('getOrInsert 插入值错误');
      if (a.getOrInsert('k', 2) !== 1) throw new Error('getOrInsert 应保留现值');
      if (a.size !== 1) throw new Error('getOrInsert 不应重复插入');
      // getOrInsertComputed：仅 key 缺失时计算一次，回调收到 key
      const b = new Map();
      let calls = 0;
      let seenKey: unknown = null;
      const cb = (key: unknown) => { calls++; seenKey = key; return 'v'; };
      if (b.getOrInsertComputed('k', cb) !== 'v') throw new Error('getOrInsertComputed 返回值错误');
      if (b.getOrInsertComputed('k', cb) !== 'v') throw new Error('getOrInsertComputed 应命中缓存');
      if (calls !== 1) throw new Error('getOrInsertComputed 不应重复计算');
      if (seenKey !== 'k') throw new Error('getOrInsertComputed 回调应收到 key');
      if (b.size !== 1) throw new Error('getOrInsertComputed 不应重复插入');
    });

    // 用补齐后的方法实际加载 PDF，不应失败（无错误卡片）
    await page.locator('.kb-tree-item').filter({ hasText: 'sample.pdf' }).click({ timeout: 10_000 });
    const viewer = page.locator('[data-testid="pdf-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 15_000 });
    await expect(viewer.getByTestId('pdf-statusbar')).toContainText('第 1 / 3');
    await expect(viewer.locator('[data-testid="pdf-canvas-1"]')).toBeVisible();
  });
});

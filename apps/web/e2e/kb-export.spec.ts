/**
 * @area kb
 * @priority P1
 *
 * 文档出图 E2E：知识库文档 → 单张长图（超长自动分页，文件名带页码）。
 *
 * 覆盖四条真实失败路径：
 *   1. 短文档：点一次出一张 2160px 宽的 PNG
 *   2. 长文档：自动切成多张，文件名为 -1 / -2 …，每张都下得下来
 *   3. 富内容：公式（MathJax SVG）+ 代码块 + 中文 + 同源图片 + 断图，导出不中断
 *   4. 超大单块：普通段落之后跟一块超过单页预算（7248px）的代码块——它必须
 *      被纵向切片成多张（-2 / -3 …），首尾段落仍各自落在普通整页上
 *
 * Playwright 自动启动隔离的 daemon/cloud/web（见 apps/web/playwright.config.ts 的 webServer），无需另开 pnpm dev。
 */

import { test, expect, type Download, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON_API = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}/api`;
const VAULT_NAME = `e2e-export-${Date.now()}`;

// 1x1 PNG —— 同源图片内联路径的最小素材
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// 单张导出页的字节数下限：2160×14496 的纯色空白 PNG 压缩后只有约 8 KB；
// 实测正文页里最小的一张（giant 收尾段）也有 44 KB，取 25 KB 作空白/正文分界，
// 给 Linux 下不同的字体栅格化留出余量。
const EXPORT_PAGE_MIN_BYTES = 25_000;
// 单页最大像素高度：MAX_PAGE_HEIGHT(7400) × EXPORT_SCALE(2)。分页/切片的实现
// 若退化成「不切直接出一张超长图」，一定会越过这个上界。
const MAX_EXPORT_PAGE_PIXELS = 14_800;

const SHORT_MD = `# 导出短文

这一段用来确认导出的正文确实来自当前文档。

## 小结

短文档应该只出一张图。
`;

const LONG_MD = [
  '# 长文档分页',
  ...Array.from({ length: 60 }, (_, i) =>
    [`## 第 ${i + 1} 节`, '', `第 ${i + 1} 节的正文。`.repeat(12)].join('\n'),
  ),
].join('\n\n');

const RICH_MD = `# 富内容导出

行内公式 $E = mc^2$。

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

\`\`\`ts
const answer: number = 42;
console.log(answer);
\`\`\`

![[tiny.png]]

![断图](missing.png)
`;

// 超大单块：一行一变，避免整页内容高度重复导致 PNG 压缩后过小（阈值判据失真）
const GIANT_CODE_LINES = Array.from(
  { length: 500 },
  (_, i) =>
    `const item${i} = { id: ${i}, name: 'item-${i}', score: ${(i * 37) % 100}, tags: [${i}, ${i + 1}, ${i * 3}] };`,
);

const GIANT_LEAD = '这一段是普通段落，位于超大代码块之前，应当落在第一张整页上。';
const GIANT_TAIL = '代码块之后还有一段收尾正文，它应当出现在最后一张整页上。';

const GIANT_MD = [
  '# 超大单块分片',
  '',
  GIANT_LEAD,
  '',
  '第二段把首页撑出真实的正文密度；切片页从第二张开始。',
  '',
  '```ts',
  ...GIANT_CODE_LINES,
  '```',
  '',
  GIANT_TAIL,
].join('\n');

let vaultId = '';
let vaultPath = '';

function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 抓取导出流水线真正栅格化的 SVG，用「它是不是带 molio-doc-export 作用域的
 * SVG data URL」判定。
 *
 * 在生产代码里留调试钩子不可接受，所以观测放在测试侧：`drawSvgToCanvas` 把
 * 页面 SVG 赋给 `Image.src` 后解码，包一层原型 setter 就能拿到同一份字符串。
 * 这样可以直接断言「导出的 SVG 里有哪些 CSS 规则」，而不是靠 PNG 像素/字节
 * 这种弱判据猜。
 */
async function installSvgCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __capturedExportSvg?: string[] }).__capturedExportSvg = store;
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (!desc?.set || desc.configurable === false) return;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(this: HTMLImageElement, value: string) {
        if (typeof value === 'string' && value.startsWith('data:image/svg+xml;base64,')) {
          store.push(value);
        }
        desc.set!.call(this, value);
      },
    });
  });
}

function decodeSvgDataUrl(dataUrl: string): string {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').toString('utf8');
}

async function openExportFile(page: Page, filename: string) {
  await gotoHome(page);
  await page.reload({ waitUntil: 'networkidle' });
  await clickNav(page, 'knowledge');
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

  await page.locator('.kb-vault-bar').first().click({ timeout: 5_000 });
  await page.waitForTimeout(500);
  await page.locator('.vm-vault-item').filter({ hasText: VAULT_NAME }).click({ timeout: 5_000 });
  await page.waitForTimeout(1_000);

  await page.locator('.kb-tree-item').filter({ hasText: filename }).click({ timeout: 10_000 });
  await expect(page.locator('.kb-header-filename-center')).toContainText(filename, {
    timeout: 10_000,
  });
  await expect(page.locator('#output')).toBeVisible({ timeout: 10_000 });
}

test.describe('Document image export', () => {
  test.beforeAll(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-export-'));
    writeFileSync(join(vaultPath, 'short.md'), SHORT_MD);
    writeFileSync(join(vaultPath, 'long.md'), LONG_MD);
    writeFileSync(join(vaultPath, 'rich.md'), RICH_MD);
    writeFileSync(join(vaultPath, 'giant.md'), GIANT_MD);
    writeFileSync(join(vaultPath, 'tiny.png'), TINY_PNG);

    const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: VAULT_NAME, path: vaultPath }),
    });
    const vault = await res.json();
    vaultId = vault.id;
  });

  test.afterAll(async () => {
    if (vaultId) {
      await fetch(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
    }
    if (vaultPath) rmSync(vaultPath, { recursive: true, force: true });
  });

  test('exports a short document as one 2x PNG', async ({ page }) => {
    await openExportFile(page, 'short.md');

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('[data-testid="kb-btn-export-image"]').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^molio-doc-short-\d{8}-\d{4}\.png$/);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();

    const { width, height } = pngSize(readFileSync(filePath!));
    expect(width).toBe(2160);
    expect(height).toBeGreaterThan(400);

    await expect(page.locator('[data-testid="kb-export-notice"]')).toContainText('已导出', {
      timeout: 30_000,
    });
  });

  test('splits a long document into numbered pages', async ({ page }) => {
    test.setTimeout(120_000);
    await openExportFile(page, 'long.md');

    const downloads: Download[] = [];
    page.on('download', (download) => downloads.push(download));

    await page.locator('[data-testid="kb-btn-export-image"]').click();

    // 分页数取决于渲染高度，只断言「至少两页」，不锁死具体页数
    await expect(page.locator('[data-testid="kb-export-notice"]')).toContainText('张图片', {
      timeout: 90_000,
    });
    await expect.poll(() => downloads.length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);

    const names = downloads.map((d) => d.suggestedFilename());
    expect(names[0]).toMatch(/^molio-doc-long-\d{8}-\d{4}-1\.png$/);
    expect(names[1]).toMatch(/^molio-doc-long-\d{8}-\d{4}-2\.png$/);

    for (const download of downloads) {
      const filePath = await download.path();
      expect(filePath).toBeTruthy();
      const buf = readFileSync(filePath!);
      const { width, height } = pngSize(buf);
      expect(width).toBe(2160);
      expect(height).toBeGreaterThan(400);
    }
  });

  test('keeps formulas, code, images and broken images', async ({ page }) => {
    test.setTimeout(90_000);
    await installSvgCapture(page);
    await openExportFile(page, 'rich.md');

    // 前置：公式已经升级成 MathJax SVG（否则导出的只是原始 LaTeX 文本）
    await expect(page.locator('#output .katex-inline svg')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('#output .katex-block svg')).toHaveCount(1, { timeout: 15_000 });

    // 代码高亮 token 色来自异步加载的 CDN 主题 CSS。记录「导出开始那一刻」
    // 主题里是否已有 `hljs-*`：有则导出必须保留；没有（网络/时序原因）就不硬
    // 断言，避免外部 CDN 抖动让 CI 假红。必须在点击导出前采样——导出后再读
    // #md-theme 可能赶上刚异步落地的样式，条件与导出快照对不上。
    const themeHadTokensAtExport = await page.evaluate(() =>
      (document.getElementById('md-theme')?.textContent ?? '').includes('hljs-'),
    );

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('[data-testid="kb-btn-export-image"]').click();
    const download = await downloadPromise;

    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const buf = readFileSync(filePath!);
    const { width } = pngSize(buf);
    expect(width).toBe(2160);
    // 断图与公式都不会让页面退化成纯白：给一个很低的内容下限
    expect(buf.length).toBeGreaterThan(10_000);

    await expect(page.locator('[data-testid="kb-export-notice"]')).toContainText('已导出', {
      timeout: 60_000,
    });

    // doocs 把「代码块 mac 圆点显隐」等规则以 <style> 嵌在 section.container
    // 里，不在 #md-theme。导出只收 #md-theme 时这些规则整段丢失——断言栅格化
    // 用的 SVG 里确实带上了容器内嵌规则（改回只看 :scope > style 即失败）。
    const svgs = await page.evaluate(
      () =>
        (window as unknown as { __capturedExportSvg?: string[] }).__capturedExportSvg ?? [],
    );
    const exportSvg = svgs
      .map(decodeSvgDataUrl)
      .find((svg) => svg.includes('molio-doc-export'));
    expect(exportSvg, '没有捕获到导出页 SVG').toBeTruthy();
    const exportedCss = /<style[^>]*>([\s\S]*?)<\/style>/.exec(exportSvg!)?.[1] ?? '';
    expect(exportedCss).toContain('.hljs.code__pre > .mac-sign');

    // 导出开始前主题里已带 `hljs-*` 时，token 色规则必须原样进入导出。
    if (themeHadTokensAtExport) {
      expect(exportedCss).toContain('hljs-');
    }
  });

  test('slices an oversized single block after normal paragraphs', async ({ page }) => {
    test.setTimeout(150_000);
    await installSvgCapture(page);
    await openExportFile(page, 'giant.md');

    const downloads: Download[] = [];
    page.on('download', (download) => downloads.push(download));

    await page.locator('[data-testid="kb-btn-export-image"]').click();

    await expect(page.locator('[data-testid="kb-export-notice"]')).toContainText('张图片', {
      timeout: 120_000,
    });
    // 首段整页 + 超高代码块至少 2 张切片 + 尾段整页 = ≥4 张；单块不切片时
    // 只有 3 张，这一步就会失败。
    await expect.poll(() => downloads.length, { timeout: 120_000 }).toBeGreaterThanOrEqual(4);

    // 页名按序编号：-1 / -2 / -3 …（时间戳是分钟精度，跨分钟时允许各页不同）
    const names = downloads.map((d) => d.suggestedFilename());
    names.forEach((name, i) => {
      expect(name).toMatch(new RegExp(`^molio-doc-giant-\\d{8}-\\d{4}-${i + 1}\\.png$`));
    });

    for (const [i, download] of downloads.entries()) {
      const filePath = await download.path();
      expect(filePath).toBeTruthy();
      const buf = readFileSync(filePath!);
      const { width, height } = pngSize(buf);
      expect(width).toBe(2160);
      // 分页/切片必须落在单页高度预算内：不切直接出一张超长图会越过上界。
      expect(height).toBeLessThanOrEqual(MAX_EXPORT_PAGE_PIXELS);
      // 纯色空白页在这个尺寸下压缩得极小（实测见 SPEC 导出样本），正文页必须明显高于它
      expect(buf.length).toBeGreaterThan(EXPORT_PAGE_MIN_BYTES);
      // 首末两张是普通整页（带页脚），中间全是超高块的纵向切片——
      // 切片页必须真的切出了大幅内容，而不是退化成一条细带
      if (i > 0 && i < downloads.length - 1) {
        expect(height).toBeGreaterThan(1000);
      }
    }

    // 内容分区：首段必须落在第一张，尾段必须落在最后一张——证明切片没有把
    // 首尾段落吞掉，也没有把整块内容重复塞进每一页。
    const captured = await page.evaluate(
      () =>
        (window as unknown as { __capturedExportSvg?: string[] }).__capturedExportSvg ?? [],
    );
    const exportSvgs = captured
      .map(decodeSvgDataUrl)
      .filter((svg) => svg.includes('molio-doc-export'));
    expect(exportSvgs.length).toBeGreaterThanOrEqual(4);
    expect(exportSvgs[0]).toContain(GIANT_LEAD);
    expect(exportSvgs[exportSvgs.length - 1]).toContain(GIANT_TAIL);
    expect(exportSvgs[0]).not.toContain(GIANT_TAIL);
    expect(exportSvgs[exportSvgs.length - 1]).not.toContain(GIANT_LEAD);
  });
});

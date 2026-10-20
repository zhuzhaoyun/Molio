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

// 公式单独成篇：栅格后的墨迹像素数必须显著大于空白页，否则说明公式在
// foreignObject 里被吞掉了（PNG 字节数不可靠——空白页也有一堆压缩噪声）。
const FORMULA_MD = `$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$
`;

// 一行 300+ 字符：导出时若不换行，静态图里会被横向裁掉；预览里只是可滚动，
// 所以必须靠 SVG 侧的 scrollWidth <= clientWidth 判定。
const LONG_LINE = 'abcdefghij'.repeat(32);
const LONGLINE_MD = `# 长行代码

\`\`\`ts
const veryLong = '${LONG_LINE}';
\`\`\`
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

/** 栅格化真正用到的 SVG data URL（公式栅格需要原始 data URL 再交给 Image）。 */
async function readCapturedSvgDataUrls(page: Page): Promise<string[]> {
  const captured = await page.evaluate(
    () => (window as unknown as { __capturedExportSvg?: string[] }).__capturedExportSvg ?? [],
  );
  return captured.filter((dataUrl) => decodeSvgDataUrl(dataUrl).includes('molio-doc-export'));
}

/** 栅格化真正用到的 SVG 字符串（按捕获顺序；重试会带来同一页的重复项）。 */
async function readCapturedSvgs(page: Page): Promise<string[]> {
  const captured = await readCapturedSvgDataUrls(page);
  return captured.map(decodeSvgDataUrl);
}

interface ParsedPageSvg {
  viewBoxY: number;
  viewBoxHeight: number;
  foreignObjectHeight: number;
  page: number;
  total: number;
}

function parsePageSvg(svg: string): ParsedPageSvg {
  const viewBox = /viewBox="0 ([\d.]+) 1080 ([\d.]+)"/.exec(svg);
  const foreignObject = /<foreignObject[^>]*height="([\d.]+)"/.exec(svg);
  const pageNumber = /(\d+) \/ (\d+)<\/text>/.exec(svg);
  expect(viewBox, `SVG 少了 viewBox: ${svg.slice(0, 200)}`).toBeTruthy();
  expect(foreignObject, `SVG 少了 foreignObject 高度`).toBeTruthy();
  expect(pageNumber, `多页 SVG 少了页码`).toBeTruthy();
  return {
    viewBoxY: Number(viewBox![1]),
    viewBoxHeight: Number(viewBox![2]),
    foreignObjectHeight: Number(foreignObject![1]),
    page: Number(pageNumber![1]),
    total: Number(pageNumber![2]),
  };
}

/**
 * 把导出的 SVG 装进同源 iframe 重新排版并测量。
 *
 * srcdoc 按 HTML 解析，XML 专用的 `<![CDATA[…]]>` 会被当成样式表内容里的
 * 非法 token，整段 CSS 规则失效（实测 styleSheets 规则数为 0）——测量前
 * 剥掉 CDATA 包装。加载后把根 SVG 强制成 viewBox 原尺寸（1:1），这样
 * getBoundingClientRect 的读数就是 SVG 用户单位，和 foreignObject 属性可比。
 */
async function inspectSvgInIframe(
  page: Page,
  svg: string,
  selector: string,
): Promise<{
  height: number;
  scrollWidth: number;
  clientWidth: number;
  cssRuleCount: number;
} | null> {
  // 只拆 CDATA 包装，并还原生产 cdata() 对字面 `]]>` 的拆分
  // （`]]]]><![CDATA[>`）。整段删 `]]>` 会改坏含该字面量的自定义主题 CSS。
  const markup = svg.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    (_match, css: string) => css.replace(/\]\]\]\]><!\[CDATA\[>/g, ']]>'),
  );
  return page.evaluate(
    async ({ markup, selector }) => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText =
        'position:fixed;left:-10000px;top:0;width:2160px;height:8000px;border:0';
      document.body.appendChild(iframe);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('svg iframe load timeout')), 10_000);
          iframe.onload = () => {
            clearTimeout(timer);
            resolve();
          };
          iframe.srcdoc = markup;
        });
        const doc = iframe.contentDocument;
        if (!doc) return null;
        const root = doc.querySelector('svg') as SVGSVGElement | null;
        if (!root || !root.viewBox?.baseVal) return null;
        root.setAttribute('width', String(root.viewBox.baseVal.width));
        root.setAttribute('height', String(root.viewBox.baseVal.height));
        const el = doc.querySelector(selector) as HTMLElement | null;
        if (!el) return null;
        // CSS 规则数为 0 说明 CDATA/样式在 iframe 里没生效——此时未加样式的
        // 内容只会量得更矮、`code` 的 scrollWidth/clientWidth 都是 0，两条
        // 断言会双双「通过」。把它作为前置判据，防止判别器退化成空断言。
        const cssRuleCount = Array.from(doc.styleSheets).reduce((count, sheet) => {
          try {
            return count + sheet.cssRules.length;
          } catch {
            return count;
          }
        }, 0);
        return {
          height: el.getBoundingClientRect().height,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          cssRuleCount,
        };
      } finally {
        iframe.remove();
      }
    },
    { markup, selector },
  );
}

async function openExportFile(page: Page, filename: string, expectOutput = true) {
  // 不要再 reload({waitUntil:'networkidle'})：SSE/HMR 长连接下 networkidle
  // 不可靠，且 gotoHome 已完成导航、addInitScript 也已生效。
  await gotoHome(page);
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
  // 空文档的 #output 是 0 高，Playwright 会判定不可见；它仍然存在（导出按钮据此渲染）。
  if (expectOutput) {
    await expect(page.locator('#output')).toBeVisible({ timeout: 10_000 });
  } else {
    await expect(page.locator('#output')).toHaveCount(1, { timeout: 10_000 });
  }
}

test.describe('Document image export', () => {
  test.beforeAll(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-export-'));
    writeFileSync(join(vaultPath, 'short.md'), SHORT_MD);
    writeFileSync(join(vaultPath, 'long.md'), LONG_MD);
    writeFileSync(join(vaultPath, 'rich.md'), RICH_MD);
    writeFileSync(join(vaultPath, 'giant.md'), GIANT_MD);
    writeFileSync(join(vaultPath, 'formula.md'), FORMULA_MD);
    writeFileSync(join(vaultPath, 'longline.md'), LONGLINE_MD);
    writeFileSync(join(vaultPath, 'empty.md'), '');
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
    await installSvgCapture(page);
    await openExportFile(page, 'short.md');

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('[data-testid="kb-btn-export-image"]').click();
    const download = await downloadPromise;

    // 文件名优先用文档 H1（`# 导出短文`），而不是文件 stem `short`。
    expect(download.suggestedFilename()).toMatch(/^molio-doc-导出短文-\d{8}-\d{4}\.png$/);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();

    const { width, height } = pngSize(readFileSync(filePath!));
    expect(width).toBe(2160);
    expect(height).toBeGreaterThan(400);

    await expect(page.locator('[data-testid="kb-export-notice"]')).toContainText('已导出', {
      timeout: 30_000,
    });

    // 单页导出：署名恒有，页码不渲染（`1 / 1` 只会让人以为还有下一页）。
    const svgs = await readCapturedSvgs(page);
    expect(svgs.length).toBeGreaterThanOrEqual(1);
    expect(svgs[0]).toContain('Molio');
    expect(svgs[0]).not.toMatch(/\d+ \/ \d+/);
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
    expect(names[0]).toMatch(/^molio-doc-长文档分页-\d{8}-\d{4}-1\.png$/);
    expect(names[1]).toMatch(/^molio-doc-长文档分页-\d{8}-\d{4}-2\.png$/);

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

    // 页名按序编号：-1 / -2 / -3 …（一次导出共用同一个时间戳，所以整组一致）
    const names = downloads.map((d) => d.suggestedFilename());
    names.forEach((name, i) => {
      expect(name).toMatch(new RegExp(`^molio-doc-超大单块分片-\\d{8}-\\d{4}-${i + 1}\\.png$`));
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
    const exportSvgs = await readCapturedSvgs(page);
    expect(exportSvgs.length).toBeGreaterThanOrEqual(4);
    expect(exportSvgs[0]).toContain(GIANT_LEAD);
    expect(exportSvgs[exportSvgs.length - 1]).toContain(GIANT_TAIL);
    expect(exportSvgs[0]).not.toContain(GIANT_TAIL);
    expect(exportSvgs[exportSvgs.length - 1]).not.toContain(GIANT_LEAD);

    // ── 级联一致性 / 内容不丢（Critical 的直接回归）──────────────────────────
    // 切片的 foreignObject 装的是整块内容，foreignObject.height = 64 + 测量高度；
    // 把导出的 SVG 按同一份 CSS 重新排版后，首元素的渲染高度必须落在测量高度内；
    // 各切片的可见高度之和也必须覆盖整块。测量宿主少了 base.css 的 code 规则时，
    // 渲染高度会高出约 8.7%，两条断言同时失败。
    const parsedPages = exportSvgs.map((svg) => ({ svg, info: parsePageSvg(svg) }));
    const totals = new Set(parsedPages.map(({ info }) => info.total));
    expect(totals.size).toBe(1);
    const total = parsedPages[0].info.total;
    const pageNumbers = [...new Set(parsedPages.map(({ info }) => info.page))].sort(
      (a, b) => a - b,
    );
    expect(pageNumbers).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(total);
    for (const svg of exportSvgs) expect(svg).toContain('Molio');

    // 切片页 viewBox 的 Y 非 0（正常整页从 0 起）；重试会重复捕获同一页，去重。
    const slicesByY = new Map<number, { svg: string; info: ParsedPageSvg }>();
    for (const parsed of parsedPages) {
      if (parsed.info.viewBoxY !== 0 && !slicesByY.has(parsed.info.viewBoxY)) {
        slicesByY.set(parsed.info.viewBoxY, parsed);
      }
    }
    const slices = [...slicesByY.values()];
    expect(slices.length).toBeGreaterThanOrEqual(2);

    const firstSlice = slices[0];
    const rendered = await inspectSvgInIframe(
      page,
      firstSlice.svg,
      'section.container > :first-child',
    );
    expect(rendered, '切片页里找不到正文块').toBeTruthy();
    // 前置判据：导出 CSS 必须在 iframe 里真正生效。规则数为 0 时内容不带
    // 样式、只会量得更矮，下面的 `<=` 会变成空断言。
    expect(rendered!.cssRuleCount).toBeGreaterThan(50);
    expect(rendered!.height).toBeLessThanOrEqual(firstSlice.info.foreignObjectHeight - 64 + 1);

    const sliceCoverage = slices.reduce(
      (sum, { info }) => sum + (info.viewBoxHeight - 88),
      0,
    );
    expect(sliceCoverage).toBeGreaterThanOrEqual(rendered!.height);
  });

  test('rasterizes the formula instead of a blank page', async ({ page }) => {
    test.setTimeout(90_000);
    await installSvgCapture(page);
    await openExportFile(page, 'formula.md');

    // 前置：公式已经升级成 MathJax SVG（否则导出的只是原始 LaTeX 文本）
    await expect(page.locator('#output .katex-block svg')).toHaveCount(1, { timeout: 15_000 });

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('[data-testid="kb-btn-export-image"]').click();
    await downloadPromise;

    const dataUrls = await readCapturedSvgDataUrls(page);
    expect(dataUrls.length).toBeGreaterThanOrEqual(1);
    const dataUrl = dataUrls[0];

    // 不用 PNG 字节数当判据（空白页压缩后也不小）：直接把导出的 SVG 画进
    // canvas，以左上角像素为底色，数「明显偏离底色」的墨迹像素。
    // 只数页脚带以上：`Molio` 水印本身就有 1600+ 墨迹像素，会把「公式被
    // 抹掉」的空白页顶到阈值以上，让断言失去判别力。
    const ink = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const background = [data[0], data[1], data[2]];
      // 页脚带固定 88 用户单位；栅格倍率 = 像素宽 / 1080。
      const scale = canvas.width / 1080;
      const contentBottom = canvas.height - 88 * scale;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const y = Math.floor(i / 4 / canvas.width);
        if (y >= contentBottom) continue;
        const distance =
          Math.abs(data[i] - background[0]) +
          Math.abs(data[i + 1] - background[1]) +
          Math.abs(data[i + 2] - background[2]);
        if (distance > 60) count += 1;
      }
      return count;
    }, dataUrl);

    expect(ink).toBeGreaterThan(200);
  });

  test('wraps long code lines instead of clipping them', async ({ page }) => {
    test.setTimeout(90_000);
    await installSvgCapture(page);
    await openExportFile(page, 'longline.md');

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('[data-testid="kb-btn-export-image"]').click();
    await downloadPromise;

    const svgs = await readCapturedSvgs(page);
    expect(svgs.length).toBeGreaterThanOrEqual(1);
    const rendered = await inspectSvgInIframe(page, svgs[0], 'pre.code__pre > code');
    expect(rendered, '导出的 SVG 里找不到代码元素').toBeTruthy();
    // CSS 没生效时默认 inline code 的 scrollWidth/clientWidth 都是 0，
    // `0 <= 1` 会让下面的断言空转；先钉住「样式确实生效且元素有宽度」。
    expect(rendered!.cssRuleCount).toBeGreaterThan(50);
    expect(rendered!.clientWidth).toBeGreaterThan(100);
    expect(rendered!.scrollWidth).toBeLessThanOrEqual(rendered!.clientWidth + 1);
  });

  test('reports nothing to export for an empty document', async ({ page }) => {
    await openExportFile(page, 'empty.md', false);

    let downloaded = false;
    page.on('download', () => {
      downloaded = true;
    });

    await page.locator('[data-testid="kb-btn-export-image"]').click();
    await expect(page.locator('[data-testid="kb-export-notice"]')).toContainText(
      '没有可导出的内容',
      { timeout: 15_000 },
    );
    // 给下载事件一个可能到达的窗口：空文档绝不能产出空白图片。
    await page.waitForTimeout(1_500);
    expect(downloaded).toBe(false);
  });
});

import { test, expect, type Page } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * 阅读视窗位置记忆（useScrollMemory）：按文档身份记住滚动位置，
 * **切回一篇已经开着的文档**（点标签 / 前进后退）时恢复；**把文档开进一个原本
 * 没有它的标签**（单标签里从树里点开另一篇）则从顶部重新开始。
 * 两条路径都记：小 .md 阅读视图（容器 `.kb-content-area`）、源码视图
 * （大 md / 非 md 文本 → CodeMirror，容器 `.cm-scroller`）；PDF / 图片 / 排版 /
 * 编辑模式不在记忆范围内（hook 让位）。两条路径的高度模型不同，位置互不通用
 * （key 里带 `cm:` 段）。
 *
 * 回归的是四类行为：
 *  - 残留：滚动容器被 React 复用，切文档后停在上一篇的坐标上（属于别的文档的
 *    位置，纯 bug）——fresh 语义下必须回顶；
 *  - 丢位置：多标签切换（去别的文档核一下再回来）每次都从顶部重读；
 *  - 落位被截断：内容上屏是异步的（MdRenderer 在 effect 里 setState），若在
 *    「数据到手」时就落位，会被容器里上一篇的 scrollHeight 截断——上一篇越短
 *    截得越狠，短到没有滚动条时直接截成 0，看起来就是「切回长文档却回到顶部」。
 *    点标签 / 前进后退两个用例专门守这条；
 *  - 内容改写后旧坐标作废（指纹校验）。
 *
 * 单标签「从树里点开另一篇 = 重新开始读」这一条的独立用例在 kb-scroll-reset.spec.ts
 * （#274）里，两份 spec 都不该被改回去。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;
let fileA: string;
let fileB: string;
let fileShort: string;
let fileText: string;
let fileLongText: string;
let fileImage: string;
let fileBig: string;

/** 短到没有滚动条的文档 —— 用来暴露「落位被上一篇高度截断」。 */
function shortDoc(title: string, marker: string): string {
  return [`# ${title}`, '', '很短的一段话。', '', marker].join('\n');
}

/** 生成足够撑出滚动条的长文档。 */
function longDoc(title: string, marker: string): string {
  const lines = [`# ${title}`, ''];
  for (let i = 1; i <= 200; i++) {
    lines.push(`段落 ${i}：这是一段用于撑高文档的占位文本，重复多次以确保内容超出视口高度。`);
    lines.push('');
  }
  lines.push(marker);
  return lines.join('\n');
}

/** 撑高源码视图用的纯文本：标记在头两行（CM 只渲染可见行，尾行标记读不到）。 */
function longTextDoc(title: string, marker: string): string {
  const lines = [title, marker, ''];
  for (let i = 1; i <= 300; i++) lines.push(`第 ${i} 行：这是一段用于撑高文档的占位文本。`);
  return lines.join('\n');
}

/** 生成超过 MD_RENDER_THRESHOLD(1MB) 的 .md —— 落到 CodeMirror 源码视图。标题行即标记。 */
function bigDoc(title: string, targetBytes = 1_100_000): string {
  const lines = [`# ${title}`, ''];
  const filler = '　　这是一段用于撑大文件的占位文本，重复多次以确保超过 1MB 阈值。';
  let bytes = Buffer.byteLength(lines.join('\n'));
  let n = 0;
  while (bytes < targetBytes) {
    const line = `${++n} ${filler}`;
    lines.push(line, '');
    bytes += Buffer.byteLength(line) + 2;
  }
  return lines.join('\n');
}

function treeItem(page: Page, name: string) {
  return page.locator('.kb-tree-item').filter({ hasText: name });
}

const contentArea = (page: Page) => page.locator('.kb-content-area');
const scrollTopOf = (page: Page) => contentArea(page).evaluate((el) => el.scrollTop);

async function scrollTo(page: Page, top: number) {
  await contentArea(page).evaluate((el, t) => { el.scrollTop = t; }, top);
}

// ── 源码视图（CodeMirror）：滚动条在 CM 自己的 .cm-scroller 上，不是 .kb-content-area ──
const cmScroller = (page: Page) => page.locator('.cm-scroller').first();
const cmTopOf = (page: Page) => cmScroller(page).evaluate((el) => el.scrollTop);

async function scrollCm(page: Page, top: number) {
  await cmScroller(page).evaluate((el, t) => { el.scrollTop = t; }, top);
}

/** 打开文档并等它的正文渲染完（用结尾标记确认拿到的是这一篇）。 */
async function openDoc(page: Page, name: string, marker: string) {
  await treeItem(page, name).click();
  await expect(contentArea(page)).toContainText(marker, { timeout: 10_000 });
}

/**
 * 把文档开进一个**独立标签**：先「+」建空标签，再从树里点开（空标签被回收）。
 * 空标签是 recyclable 的，所以这一步保证文档拿到自己的标签，而不依赖此前开着什么。
 */
async function openInOwnTab(page: Page, name: string, marker: string) {
  await page.locator('[data-testid="kb-tab-add"]').click();
  await openDoc(page, name, marker);
}

/** 点标签切回（多标签切换 = 应恢复阅读位置的路径）。 */
async function clickTab(page: Page, name: string) {
  await page.locator('.kb-wtab').filter({ hasText: name }).first().click();
}

/**
 * KB Tab 栏的关闭不是同步的：`requestClose` 先播关闭动画、**190ms 后**才在
 * setTimeout 里调 `onClose`（KbTabBar.tsx）。所以点完 × 标签就已经从 DOM 上消失，
 * 而真正的关闭处理（写落位意图 + `selectFile` 换到相邻标签/null）还在路上。
 * 不等它落地就继续下一步，那个迟到的 handler 会写在紧随其后的导航**之后**，
 * 把这次导航的 `fresh` 冲成 `restore`（实测就是这么偶发失败的）。
 */
const TAB_CLOSE_ANIM_MS = 190;

/**
 * 关掉当前工作区里所有标签（每个用例从确定状态开始）。
 * 用 dispatchEvent 而不是 click：切标签后 tab 条的「滚入可见区」动画会让关闭按钮
 * 处于 not stable 状态，click 的可操作性等待会一直重试到超时。
 * 每关一个等关闭动画走完，别让下一次点击赶在还没执行的 handler 前面。
 */
async function closeAllTabs(page: Page) {
  for (let i = 0; i < 30; i++) {
    const close = page.locator('.kb-wtab-close').first();
    if ((await close.count()) === 0) return;
    try {
      await close.dispatchEvent('click');
    } catch {
      // 元素在这一瞬被重渲染换掉了 —— 下一轮拿新的
    }
    await page.waitForTimeout(TAB_CLOSE_ANIM_MS + 110);
  }
}

test.describe('KB 阅读视窗位置记忆', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-scroll-memory');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fileA = path.join(vault.path, 'long-a.md');
    fileB = path.join(vault.path, 'long-b.md');
    fileShort = path.join(vault.path, 'short.md');
    fs.writeFileSync(fileA, longDoc('文档 A', 'A 的结尾标记'));
    fs.writeFileSync(fileB, longDoc('文档 B', 'B 的结尾标记'));
    fs.writeFileSync(fileShort, shortDoc('短文档', 'S 的结尾标记'));
    // 非 md 的文本文件走 CodeMirror 源码分支（另一条渲染分支，用作覆盖用例）
    fileText = path.join(vault.path, 'notes.txt');
    fs.writeFileSync(fileText, ['T 的结尾标记', '', '一行源码文本。'].join('\n'));
    // 图片：第三条渲染分支，配合被扣住的内容请求复现「读取未落地」的时序（见下）
    fileImage = path.join(vault.path, 'dot.png');
    fs.writeFileSync(fileImage, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'));
    // 超过 1MB 的 md → 源码视图（CM 分支），标记就在首行（CM 只渲染可见行）
    fileBig = path.join(vault.path, 'big-note.md');
    fs.writeFileSync(fileBig, bigDoc('BIG 文档'));
    // 非 md 文本同样走源码视图（不进 doocs 渲染），也进记忆范围
    fileLongText = path.join(vault.path, 'notes-long.txt');
    fs.writeFileSync(fileLongText, longTextDoc('NOTES-LONG', 'LONG-TXT 的开头标记'));
  });

  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(treeItem(page, 'long-a.md')).toBeVisible({ timeout: 10_000 });
    await closeAllTabs(page);
  });

  test('单标签下从树里换文档：新开的那篇从顶部开始，不复用上一篇的坐标', async ({ page }) => {
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 600);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(500);

    // 开进「没有它的标签」（这里就是当前这个标签）→ 重新开始读，从顶部
    await openDoc(page, 'long-b.md', 'B 的结尾标记');
    expect(await scrollTopOf(page)).toBe(0);

    await scrollTo(page, 1200);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(1100);

    // 换回 A：A 也没有自己的标签了，同样是「重新开始读」
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    expect(await scrollTopOf(page)).toBe(0);
  });

  test('多标签切换：切回已开着的文档恢复各自的阅读位置', async ({ page }) => {
    await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 600);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(500);
    const aTop = await scrollTopOf(page);

    // B 开进自己的标签（A 的标签仍然开着）
    await openInOwnTab(page, 'long-b.md', 'B 的结尾标记');
    expect(await scrollTopOf(page), 'B 是新开的，从顶部').toBe(0);
    await scrollTo(page, 1200);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(1100);

    // 点标签切回 A：恢复 A 自己的位置（这是「去别的文档核一下再回来」的主场景）
    await clickTab(page, 'long-a.md');
    await expect(contentArea(page)).toContainText('A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBe(aTop);

    // 再切回 B：恢复 B 的位置（不是 A 的）
    await clickTab(page, 'long-b.md');
    await expect(contentArea(page)).toContainText('B 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(1100);
  });

  test('上一次看的是源码分支（.txt）的文档时，切回 md 仍恢复原位置', async ({ page }) => {
    // 覆盖：另一条渲染分支（CodeMirror 源码视图）→ 阅读分支的来回。这一条在修复前后
    // 都是绿的（.txt 的内容会在中途喂给 MdRenderer，mdRenderedSource 被换成别的串，
    // ready 只会在真正上屏后才为真）；真正的回归守卫是下面用图片那条。
    await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 900);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(800);
    const aTop = await scrollTopOf(page);

    // 另一个标签打开 .txt：md 分支的子树被整棵换掉，回来时容器是空壳
    await openInOwnTab(page, 'notes.txt', 'T 的结尾标记');
    await expect(page.locator('.cm-scroller')).toBeVisible({ timeout: 10_000 });

    await clickTab(page, 'long-a.md');
    await expect(contentArea(page)).toContainText('A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBe(aTop);
  });

  test('另一条渲染分支的文档读取还没落地时切回，仍恢复原位置', async ({ page }) => {
    // 回归（2026-09-29 桌面端实测「三条路径都不恢复」）：真正的触发条件不是「切到另一条
    // 分支的文档」，而是**那篇文档的内容读取迟迟没落地**——大文件（用户现场那篇 1.1MB
    // 的 PDF）、慢盘、后台还有请求排队时都会这样，此时 fileContent 还是这篇 md 的。
    // 于是切回来时：md 分支整棵重新挂载（容器是空壳），而 mdRenderedSource 还留着上一次
    // 为它渲染的内容串 —— 两者相等，ready 在**容器还空着**的那一帧就为真，落位被容器
    // 高度 clamp 成 0（空壳 scrollHeight === clientHeight，无处可滚）；等 MdRenderer
    // 真正上屏，回传的还是同一个字符串，ready 不再变化，这次落位永远不会重来。
    // 所以落位必须**可重复施加**（pending 留到「真的滚过一次」为止，见约束 6）。
    // 这里用一张图片 + 扣住它的内容请求来稳定复现「读取没落地」的时序。
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(
      (url) => url.pathname.includes('/files/') && decodeURIComponent(url.pathname).includes('dot.png'),
      async (route) => { await held; await route.continue(); },
    );
    try {
      await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
      await scrollTo(page, 900);
      await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(800);
      const aTop = await scrollTopOf(page);

      await page.locator('[data-testid="kb-tab-add"]').click();
      await treeItem(page, 'dot.png').click();
      await expect(page.locator('.kb-wtab').filter({ hasText: 'dot.png' })).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);

      await clickTab(page, 'long-a.md');
      await expect(contentArea(page)).toContainText('A 的结尾标记');
      await expect.poll(() => scrollTopOf(page)).toBe(aTop);
    } finally {
      release();
    }
  });

  test('文档内容被改写后旧位置作废，切回时回到顶部', async ({ page }) => {
    await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 800);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(700);

    // 外部改写 A（AI 回写知识库的真实场景）→ size/mtime 变 → 指纹失效
    fs.appendFileSync(fileA, `\n\n## 追加段落\n\n${'新写入的内容。'.repeat(100)}\n`);

    await openInOwnTab(page, 'long-b.md', 'B 的结尾标记');
    await clickTab(page, 'long-a.md');
    await expect(contentArea(page)).toContainText('追加段落', { timeout: 10_000 });

    // 内容已变：不留在旧坐标上，从顶部开始（poll：落位发生在内容就绪后的 effect 里）
    await expect.poll(() => scrollTopOf(page)).toBe(0);
  });

  test('上一篇短到没有滚动条时，点标签切回长文档仍恢复原位置', async ({ page }) => {
    await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 4000);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3900);

    // 另开一个标签打开短文档 → 两篇同时开着，覆盖「点标签切换」路径
    await openInOwnTab(page, 'short.md', 'S 的结尾标记');
    expect(
      await contentArea(page).evaluate((el) => el.scrollHeight - el.clientHeight),
      '前提：短文档必须没有滚动条（否则测不到截断）',
    ).toBe(0);

    // 回到长文档：落位发生在新内容上屏之后，不该被短文档的高度截断到 0
    await clickTab(page, 'long-a.md');
    await expect(contentArea(page)).toContainText('A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3900);
  });

  test('上一篇短到没有滚动条时，前进/后退切回长文档仍恢复原位置', async ({ page }) => {
    await openDoc(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 4000);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3900);

    // 单标签：打开短文档会回收当前标签，历史里留下 long-a → short
    await openDoc(page, 'short.md', 'S 的结尾标记');
    await page.locator('[data-testid="nav-back"]').click();
    await expect(contentArea(page)).toContainText('A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(3900);
  });

  test('「回到顶部」按钮归零并同步记忆', async ({ page }) => {
    await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
    await scrollTo(page, 700);
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(600);

    await page.locator('[data-testid="kb-btn-top"]').click();
    expect(await scrollTopOf(page)).toBe(0);

    // 记忆已随之归零：切走再切回仍从顶部开始（而不是回到点按钮前的位置）
    await openInOwnTab(page, 'long-b.md', 'B 的结尾标记');
    await clickTab(page, 'long-a.md');
    await expect(contentArea(page)).toContainText('A 的结尾标记');
    await expect.poll(() => scrollTopOf(page)).toBe(0);
  });

  test('源码视图（.txt 等非 md 文本）：切回恢复原位置', async ({ page }) => {
    // 非 md 文本不进 doocs 渲染、直接落源码视图（isCmPath 的另一半条件：
    // 不是「大文件」也会走这条路），记忆同样要跟着回来。
    await openInOwnTab(page, 'notes-long.txt', 'LONG-TXT 的开头标记');
    await expect(cmScroller(page)).toBeVisible({ timeout: 10_000 });
    await scrollCm(page, 2500);
    await expect.poll(() => cmTopOf(page)).toBeGreaterThan(2000);
    const txtTop = await cmTopOf(page);

    await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
    await clickTab(page, 'notes-long.txt');
    await expect(cmScroller(page)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => cmTopOf(page)).toBe(txtTop);
  });

  test('源码视图（>1MB 的 md）：切回恢复原位置，开进没有它的标签时从顶部开始', async ({ page }) => {
    // 1.1MB 的文档要现写盘、再由 daemon 读回、CM 还要解析，段数也多 —— 默认 30s 不够
    test.slow();
    // 大文件落到 CM 源码分支，滚动条在 CM 自己的 .cm-scroller 上（.kb-content-area
    // 只是个 flex 容器）。这条同时守住就绪时序：CM 的滚动高度来自它自己的高度模型
    // （measure 周期），不是 DOM 布局的自然结果——落位若发生在它量之前会被 clamp 成
    // 0 且不会重来（见 KbCodeMirrorViewer.onMeasured）。
    await openInOwnTab(page, 'big-note.md', 'BIG 文档');
    await expect(cmScroller(page)).toBeVisible({ timeout: 15_000 });
    await scrollCm(page, 9000);
    await expect.poll(() => cmTopOf(page)).toBeGreaterThan(8000);
    const bigTop = await cmTopOf(page);

    // 另开一个标签看小 md，再点标签切回 → 恢复原位置（与 md 路径同一套语义）
    await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
    await clickTab(page, 'big-note.md');
    await expect.poll(() => cmTopOf(page)).toBe(bigTop);

    // CM 工具条的「回到顶部」归零，记忆随之同步（切走再切回仍是顶部）
    await page.locator('[data-testid="kb-btn-top"]').click();
    expect(await cmTopOf(page)).toBe(0);
    await openInOwnTab(page, 'long-a.md', 'A 的结尾标记');
    await clickTab(page, 'big-note.md');
    await expect.poll(() => cmTopOf(page)).toBe(0);

    // 再滚出一个非零位置，关掉所有标签后从树里打开（= 开进一个没有它的标签）
    // → 重新开始读：从顶部，且旧记录已被作废（否则这里会回到 5000）
    await scrollCm(page, 5000);
    await expect.poll(() => cmTopOf(page)).toBeGreaterThan(4000);
    await closeAllTabs(page);
    await openDoc(page, 'big-note.md', 'BIG 文档');
    await expect.poll(() => cmTopOf(page)).toBe(0);
  });
});

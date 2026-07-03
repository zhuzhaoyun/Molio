/**
 * @area kb
 * @priority P0
 *
 * 回归：拖选文档内容松手后，选区必须保留（不被 React 重渲染抹掉）。
 * 前置：pnpm dev（daemon :3100 + web :5173）。
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON_API = 'http://localhost:3100/api';
const MD = `# Selection Repro

这是一段用来测试选中的中文内容。Another English paragraph here with enough text to drag across.
`;
const TABLE_MD = `# Table Copy

| 姓名 | 城市 |
|---|---|
| 张三 | 北京 |
| 李四 | 上海 |
`;
let vaultPath: string;
let vaultId: string;
const vaultName = `e2e-ctx-${Date.now()}`;
const t_zh_copy = '复制';

test.beforeAll(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'molio-ctx-'));
  writeFileSync(join(vaultPath, 'sel-test.md'), MD);
  writeFileSync(join(vaultPath, 'table-test.md'), TABLE_MD);
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: vaultName, path: vaultPath }),
  });
  vaultId = (await res.json()).id;
});

test.afterAll(async () => {
  if (vaultId) await fetch(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
  if (vaultPath) rmSync(vaultPath, { recursive: true, force: true });
});

async function openFile(page: import('@playwright/test').Page, filename = 'sel-test.md') {
  await gotoHome(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await clickNav(page, 'knowledge');
  await page.waitForSelector('.kb-shell');
  await page.locator('.kb-vault-bar').first().click();
  await page.waitForTimeout(400);
  await page.locator('.vm-vault-item').filter({ hasText: vaultName }).click();
  await page.waitForTimeout(800);
  await page.locator('.kb-tree-item').filter({ hasText: filename }).click();
  await page.waitForSelector('.kb-content-area #output section', { timeout: 10_000 });
}

test('drag selection survives mouseup', async ({ page }) => {
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = (await para.boundingBox())!;
  const startX = box.x + 12, endX = box.x + box.width - 12, y = box.y + box.height / 2;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(sel.length).toBeGreaterThan(0);
});

test('context menu appears with correct items and disabled states', async ({ page }) => {
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = (await para.boundingBox())!;

  // 先在无选区状态下右键（点击一次放置光标，无选区）
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 3_000 });

  // 无选区时：复制与就此提问 disabled；全选 enabled
  await expect(page.locator('.ctx-menu-item', { hasText: '复制' })).toBeDisabled();
  await expect(page.locator('.ctx-menu-item', { hasText: '就此提问' })).toBeDisabled();
  await expect(page.locator('.ctx-menu-item', { hasText: '全选' })).toBeEnabled();

  // 三项都存在
  await expect(page.locator('.ctx-menu-item', { hasText: t_zh_copy })).toBeVisible();
  // 用 data-testid 不可得（ContextMenu 不带 testid），用文本定位
  const items = page.locator('.ctx-menu-item');
  await expect(items).toHaveCount(3);

  // 关闭菜单（ESC）
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toBeHidden();
});

test('copy action writes selection to clipboard', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = (await para.boundingBox())!;

  // 拖选整段大部分（横跨段落），避免小幅选区在 suite 上下文里漂移
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const selBefore = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selBefore.length).toBeGreaterThan(0);

  // 右键 → 复制
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '复制' }).click();
  await page.waitForTimeout(250);

  // readText 可能因 clipboard 异步稍延迟，重试几次
  let clip = '';
  for (let i = 0; i < 5 && !clip; i++) {
    clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    if (!clip) await page.waitForTimeout(150);
  }
  // text/plain 现在是 markdown；纯文本段落 turndown 后≈原文，至少包含选中文本
  expect(clip.length).toBeGreaterThan(0);
  expect(clip).toContain('中文内容');
});

test('select-all action selects #output content', async ({ page }) => {
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = (await para.boundingBox())!;

  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '全选' }).click();
  await page.waitForTimeout(200);

  const sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(sel).toContain('这是一段用来测试选中的中文内容');
});

test('ask-about-selection opens chat with selection preview', async ({ page }) => {
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = (await para.boundingBox())!;

  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const selBefore = await page.evaluate(() => window.getSelection()?.toString() ?? '');

  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '就此提问' }).click();

  await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-testid="kb-chat-selected-preview"]')).toContainText(selBefore);
});

test('copy action writes markdown + html (table preserved)', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFile(page, 'table-test.md');
  await page.waitForSelector('#output table.md-table', { timeout: 10_000 });
  const table = page.locator('#output table.md-table').first();
  const box = (await table.boundingBox())!;

  // Select all #output (includes the table) via the context menu's 全选
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '全选' }).click();
  await page.waitForTimeout(200);

  // Right-click again on the table (selection preserved) → 复制
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '复制' }).click();
  await page.waitForTimeout(200);

  // text/html — table structure preserved for rich-text paste (Word/Notion)
  const html = await page.evaluate(async () => {
    const clips = await navigator.clipboard.read();
    for (const c of clips) {
      if (c.types.includes('text/html')) {
        const blob = await c.getType('text/html');
        return await blob.text();
      }
    }
    return '';
  });
  expect(html).toContain('<table');
  expect(html).toContain('张三');

  // text/plain — markdown source (Obsidian/markdown editors/记事本)
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('|');      // markdown pipe table
  expect(text).toContain('姓名');   // header cell as markdown
  expect(text).toContain('张三');
  // doocs/md injects <style> blocks inside #output; they must NOT leak into
  // the copied markdown (regression guard for the style-strip in selHtml).
  expect(text).not.toContain('.preview-wrapper');
  expect(text).not.toContain('hljs');
});

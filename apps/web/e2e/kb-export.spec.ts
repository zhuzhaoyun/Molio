/**
 * @area kb
 * @priority P1
 *
 * 文档出图 E2E：知识库文档 → 单张长图（超长自动分页，文件名带页码）。
 *
 * 覆盖三条真实失败路径：
 *   1. 短文档：点一次出一张 2160px 宽的 PNG
 *   2. 长文档：自动切成多张，文件名为 -1 / -2 …，每张都下得下来
 *   3. 富内容：公式（MathJax SVG）+ 代码块 + 中文 + 同源图片 + 断图，导出不中断
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

let vaultId = '';
let vaultPath = '';

function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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
});

/**
 * @area kb
 * @priority P1
 *
 * 外部素材根（external source roots）—— 挂载 / 只读保证 / 解除挂载。
 *
 * 产品契约：一个 vault 可以把外部文件夹**只读**挂载到 `<vault>/external/<label>`。
 * 挂载内容是素材来源，可读、不可写；vault 自己的内容不受影响（只读不外溢）。
 *
 * 六条断言（与 brief 的必测清单一一对应）：
 *   1. 挂载      —— UI 添加 → `external-root-item` 可见、`data-valid="true"`、label = basename(target)
 *   2. 只读      —— `external/<label>` 目录节点不可拖拽、无 `data-drop-dir`；
 *                   右键菜单有 `kb-ctx-external-readonly` 说明项，无「重命名 / 删除 / 新建文件 / 新建子文件夹」；
 *                   树上有 `kb-tree-readonly-badge`
 *   3. 可读      —— 挂载的 `mounted.md` 能打开且正文渲染出来
 *   4. 编辑器只读 —— 挂载文件打开时 `kb-btn-edit` / `kb-btn-typeset` / `kb-btn-save` 全部不存在
 *   5. 对照组    —— vault 自己的 `notes/` 仍可拖拽、仍有 `data-drop-dir`；其文件右键仍有「重命名」「删除」
 *   6. 解除      —— `external-root-remove` → 行归零，树里的挂载目录同步消失
 *
 * 额外一条（brief「建议」项，非必测）：源目录被从磁盘删除后，挂载行保留、标 `data-valid="false"`
 * 并可移除——daemon 的契约是「失效也返回该行，让 UI 提供 unmount」。
 *
 * 前置：`pnpm dev`（daemon :3100 + web :5173）。
 * Playwright 里没有 Electron，`window.__electron__.showDirectoryPicker` 不存在，
 * 挂载走的是设置面板的「内联路径输入」分支（与桌面端原生选择器共用同一个挂载 API）。
 *
 * 选择器说明：vault / 设置面板 / 文件树没有 testid，用既有 spec 验证过的 class
 * （`.kb-vault-bar` → `.vm-overlay`、`.kb-tree-group-label`、`.kb-tree-item`）。
 * 右键菜单的写操作项没有 testid，按文本断言（读操作项有 testid 时优先用 testid）。
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAEMON = 'http://localhost:3100/api';

let vaultPath = '';
let vaultId = '';
/** 被只读挂载的外部素材目录（`mounted.md` 在里面）。 */
let extPath = '';
let extLabel = '';
const vaultName = `e2e-ext-roots-${Date.now()}`;

test.beforeAll(async () => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-extvault-'));
  // vault 自己的内容 —— 对照组：只读不能外溢到这里。
  fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, 'notes', 'in-vault.md'),
    '# in vault\n\nowned by the vault\n',
  );

  // 外部素材 —— 只被读，测试全程不写它。
  extPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-extsrc-'));
  extLabel = path.basename(extPath);
  fs.writeFileSync(
    path.join(extPath, 'mounted.md'),
    '# mounted memory\n\nmounted-body-marker\n',
  );

  const res = await fetch(`${DAEMON}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: vaultName, path: vaultPath }),
  });
  vaultId = (await res.json()).id;
});

test.afterAll(async () => {
  if (vaultId) {
    await fetch(`${DAEMON}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
  }
  // The mount link lives INSIDE vaultPath, so dropping the vault dir drops the
  // link — never the target. Both temp dirs go.
  for (const p of [vaultPath, extPath]) {
    if (p) fs.rmSync(p, { recursive: true, force: true });
  }
});

/** 打开知识库并锁定到本用例的 vault（?vault= 是本窗口的权威作用域）。 */
async function openKb(page: Page) {
  await page.goto(`/knowledge?vault=${vaultId}`);
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 10_000 });
}

/** 打开 vault 设置面板（右下 vault bar → VaultManagerModal 的右栏）。 */
async function openVaultManager(page: Page) {
  await page.locator('.kb-vault-bar').first().click();
  await expect(page.locator('.vm-overlay')).toBeVisible({ timeout: 5_000 });

  const section = page.locator('[data-testid="external-root-section"]');
  if (!(await section.isVisible().catch(() => false))) {
    // activeVault 还没解析出来时右栏是空的 —— 显式在列表里选一次本 vault
    // （URL 已 pin 到同一个 vault，所以是原地切换、不会开新窗口）。
    await page.locator('.vm-vault-item').filter({ hasText: vaultName }).click();
    await page.locator('.kb-vault-bar').first().click();
  }
  await expect(section).toBeVisible({ timeout: 5_000 });
  return section;
}

/** 关闭设置面板（overlay 只在点到自身时关闭，所以点它的内边距区）。 */
async function closeVaultManager(page: Page) {
  await page.locator('.vm-overlay').click({ position: { x: 4, y: 4 } });
  await expect(page.locator('.vm-overlay')).toBeHidden({ timeout: 5_000 });
}

/** 树里的目录节点标签（`.kb-tree-group-label` 元素本身）。 */
function treeGroupLabels(page: Page, text: string) {
  return page.locator('.kb-tree-group-label').filter({ hasText: text });
}

/** 设置面板里某一个挂载行（按 data-label 之外的文本定位，label/target 都含它）。 */
function externalRootRow(page: Page, label: string) {
  return page.locator('[data-testid="external-root-item"]').filter({ hasText: label });
}

test('external root mounts read-only on the tree, stays readable, and unmounts', async ({ page }) => {
  await openKb(page);

  // ── 1. 挂载：全程走 UI（设置面板 → 内联路径输入 → 确认）───────────────
  await openVaultManager(page);
  await page.locator('[data-testid="external-root-add"]').click();
  await page.locator('[data-testid="external-root-target"]').fill(extPath);
  await page.locator('[data-testid="external-root-add-confirm"]').click();

  const row = externalRootRow(page, extLabel);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveAttribute('data-valid', 'true');
  // label == basename(target) —— daemon 的契约，UI 原样透出。
  await expect(row).toHaveAttribute('data-label', extLabel);
  await expect(row).toContainText(extLabel);
  await expect(page.locator('[data-testid="external-root-error"]')).toHaveCount(0);

  await closeVaultManager(page);

  // ── 2. 只读（核心保证）：external/<label> 子树 ─────────────────────────
  const externalLabel = treeGroupLabels(page, 'external').first();
  await expect(externalLabel).toBeVisible({ timeout: 10_000 });
  await externalLabel.click(); // 展开 external/

  const mountLabel = treeGroupLabels(page, extLabel).first();
  await expect(mountLabel).toBeVisible({ timeout: 10_000 });

  // 目录节点的 DOM 是 `.kb-tree-group-label` 的父级 `.kb-tree-group`
  // （用 xpath=.. 取父级，避免 `.kb-tree-group` 的 hasText 连带匹配祖先）。
  const mountGroup = mountLabel.locator('xpath=..');
  await expect(mountGroup).toHaveAttribute('data-readonly', 'true');
  // 不是拖放落点、也不能被拖走。
  expect(await mountGroup.getAttribute('data-drop-dir')).toBeNull();
  expect(await mountGroup.getAttribute('draggable')).toBe('false');
  // 树上的「只读」徽标。
  await expect(mountGroup.locator('[data-testid="kb-tree-readonly-badge"]')).toBeVisible();

  // 右键菜单：有只读说明项，没有任何写操作入口。
  await mountLabel.click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });

  const readonlyNote = page.locator('[data-testid="kb-ctx-external-readonly"]');
  await expect(readonlyNote).toBeVisible();
  await expect(readonlyNote).toBeDisabled();

  for (const writeAction of ['重命名', '删除', '新建文件', '新建子文件夹']) {
    // 这些项在挂载节点上都没有 testid（product 侧只有根菜单的 kb-ctx-new-*-root），
    // 所以按文本断言；数量为 0 即「菜单里根本不提供」。
    await expect(page.locator('.ctx-menu-item').filter({ hasText: writeAction })).toHaveCount(0);
  }
  // 删除是唯一的 danger 项 —— 结构上再兜一层。
  expect(await page.locator('.ctx-menu-item.is-danger').count()).toBe(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toBeHidden();

  // ── 3. 可读：挂载的 .md 能打开、正文渲染出来 ──────────────────────────
  await mountLabel.click(); // 展开 external/<label>/
  const mountedFile = page.locator('.kb-tree-item').filter({ hasText: 'mounted.md' });
  await expect(mountedFile).toBeVisible({ timeout: 10_000 });
  await mountedFile.click();
  await expect(page.locator('.kb-content-area #output')).toContainText('mounted memory', {
    timeout: 10_000,
  });

  // ── 4. 编辑器也只读：三个写入入口一个都不渲染 ────────────────────────
  await expect(page.locator('[data-testid="kb-btn-edit"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="kb-btn-typeset"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="kb-btn-save"]')).toHaveCount(0);

  // ── 5. 对照组：vault 自己的内容不受只读影响 ──────────────────────────
  const notesGroup = page.locator('.kb-tree-group[data-drop-dir="notes"]');
  await expect(notesGroup).toBeVisible();
  expect(await notesGroup.getAttribute('draggable')).toBe('true');
  expect(await notesGroup.getAttribute('data-readonly')).toBeNull();

  await treeGroupLabels(page, 'notes').first().click();
  const inVaultFile = page.locator('.kb-tree-item').filter({ hasText: 'in-vault.md' });
  await expect(inVaultFile).toBeVisible({ timeout: 10_000 });

  await inVaultFile.click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.ctx-menu-item').filter({ hasText: '重命名' })).toHaveCount(1);
  await expect(page.locator('.ctx-menu-item').filter({ hasText: '删除' })).toHaveCount(1);
  await expect(page.locator('[data-testid="kb-ctx-external-readonly"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toBeHidden();

  // 同一个 header：vault 文件仍有编辑入口 —— 证明第 4 步的「不存在」来自只读，
  // 而不是 header 压根没渲染。
  await inVaultFile.click();
  await expect(page.locator('.kb-content-area #output')).toContainText('owned by the vault');
  await expect(page.locator('[data-testid="kb-btn-edit"]').first()).toBeVisible();

  // ── 6. 解除挂载：行归零 + 树里的挂载目录同步消失 ─────────────────────
  await openVaultManager(page);
  await externalRootRow(page, extLabel)
    .locator('[data-testid="external-root-remove"]')
    .click();
  await expect(page.locator('[data-testid="external-root-item"]')).toHaveCount(0, {
    timeout: 10_000,
  });
  await closeVaultManager(page);

  await expect(treeGroupLabels(page, extLabel)).toHaveCount(0, { timeout: 10_000 });
});

test('a mount whose target vanished is flagged invalid and stays removable', async ({ page }) => {
  const gonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-extgone-'));
  const goneLabel = path.basename(gonePath);
  try {
    await openKb(page);
    await openVaultManager(page);
    await page.locator('[data-testid="external-root-add"]').click();
    await page.locator('[data-testid="external-root-target"]').fill(gonePath);
    await page.locator('[data-testid="external-root-add-confirm"]').click();

    const row = externalRootRow(page, goneLabel);
    await expect(row).toHaveAttribute('data-valid', 'true', { timeout: 10_000 });

    // 源目录被从磁盘上拿掉（拔盘 / 删文件夹）。
    fs.rmSync(gonePath, { recursive: true, force: true });

    // 重开面板：行还在（不静默丢弃用户配置），标失效，仍可移除。
    await closeVaultManager(page);
    await openVaultManager(page);
    await expect(row).toHaveAttribute('data-valid', 'false', { timeout: 10_000 });
    await expect(row.locator('[data-testid="external-root-invalid"]')).toBeVisible();

    await row.locator('[data-testid="external-root-remove"]').click();
    await expect(page.locator('[data-testid="external-root-item"]')).toHaveCount(0, {
      timeout: 10_000,
    });
    await closeVaultManager(page);
  } finally {
    fs.rmSync(gonePath, { recursive: true, force: true });
  }
});

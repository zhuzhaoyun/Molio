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
 * 其余三条是终审（whole-branch review）后的补测：
 *   7. 拖放        —— 拖到挂载上被拒（不落到 vault 根），拖到面板空白处仍照常导入
 *   8. 文件级只读  —— 挂载**文件**的右键菜单同样没有写操作（第 2 步只测了目录）
 *   9. 无挂载对照  —— 一个自己就有 `external/` 文件夹、但没注册任何挂载的 vault，
 *                     该目录必须仍是普通目录（可拖放、可编辑、可重命名）
 *  10. 选中即可配置 —— 未跨仓库：面板留住就地配置；已 pin 窗口选别的仓库（多窗口
 *                     语义保留）：新窗口承载该仓库且管理器直接打开（manage=1），
 *                     配置不用再点开一次（用户反馈：以前两条路都得重开面板）
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
  // Never let a failed POST slide through: `vaultId` would stay '' and every
  // mount in this file would land in whatever vault the daemon has active —
  // leaking a registry row + a link into the developer's real vault while the
  // temp dirs are deleted underneath it.
  expect(res.ok, `vault POST failed: ${res.status}`).toBe(true);
  vaultId = (await res.json()).id;
  expect(vaultId, 'vault POST returned no id').toBeTruthy();
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
    // 列表是异步渲染的（仓库 retries: 0），先等它出现再点，否则这里会静默
    // 点空 → 后面等 section 可见时超时。
    await expect(page.locator('.vm-vault-item').first()).toBeVisible({ timeout: 5_000 });
    // 选中即切换，但面板不再自动关闭 —— 右栏就地变成这个 vault 的设置，同一趟
    // 就能挂外部文件夹（这正是这条路径存在的理由）。
    await page.locator('.vm-vault-item').filter({ hasText: vaultName }).click();
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

  // 作用域：这块设置点名它属于哪个仓库。面板上方还有「新建仓库 / 打开本地仓库」
  // 两个不针对任何具体仓库的动作，作用域头是两者不混为一谈的唯一依据。
  await expect(page.locator('[data-testid="external-root-scope"]')).toHaveText(vaultName);

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

  // 4b. 挂载**文件**的右键菜单同样没有任何写操作 —— 只读是整棵子树的性质，
  // 文件级回归（目录只读、文件却可重命名/删除）在这里必须挂。
  await mountedFile.click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-testid="kb-ctx-external-readonly"]')).toBeVisible();
  for (const writeAction of ['重命名', '删除', '新建文件', '新建子文件夹']) {
    await expect(page.locator('.ctx-menu-item').filter({ hasText: writeAction })).toHaveCount(0);
  }
  expect(await page.locator('.ctx-menu-item.is-danger').count()).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toBeHidden();

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

test('a drop onto a mount is rejected, a drop on empty panel space still imports', async ({ page }) => {
  const srcPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-extdrop-'));
  const label = path.basename(srcPath);
  let rootId = '';
  try {
    fs.writeFileSync(path.join(srcPath, 'kept.md'), '# kept\n');
    const add = await fetch(`${DAEMON}/knowledge/vaults/${vaultId}/external-roots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: srcPath }),
    });
    expect(add.ok, `mount POST failed: ${add.status}`).toBe(true);
    rootId = (await add.json()).root.id;

    await openKb(page);
    await treeGroupLabels(page, 'external').first().click();
    const mountGroup = treeGroupLabels(page, label).first().locator('xpath=..');
    await expect(mountGroup).toBeVisible({ timeout: 10_000 });
    await expect(mountGroup).toHaveAttribute('data-readonly', 'true');

    // 拖到只读挂载上：挂载子树自身的 drop handler 对外部文件是「静默放行」
    // （不打 preventDefault），事件冒泡到面板；面板必须把它拒掉，而不是把
    // 目标目录解析成空串（挂载节点没有 data-drop-dir）后导到 vault 根。
    const droppedOnMount = await page.evaluate((labelText: string) => {
      // 只看 group 自己的 label（`external` 组的 label 里不含挂载 label，
      // 展开后它的 textContent 才包含子节点）。
      const groups = Array.from(document.querySelectorAll('.kb-tree-group[data-readonly="true"]'));
      const group = groups.find((g) => {
        const lbl = g.querySelector(':scope > .kb-tree-group-label');
        return (lbl?.textContent ?? '').includes(labelText);
      }) as HTMLElement | undefined;
      if (!group) return 'mount-group-not-found';
      const dt = new DataTransfer();
      dt.items.add(new File(['# nope'], 'rejected-in-mount.md', { type: 'text/markdown' }));
      group.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      group.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return 'ok';
    }, label);
    expect(droppedOnMount).toBe('ok');

    // 对照组（正面）：拖到面板空白处仍然导到 vault 根 —— 拒绝不能把这条路径
    // 也一起废掉。它同时是上面那条「没有导入」断言的同步点：这条导入跑完，
    // 说明导入链路确实在工作。
    await page.evaluate(() => {
      const panel = document.querySelector('.kb-file-panel') as HTMLElement | null;
      if (!panel) return;
      const dt = new DataTransfer();
      dt.items.add(new File(['# hello'], 'allowed-at-root.md', { type: 'text/markdown' }));
      panel.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      panel.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(
      page.locator('.kb-tree-item .kb-tree-name').filter({ hasText: 'allowed-at-root.md' }),
    ).toBeVisible({ timeout: 10_000 });
    expect(fs.existsSync(path.join(vaultPath, 'allowed-at-root.md'))).toBe(true);

    // 负面：被拒的那次一个字节都没落盘，树里也不该出现。
    expect(fs.existsSync(path.join(vaultPath, 'rejected-in-mount.md'))).toBe(false);
    await expect(page.locator('.kb-tree-name').filter({ hasText: 'rejected-in-mount.md' })).toHaveCount(0);
  } finally {
    if (rootId) {
      await fetch(`${DAEMON}/knowledge/vaults/${vaultId}/external-roots/${rootId}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    fs.rmSync(srcPath, { recursive: true, force: true });
  }
});

test('a vault that mounted nothing treats its own external/ folder as ordinary', async ({ page }) => {
  // 「没有外部素材根的 vault 行为不变」：`external/` 只是个普通目录名。
  const ownVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-extown-'));
  fs.mkdirSync(path.join(ownVaultPath, 'external'), { recursive: true });
  fs.writeFileSync(
    path.join(ownVaultPath, 'external', 'mine.md'),
    '# mine\n\nowned by an unmounted vault\n',
  );
  const ownName = `e2e-ext-own-${Date.now()}`;
  const res = await fetch(`${DAEMON}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ownName, path: ownVaultPath }),
  });
  expect(res.ok, `vault POST failed: ${res.status}`).toBe(true);
  const ownVaultId = (await res.json()).id;
  expect(ownVaultId).toBeTruthy();

  try {
    await page.goto(`/knowledge?vault=${ownVaultId}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    // 目录节点照样是可拖放落点、不是只读节点（有挂载时这两个断言都会反转）。
    const externalGroup = page.locator('.kb-tree-group[data-drop-dir="external"]');
    await expect(externalGroup).toBeVisible({ timeout: 10_000 });
    expect(await externalGroup.getAttribute('data-readonly')).toBeNull();

    await treeGroupLabels(page, 'external').first().click();
    const mine = page.locator('.kb-tree-item').filter({ hasText: 'mine.md' });
    await expect(mine).toBeVisible({ timeout: 10_000 });
    await mine.click();
    await expect(page.locator('.kb-content-area #output')).toContainText(
      'owned by an unmounted vault',
    );

    // 文档头部三个写入入口都在（只读时一个都不渲染）。
    await expect(page.locator('[data-testid="kb-btn-edit"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="kb-btn-typeset"]').first()).toBeVisible();

    // 右键菜单有写操作，没有只读说明项。
    await mine.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.ctx-menu-item').filter({ hasText: '重命名' })).toHaveCount(1);
    await expect(page.locator('.ctx-menu-item').filter({ hasText: '删除' })).toHaveCount(1);
    await expect(page.locator('[data-testid="kb-ctx-external-readonly"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ctx-menu')).toBeHidden();
  } finally {
    await fetch(`${DAEMON}/knowledge/vaults/${ownVaultId}`, { method: 'DELETE' }).catch(() => {});
    fs.rmSync(ownVaultPath, { recursive: true, force: true });
  }
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

/**
 * 用户反馈：点仓库名是想「切过去并配置它（挂外部素材根）」，但面板总会关掉，得
 * 再点开一次。两个分支都要顾及：
 *   • 未跨仓库（就地切换）：面板留住，右栏就地保持该仓库的设置。
 *   • 已 pin 窗口选别的仓库（多窗口语义，保留）：新窗口承载该仓库，且 URL 带
 *     manage=1 让管理器在新窗口里直接打开 —— 不用在新窗口里再点开一次。
 * 固定 pin 到本用例的仓库再操作，走哪条分支不依赖「URL 镜像是否已写入」的时序。
 */
test('picking a vault lands you in its settings — in place, or in the new window', async ({ page }) => {
  // 名字不能是 vaultName 的子串，否则 `.vm-vault-item` 的 hasText 会同时命中两个。
  const otherName = `e2e-ext-roots-two-${Date.now()}`;
  const otherPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-extvault-two-'));
  let otherId = '';
  try {
    const res = await fetch(`${DAEMON}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: otherName, path: otherPath }),
    });
    expect(res.ok, `vault POST failed: ${res.status}`).toBe(true);
    otherId = (await res.json()).id;

    await openKb(page);
    await page.locator('.kb-vault-bar').first().click();
    await expect(page.locator('.vm-overlay')).toBeVisible({ timeout: 5_000 });

    const scope = page.locator('[data-testid="external-root-scope"]');

    // ── 1. 点当前仓库（未跨仓库 → 就地）：面板留住，作用域不变 ──────────
    await page.locator('.vm-vault-item').filter({ hasText: vaultName }).click();
    await expect(page.locator('.vm-overlay')).toBeVisible();
    await expect(scope).toHaveText(vaultName);

    // ── 2. 点别的仓库（已 pin + 跨仓库 → 多窗口）：新窗口承载它，管理器在新窗口
    //       直接打开、作用域就是它 —— 配置它不需要再点开一次；原窗口原样不动 ──
    const popupPromise = page.context().waitForEvent('page');
    await page.locator('.vm-vault-item').filter({ hasText: otherName }).click();
    const popup = await popupPromise;
    await popup.waitForURL(/vault=/);
    expect(new URL(popup.url()).searchParams.get('vault')).toBe(otherId);
    await expect(popup.locator('.vm-overlay')).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator('[data-testid="external-root-scope"]')).toHaveText(otherName);

    // 原窗口：管理器收起（新窗口已接手配置），仓库与 URL 都没动。
    await expect(page.locator('.vm-overlay')).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('.kb-vault-bar__name')).toHaveText(vaultName);
    expect(new URL(page.url()).searchParams.get('vault')).toBe(vaultId);

    // ── 3. 显式出口：新窗口里 ✕ 关掉管理器 ─────────────────────────────
    await popup.locator('[data-testid="vault-manager-close"]').click();
    await expect(popup.locator('.vm-overlay')).toBeHidden({ timeout: 5_000 });
  } finally {
    if (otherId) {
      await fetch(`${DAEMON}/knowledge/vaults/${otherId}`, { method: 'DELETE' }).catch(() => {});
    }
    fs.rmSync(otherPath, { recursive: true, force: true });
  }
});

/**
 * Escape 关面板，但删除确认框弹着的时候不能顺手把整块面板也关掉 —— 那个对话框
 * 自己也吃 Escape，两个都监听 document 的话会一起触发。
 */
test('Escape closes the manager, but not while the delete confirmation is up', async ({ page }) => {
  await openKb(page);
  await page.locator('.kb-vault-bar').first().click();
  await expect(page.locator('.vm-overlay')).toBeVisible({ timeout: 5_000 });

  // 删仓库的 ⋯ 只在 hover 时可见 —— 先 hover 行再点。
  const row = page.locator('.vm-vault-item').filter({ hasText: vaultName }).first();
  await row.hover();
  await row.locator('.vm-vault-delete').click();
  await expect(page.locator('[data-testid="confirm-dialog"]')).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="confirm-dialog"]')).toBeHidden({ timeout: 5_000 });
  await expect(page.locator('.vm-overlay'), 'Escape 只该关确认框').toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.vm-overlay')).toBeHidden({ timeout: 5_000 });
});

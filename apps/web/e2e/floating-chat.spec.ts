// apps/web/e2e/floating-chat.spec.ts
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 * 方案 D 全局悬浮对话：任意页面右下角按钮、展开/收起显隐、与 KB 页内 💬问答共用同一面板、
 * 历史就地打开不跳转。
 * Prerequisites: `pnpm dev`.
 */

let vault: TempVault;

test.describe('Floating chat (方案 D)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-floating-chat');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('默认收起：任意页面右下角悬浮按钮可见，面板不可见', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await expect(page.locator('[data-testid="floating-chat-btn"]')).toBeVisible();
    // 面板 DOM 常驻（保 ref 恒有效），收起态是 CSS --closed → visibility:hidden（不参与命中/焦点）
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeHidden();
  });

  test('点击悬浮按钮 → 面板展开、按钮隐藏；收起后按钮复现', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(0);

    // 收起 → 按钮复现、面板隐藏
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeHidden();
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toBeVisible();
  });

  test('KB 页内 💬问答展开的是同一全局面板，按钮隐藏', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 方案 D：KB 页不再渲染页内面板，💬问答直接展开全局面板
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);
  });

  test('首页同样可用悬浮面板（不依赖 KB 页）', async ({ page }) => {
    await mockChatRun(page);
    await page.goto('http://localhost:5173/');
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="floating-chat-btn"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    // 无 vault 上下文也能打开：面板空态
    await expect(page.locator('[data-testid="kb-chat-sessions-empty"]')).toBeVisible();
  });

  test('面板开合有升入动画：open 态配置 opacity+transform 过渡，收起后 visibility 隐藏', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="floating-chat-btn"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();

    // open 态：opacity + transform 升入过渡（0.2s ease-out），无 --closed 类
    const open = await panel.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      return {
        closed: el.classList.contains('floating-chat-panel--closed'),
        props: cs.transitionProperty,
        duration: cs.transitionDuration,
      };
    });
    expect(open.closed).toBe(false);
    expect(open.props).toContain('opacity');
    expect(open.props).toContain('transform');
    expect(open.duration).toContain('0.2s');

    // 收起：类名立即切换（CSS 状态），visibility 延迟到动画结束再隐藏
    await page.locator('[data-testid="kb-chat-close"]').click();
    const closedClass = await panel.evaluate((el) =>
      el.classList.contains('floating-chat-panel--closed'));
    expect(closedClass).toBe(true);
    await expect(panel).toBeHidden();
    const visibility = await panel.evaluate((el) => getComputedStyle(el as HTMLElement).visibility);
    expect(visibility).toBe('hidden');
  });

  test('面板可拖拽调整宽度（左缘 handle 320–720），重载后宽度持久化保留', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250); // 等开启动画结束，boundingBox 稳定

    const before = (await panel.boundingBox())!.width;
    const handle = page.locator('[data-testid="kb-chat-resize-handle"]');
    await expect(handle).toBeVisible();
    const hb = (await handle.boundingBox())!;
    // 右缘锚定：向左拖 → 面板变宽
    await page.mouse.move(hb.x + 4, hb.y + 300);
    await page.mouse.down();
    await page.mouse.move(hb.x - 120, hb.y + 300, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const after = (await panel.boundingBox())!.width;
    expect(after).toBeGreaterThan(before + 90);

    // 重载后宽度保留（localStorage 持久化）
    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    const persisted = (await panel.boundingBox())!.width;
    expect(Math.abs(persisted - after)).toBeLessThan(5);
  });

  test('面板可拖拽调整高度（顶缘 handle，下锚定），默认撑满视口、重载后高度持久化', async ({ page }) => {
    // 首页测试：顶缘高度 handle 是悬浮形态独有（停靠形态 display:none），KB 页默认停靠，
    // 故迁移到首页（默认悬浮）验证拖高。
    await mockChatRun(page);
    await page.goto('http://localhost:5173/');
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="floating-chat-btn"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);

    // 默认高度 = 撑满视口（100vh - 96px：top 72 + bottom 24）
    const vp = page.viewportSize()!;
    const before = (await panel.boundingBox())!.height;
    expect(Math.abs(before - (vp.height - 96))).toBeLessThan(8);

    // 下锚定：向下拖顶缘 → 变矮
    const handle = page.locator('[data-testid="kb-chat-resize-handle-h"]');
    await expect(handle).toBeVisible();
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + 300, hb.y + 4);
    await page.mouse.down();
    await page.mouse.move(hb.x + 300, hb.y + 120, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const after = (await panel.boundingBox())!.height;
    expect(after).toBeLessThan(before - 90);

    // 拖拽结束必须清理干净：手柄不留 is-dragging、body 不留拖拽光标类
    // （回归：此前 is-dragging 加在手柄却从面板移除 → 残留；cursor 一直显示 ns-resize）
    const dragState = await page.evaluate(() => ({
      hCls: document.querySelector('[data-testid="kb-chat-resize-handle-h"]')?.className ?? '',
      wCls: document.querySelector('[data-testid="kb-chat-resize-handle"]')?.className ?? '',
      body: document.body.className,
    }));
    expect(dragState.hCls).not.toContain('is-dragging');
    expect(dragState.wCls).not.toContain('is-dragging');
    expect(dragState.body).not.toContain('kb-resizing');

    // 重载后高度保留（localStorage 持久化）
    await page.reload();
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="floating-chat-btn"]').click();
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    const persisted = (await panel.boundingBox())!.height;
    expect(Math.abs(persisted - after)).toBeLessThan(5);
  });

  test('边缘跟随光标：移动面板后拖宽/拖高，被拖边动、对侧固定', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);

    // 先通过 header 拖拽移动面板（floatPos 生效、inline left/top 固定）——
    // 这正是旧逻辑出错的前提：被拖的边被钉死、对侧外扩（反直觉）。
    const tb = (await page.locator('[data-testid="kb-chat-session-tabbar"]').boundingBox())!;
    const sx = tb.x + tb.width - 150;
    const sy = tb.y + 16;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 80, sy - 60, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    // ── 拖左缘（宽度手柄）：左缘跟随光标左移、右缘钉死不动 ──
    const wBefore = (await panel.boundingBox())!;
    const rightPinned = wBefore.x + wBefore.width;
    const wh = await page.locator('[data-testid="kb-chat-resize-handle"]').boundingBox();
    await page.mouse.move(wh.x + 4, wh.y + 300);
    await page.mouse.down();
    await page.mouse.move(wh.x - 100, wh.y + 300, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const wAfter = (await panel.boundingBox())!;
    expect(wAfter.width).toBeGreaterThan(wBefore.width + 80); // 变宽
    expect(wAfter.x).toBeLessThan(wBefore.x - 80); // 左缘跟随光标左移
    expect(Math.abs(wAfter.x + wAfter.width - rightPinned)).toBeLessThan(4); // 右缘钉死

    // ── 拖顶缘（高度手柄）：先向下收矮（顶缘下移、下缘钉死），再向上拉高（顶缘上移、下缘仍钉死）──
    const hBefore = (await panel.boundingBox())!;
    const bottomPinned = hBefore.y + hBefore.height;
    let hh = await page.locator('[data-testid="kb-chat-resize-handle-h"]').boundingBox();
    await page.mouse.move(hh.x + 300, hh.y + 4);
    await page.mouse.down();
    await page.mouse.move(hh.x + 300, hh.y + 90, { steps: 5 }); // 向下拖 → 变矮
    await page.mouse.up();
    await page.waitForTimeout(100);
    const hShrunk = (await panel.boundingBox())!;
    expect(hShrunk.height).toBeLessThan(hBefore.height - 70);
    expect(hShrunk.y).toBeGreaterThan(hBefore.y + 70); // 顶缘跟随光标下移
    expect(Math.abs(hShrunk.y + hShrunk.height - bottomPinned)).toBeLessThan(4); // 下缘钉死

    // 再向上拉回 → 变高、顶缘上移、下缘仍钉死
    hh = await page.locator('[data-testid="kb-chat-resize-handle-h"]').boundingBox();
    await page.mouse.move(hh.x + 300, hh.y + 4);
    await page.mouse.down();
    await page.mouse.move(hh.x + 300, hh.y - 90, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const hGrown = (await panel.boundingBox())!;
    expect(hGrown.height).toBeGreaterThan(hShrunk.height + 70);
    expect(hGrown.y).toBeLessThan(hShrunk.y - 70);
    expect(Math.abs(hGrown.y + hGrown.height - bottomPinned)).toBeLessThan(4);
  });

  test('停靠切换按钮：悬浮 ⇄ 页内分栏（带形态过渡），停靠时文档区让出宽度、拖宽联动', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    const vw = page.viewportSize()!.width;
    // .kb-shell 当前让出的右缘宽度（停靠=面板宽，悬浮=0）
    const shellPad = () => page.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('.kb-shell')!).paddingRight));

    // KB 页默认停靠 = 页内分栏：从页顶（y=0）占满整高、贴右缘，而非悬浮式 overlay
    let box = (await panel.boundingBox())!;
    expect(Math.abs(box.y)).toBeLessThan(4);
    expect(Math.abs(box.x + box.width - vw)).toBeLessThan(4);
    const dockWidth = box.width;
    // 文档区让出等宽 → 问答与文档分栏（不被覆盖）
    expect(Math.abs((await shellPad()) - dockWidth)).toBeLessThan(4);

    // 切悬浮：--morphing 临时启用几何过渡（left/right/top/height 可过渡），随后恢复全宽
    const toggle = page.locator('[data-testid="kb-chat-dock-toggle"]');
    await expect(toggle).toBeVisible();
    await toggle.click();
    const morphProps = await panel.evaluate((el) => getComputedStyle(el as HTMLElement).transitionProperty);
    expect(morphProps).toContain('left');
    expect(morphProps).toContain('right');
    expect(morphProps).toContain('top');
    expect(morphProps).toContain('height');
    await page.waitForTimeout(300); // 等形态过渡结束
    box = (await panel.boundingBox())!;
    // 悬浮：右缘距视口 24px，文档区恢复全宽（不再被让出）
    expect(Math.abs(box.x + box.width - (vw - 24))).toBeLessThan(4);
    expect(await shellPad()).toBeLessThan(4);

    // 切回停靠 → 恢复分栏几何（文档区再次让出等宽）
    await toggle.click();
    await page.waitForTimeout(300);
    box = (await panel.boundingBox())!;
    expect(Math.abs(box.y)).toBeLessThan(4);
    expect(Math.abs(box.x + box.width - vw)).toBeLessThan(4);
    expect(Math.abs((await shellPad()) - box.width)).toBeLessThan(4);

    // 停靠形态下左缘拖宽 → 文档区同步重排（拖宽联动）
    const handle = page.locator('[data-testid="kb-chat-resize-handle"]');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + 4, hb.y + 300);
    await page.mouse.down();
    await page.mouse.move(hb.x - 80, hb.y + 300, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    box = (await panel.boundingBox())!;
    expect(box.width).toBeGreaterThan(dockWidth + 60);
    expect(Math.abs((await shellPad()) - box.width)).toBeLessThan(4); // 文档区跟着调整

    // 回到悬浮 → 文档区恢复全宽
    await toggle.click();
    await page.waitForTimeout(300);
    box = (await panel.boundingBox())!;
    expect(Math.abs(box.x + box.width - (vw - 24))).toBeLessThan(4);
    expect(await shellPad()).toBeLessThan(4);
  });

  test('悬浮形态可拖拽移动位置，重载后位置保留', async ({ page }) => {
    // 首页测试：KB 页默认停靠（无悬浮位置可拖），迁移到首页（默认悬浮）验证移动。
    await mockChatRun(page);
    await page.goto('http://localhost:5173/');
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="floating-chat-btn"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    const before = (await panel.boundingBox())!;

    // 拖标签栏右侧空区（避开左缘宽度手柄/顶缘高度手柄/标签/按钮）向左上移动
    const tb = (await page.locator('[data-testid="kb-chat-session-tabbar"]').boundingBox())!;
    const sx = tb.x + tb.width - 150;
    const sy = tb.y + 16;
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { tag: el?.tagName ?? '', role: el?.getAttribute?.('role') ?? '', cls: String(el?.className ?? '') };
    }, { x: sx, y: sy });
    expect(hit.tag).not.toBe('BUTTON');
    expect(hit.role).not.toBe('button');
    expect(hit.cls).not.toContain('resize-handle');

    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 80, sy - 60, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const after = (await panel.boundingBox())!;
    expect(after.x).toBeLessThan(before.x - 70);
    expect(after.y).toBeLessThan(before.y - 50);

    // 重载 → 位置保留（localStorage 持久化）
    await page.reload();
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="floating-chat-btn"]').click();
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    const persisted = (await panel.boundingBox())!;
    expect(Math.abs(persisted.x - after.x)).toBeLessThan(5);
    expect(Math.abs(persisted.y - after.y)).toBeLessThan(5);
  });

  test('拖拽互切：悬浮拖到右缘 → 停靠；停靠后向左拖 → 恢复悬浮', async ({ page }) => {
    // 首页测试：KB 页默认停靠（起点已是停靠，无「悬浮拖到右缘」路径），迁移到首页（默认悬浮）。
    await mockChatRun(page);
    await page.goto('http://localhost:5173/');
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="floating-chat-btn"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    const vw = page.viewportSize()!.width;

    // 悬浮 → 向右拖至右缘（越过 8px 阈值）→ 停靠
    let tb = (await page.locator('[data-testid="kb-chat-session-tabbar"]').boundingBox())!;
    let sx = tb.x + tb.width - 150;
    let sy = tb.y + 16;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 60, sy, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    let box = (await panel.boundingBox())!;
    expect(Math.abs(box.x + box.width - vw)).toBeLessThan(4); // 贴右缘 = 停靠

    // 停靠 → 向左拖 → 脱离停靠恢复悬浮
    tb = (await page.locator('[data-testid="kb-chat-session-tabbar"]').boundingBox())!;
    sx = tb.x + tb.width - 150;
    sy = tb.y + 16;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 120, sy, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    box = (await panel.boundingBox())!;
    expect(box.x + box.width).toBeLessThan(vw - 90); // 不再贴右缘
  });

  test('活跃标签加粗 + 标签字号 13px（P0 视觉精修）', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();

    const activeTab = page.locator('[data-testid="kb-chat-session-tab"].is-active');
    await expect(activeTab).toHaveCSS('font-weight', '500');
    await expect(activeTab).toHaveCSS('font-size', '13px');
  });

  test('KB 页打开默认停靠；首页默认悬浮', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="floating-chat-btn"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/floating-chat-panel--dock-kb/);
    await expect(page.locator('[data-testid="kb-chat-dock-toggle"]')).toHaveAttribute('aria-pressed', 'true');

    await page.goto('http://localhost:5173/');
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="floating-chat-btn"]').click();
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveClass(/floating-chat-panel--dock/);
  });
});

// apps/web/e2e/floating-chat.spec.ts
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import { gotoChatSpa, clickNav } from './helpers/navigation';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 * 全局悬浮对话面板（方案 D）：除主页外任意页面右下角悬浮按钮常驻（面板展开时按钮让位）；
 * 面板跨页面保持开启（后台任务继续）；KB 页默认停靠页内分栏、可切悬浮。
 * 主页是唯一例外——主页自身即聊天页，按钮不渲染，且到达主页时面板收起。
 * Prerequisites: `pnpm dev`.
 */

let vault: TempVault;

/** startViewTransition 调用计数探针：断言「同一个表面」形变确实发起 / 被跳过。
 *  必须在 goto 前经 addInitScript 安装（早于应用代码执行）。 */
const VT_COUNTER_SCRIPT = () => {
  (window as unknown as { __vtCalls: number }).__vtCalls = 0;
  const orig = document.startViewTransition?.bind(document);
  if (orig) {
    (document as unknown as { startViewTransition: typeof orig }).startViewTransition = (cb) => {
      (window as unknown as { __vtCalls: number }).__vtCalls += 1;
      return orig(cb);
    };
  }
};

test.describe('Floating chat (方案 D)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-floating-chat');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('KB 页有右下角悬浮按钮；面板默认收起', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 方案 D：面板收起时右下角常驻悬浮按钮
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(1);
    // 面板 DOM 常驻（保 ref 恒有效），收起态是 CSS --closed → visibility:hidden（不参与命中/焦点）
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeHidden();
  });

  test('💬问答唤起面板，按钮让位；收起后按钮复现', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    // 面板展开时按钮让位（FloatingChatButton 在 panelOpen 时返回 null）
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(0);

    // 收起 → 面板隐藏，按钮复现可再次唤起
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeHidden();
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(1);
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

  test('离开 KB 页面板保持开启；非 KB 页有悬浮按钮', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();

    // 客户端跳转历史页 → 面板保持开启（不再离开 KB 就收起），后台任务继续且可见
    await clickNav(page, 'history');
    await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });

    // 必须等过「收起动画 160ms + effect flush」窗口再断言：否则 toBeVisible 会在
    // 面板尚未收起的瞬时窗口里通过，测不出「离开 KB 自动收起」这个旧行为（假绿）。
    await page.waitForTimeout(600);
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveClass(/floating-chat-panel--closed/);
    // 面板开着时按钮让位
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(0);
  });

  test('非 KB 页收起面板后，悬浮按钮可重新唤起', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();

    await clickNav(page, 'history');
    await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });
    // 等过收起动画窗口：旧行为下这里面板已自动收起、关闭按钮不可点，用例会翻车
    await page.waitForTimeout(600);
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeHidden();

    // 非 KB 页收起后按钮复现，点击可再次展开（方案 D 的「全局可用」）
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toHaveCount(1);
    await btn.click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    // 就地展开，不发生路由跳转
    await expect(page).toHaveURL(/\/history$/);
  });

  test('主页是例外：到达主页时面板不渲染，无悬浮按钮', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/floating-chat-panel--dock-kb/);

    // 到达全屏态（`/chat`）→ 面板整体不渲染：全屏 shell 自身已经渲染了活动会话的
    // ChatSessionView，再渲染面板会让同一个会话出现两份输入框/消息列表
    // （L2b 裁决；见 KbChatSessionsPanel 的 `if (isFullscreenRoute(location.pathname)) return null;`）。
    await gotoChatSpa(page);
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });
    await expect(panel).toHaveCount(0);
    // 主页不渲染悬浮按钮
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveCount(0);
  });

  test('面板开合有升入动画：open 态配置 opacity+transform 过渡，收起后 visibility 隐藏', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
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

    // 收起：类名切换走 VT（回调在旧快照抓取后一帧执行，用可重试断言），
    // visibility 延迟到动画结束再隐藏
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(panel).toHaveClass(/floating-chat-panel--closed/);
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
    // 顶缘高度 handle 是悬浮形态独有（停靠形态 display:none）。KB 页默认停靠，
    // 故经 💬问答 打开（停靠）→ 切悬浮 → 验证拖高。
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    // 默认停靠 → 切悬浮才有顶缘高度 handle（等形变收尾：形变期间表面是快照、摸不到）
    await page.locator('[data-testid="kb-chat-dock-toggle"]').click();
    await page.waitForTimeout(500);

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

    // 重载后高度保留（localStorage 持久化；knowledge 形态已被上一步存为悬浮，重开即浮态）
    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
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

  test('停靠切换按钮：悬浮 ⇄ 页内分栏（同一个表面形变），停靠时文档区让出宽度、拖宽联动', async ({ page }) => {
    await page.addInitScript(VT_COUNTER_SCRIPT);
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    const vw = page.viewportSize()!.width;
    // 内容区当前让出的右缘宽度（停靠=面板宽，悬浮=0）。
    // 读 **.entry-main**（App 外壳）而不是 .kb-shell：让位已从「知识库页自己让」上提为
    // 全站通用（一条规则覆盖所有页面，新增页面不会漏），见 rail.css 的 --chat-dock-w。
    const shellPad = () => page.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('.entry-main')!).paddingRight));

    // KB 页默认停靠 = 页内分栏：从页顶（y=0）占满整高、贴右缘，而非悬浮式 overlay
    let box = (await panel.boundingBox())!;
    expect(Math.abs(box.y)).toBeLessThan(4);
    expect(Math.abs(box.x + box.width - vw)).toBeLessThan(4);
    const dockWidth = box.width;
    // 文档区让出等宽 → 问答与文档分栏（不被覆盖）
    expect(Math.abs((await shellPad()) - dockWidth)).toBeLessThan(4);

    // 切悬浮：走「同一个表面」的 View Transition（面板 ↔ 全屏 shell ↔ 悬浮按钮互斥
    // 持有同一个 view-transition-name，浏览器实测两端矩形做形变）；终态几何断言在下方不变
    const toggle = page.locator('[data-testid="kb-chat-dock-toggle"]');
    await expect(toggle).toBeVisible();
    await toggle.click();
    // VT 确实发起了（startViewTransition 调用计数探针在 goto 前通过 addInitScript 安装）
    expect(await page.evaluate(() => (window as unknown as { __vtCalls: number }).__vtCalls)).toBeGreaterThanOrEqual(1);
    // 形变结束即摘名：常驻名字会让命名元素命中测试失效（拖拽/点击全哑），
    // 这个断言守住「结束必摘名」的清理契约
    await page.waitForTimeout(450);
    const vtName = await panel.evaluate((el) => getComputedStyle(el as HTMLElement).viewTransitionName);
    expect(['none', '']).toContain(vtName);
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
    // 等形变彻底收尾（300ms 动画 + 快照就绪）再落指针：形变进行中命中测试在快照层上
    await page.waitForTimeout(500);
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

  test('减少动态偏好：形态切换不发起 VT、直接落位（几何仍正确）', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(VT_COUNTER_SCRIPT);
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);

    await page.locator('[data-testid="kb-chat-dock-toggle"]').click();
    await page.waitForTimeout(150);
    const vw = page.viewportSize()!.width;
    // JS 层短路：一次 VT 都没发起
    expect(await page.evaluate(() => (window as unknown as { __vtCalls: number }).__vtCalls)).toBe(0);
    // 但形态照常切换：悬浮终态几何正确
    const box = (await panel.boundingBox())!;
    expect(Math.abs(box.x + box.width - (vw - 24))).toBeLessThan(4);
  });

  test('停靠态单击顶部空白区不脱离（仅真实拖动才变悬浮）', async ({ page }) => {
    // 回归：onHeaderDragStart 原在 pointerdown 立即切 dock→float，单击（无位移）也误触脱离。
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/floating-chat-panel--dock-kb/);

    // 单击标签栏空白区（down+up 无位移）→ 保持停靠，不变悬浮
    const tb = (await page.locator('[data-testid="kb-chat-session-tabbar"]').boundingBox())!;
    await page.mouse.click(tb.x + tb.width - 120, tb.y + 16);
    await page.waitForTimeout(200);
    await expect(panel).toHaveClass(/floating-chat-panel--dock-kb/);
  });

  test('窄视口拖宽不过 90vw：右缘钉死、不偏出屏（JS clamp 与 CSS max-width 一致）', async ({ page }) => {
    // 回归：JS clamp 上限 720 与 CSS max-width:min(90vw,720) 在窄窗口（<800px）下不一致，
    // inline width 超过渲染上限 → left 按 inline 算 → 右缘漂移、面板偏出屏（释放后跳回）。
    await page.setViewportSize({ width: 700, height: 800 });
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="kb-chat-dock-toggle"]').click();
    await page.waitForTimeout(300);

    const handle = page.locator('[data-testid="kb-chat-resize-handle"]');
    const hb = (await handle.boundingBox())!;
    const sx = hb.x + 4, sy = hb.y + 200;
    const pinnedRight = 700 - 24; // 浮态右缘距视口 24
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    // 拖到远超 CSS max-width（700px 视口 → min(90vw,720)=630）→ 右缘必须始终钉死
    for (const dx of [-60, -120, -180, -240, -300, -360]) {
      await page.mouse.move(sx + dx, sy);
      const r = (await panel.boundingBox())!;
      expect(Math.abs(r.x + r.width - pinnedRight)).toBeLessThan(2);
    }
    await page.mouse.up();
    // 释放后仍在视口内（不出屏偏左），右缘依旧钉死
    const end = (await panel.boundingBox())!;
    expect(end.x).toBeGreaterThanOrEqual(0);
    expect(Math.abs(end.x + end.width - pinnedRight)).toBeLessThan(2);
  });

  test('停靠态拖宽到最大后释放保持，不回退到拖前宽度', async ({ page }) => {
    // 回归：拖宽提交依赖 el.style.width，真实环境下它可能在释放前被清空/覆盖，
    // 回退到旧 panelWidth。现从 dragWidthRef 提交（真值源），拖到最大松开必须保持。
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(300);
    const before = (await panel.boundingBox())!.width;

    const handle = page.locator('[data-testid="kb-chat-resize-handle"]');
    const hb = (await handle.boundingBox())!;
    const sx = hb.x + 4, sy = hb.y + 300;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    // 拖到远超最大宽度（1280 视口 max=720）
    await page.mouse.move(sx - 400, sy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const after = (await panel.boundingBox())!.width;
    // 保持最大宽度（720），不回退到拖前宽度
    expect(after).toBeGreaterThan(before + 100);
    expect(after).toBeGreaterThanOrEqual(700);
  });

  test('悬浮已移动后面板拖宽到最大释放：位置保持，不跳到最右侧', async ({ page }) => {
    // 回归：释放时 el.style.left 被清空会把已移动的悬浮面板甩到 CSS 默认 right:24px
    // （最右侧）再等重渲染跳回。修复后保持拖拽左缘、同步 floatPos，位置不跳变。
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="kb-chat-dock-toggle"]').click();
    await page.waitForTimeout(300);

    // 先 header 拖动把面板移到自定义位置（floatPos 生效）
    const tb = (await page.locator('[data-testid="kb-chat-session-tabbar"]').boundingBox())!;
    await page.mouse.move(tb.x + tb.width - 120, tb.y + 16);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width - 270, tb.y + 16, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const moved = (await panel.boundingBox())!;
    const movedRight = moved.x + moved.width;

    // 拖宽到最大（右缘应钉在移动后位置）
    const handle = page.locator('[data-testid="kb-chat-resize-handle"]');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + 4, hb.y + 300);
    await page.mouse.down();
    await page.mouse.move(hb.x - 400, hb.y + 300, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const after = (await panel.boundingBox())!;
    expect(after.width).toBeGreaterThan(moved.width + 100); // 拖宽生效
    expect(Math.abs(after.x + after.width - movedRight)).toBeLessThan(4); // 右缘不跳到最右侧
  });

  test('悬浮形态可拖拽移动位置，重载后位置保留', async ({ page }) => {
    // KB 页默认停靠 → 经 💬问答 打开后切悬浮，验证移动与位置持久化。
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    await page.locator('[data-testid="kb-chat-dock-toggle"]').click();
    await page.waitForTimeout(500); // 等形变收尾：形变期间表面是快照、摸不到
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

    // 重载 → 位置保留（localStorage 持久化；knowledge 形态已是悬浮，重开即浮态）
    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    const persisted = (await panel.boundingBox())!;
    expect(Math.abs(persisted.x - after.x)).toBeLessThan(5);
    expect(Math.abs(persisted.y - after.y)).toBeLessThan(5);
  });

  test('拖拽互切：悬浮拖到右缘 → 停靠；停靠后向左拖 → 恢复悬浮', async ({ page }) => {
    // KB 页默认停靠 → 切悬浮 → 拖右缘停靠（页内分栏）→ 再拖回悬浮。
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);
    await page.locator('[data-testid="kb-chat-dock-toggle"]').click();
    await page.waitForTimeout(500); // 等形变收尾：形变期间表面是快照、摸不到
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

  test('恢复持久化悬浮位置时按当前视口 clamp：窗口变小后切悬浮不得落到视口外', async ({ page }) => {
    // 用户 2026-10-09 真实踩坑：在大视口下保存的 floatPos（left:1611）+ 宽 720，
    // 窗口变小后停靠→悬浮，面板被渲染到视口外（x:1611 > vw）→「侧边栏消失，悬浮不见」。
    // 宽/高恢复各有 CSS max 兜底，唯独 left/top 裸用——恢复时必须按视口 clamp。
    await mockChatRun(page);
    await page.addInitScript(() => {
      localStorage.setItem('molio.kb.chatFloatPos', JSON.stringify({ left: 1611, top: 158 }));
      localStorage.setItem('molio.kb.chatPanelWidth', '720');
      localStorage.setItem('molio.kb.chatPanelHeight', '772');
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 默认停靠：打开即侧边栏（可正常看到）
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await page.waitForTimeout(250);

    // 切悬浮：面板必须落在当前视口内——至少留 80px 横向 / 48px 纵向可见条带
    //（与拖拽 clampMoveX/clampMoveY 的语义一致，不要求完整可见，但必须摸得到、拖得回）
    await page.locator('[data-testid="kb-chat-dock-toggle"]').click();
    await page.waitForTimeout(300);
    const { width: vw, height: vh } = page.viewportSize()!;
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeLessThanOrEqual(vw - 80);
    expect(box.x + box.width).toBeGreaterThanOrEqual(80);
    expect(box.y).toBeLessThanOrEqual(vh - 48);
    expect(box.y + box.height).toBeGreaterThanOrEqual(48);
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

  test('双击标签标题重命名：Enter 提交生效', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();

    const title = page.locator('[data-testid="kb-chat-session-tab"] .chat-session-tab-title');
    await title.dblclick();
    const rename = page.locator('[data-testid="kb-chat-session-rename-input"]');
    await expect(rename).toBeVisible();
    await rename.fill('我的会话');
    await rename.press('Enter');

    await expect(title).toHaveText('我的会话');
  });

  test('重命名的标题跨 reload 保留（不被历史加载覆盖）', async ({ page }) => {
    await mockChatRun(page, {
      persistedMessages: [{ id: 'm1', role: 'user', content: '原始问题', timestamp: 1 }],
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();

    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('关于 doc.md 的问题');
    await page.locator('[data-testid="composer-send"]').click();
    const title = page.locator('[data-testid="kb-chat-session-tab"] .chat-session-tab-title');
    await expect(title).toHaveText('关于 doc.md 的问题');

    await title.dblclick();
    await page.locator('[data-testid="kb-chat-session-rename-input"]').fill('我的会话');
    await page.locator('[data-testid="kb-chat-session-rename-input"]').press('Enter');
    await expect(title).toHaveText('我的会话');

    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    // 等历史加载完成（持久化 user 消息出现）再断言，避免异步覆盖造成误判
    await expect(page.locator('[data-testid="kb-chat-panel"] .file-chat-messages')).toContainText('原始问题');
    await expect(title).toHaveText('我的会话');
  });

  test('切到别的页面后，面板里正在跑的会话继续收到事件', async ({ page }) => {
    // 后台标签保活护栏（L2a 第 3 步）：状态生命周期必须与面板 DOM 解耦。
    // frameDelay 拉长流式，保证 SPA 导航发生在 run 结束之前。
    await mockChatRun(page, { frameDelay: 400 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();

    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await panel.locator('[data-testid="composer-input"]').fill('保活测试');
    await page.locator('[data-testid="composer-send"]').click();

    const assistant = panel.locator('[data-testid="assistant-message"]').last();
    // 等到首个 delta 落地再取快照 —— 后面才能断言内容真的继续推进（不是一开始就是终态）
    await expect(assistant).toContainText('Hello,', { timeout: 5_000 });
    const textBefore = await assistant.innerText();

    // SPA 导航走开（面板常驻渲染）：不能用整页 goto —— 那本来就会重建一切，测不出保活。
    await clickNav(page, 'history');
    await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });
    await expect(panel).toBeAttached();

    // 面板里正在跑的会话内容继续推进 → 订阅没断（run 未被卸载的 DOM 带走）
    await expect(panel.locator('[data-testid="assistant-message"]').last())
      .not.toHaveText(textBefore, { timeout: 10_000 });
  });

  test('历史加载失败：关闭标签并弹出提示（load-error toast）', async ({ page }) => {
    // 回归：controller 上移到 App 层 Provider 后，「历史加载失败」的用户反馈不能丢 ——
    // Provider 无 DOM，提示经 context（loadError）交给面板渲染。
    await mockChatRun(page);
    // 覆盖 mock 的默认「200 空历史」：让该会话的历史加载失败（会话已不存在 / 404）。
    // 后注册的同 URL 路由优先。
    await page.route('**/api/conversations/test-conv-1/messages', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }));

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await panel.locator('[data-testid="composer-input"]').fill('触发历史加载失败');
    await page.locator('[data-testid="composer-send"]').click();
    // 发送后标签带上后端返回的 conversationId（test-conv-1），标签持久化到 localStorage
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);

    // 重载：会话从 localStorage 恢复，controller 挂载即按其 conversationId 从 DB 加载历史 → 404
    await page.reload();

    // ① 标签被关闭；② 用户可见提示出现（面板 DOM 常驻，收起态也渲染该元素）
    await expect(page.locator('[data-testid="kb-notice"]'))
      .toHaveText('该会话已不存在或无法加载，已关闭标签', { timeout: 10_000 });
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(0);
  });

  test('KB 页经 💬问答 打开默认停靠（页内分栏）', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/floating-chat-panel--dock-kb/);
    await expect(page.locator('[data-testid="kb-chat-dock-toggle"]')).toHaveAttribute('aria-pressed', 'true');
  });

  // ── 悬浮按钮：品牌标 + 拖拽定位（磁吸/藏边）──────────────────────────

  test('悬浮按钮：图标为品牌标（尺寸被按钮容纳）', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();
    await expect(btn.locator('img.floating-chat-btn__logo')).toHaveCount(1);
    // logo 尺寸必须被按钮容纳（120% 裁切）：img 是替换元素，若用 inset 撑尺寸
    // 会取固有尺寸 965px 铺满整页（实测踩过）——这条断言守死；
    // 按钮本体必须 overflow:hidden，否则 img 圆溢出、可见尺寸偏大
    expect(await btn.evaluate((el) => getComputedStyle(el as HTMLElement).overflow)).toBe('hidden');
    const logoBox = (await btn.locator('img.floating-chat-btn__logo').boundingBox())!;
    expect(logoBox.width).toBeLessThan(80);
    expect(logoBox.height).toBeLessThan(80);
    const btnBox = (await btn.boundingBox())!;
    expect(Math.abs(logoBox.x + logoBox.width / 2 - (btnBox.x + btnBox.width / 2))).toBeLessThan(2);
    expect(Math.abs(logoBox.y + logoBox.height / 2 - (btnBox.y + btnBox.height / 2))).toBeLessThan(2);
  });

  test('悬浮按钮：中间松手 = 自由位持久化', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();

    const bb = (await btn.boundingBox())!;
    await page.mouse.move(bb.x + 26, bb.y + 26);
    await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    let box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - 374)).toBeLessThan(4); // 中心跟到 (400,300)
    expect(Math.abs(box.y - 274)).toBeLessThan(4);

    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(btn).toBeVisible();
    box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - 374)).toBeLessThan(4);
    expect(Math.abs(box.y - 274)).toBeLessThan(4);
  });

  test('悬浮按钮：拖近右缘实时磁吸 → 松手吸进缘里隐藏 → 点签唤回 → 重载保持', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(btn).toBeVisible();
    const vw = page.viewportSize()!.width;

    // 抓住中心拖向右缘：进入吸附区（中心距缘 <48px）→ 磁吸到距缘 10px + 压扁预告
    const bb = (await btn.boundingBox())!;
    await page.mouse.move(bb.x + 26, bb.y + 26);
    await page.mouse.down();
    await page.mouse.move(vw - 30, 300, { steps: 8 });
    await expect(btn).toHaveClass(/floating-chat-btn--swallow-right/);
    // 吸附预告的三件套里，箭头必须有（指向缘的雪佛龙，::before content 已设）
    const hint = await btn.evaluate((el) => getComputedStyle(el as HTMLElement, '::before').content);
    expect(hint).not.toBe('none');
    let box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - (vw - 32))).toBeLessThan(3); // 磁吸：半嵌入——可见 32px（嵌入 20px）

    // 吸附状态下松手 → 自动吸进缘里隐藏（只露 12px 小签）
    await page.mouse.up();
    await page.waitForTimeout(450);
    await expect(btn).toHaveClass(/floating-chat-btn--hidden/);
    await page.mouse.move(600, 400); // 移开指针：小签 :hover 探出是交互态，量静息几何
    await page.waitForTimeout(250);
    box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - (vw - 12))).toBeLessThan(2);

    // 点可见的小签 → 唤回贴缘可见位（不开面板）
    await btn.click({ position: { x: 4, y: 26 } });
    await page.waitForTimeout(400);
    await expect(btn).not.toHaveClass(/floating-chat-btn--hidden/);
    box = (await btn.boundingBox())!;
    expect(Math.abs(box.x + box.width - vw)).toBeLessThan(3);
    await expect(panel).toHaveClass(/--closed/);

    // 唤回后再点按钮 → 开面板（交互各管各的事）
    await btn.click();
    await page.waitForTimeout(400);
    await expect(panel).not.toHaveClass(/--closed/);
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(panel).toHaveClass(/--closed/);

    // 再藏 → 重载保持隐藏（用户显式选择被尊重）
    const bb2 = (await btn.boundingBox())!;
    await page.mouse.move(bb2.x + 26, bb2.y + 26);
    await page.mouse.down();
    await page.mouse.move(vw - 30, 300, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(450);
    await expect(btn).toHaveClass(/floating-chat-btn--hidden/);
    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toHaveClass(/floating-chat-btn--hidden/);
  });

  test('悬浮按钮：四缘之顶缘同样吸附隐藏（不只左右）', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();

    // 拖向上缘：进入吸附区 → 压扁预告（--swallow-top）；松手 → 藏进顶缘
    const bb = (await btn.boundingBox())!;
    await page.mouse.move(bb.x + 26, bb.y + 26);
    await page.mouse.down();
    await page.mouse.move(640, 8, { steps: 10 });
    await expect(btn).toHaveClass(/floating-chat-btn--swallow-top/);
    await page.mouse.up();
    await page.waitForTimeout(450);
    await expect(btn).toHaveClass(/floating-chat-btn--hidden/);
    await expect(btn).toHaveClass(/floating-chat-btn--edge-top/);
    await page.mouse.move(600, 400);
    await page.waitForTimeout(250);
    const box = (await btn.boundingBox())!;
    expect(Math.abs(box.y + 40)).toBeLessThan(2); // 顶缘小签：元素 top=-40，只露 12px
  });

  test('悬浮按钮：持久化位置在视口外时恢复按视口 clamp', async ({ page }) => {
    // 种一个「视口左侧外」的位置：clamp 后应落在左缘 8px 处，且纵向 158 原样保留。
    // 断言有判别力：无 clamp 的实现按钮停在默认右下角（x≈1204, y≈644），两条都会炸。
    await page.addInitScript(() => {
      localStorage.setItem('molio.kb.chatBtnPos', JSON.stringify({ edge: null, x: -500, y: 158, hidden: false }));
    });
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();
    const box = (await btn.boundingBox())!;
    expect(box.x).toBeLessThan(100);
    expect(Math.abs(box.y - 158)).toBeLessThan(3);
  });

  test('悬浮面板：窗口缩小时收进视口（留可抓条带）；还原窗口原位恢复', async ({ page }) => {
    // 用户显式把 history 页记成悬浮（偏好被尊重）+ 右侧自由位。缩窗后面板必须
    // 收进视口——面板 clamp 语义是「至少留 80px 横向 / 48px 纵向可抓条带」
    // （摸得到就拖得回），不是按钮那种整圆进视口。旧实现只在任意重渲染时
    // clamp，resize 不触发渲染 → 面板整个悬在视口外。
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('molio.kb.chatDockModeByPage', JSON.stringify({ history: 'float' }));
      localStorage.setItem('molio.kb.chatFloatPos', JSON.stringify({ left: 820, top: 60 }));
    });
    await mockChatRun(page);
    await page.goto('http://localhost:5173/history');
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await page.locator('[data-testid="floating-chat-btn"]').click();
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveClass(/--dock/);
    // 开合动画（200ms，从 translateY(16px) 升起）落定后再量几何——否则量到行程中点
    await expect.poll(async () => (await panel.boundingBox())!.y, { timeout: 5_000 })
      .toBeLessThan(63);
    let box = (await panel.boundingBox())!;
    expect(Math.abs(box.x - 820)).toBeLessThan(3);
    expect(Math.abs(box.y - 60)).toBeLessThan(3);

    await page.setViewportSize({ width: 800, height: 600 });
    // left clamp 到 vw-80=720（留 80px 条带）；top 60 < vh-48 仍在界内不动
    await expect.poll(async () => (await panel.boundingBox())!.x, { timeout: 5_000 })
      .toBeLessThan(730);
    box = (await panel.boundingBox())!;
    expect(Math.abs(box.x - (800 - 80))).toBeLessThan(3);
    expect(Math.abs(box.y - 60)).toBeLessThan(3);
    expect(box.x).toBeGreaterThanOrEqual(0);

    // 持久化不被 resize 改写：还原窗口 → 原位恢复
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(async () => (await panel.boundingBox())!.x, { timeout: 5_000 })
      .toBeGreaterThan(810);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('molio.kb.chatFloatPos')!));
    expect(stored.left).toBe(820);
    expect(stored.top).toBe(60);
  });

  test('悬浮按钮：窗口缩小时自由位收进视口；还原窗口原位恢复', async ({ page }) => {
    // 1400×900 下种右下角自由位 → 缩到 800×600：按钮必须整体收进视口
    // （旧实现没有 resize 处理，按钮悬在旧坐标 → 一部分/全部在可视区外）。
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('molio.kb.chatBtnPos', JSON.stringify({ edge: null, x: 1330, y: 836, hidden: false }));
    });
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();
    let box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - 1330)).toBeLessThan(3);
    expect(Math.abs(box.y - 836)).toBeLessThan(3);

    await page.setViewportSize({ width: 800, height: 600 });
    // clamp 到「缘内 8px」：x=740、y=540，且整圆在视口内
    await expect.poll(async () => (await btn.boundingBox())!.x, { timeout: 5_000 })
      .toBeLessThan(760);
    box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - (800 - 52 - 8))).toBeLessThan(3);
    expect(Math.abs(box.y - (600 - 52 - 8))).toBeLessThan(3);
    expect(box.x + box.width).toBeLessThanOrEqual(800);
    expect(box.y + box.height).toBeLessThanOrEqual(600);

    // 持久化不被 resize 改写：还原窗口 → 原位恢复（所选坐标是用户的，resize 只临时收拢）
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(async () => (await btn.boundingBox())!.x, { timeout: 5_000 })
      .toBeGreaterThan(1300);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('molio.kb.chatBtnPos')!));
    expect(stored.x).toBe(1330);
    expect(stored.y).toBe(836);
  });

  test('悬浮按钮：藏边小签随窗口缩放贴住新缘（不消失在旧坐标）', async ({ page }) => {
    // 右缘小签的 x 由渲染期推导：缩窗后必须贴住**新**右缘——旧实现停在旧坐标，
    // 小签整个消失在视口外、点不回来（比自由位更糟）。
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('molio.kb.chatBtnPos', JSON.stringify({ edge: 'right', x: null, y: 836, hidden: true }));
    });
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toHaveClass(/floating-chat-btn--hidden/);
    await page.mouse.move(10, 10); // 移开指针：小签 :hover 是交互态，量静息几何
    await page.waitForTimeout(250);
    let box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - (1400 - 12))).toBeLessThan(2);
    expect(Math.abs(box.y - 836)).toBeLessThan(3);

    await page.setViewportSize({ width: 800, height: 600 });
    // 小签贴住新右缘（x=788），平行轴 y clamp 到 540——整签仍可见可点
    await expect.poll(async () => (await btn.boundingBox())!.x, { timeout: 5_000 })
      .toBeLessThan(795);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(250);
    box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - (800 - 12))).toBeLessThan(2);
    expect(Math.abs(box.y - (600 - 52 - 8))).toBeLessThan(3);

    // 缩窗后小签仍可点回（不可达是这条 bug 最糟的后果）
    await btn.click({ position: { x: 4, y: 26 } });
    await page.waitForTimeout(400);
    await expect(btn).not.toHaveClass(/floating-chat-btn--hidden/);
    box = (await btn.boundingBox())!;
    expect(Math.abs(box.x + box.width - 800)).toBeLessThan(3);
  });

  // ── 悬浮按钮：右键菜单（会话切换 / 新建 / 隐藏唤回 / 恢复默认位）────────

  test('悬浮按钮：右键菜单固定动作——构建Wiki / 打开会话 / 位置管理', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();

    // 冷启动（无持久化位置）：构建Wiki + 打开会话 + 隐藏按钮；无「恢复默认位置」可恢复
    await btn.click({ button: 'right' });
    await expect(page.locator('[data-testid="kb-chat-menu-build"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-chat-menu-open"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-chat-menu-hide-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-chat-menu-reset"]')).toHaveCount(0);

    // 「打开会话」只展开面板，不创建任何会话标签
    await page.locator('[data-testid="kb-chat-menu-open"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(0);
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(btn).toBeVisible();
  });

  test('悬浮按钮：菜单「构建Wiki」与 KB 固定按钮同源——复用同一标签', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    const tabs = page.locator('[data-testid="kb-chat-session-tab"]');

    // 菜单「构建Wiki」→ 建 build 标签（规范标题）+ 展开面板 + 自动发送
    await btn.click({ button: 'right' });
    await page.locator('[data-testid="kb-chat-menu-build"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible();
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toContainText('构建Wiki');

    // KB 页固定按钮再点 → 同一条 runWikiOp 路径：复用同一标签，不重复建
    await page.locator('[data-testid="kb-btn-build-wiki"]').click();
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toContainText('构建Wiki');
  });

  test('悬浮按钮：构建在跑时菜单「构建Wiki」→ 三选一（与 KB 按钮同一互斥）', async ({ page }) => {
    // frameDelay 400ms × 5 帧：第一个构建保持 running，第二次触发才能命中三选一
    await mockChatRun(page, { frameDelay: 400 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    const tabs = page.locator('[data-testid="kb-chat-session-tab"]');

    // 菜单发起构建 → 面板展开、构建在跑 → 收起面板（后台继续），按钮复现
    await btn.click({ button: 'right' });
    await page.locator('[data-testid="kb-chat-menu-build"]').click();
    await expect(panel).toBeVisible();
    await expect(tabs).toHaveCount(1);
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(btn).toBeVisible();

    // 构建在跑再走菜单「构建Wiki」→ runWikiOp 命中互斥 → 三选一弹窗（面板已随之展开）
    await btn.click({ button: 'right' });
    await page.locator('[data-testid="kb-chat-menu-build"]').click();
    const dialog = page.locator('[data-testid="confirm-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();

    // KB 固定按钮走同一互斥：同样弹三选一（一条代码路径，两处入口行为一致）
    await page.locator('[data-testid="kb-btn-build-wiki"]').click();
    await expect(page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
  });

  test('旧版提示词片段标题迁移为规范 wiki 标签标题', async ({ page }) => {
    // 旧版「标题取首条消息」曾把 wiki 自动提示词截成标题并经 localStorage 残留
    // （2026-10-13 用户右键菜单实测）。迁移只动「用 wiki-」开头的非 qa 标题，
    // 用户重命名过的（如「我的构建」）保持原样。
    await page.addInitScript(() => {
      localStorage.setItem('molio.kb.chatSessions', JSON.stringify([
        { id: 'chat:mig1', title: '用 wiki-build skill 开始构建', conversationId: null, mode: 'build', vaultId: null, filePath: null },
        { id: 'chat:mig2', title: '我的构建', conversationId: null, mode: 'build', vaultId: null, filePath: null },
      ]));
      localStorage.setItem('molio.kb.chatActiveSessionId', 'chat:mig1');
    });
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();

    // 标签栏里迁移生效（标签与右键菜单同源）
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2);
    const tabs = page.locator('[data-testid="kb-chat-session-tab"]');
    await expect(tabs.filter({ hasText: '构建Wiki' })).toHaveCount(1);
    await expect(tabs.filter({ hasText: '我的构建' })).toHaveCount(1);
    await expect(tabs.filter({ hasText: '用 wiki-build' })).toHaveCount(0);
    // 迁移回写 storage：重载后仍是规范标题（脏数据已清）
    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="kb-chat-session-tab"]').filter({ hasText: '构建Wiki' })).toHaveCount(1);
  });

  test('悬浮按钮：右键「隐藏按钮」吸进最近缘；小签右键「唤回按钮」', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();

    // 默认右下角 → 最近的缘是右缘：隐藏后是 --edge-right --hidden
    await btn.click({ button: 'right' });
    await page.locator('[data-testid="kb-chat-menu-hide-toggle"]').click();
    await expect(btn).toHaveClass(/floating-chat-btn--hidden/);
    await expect(btn).toHaveClass(/floating-chat-btn--edge-right/);

    // 隐藏态右键小签：同一路菜单，条目变「唤回」→ 点后取消隐藏
    await btn.click({ button: 'right' });
    const toggle = page.locator('[data-testid="kb-chat-menu-hide-toggle"]');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(btn).not.toHaveClass(/floating-chat-btn--hidden/);
    await expect(btn).toHaveClass(/floating-chat-btn--edge-right/); // 唤回 = 贴缘可见位
  });

  test('悬浮按钮：右键「恢复默认位置」清持久化并回默认右下角', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('molio.kb.chatBtnPos', JSON.stringify({ edge: null, x: 100, y: 100, hidden: false }));
    });
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    const btn = page.locator('[data-testid="floating-chat-btn"]');
    await expect(btn).toBeVisible();
    let box = (await btn.boundingBox())!;
    expect(Math.abs(box.x - 100)).toBeLessThan(3);

    await btn.click({ button: 'right' });
    await page.locator('[data-testid="kb-chat-menu-reset"]').click();

    // 持久化被清除（下次冷启动也是默认位）；按钮回 CSS 默认右下角（right/bottom 24px）
    const stored = await page.evaluate(() => localStorage.getItem('molio.kb.chatBtnPos'));
    expect(stored).toBeNull();
    const vw = page.viewportSize()!.width;
    const vh = page.viewportSize()!.height;
    // 默认角 left = vw-76（right:24 + 52px 宽）
    await expect.poll(async () => (await btn.boundingBox())!.x, { timeout: 5_000 })
      .toBeGreaterThan(vw - 80);
    box = (await btn.boundingBox())!;
    expect(Math.abs(box.x + box.width - (vw - 24))).toBeLessThan(3);
    expect(Math.abs(box.y + box.height - (vh - 24))).toBeLessThan(3);
  });
});

/** 经真实问答流建一个会话标签（与 chat-fullscreen.spec 的 seedSession 同法）。 */
async function seedChatSession(page: import('@playwright/test').Page, text: string) {
  await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
  await page.locator('[data-testid="kb-btn-ask"]').click();
  await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]').fill(text);
  await page.locator('[data-testid="composer-send"]').click();
  await expect(
    page.locator('[data-testid="kb-chat-panel"] [data-testid="assistant-message"]').last(),
  ).toBeVisible({ timeout: 10_000 });
}

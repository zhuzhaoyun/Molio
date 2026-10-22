/**
 * @area onboarding
 * @priority P0
 */
import { test, expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTempVault, cleanupTempVault } from './helpers/cleanup';
import { mockAgent, mockChatRun, mockUnavailableAgents } from './helpers/mock-sse';

const DAEMON = `http://localhost:${Number(process.env.MOLIO_E2E_DAEMON_PORT ?? 3100)}`;
const SAMPLE_PATH = join(process.env.MOLIO_E2E_DATA_DIR!, 'sample-vault');

/** Force the "zero vaults" state without depending on other specs' leftovers. */
async function mockZeroVaultsUntilSampleCreated(page: Page) {
  let sampleCreated = false;
  await page.route('**/api/knowledge/vaults', async (route) => {
    if (route.request().method() === 'GET' && !sampleCreated) {
      await route.fulfill({ json: { vaults: [] } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/knowledge/sample-vault', async (route) => {
    sampleCreated = true;
    await route.continue();
  });
}

async function deleteSampleVaultIfAny() {
  const res = await fetch(`${DAEMON}/api/knowledge/vaults`);
  if (res.ok) {
    const body = await res.json() as { vaults: Array<{ id: string; path: string }> };
    for (const vault of body.vaults) {
      if (vault.path === SAMPLE_PATH) {
        await fetch(`${DAEMON}/api/knowledge/vaults/${vault.id}`, { method: 'DELETE' });
      }
    }
  }
  rmSync(SAMPLE_PATH, { recursive: true, force: true });
}

test.afterEach(async () => {
  await deleteSampleVaultIfAny();
});

test('零库首启展示两个对等动作', async ({ page }) => {
  await mockZeroVaultsUntilSampleCreated(page);
  await page.goto('/knowledge');

  await expect(page.locator('[data-testid="kb-empty-sample-vault-cta"]')).toBeVisible();
  await expect(page.locator('[data-testid="kb-empty-create-vault-cta"]')).toBeVisible();

  // 欢迎区必须落在主内容区的水平中线上：它是 flex 列里的一个 max-width 块，
  // 少了 auto 外边距会被钉在左边缘（用户 2026-10-19 验收截图即此）。
  const main = await page.locator('.kb-main').boundingBox();
  const welcome = await page.locator('.kb-empty-state--welcome').boundingBox();
  expect(main).not.toBeNull();
  expect(welcome).not.toBeNull();
  expect(Math.abs((main!.x + main!.width / 2) - (welcome!.x + welcome!.width / 2))).toBeLessThan(2);
});

const ACTIVE_STATE = {
  status: 'active',
  steps: { vault: false, openOrImport: false, import: false, ask: false, save: false },
  mapDismissed: true,
  startedAt: Date.now(),
};

const DONE_STATE = {
  status: 'done',
  steps: { vault: true, openOrImport: true, import: true, ask: true, save: true },
  mapDismissed: false,
  startedAt: Date.now(),
};

async function seedActiveOnboarding(page: Page) {
  // Seed once only. `addInitScript` runs on every navigation: re-writing on the
  // reload below would resurrect a dismissed state and hide a persistence bug.
  await page.addInitScript((state) => {
    if (!localStorage.getItem('molio.onboarding.v1')) {
      localStorage.setItem('molio.onboarding.v1', JSON.stringify(state));
    }
  }, ACTIVE_STATE);
}

test('点示例库 → 入口文档自动打开', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('molio.onboarding.v1'));
  await mockZeroVaultsUntilSampleCreated(page);
  await page.goto('/knowledge');

  await page.locator('[data-testid="kb-empty-sample-vault-cta"]').click();

  await expect(page.locator('.kb-wtab-title').filter({ hasText: '开始使用' })).toBeVisible();
  await expect(page.locator('.kb-workspace-tabs')).toContainText('开始使用');
  // 文件真的从磁盘读出来了（不是空标签）
  await expect(page.locator('body')).toContainText('三个动作，跑通一次闭环');
});

test('全新安装点示例库后 checklist 紧接着出现', async ({ page }) => {
  // 这是最短激活路径：零库首启 → 点「立即试用」→ 入口文档打开。checklist 必须
  // 与文档同一时刻出现，而不是等用户再打开一次文件（首屏的引导价值全在这一步）。
  await page.addInitScript(() => localStorage.removeItem('molio.onboarding.v1'));
  await mockZeroVaultsUntilSampleCreated(page);
  await page.goto('/knowledge');

  await page.locator('[data-testid="kb-empty-sample-vault-cta"]').click();

  await expect(page.locator('.kb-wtab-title').filter({ hasText: '开始使用' })).toBeVisible();
  await expect(page.locator('[data-testid="kb-onboarding"]')).toBeVisible();
  // 建库 + 自动打开入口文档至少完成两步，不可能是 0/5。
  await expect(page.locator('[data-testid="kb-onboarding"]')).toContainText(/[12]\/5/);
  // 下一步必须是可点的主按钮，而不是一段容易被忽略的说明文字。
  const cta = page.locator('[data-testid="kb-onboarding-cta"]');
  await expect(cta).toBeVisible();
  await expect(cta).toHaveRole('button');
});

test('首屏库列表加载失败后建示例库，checklist 仍必须出现', async ({ page }) => {
  // 首屏 GET /vaults 失败时 vaultsLoaded 保持 false，引导状态始终没初始化；
  // 建完示例库后的那次刷新才第一次「成功」，若此时按库数初始化（=1）就会把用户
  // 判成老用户写死 done，checklist 永远不出现。示例库是显式的全新安装路径，
  // 必须在创建时就声明自己处于激活态。
  await page.addInitScript(() => localStorage.removeItem('molio.onboarding.v1'));
  // 失败必须持续到示例库建成为止：只失败第一次的话，StrictMode 的第二次挂载
  // 请求就会拿到真实（0 库）列表把引导初始化掉，复现不了这条路径。
  let sampleCreated = false;
  await page.route('**/api/knowledge/vaults', async (route) => {
    if (route.request().method() === 'GET' && !sampleCreated) {
      await route.fulfill({ status: 500, body: 'daemon warming up' });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/knowledge/sample-vault', async (route) => {
    sampleCreated = true;
    await route.continue();
  });
  await page.goto('/knowledge');

  await page.locator('[data-testid="kb-empty-sample-vault-cta"]').click();

  await expect(page.locator('.kb-wtab-title').filter({ hasText: '开始使用' })).toBeVisible();
  await expect(page.locator('[data-testid="kb-onboarding"]')).toBeVisible();
});

test('checklist 1/5 → 5/5：打开、导入、提问、存回都走通', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-checklist');
  try {
    // 真实库里已有测试 vault，首屏会写 done —— 清掉后让下一次 GET 返回 0 库，
    // 重载一次即可走到「全新安装」分支。
    let serveZero = false;
    await page.route('**/api/knowledge/vaults', async (route) => {
      if (route.request().method() === 'GET' && serveZero) {
        await route.fulfill({ json: { vaults: [] } });
        return;
      }
      await route.continue();
    });
    await mockChatRun(page);
    await page.goto('/knowledge');
    await page.evaluate(() => localStorage.removeItem('molio.onboarding.v1'));
    serveZero = true;
    await page.reload();
    // 必须等激活态真的落盘再切回真实列表：reload 的 load 事件早于 React 挂载后的
    // listVaults 请求，提前放行会让「0 库」那一刻永远不发生，init(1) 直接写 done。
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('molio.onboarding.v1')))
      .toContain('active');
    serveZero = false;

    // 重新加载真实库列表并进入测试库
    await page.goto(`/knowledge?vault=${vault.id}`);
    const checklist = page.locator('[data-testid="kb-onboarding"]');
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText('1/5');

    // 2. 打开一篇笔记
    await page.locator('.kb-tree-item').filter({ hasText: 'test.md' }).first().click();
    await expect(checklist).toContainText('2/5');

    // 3. 导入一份自己的资料：动画必须长在文件面板的真实导入键上，
    //    而不是 checklist 的中转按钮——引导收起后用户日常点的是前者。
    const importBtn = page.locator('[data-testid="kb-btn-import"]');
    await expect(importBtn).toHaveCSS('animation-name', 'kb-guide-pulse');
    // 必须持续循环：只播几次的话，用户晚看几秒就什么都看不到。
    await expect(importBtn).toHaveCSS('animation-iteration-count', 'infinite');
    await importBtn.click();
    const dialog = page.locator('.kb-modal').filter({ has: page.locator('.kb-dropzone') });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'own-material.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 我自己的资料\n\n这是一份用于验收导入步骤的文件。\n'),
    });
    await dialog.locator('[data-testid="kb-import-submit"]').click();
    await expect(checklist).toContainText('3/5');

    // 4. 就这份资料提一个问题：同样指向文档头的真实问答键。
    const askBtn = page.locator('[data-testid="kb-btn-ask"]');
    await expect(askBtn).toHaveCSS('animation-name', 'kb-guide-pulse');
    await expect(askBtn).toHaveCSS('animation-iteration-count', 'infinite');
    await askBtn.click();
    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('这份资料讲了什么？');
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-send"]').click();
    await expect(checklist).toContainText('4/5');

    // 5. 把 AI 的回答存回知识库
    await expect(checklist).toContainText('保存到知识库');
    // 进入保存步时，保存按钮必须**不靠悬停**就能看见并带文字标签：消息工具条
    // 平时 hover 才显形，纯图标在这里没人找得到（用户 2026-10-19 验收反馈）。
    const lastMessage = page.locator('[data-testid="assistant-message"]').last();
    const toolbar = lastMessage.locator('[data-testid="message-toolbar"]');
    await expect(toolbar).toHaveCSS('opacity', '1');
    const saveBtn = lastMessage.locator('[data-testid="msg-save-kb-btn"]');
    await expect(saveBtn).toContainText('保存到知识库');
    // 保存步的真实点击目标是工具条按钮，不是 checklist 的 CTA；呼吸环必须
    // 跟到那里，否则动画指着一个只打开面板的按钮。
    await expect(saveBtn).toHaveCSS('animation-name', 'icon-guide-pulse');
    await saveBtn.click();

    await expect(page.locator('[data-testid="kb-onboarding-done"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-onboarding-done"]')).toContainText('主流程已跑通');
  } finally {
    await cleanupTempVault(vault);
  }
});

test('发送失败不完成提问步：没问成就不该被引导去保存', async ({ page }) => {
  // markAsk 曾在 send 的同步包装里打勾，POST /api/runs 还没发出就先算「提问完成」。
  // 运行时缺失 / daemon 掉线时用户看到的是报错，checklist 却已经跳到保存步，
  // 等于把一次失败的提问当成跑通。
  const vault = await createTempVault('e2e-onboarding-send-fail');
  try {
    // 必须假装「有可用运行时」：没有 agentId 时 createRun 会在发 POST 之前就抛错，
    // 那就测不到「POST 失败」这条路径了（CI runner 上本来就没有装运行时）。
    await mockAgent(page);
    await page.addInitScript(() => {
      localStorage.setItem('molio.onboarding.v1', JSON.stringify({
        status: 'active',
        steps: { vault: true, openOrImport: true, import: true, ask: false, save: false },
        mapDismissed: true,
        startedAt: Date.now(),
      }));
    });
    let runPostSeen = false;
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') {
        runPostSeen = true;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'boom' }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`/knowledge?vault=${vault.id}`);

    await page.locator('.kb-tree-item').filter({ hasText: 'test.md' }).first().click();
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await panel.locator('[data-testid="composer-input"]').fill('这份资料讲了什么？');
    await panel.locator('[data-testid="composer-send"]').click();

    // 守卫：请求必须真的走到了 /api/runs（本地 agentId 缺失会提前抛错，那不算这条路径）
    await expect.poll(() => runPostSeen).toBe(true);
    await expect(page.locator('[data-testid="assistant-error"]')).toBeVisible();

    const checklist = page.locator('[data-testid="kb-onboarding"]');
    await expect(checklist).toContainText('3/5');
    // 保存步的常显提示同样不该被提前触发（按钮本来就在工具条里，看的是引导态）
    await expect(page.locator('[data-testid="msg-save-kb-btn"]').last()).not.toHaveClass(/icon-btn--labeled/);
  } finally {
    await cleanupTempVault(vault);
  }
});

test('完成地图收起后，可从帮助的功能地图重新打开', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-map');
  try {
    await page.addInitScript((state) => {
      if (!localStorage.getItem('molio.onboarding.v1')) {
        localStorage.setItem('molio.onboarding.v1', JSON.stringify(state));
      }
    }, DONE_STATE);
    await page.goto(`/knowledge?vault=${vault.id}`);

    const map = page.locator('[data-testid="kb-onboarding-done"]');
    await expect(map).toBeVisible();
    await page.locator('[data-testid="kb-onboarding-map-dismiss"]').click();
    await expect(map).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('molio.onboarding.v1')))
      .toContain('"mapDismissed":true');

    // 帮助菜单必须是找回引导的入口：收起不等于永久消失。
    await page.locator('[data-testid="nav-help-btn"]').click();
    await expect(page.locator('[data-testid="nav-help-menu"]')).toBeVisible();
    await page.locator('[data-testid="nav-feature-map"]').click();
    await expect(map).toBeVisible();
  } finally {
    await cleanupTempVault(vault);
  }
});

test('已完成引导时点上手引导：重播清单，而不是显示已跑通', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-guide-replay');
  try {
    await page.addInitScript((state) => {
      if (!localStorage.getItem('molio.onboarding.v1')) {
        localStorage.setItem('molio.onboarding.v1', JSON.stringify(state));
      }
    }, DONE_STATE);
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('[data-testid="kb-onboarding-done"]')).toBeVisible();

    await page.locator('[data-testid="nav-help-btn"]').click();
    await page.locator('[data-testid="nav-onboarding-guide"]').click();

    const checklist = page.locator('[data-testid="kb-onboarding"]');
    await expect(checklist).toBeVisible();
    // 库步骤沿用既成事实，从第 2 步开始重走 → 1/5。
    await expect(checklist).toContainText('1/5');
    // 用户报的问题：点「上手引导」却看到「主流程已跑通」。
    await expect(page.locator('[data-testid="kb-onboarding-done"]')).toHaveCount(0);
  } finally {
    await cleanupTempVault(vault);
  }
});

test('没有知识库时从帮助打开引导：等同于首次启动', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('molio.onboarding.v1', JSON.stringify({
      status: 'dismissed',
      steps: { vault: true, openOrImport: true, import: true, ask: true, save: true },
      mapDismissed: true,
      startedAt: 1,
    }));
  });
  await mockZeroVaultsUntilSampleCreated(page);
  await page.goto('/knowledge');
  await expect(page.locator('[data-testid="kb-onboarding"]')).toHaveCount(0);

  await page.locator('[data-testid="nav-help-btn"]').click();
  await page.locator('[data-testid="nav-onboarding-guide"]').click();

  // 首次启动的入口就是零库欢迎页，不是一份已经完成的地图。
  await expect(page.locator('[data-testid="kb-empty-sample-vault-cta"]')).toBeVisible();
  await expect(page.locator('[data-testid="kb-empty-create-vault-cta"]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('molio.onboarding.v1')!)))
    .toMatchObject({
      status: 'active',
      steps: { vault: false, openOrImport: false, import: false, ask: false, save: false },
    });
});

test('已有知识库时打开引导：从当前进度继续，不重置也不建示例库', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-guide-existing');
  try {
    await page.addInitScript(() => {
      localStorage.setItem('molio.onboarding.v1', JSON.stringify({
        status: 'dismissed',
        steps: { vault: false, openOrImport: true, import: true, ask: false, save: false },
        mapDismissed: true,
        startedAt: 1,
      }));
    });
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('[data-testid="kb-onboarding"]')).toHaveCount(0);

    await page.locator('[data-testid="nav-help-btn"]').click();
    await page.locator('[data-testid="nav-onboarding-guide"]').click();

    const checklist = page.locator('[data-testid="kb-onboarding"]');
    await expect(checklist).toBeVisible();
    // 已有库：库步骤直接算完成，另外两个既有进度原样保留 → 3/5，而不是从头开始。
    await expect(checklist).toContainText('3/5');

    // 打开引导不得在后台建示例库（对已有内容零副作用）。
    const res = await fetch(`${DAEMON}/api/knowledge/vaults`);
    const body = await res.json() as { vaults: Array<{ path: string }> };
    expect(body.vaults.some((v) => v.path === SAMPLE_PATH)).toBe(false);
  } finally {
    await cleanupTempVault(vault);
  }
});

test('没有可用运行时时，提问步先引导配置 AI', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-no-runtime');
  try {
    // 已经完成前 3 步（建库/打开/导入），只剩提问：这是第一次需要 AI 的时刻。
    await page.addInitScript((state) => {
      if (!localStorage.getItem('molio.onboarding.v1')) {
        localStorage.setItem('molio.onboarding.v1', JSON.stringify(state));
      }
    }, {
      status: 'active',
      steps: { vault: true, openOrImport: true, import: true, ask: false, save: false },
      mapDismissed: true,
      startedAt: Date.now(),
    });
    // 真机形状：daemon 仍列出所有已知运行时，只是全部 available:false。
    // 用空数组 mock 会掩盖「只判 agents.length === 0」的 bug。
    await mockUnavailableAgents(page);
    await page.goto(`/knowledge?vault=${vault.id}`);

    const cta = page.locator('[data-testid="kb-onboarding-cta"]');
    await expect(cta).toContainText('先配置 AI');
    // 没有运行时是唯一一个「真实目标不在本页」的步骤：此时中转按钮就是
    // 用户真正该点的东西，呼吸环留在它身上（实心底只用扩散环）。
    await expect(cta).toHaveCSS('animation-name', 'kb-guide-pulse-solid');
    await cta.click();
    await expect(page).toHaveURL(/\/settings\?tab=runtimes/);
  } finally {
    await cleanupTempVault(vault);
  }
});

test('步骤圆点只是进度，不是可点击的跳步控件', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-step-affordance');
  try {
    await page.addInitScript((state) => {
      if (!localStorage.getItem('molio.onboarding.v1')) {
        localStorage.setItem('molio.onboarding.v1', JSON.stringify(state));
      }
    }, {
      status: 'active',
      steps: { vault: true, openOrImport: true, import: false, ask: false, save: false },
      mapDismissed: true,
      startedAt: Date.now(),
    });
    await page.goto(`/knowledge?vault=${vault.id}`);

    const checklist = page.locator('[data-testid="kb-onboarding"]');
    await expect(checklist).toContainText('2/5');

    // 圆点是进度标记，不是跳步入口：2026-10-19 验收时点第 4 个圆点，
    // 只会把整条栏的详情展开/收起，看上去像「选了第 4 步却什么也没发生」。
    await checklist.locator('.kb-onboarding__dot').nth(3).click();
    await expect(page.locator('[data-testid="kb-onboarding-details"]')).toHaveCount(0);
    await expect(checklist).toContainText('2/5');

    // 展开后每一步都写明「怎么完成」，当前步有标记，且没有可跳步的控件。
    await page.locator('[data-testid="kb-onboarding-toggle"]').click();
    const details = page.locator('[data-testid="kb-onboarding-details"]');
    await expect(details).toBeVisible();
    await expect(details).toContainText('点「导入资料」，把文件放进当前知识库');
    await expect(details).toContainText('当前');
    await expect(details).toContainText('不需要手动勾选');
    await expect(details.locator('button, a')).toHaveCount(0);
    await expect(checklist).toContainText('2/5');
  } finally {
    await cleanupTempVault(vault);
  }
});

test('关闭 checklist 后刷新不再出现', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-dismiss');
  try {
    await seedActiveOnboarding(page);
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('[data-testid="kb-onboarding"]')).toBeVisible();
    await page.locator('[data-testid="kb-onboarding-dismiss"]').click();
    await expect(page.locator('[data-testid="kb-onboarding"]')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('molio.onboarding.v1')))
      .toContain('dismissed');
    await page.reload();
    // 等库真的加载完再断言：reload 的 load 事件早于 React 挂载，空 DOM 窗口里
    // checklist 本来就不可见，直接 toHaveCount(0) 会对着真空窗假绿。
    await expect(page.locator('.kb-tree-item').first()).toBeVisible();
    await expect(page.locator('[data-testid="kb-onboarding"]')).toHaveCount(0);
  } finally {
    await cleanupTempVault(vault);
  }
});

test('已有库的用户升级后不出现 checklist', async ({ page }) => {
  const vault = await createTempVault('e2e-onboarding-existing');
  try {
    await page.addInitScript(() => localStorage.removeItem('molio.onboarding.v1'));
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-tree-item').first()).toBeVisible();
    await expect(page.locator('[data-testid="kb-onboarding"]')).toHaveCount(0);
    const raw = await page.evaluate(() => localStorage.getItem('molio.onboarding.v1'));
    expect(JSON.parse(raw!).status).toBe('done');
  } finally {
    await cleanupTempVault(vault);
  }
});

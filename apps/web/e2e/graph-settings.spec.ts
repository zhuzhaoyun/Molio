import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clickNav } from './helpers/navigation';

/**
 * @area graph
 * @priority P2
 */

const DAEMON_API = 'http://localhost:3100/api';

/** fetch with a hard timeout so beforeAll never hangs if daemon is unreachable */
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

let testVaultPath: string;
let vaultId: string;
const vaultName = `e2e-graph-${Date.now()}`;

test.beforeAll(async () => {
  // Purge any stale vaults left over from crashed runs
  try {
    const list = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await list.json();
    for (const v of vaults as { id: string; name: string }[]) {
      if (v.name.startsWith('e2e-graph-')) {
        await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  } catch { /* daemon might not be running yet */ }

  // Create a temporary vault directory with a test markdown file
  testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-graph-'));
  writeFileSync(
    join(testVaultPath, 'test-node.md'),
    '# Test Node\n\nContent for graph test.\n\n[[another-node]]\n',
  );
  writeFileSync(
    join(testVaultPath, 'another-node.md'),
    '# Another Node\n\nLinked content.\n',
  );

  // Create the vault via daemon API
  const res = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: vaultName, path: testVaultPath }),
  });
  const vault = await res.json();
  vaultId = vault.id;
});

test.afterAll(async () => {
  if (vaultId) {
    await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
  }
  if (testVaultPath) {
    rmSync(testVaultPath, { recursive: true, force: true });
  }
});

test.describe('Graph Settings Panel', () => {
  test.beforeEach(async ({ page }) => {
    // Set vault in localStorage before the app loads so vaultStore picks it up
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
  });

  test('pixi canvas renders when graph data loads', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Wait for graph data (settings button appears when a vault is active),
    // then the PixiJS engine must attach a canvas to the container.
    await expect(page.locator('.graph-settings-btn')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible({ timeout: 10_000 });
  });

  test('settings button opens and closes panel', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Settings button appears once vault is selected (even before graph data loads)
    const btn = page.locator('.graph-settings-btn');
    await expect(btn).toBeVisible({ timeout: 10_000 });

    // Click to open — panel appears once graph data loads
    await btn.click();
    const panel = page.locator('.graph-settings-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Button should have is-active class when panel is open
    await expect(btn).toHaveClass(/is-active/);

    // Click again to close
    await btn.click();
    await expect(panel).not.toBeVisible({ timeout: 3_000 });
  });

  test('tab switching works', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Open settings (wait for graph data to load so panel appears)
    await page.locator('.graph-settings-btn').click();
    const panel = page.locator('.graph-settings-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Click each tab and verify it becomes active
    for (const tab of ['筛选', '外观', '力度', '图例']) {
      await panel.locator('.graph-settings__tab', { hasText: tab }).click();
      await expect(panel.locator('.graph-settings__tab.is-active')).toHaveText(tab);
    }
  });

  test('force sliders exist and are interactive', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Open settings, switch to forces tab
    await page.locator('.graph-settings-btn').click();
    const panel = page.locator('.graph-settings-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await panel.locator('.graph-settings__tab', { hasText: '力度' }).click();

    // Verify all 4 force sliders exist
    const sliders = panel.locator('.graph-settings__range');
    await expect(sliders).toHaveCount(4);

    // Verify labels
    await expect(panel).toContainText('向心力');
    await expect(panel).toContainText('排斥力');
    await expect(panel).toContainText('连线拉力');
    await expect(panel).toContainText('连线距离');
  });

  test('old info button is removed', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // The old .graph-info-btn should NOT exist
    await expect(page.locator('.graph-info-btn')).not.toBeAttached({ timeout: 3_000 });
  });

  test('settings button follows explicit dark theme on a light OS', async ({ page }) => {
    // Force explicit 深色 before the app loads, so graph chrome must go dark
    // even though Playwright's default OS color scheme is light.
    await page.addInitScript(() => {
      localStorage.setItem('molio.theme', 'dark');
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    const btn = page.locator('.graph-settings-btn');
    await expect(btn).toBeVisible({ timeout: 10_000 });

    // Dark chrome from the [data-theme="dark"] graph rules, not the light default
    const bg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(40, 40, 50, 0.8)');
  });
});

/**
 * Graph interaction tests (search / camera / minimap).
 *
 * 依赖 DEV 调试句柄 `window.__graphEngine`（GraphPage 仅在 import.meta.env.DEV
 * 下挂载）——Playwright webServer 起的是 `pnpm dev`，句柄可用；
 * 若未来 CI 改用 build+preview，需给画布另加可断言的 data 属性。
 */
test.describe('Graph Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
  });

  async function gotoGraphWithEngine(page: import('@playwright/test').Page) {
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });
    // 搜索默认折叠为 🔍 图标——点开展开输入框（引擎就绪 + 数据加载完成）
    await page.locator('[data-testid="graph-search-open"]').click();
    await expect(page.locator('[data-testid="graph-search-input"]')).toBeVisible({ timeout: 15_000 });
    // 等初始布局 + 1.5s refit 定时器窗口过去，避免相机动画干扰断言
    await page.waitForFunction(
      () => (window as unknown as { __graphEngine?: unknown }).__graphEngine != null,
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(1_800);
  }

  test('search locates node: smooth zoom to k=1.5 and selection', async ({ page }) => {
    await gotoGraphWithEngine(page);

    const input = page.locator('[data-testid="graph-search-input"]');
    await input.fill('test');

    // 节点 label = 文件 basename（daemon routes/graph.ts），fixture 为 test-node.md
    const option = page.locator('[data-testid="graph-search-option"]', { hasText: 'test-node' });
    await expect(option).toBeVisible();
    // 选中后下拉会关闭，先取 data-key 供后续断言
    const optionKey = await option.getAttribute('data-key');
    await input.press('Enter');

    // focusNode：600ms 动画结束后 k≈1.5 且节点被选中
    await page.waitForFunction(
      () => {
        const eng = (window as unknown as {
          __graphEngine?: { getSelectedKey(): string | null; getViewport(): { k: number } };
        }).__graphEngine;
        if (!eng) return false;
        const sel = eng.getSelectedKey();
        return !!sel && Math.abs(eng.getViewport().k - 1.5) < 0.05;
      },
      undefined,
      { timeout: 5_000 },
    );

    // 选中的是搜索命中的节点
    const selectedKey = await page.evaluate(() =>
      (window as unknown as { __graphEngine: { getSelectedKey(): string | null } }).__graphEngine.getSelectedKey(),
    );
    expect(selectedKey).toBe(optionKey);
  });

  test('search keyboard navigation selects second result', async ({ page }) => {
    await gotoGraphWithEngine(page);

    const input = page.locator('[data-testid="graph-search-input"]');
    // "node" 命中两个 fixture 节点（label = basename：test-node / another-node）
    await input.fill('node');

    const options = page.locator('[data-testid="graph-search-option"]');
    await expect(options).toHaveCount(2);
    const secondKey = await options.nth(1).getAttribute('data-key');

    await input.press('ArrowDown');
    await input.press('Enter');

    await page.waitForFunction(
      (key) =>
        (window as unknown as { __graphEngine?: { getSelectedKey(): string | null } })
          .__graphEngine?.getSelectedKey() === key,
      secondKey,
      { timeout: 5_000 },
    );
  });

  test('search shows empty state for no match', async ({ page }) => {
    await gotoGraphWithEngine(page);

    const input = page.locator('[data-testid="graph-search-input"]');
    await input.fill('zzz-no-such-node');
    await expect(page.locator('[data-testid="graph-search-empty"]')).toBeVisible();
  });

  test('minimap drag recenters main viewport', async ({ page }) => {
    await gotoGraphWithEngine(page);

    // 拖拽前视口中心（graph 坐标）
    const before = await page.evaluate(() => {
      const eng = (window as unknown as {
        __graphEngine: { getSnapshot(): { view: { x: number; y: number; w: number; h: number } } | null };
      }).__graphEngine;
      const view = eng.getSnapshot()?.view;
      return view ? { cx: view.x + view.w / 2, cy: view.y + view.h / 2 } : null;
    });
    expect(before).not.toBeNull();

    // 在 minimap 视口矩形内按下并拖拽（对任意图形几何都成立，静态点击在 2 节点 fixture 下可能落在矩形内不触发跳转）
    const mm = await page.locator('[data-testid="graph-minimap"]').boundingBox();
    expect(mm).not.toBeNull();
    await page.mouse.move(mm!.x + mm!.width / 2, mm!.y + mm!.height / 2);
    await page.mouse.down();
    await page.mouse.move(mm!.x + 20, mm!.y + 20, { steps: 5 });
    await page.mouse.up();

    // 拖拽后视口中心应明显移动
    await page.waitForFunction(
      (prev) => {
        const eng = (window as unknown as {
          __graphEngine?: { getSnapshot(): { view: { x: number; y: number; w: number; h: number } } | null };
        }).__graphEngine;
        const view = eng?.getSnapshot()?.view;
        if (!view || !prev) return false;
        const cx = view.x + view.w / 2;
        const cy = view.y + view.h / 2;
        return Math.hypot(cx - prev.cx, cy - prev.cy) > 5;
      },
      before,
      { timeout: 5_000 },
    );
  });
});

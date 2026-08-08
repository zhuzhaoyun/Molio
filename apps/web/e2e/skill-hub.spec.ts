import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area settings
 * @priority P1
 *
 * E2E tests for the skill store (Settings → 技能 tab → 技能商店 segment).
 *
 * Hermetic by design: ALL daemon hub endpoints (`/api/skills/hub/**`) are
 * mocked with page.route, so these tests never touch the real skillhub.cn
 * API — the live download/import chain is covered by the daemon unit + route
 * tests (apps/daemon/test/core/skills/hub.test.ts, test/routes/skills-hub.test.ts)
 * instead, because external network is too flaky for E2E.
 */

interface MockSkill {
  slug: string;
  name: string;
  description: string;
  version: string;
  downloads: number;
  ownerName: string;
  category: string;
  verified: boolean;
  requiresApiKey: boolean;
  updatedAt: number;
  installed: boolean;
  installedVersion?: string;
}

const MOCK_SKILLS: MockSkill[] = [
  {
    slug: 'pdf-tools',
    name: 'PDF Tools',
    description: '拆分、合并、转换 PDF 文件',
    version: '1.2.0',
    downloads: 123456,
    ownerName: 'acme',
    category: 'productivity',
    verified: true,
    requiresApiKey: false,
    updatedAt: 1754500000000,
    installed: false,
  },
  {
    slug: 'code-reviewer',
    name: 'Code Reviewer',
    description: 'Automated code review suggestions',
    version: '0.9.1',
    downloads: 2249,
    ownerName: 'bob',
    category: 'dev',
    verified: false,
    requiresApiKey: true,
    updatedAt: 1754400000000,
    installed: false,
  },
];

const MOCK_CATEGORIES = [
  { key: 'productivity', name: '效率工具' },
  { key: 'dev', name: '开发' },
];

interface HubMockState {
  /** When true the list endpoint answers 502 (hub unreachable). */
  failList: boolean;
  /** Artificial install latency so the busy button state is observable. */
  installDelayMs: number;
  /** Captured POST /hub/install bodies. */
  installRequests: Array<Record<string, unknown>>;
}

/**
 * Register the hub endpoint mocks. Must run BEFORE the store view is opened
 * (the list + categories requests fire on panel mount).
 */
async function setupHubMocks(page: import('@playwright/test').Page, state: HubMockState) {
  await page.route('**/api/skills/hub/skills*', (route) => {
    if (state.failList) {
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'HUB_UNAVAILABLE', message: 'E2E模拟SkillHub不可达' } }),
      });
    }
    const url = new URL(route.request().url());
    const keyword = url.searchParams.get('keyword') ?? '';
    const category = url.searchParams.get('category') ?? '';
    let skills = MOCK_SKILLS;
    if (category) skills = skills.filter((s) => s.category === category);
    if (keyword) {
      const kw = keyword.toLowerCase();
      skills = skills.filter(
        (s) => s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw),
      );
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills, total: skills.length, page: 1, pageSize: 20 }),
    });
  });

  await page.route('**/api/skills/hub/categories', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ categories: MOCK_CATEGORIES }),
    }),
  );

  await page.route('**/api/skills/hub/install', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.installRequests.push(body);
    if (state.installDelayMs > 0) {
      await new Promise((r) => setTimeout(r, state.installDelayMs));
    }
    const src = MOCK_SKILLS.find((s) => s.slug === body.slug);
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        skill: {
          id: `mock-${String(body.slug)}`,
          name: src?.name ?? String(body.slug),
          description: src?.description ?? '',
          enabled: true,
          builtIn: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        updated: false,
        version: src?.version ?? '1.0.0',
      }),
    });
  });
}

async function gotoSkillsHub(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await clickNav(page, 'settings');
  await page.locator('[data-testid="settings-tab-skills"]').click();
  await expect(page.locator('.sk-shell')).toBeVisible({ timeout: 5_000 });
  await page.locator('[data-testid="skills-view-hub"]').click();
}

test.describe('Skill store (skillhub.cn)', () => {
  test('store view renders catalog cards with meta and category filter', async ({ page }) => {
    const state: HubMockState = { failList: false, installDelayMs: 0, installRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);

    // Both mock cards render with name/author.
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-card-code-reviewer')).toBeVisible();
    await expect(page.getByTestId('hub-card-pdf-tools')).toContainText('PDF Tools');
    await expect(page.getByTestId('hub-card-pdf-tools')).toContainText('acme');

    // Total footer reflects the mock catalog size.
    await expect(page.locator('.hub-footer__total')).toBeVisible();

    // Category dropdown = 全部分类 + the two mocked categories.
    await expect(page.getByTestId('hub-category').locator('option')).toHaveCount(3);

    // The library view button is still there and switches back.
    await expect(page.getByTestId('skills-view-mine')).toBeVisible();
  });

  test('search and category filter re-query the catalog', async ({ page }) => {
    const state: HubMockState = { failList: false, installDelayMs: 0, installRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-card-code-reviewer')).toBeVisible();

    // Keyword filters server-side (the mock echoes it back filtered).
    await page.getByTestId('hub-search').fill('pdf');
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible();
    await expect(page.getByTestId('hub-card-code-reviewer')).toHaveCount(0);

    // A keyword that matches nothing shows the empty state.
    await page.getByTestId('hub-search').fill('zzz-不存在');
    await expect(page.locator('.rt-empty')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('hub-search').fill('');

    // Category filter works the same way.
    await page.getByTestId('hub-category').selectOption('dev');
    await expect(page.getByTestId('hub-card-code-reviewer')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-card-pdf-tools')).toHaveCount(0);
  });

  test('install click posts the slug and flips the card to installed', async ({ page }) => {
    // Deliberate latency so the 安装中… busy state is observable.
    const state: HubMockState = { failList: false, installDelayMs: 800, installRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });

    const btn = page.getByTestId('hub-install-pdf-tools');
    const labelBefore = await btn.textContent();
    await btn.click();

    // While the install is in flight the button is disabled (busy state).
    await expect(btn).toBeDisabled();

    // Success banner appears and the button label changes (安装 → 更新),
    // asserting on the CHANGE so the test is locale-independent.
    await expect(page.getByTestId('hub-notice')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.hub-notice--success')).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(btn).not.toHaveText(labelBefore ?? '');

    // The daemon received the right install request.
    expect(state.installRequests).toHaveLength(1);
    expect(state.installRequests[0]).toMatchObject({ slug: 'pdf-tools', version: '1.2.0' });
  });

  test('hub unreachable shows the error banner; retry recovers', async ({ page }) => {
    const state: HubMockState = { failList: true, installDelayMs: 0, installRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);

    // The daemon's 502 message surfaces in the error banner…
    await expect(page.getByTestId('hub-error')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-error')).toContainText('E2E模拟SkillHub不可达');
    await expect(page.getByTestId('hub-grid')).toHaveCount(0);

    // …and retrying once the hub is back re-renders the grid.
    state.failList = false;
    await page.getByTestId('hub-error').locator('button').click();
    await expect(page.getByTestId('hub-grid')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible();
  });
});

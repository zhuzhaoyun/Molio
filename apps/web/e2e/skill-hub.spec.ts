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
  /** Captured GET /hub/skills request URLs (sort param assertions). */
  listRequests: string[];
}

/** Build the detail payload the daemon's GET /hub/skill would return. */
function mockDetailFor(s: MockSkill) {
  return {
    slug: s.slug,
    name: s.name,
    description: s.description,
    category: s.category,
    sourceUrl: `https://skillhub.cn/skills/${s.slug}`,
    iconUrl: '',
    createdAt: s.updatedAt - 86_400_000,
    updatedAt: s.updatedAt,
    verified: s.verified,
    requiresApiKey: s.requiresApiKey,
    ownerName: s.ownerName,
    latestVersion: s.version,
    stats: { downloads: s.downloads, installs: Math.floor(s.downloads / 2), stars: 12, versions: 3 },
    readme: `# ${s.name} 使用说明\n\n这是 ${s.slug} 的 E2E mock readme 正文。`,
    security: { keen: '安全，无风险' },
    installed: s.installed,
  };
}

/**
 * Register the hub endpoint mocks. Must run BEFORE the store view is opened
 * (the list + categories requests fire on panel mount).
 */
async function setupHubMocks(page: import('@playwright/test').Page, state: HubMockState) {
  // Detail endpoint (GET /hub/skill?slug=…). A REGEX route on purpose: the
  // glob '**/api/skills/hub/skill*' would also swallow the LIST endpoint
  // ('/hub/skills…'), and glob '?' is a one-char wildcard, so 'skill?*'
  // can't disambiguate either.
  await page.route(/\/api\/skills\/hub\/skill\?/, (route) => {
    const url = new URL(route.request().url());
    const slug = url.searchParams.get('slug') ?? '';
    const src = MOCK_SKILLS.find((s) => s.slug === slug);
    if (!src) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'E2E模拟详情不存在' } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ detail: mockDetailFor(src) }),
    });
  });

  await page.route('**/api/skills/hub/skills*', (route) => {
    state.listRequests.push(route.request().url());
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
    const state: HubMockState = { failList: false, installDelayMs: 0, installRequests: [], listRequests: [] };
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
    const state: HubMockState = { failList: false, installDelayMs: 0, installRequests: [], listRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-card-code-reviewer')).toBeVisible();

    // Keyword filters server-side (the mock echoes it back filtered).
    await page.getByTestId('hub-search').fill('pdf');
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible();
    await expect(page.getByTestId('hub-card-code-reviewer')).toHaveCount(0);

    // A keyword that matches nothing shows the empty state. Scoped to the hub
    // pane: the library pane stays mounted (keep-alive) and renders its own
    // `.rt-empty` whenever the library is empty — an unscoped match would hit
    // both and trip strict mode.
    await page.getByTestId('hub-search').fill('zzz-不存在');
    await expect(page.getByTestId('skills-pane-hub').locator('.rt-empty')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('hub-search').fill('');

    // Category filter works the same way.
    await page.getByTestId('hub-category').selectOption('dev');
    await expect(page.getByTestId('hub-card-code-reviewer')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-card-pdf-tools')).toHaveCount(0);
  });

  test('install click posts the slug and flips the card to installed', async ({ page }) => {
    // Deliberate latency so the 安装中… busy state is observable.
    const state: HubMockState = { failList: false, installDelayMs: 800, installRequests: [], listRequests: [] };
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

  test('one install at a time: every install button is gated while one is in flight', async ({ page }) => {
    const state: HubMockState = { failList: false, installDelayMs: 800, installRequests: [], listRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('hub-install-pdf-tools').click();

    // While the install is in flight, ALL install buttons are disabled — not
    // just the clicked one (a single indicator slot can't track two installs,
    // and a second install could race the first on the daemon).
    await expect(page.getByTestId('hub-install-pdf-tools')).toBeDisabled();
    await expect(page.getByTestId('hub-install-code-reviewer')).toBeDisabled();

    await expect(page.getByTestId('hub-notice')).toBeVisible({ timeout: 10_000 });

    // Re-enabled afterwards; exactly one install request reached the daemon.
    await expect(page.getByTestId('hub-install-pdf-tools')).toBeEnabled();
    await expect(page.getByTestId('hub-install-code-reviewer')).toBeEnabled();
    expect(state.installRequests).toHaveLength(1);
  });

  test('hub browsing state survives switching to the library tab and back', async ({ page }) => {
    const state: HubMockState = { failList: false, installDelayMs: 0, installRequests: [], listRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });

    // Narrow the catalog down to one card…
    await page.getByTestId('hub-search').fill('pdf');
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible();
    await expect(page.getByTestId('hub-card-code-reviewer')).toHaveCount(0);

    // …flip to the library tab and back. The panel stays mounted, so the
    // keyword and the filtered result survive without a refetch.
    await page.getByTestId('skills-view-mine').click();
    await expect(page.getByTestId('skill-new-btn')).toBeVisible();
    await page.getByTestId('skills-view-hub').click();

    await expect(page.getByTestId('hub-search')).toHaveValue('pdf');
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible();
    await expect(page.getByTestId('hub-card-code-reviewer')).toHaveCount(0);
  });

  test('hub unreachable shows the error banner; retry recovers', async ({ page }) => {
    const state: HubMockState = { failList: true, installDelayMs: 0, installRequests: [], listRequests: [] };
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

  test('sort buttons re-query the catalog with the matching sort param', async ({ page }) => {
    const state: HubMockState = { failList: false, installDelayMs: 0, installRequests: [], listRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });

    // Default ranking is active initially; its request carries no sort param.
    await expect(page.getByTestId('hub-sort-default')).toHaveClass(/sk-seg__item--active/);
    expect(state.listRequests.some((u) => u.includes('sort='))).toBe(false);

    // Downloads sort → the debounced re-query carries sort=downloads.
    await page.getByTestId('hub-sort-downloads').click();
    await expect(page.getByTestId('hub-sort-downloads')).toHaveClass(/sk-seg__item--active/);
    await expect
      .poll(() => state.listRequests.some((u) => u.includes('sort=downloads')), { timeout: 10_000 })
      .toBe(true);

    // Recently updated → sort=updated.
    await page.getByTestId('hub-sort-updated').click();
    await expect
      .poll(() => state.listRequests.some((u) => u.includes('sort=updated')), { timeout: 10_000 })
      .toBe(true);

    // Back to default: the newest request drops the sort param entirely.
    await page.getByTestId('hub-sort-default').click();
    await expect(page.getByTestId('hub-sort-default')).toHaveClass(/sk-seg__item--active/);
    await expect
      .poll(() => {
        const last = state.listRequests[state.listRequests.length - 1];
        return !!last && !last.includes('sort=');
      }, { timeout: 10_000 })
      .toBe(true);
  });

  test('clicking a card opens the detail modal with readme and stats', async ({ page }) => {
    const state: HubMockState = { failList: false, installDelayMs: 0, installRequests: [], listRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('hub-card-pdf-tools').click();

    const overlay = page.getByTestId('hub-detail-overlay');
    await expect(overlay).toBeVisible({ timeout: 10_000 });

    // Header name, author and the rendered SKILL.md readme come from the mock.
    await expect(page.locator('.hub-detail-name')).toHaveText('PDF Tools');
    await expect(page.getByTestId('hub-detail-body')).toContainText('acme');
    await expect(page.getByTestId('hub-detail-readme')).toContainText('pdf-tools 的 E2E mock readme 正文');
    // Security verdict badges show when the detail reports them.
    await expect(page.getByTestId('hub-detail-security')).toBeVisible();
    // Not installed in the mock → install button enabled.
    await expect(page.getByTestId('hub-detail-install')).toBeEnabled();

    // Esc closes the modal (same convention as the resources lightbox).
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('install from the detail modal posts the request and closes the modal', async ({ page }) => {
    const state: HubMockState = { failList: false, installDelayMs: 0, installRequests: [], listRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });

    const cardBtn = page.getByTestId('hub-install-pdf-tools');
    const labelBefore = await cardBtn.textContent();

    await page.getByTestId('hub-card-pdf-tools').click();
    await expect(page.getByTestId('hub-detail-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-detail-install')).toBeEnabled();

    await page.getByTestId('hub-detail-install').click();

    // The success banner is the feedback; the modal closes behind it.
    await expect(page.getByTestId('hub-notice')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.hub-notice--success')).toBeVisible();
    await expect(page.getByTestId('hub-detail-overlay')).toHaveCount(0);

    // The daemon received the install request and the card flipped state
    // (安装 → 更新), asserted on the CHANGE to stay locale-independent.
    expect(state.installRequests).toHaveLength(1);
    expect(state.installRequests[0]).toMatchObject({ slug: 'pdf-tools', version: '1.2.0' });
    await expect(cardBtn).not.toHaveText(labelBefore ?? '');
  });

  test('clicking the install button on a card does not open the detail modal', async ({ page }) => {
    const state: HubMockState = { failList: false, installDelayMs: 300, installRequests: [], listRequests: [] };
    await setupHubMocks(page, state);

    await gotoSkillsHub(page);
    await expect(page.getByTestId('hub-card-pdf-tools')).toBeVisible({ timeout: 10_000 });

    // Direct install from the card: the click must not bubble into the card's
    // own onClick (which opens the detail modal).
    await page.getByTestId('hub-install-pdf-tools').click();

    await expect(page.getByTestId('hub-notice')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hub-detail-overlay')).toHaveCount(0);
    expect(state.installRequests).toHaveLength(1);
  });
});

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * daemon 直连地址：跟随 MOLIO_E2E_DAEMON_PORT 平移（见 playwright.config.ts 头注）。
 * 必须在 Node 作用域计算——page.evaluate 回调跑在浏览器里，那里没有 process。
 * 浏览器内的 fetch 通过 evaluate 参数把这个 base 传进去，不能内联 process.env。
 */
const DAEMON_API = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}/api`;

/**
 * @area runtimes
 * @priority P1
 *
 * E2E: Claude Code one-click install + DeepSeek provider configuration.
 *
 * Prerequisites: daemon (:3100) + web (:5173) running via `pnpm dev`.
 *
 * Tests:
 *  1. Navigate to runtimes page
 *  2. Find Claude Code agent card (should be available if installed)
 *  3. Expand provider config panel
 *  4. Select DeepSeek as provider
 *  5. Enter API key
 *  6. Save and verify persistence
 *  7. Clean up (reset to Anthropic default)
 */

test.describe('Runtime provider config', () => {
  // These tests write to the REAL ~/.claude/settings.json (Claude provider env
  // lives there since the settings.json migration). Back it up and restore it so
  // the suite never clobbers the developer's actual Claude credentials/models.
  const claudeSettingsJson = path.join(os.homedir(), '.claude', 'settings.json');
  let claudeSettingsBackup: string | null = null;

  test.beforeAll(() => {
    if (fs.existsSync(claudeSettingsJson) && fs.statSync(claudeSettingsJson).isFile()) {
      claudeSettingsBackup = fs.readFileSync(claudeSettingsJson, 'utf8');
    }
  });

  test.afterAll(() => {
    if (claudeSettingsBackup !== null) {
      fs.writeFileSync(claudeSettingsJson, claudeSettingsBackup);
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Navigate to Settings → Runtimes tab (standalone /runtimes route was removed)
    await page.locator('[data-view="settings"]').click();
    await expect(page.locator('.settings-shell')).toBeVisible();
    const runtimesTab = page.locator('.settings-tab-btn').filter({ hasText: /Runtime|运行时/ });
    await runtimesTab.click({ timeout: 5_000 });
    await expect(page.locator('.rt-shell')).toBeVisible();

    // All tests in this suite require Claude Code to be installed and available.
    // Skip gracefully in CI environments where it isn't.
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });
    // agent 列表是异步扫描渲染的，先等卡片出现再判断安装状态
    await claudeCard.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    const hasCard = await claudeCard.count();
    const isAvailable = hasCard > 0 && await claudeCard.locator('.rt-badge--ok').count() > 0;
    test.skip(!isAvailable, 'Claude Code not installed in this environment');
  });

  test('Claude Code card shows provider config button when installed', async ({ page }) => {
    // Find the Claude Code agent card — it should be in the "installed" section
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });
    await expect(claudeCard).toBeVisible();

    // Should show "可用" badge
    await expect(claudeCard.locator('.rt-badge--ok')).toBeVisible();

    // Should have the provider config toggle button (⚙ 模型提供商)
    const providerToggle = claudeCard.locator('.rt-provider-toggle');
    await expect(providerToggle).toBeVisible();
  });

  test('expand provider config and select DeepSeek', async ({ page }) => {
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });
    await expect(claudeCard).toBeVisible();

    // Click the provider toggle to expand
    const providerToggle = claudeCard.locator('.rt-provider-toggle');
    await providerToggle.click();

    // Provider config panel should appear
    const configPanel = claudeCard.locator('.rt-provider-config');
    await expect(configPanel).toBeVisible();

    // Provider selector dropdown should be present
    const providerSelect = configPanel.locator('.rt-provider-form__select');
    await expect(providerSelect).toBeVisible();

    // Select DeepSeek
    await providerSelect.selectOption('deepseek');

    // API key input should appear (not shown for Anthropic)
    const apiKeyInput = configPanel.locator('.rt-provider-form__input[type="password"]');
    await expect(apiKeyInput).toBeVisible();

    // Should show DeepSeek-specific hint
    await expect(configPanel.locator('.rt-provider-form__hint')).toContainText('sk-');

    // Should show link to get API key
    const apiKeyLink = configPanel.locator('.rt-provider-form__link').filter({ hasText: 'API Key' });
    await expect(apiKeyLink).toBeVisible();
    await expect(apiKeyLink).toHaveAttribute('href', 'https://platform.deepseek.com/api_keys');

    // DeepSeek model mapping is collapsed by default — expand and verify prefilled
    await configPanel.locator('.rt-provider-mapping-toggle').click();
    const mappingSection = configPanel.locator('.rt-provider-mapping');
    await expect(mappingSection).toBeVisible();
    await expect(mappingSection.locator('.rt-provider-mapping__input').first())
      .toHaveValue(/deepseek-v4-pro/);
  });

  test('save DeepSeek config and verify persistence', async ({ page }) => {
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });

    // Expand provider config
    await claudeCard.locator('.rt-provider-toggle').click();
    const configPanel = claudeCard.locator('.rt-provider-config');
    await expect(configPanel).toBeVisible();

    // Select DeepSeek
    await configPanel.locator('.rt-provider-form__select').selectOption('deepseek');

    // Enter a test API key
    const apiKeyInput = configPanel.locator('.rt-provider-form__input[type="password"]');
    await apiKeyInput.fill('sk-test-e2e-deepseek-key');

    // Click save
    const saveBtn = configPanel.locator('.rt-provider-form__actions .rt-btn').first();
    await saveBtn.click();

    // Should show saved confirmation
    await expect(configPanel.locator('.rt-provider-form__status--ok')).toBeVisible({ timeout: 5000 });

    // Verify via API that config was persisted correctly
    const response = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/config/agents/claude`);
      return res.json();
    }, DAEMON_API);

    expect(response.env).toBeDefined();
    expect(response.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(response.env.ANTHROPIC_API_KEY).toBe('sk-test-e2e-deepseek-key');

    // Collapse and re-expand — should detect DeepSeek as current provider
    await claudeCard.locator('.rt-provider-config__header .rt-btn').click(); // close
    await claudeCard.locator('.rt-provider-toggle').click(); // reopen

    const reopenedSelect = claudeCard.locator('.rt-provider-config .rt-provider-form__select');
    await expect(reopenedSelect).toHaveValue('deepseek');
  });

  test('switch between providers clears API key', async ({ page }) => {
    const claudeCard = page.locator('.rt-agent-card').filter({ hasText: 'Claude Code' });

    // Expand
    await claudeCard.locator('.rt-provider-toggle').click();
    const configPanel = claudeCard.locator('.rt-provider-config');

    // Select DeepSeek and enter key
    await configPanel.locator('.rt-provider-form__select').selectOption('deepseek');
    await configPanel.locator('.rt-provider-form__input[type="password"]').fill('sk-some-key');

    // Switch to OpenRouter
    await configPanel.locator('.rt-provider-form__select').selectOption('openrouter');

    // API key should be cleared
    const apiKeyInput = configPanel.locator('.rt-provider-form__input[type="password"]');
    await expect(apiKeyInput).toHaveValue('');

    // Should show OpenRouter-specific hint
    await expect(configPanel.locator('.rt-provider-form__hint')).toContainText('sk-or-');
  });

  test('clean up: reset to Anthropic default', async ({ page }) => {
    // Reset via API
    await page.evaluate(async (api) => {
      await fetch(`${api}/config/agents/claude`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: { ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '' } }),
      });
    }, DAEMON_API);

    // Verify. Since the Claude env → ~/.claude/settings.json migration, clearing
    // every managed key makes the GET drop the `env` object entirely (env is
    // undefined), so tolerate both "absent" and "empty string".
    const response = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/config/agents/claude`);
      return res.json();
    }, DAEMON_API);
    expect(response.env?.ANTHROPIC_BASE_URL ?? '').toBe('');
    expect(response.env?.ANTHROPIC_API_KEY ?? '').toBe('');
  });
});

test.describe('Codex provider config', () => {
  const codexDir = path.join(os.homedir(), '.codex');
  const configToml = path.join(codexDir, 'config.toml');
  const authJson = path.join(codexDir, 'auth.json');
  let backupDir = '';
  const backups: { src: string; bak: string }[] = [];
  const suiteCreated: string[] = []; // 跑前不存在的文件，afterAll 删掉

  test.beforeAll(() => {
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-backup-'));
    for (const src of [configToml, authJson]) {
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        const bak = path.join(backupDir, path.basename(src));
        fs.copyFileSync(src, bak);
        backups.push({ src, bak });
      } else {
        suiteCreated.push(src);
      }
    }
  });

  test.afterAll(() => {
    for (const { src, bak } of backups) {
      fs.copyFileSync(bak, src);
    }
    for (const src of suiteCreated) {
      fs.rmSync(src, { force: true }); // 本来就不存在的，删掉而不是留下测试垃圾
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    // ProviderConfig loads live ~/.codex state ON MOUNT (the agent card mounts
    // during navigation below). If we seeded state in the test body instead, the
    // mount-load would already be in flight reading the PREVIOUS test's leftover
    // and could clobber the selection — a race. So write the deterministic
    // precondition via the daemon API BEFORE goto, guaranteeing the mount-load
    // reads exactly this state.
    const title = test.info().title;
    const precondition = title.includes('switch to official')
      ? { presetId: 'deepseek', model: 'deepseek-v4-pro' }
      : title.includes('saved-key hint')
        // apiKey so hasKey=true at mount — the hint under test reads it
        ? { presetId: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-e2e-saved' }
        : { presetId: 'official' };
    const seedRes = await fetch(`${DAEMON_API}/agents/codex/provider`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(precondition),
    });
    expect(seedRes.ok, `failed to seed codex provider precondition: ${seedRes.status}`).toBeTruthy();

    await page.goto('/');
    await page.locator('[data-view="settings"]').click();
    await expect(page.locator('.settings-shell')).toBeVisible();
    await page.locator('.settings-tab-btn').filter({ hasText: /Runtime|运行时/ }).click({ timeout: 5_000 });
    await expect(page.locator('.rt-shell')).toBeVisible();

    const codexCard = page.locator('.rt-agent-card').filter({ hasText: 'Codex' });
    // agent 列表是异步扫描渲染的，先等卡片出现再判断安装状态
    await codexCard.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    const installed = await codexCard.count() > 0
      && await codexCard.locator('.rt-badge--ok').count() > 0;
    test.skip(!installed, 'Codex CLI not installed in this environment');
  });

  test('save DeepSeek provider and verify ~/.codex files', async ({ page }) => {
    // beforeEach seeded 'official' before mount, so the mount-load shows
    // 'official' — the select defaults to 'deepseek', so it only reads
    // 'official' once the async load has been applied.
    const codexCard = page.locator('.rt-agent-card').filter({ hasText: 'Codex' });
    await codexCard.locator('.rt-provider-toggle').click();
    const panel = codexCard.locator('.rt-provider-config');
    await expect(panel).toBeVisible();

    // codex file hint shown
    await expect(panel.locator('.rt-provider-form__hint').first()).toContainText('.codex/config.toml');

    // async state load applied — safe to interact without being overwritten
    await expect(panel.locator('.rt-provider-form__select').first()).toHaveValue('official');

    await panel.locator('.rt-provider-form__select').first().selectOption('deepseek');

    const modelField = panel.locator('[data-testid="codex-model-field"]');
    await expect(modelField).toBeVisible();
    // select default model if it's a <select>
    if (await modelField.evaluate((el) => el.tagName) === 'SELECT') {
      await modelField.selectOption('deepseek-v4-flash');
    } else {
      await modelField.fill('deepseek-v4-flash');
    }

    await panel.locator('.rt-provider-form__input[type="password"]').fill('sk-e2e-codex-test');
    await panel.locator('.rt-provider-form__actions .rt-btn').first().click();
    await expect(panel.locator('.rt-provider-form__status--ok')).toBeVisible({ timeout: 5_000 });

    // daemon wrote the live files
    const toml = fs.readFileSync(configToml, 'utf8');
    expect(toml).toContain('base_url = "https://api.deepseek.com"');
    expect(toml).toContain('model_provider = "custom"');
    expect(toml).toContain('model = "deepseek-v4-flash"');
    const auth = JSON.parse(fs.readFileSync(authJson, 'utf8'));
    expect(auth['OPENAI_API_KEY']).toBe('sk-e2e-codex-test');

    // GET provider reflects live state
    const state = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/agents/codex/provider`);
      return res.json();
    }, DAEMON_API);
    expect(state.presetHint).toBe('deepseek');
    expect(state.hasKey).toBe(true);
  });

  test('shows saved-key hint when auth.json already has a key', async ({ page }) => {
    // beforeEach seeded deepseek + apiKey BEFORE mount, so the mount-load of
    // GET /codex/provider sees hasKey=true.
    const codexCard = page.locator('.rt-agent-card').filter({ hasText: 'Codex' });
    await codexCard.locator('.rt-provider-toggle').click();
    const panel = codexCard.locator('.rt-provider-config');
    await expect(panel).toBeVisible();

    // Secrets never round-trip to the UI — the field stays empty…
    const keyInput = panel.locator('.rt-provider-form__input[type="password"]');
    await expect(keyInput).toHaveValue('');
    // …but the saved-key hint makes that explicit instead of looking "unsaved"
    await expect(panel.locator('[data-testid="codex-key-saved-hint"]')).toBeVisible();

    // Typing a replacement key hides the hint
    await keyInput.fill('sk-replacement');
    await expect(panel.locator('[data-testid="codex-key-saved-hint"]')).toHaveCount(0);
  });

  test('switch to official clears the override', async ({ page }) => {
    // beforeEach seeded deepseek + 非默认模型 deepseek-v4-pro；加载完成前模型
    // 下拉框显示默认第一项 deepseek-v4-flash，因此 deepseek-v4-pro 可作为
    // 「异步状态加载已应用」的可观测标记
    const codexCard = page.locator('.rt-agent-card').filter({ hasText: 'Codex' });
    await codexCard.locator('.rt-provider-toggle').click();
    const panel = codexCard.locator('.rt-provider-config');
    // 等异步状态加载完成，避免晚到的响应覆盖下面的 official 选择
    await expect(panel.locator('[data-testid="codex-model-field"]')).toHaveValue('deepseek-v4-pro');
    await panel.locator('.rt-provider-form__select').first().selectOption('official');
    await panel.locator('.rt-provider-form__actions .rt-btn').first().click();
    await expect(panel.locator('.rt-provider-form__status--ok')).toBeVisible({ timeout: 5_000 });

    const toml = fs.readFileSync(configToml, 'utf8');
    // 用行首锚定正则，避免被保留的 [model_providers.X] 段（含 "model_provider" 子串）误伤
    expect(toml).not.toMatch(/^model_provider\s*=/m);
    expect(toml).not.toContain('https://api.deepseek.com');
  });
});

test.describe('dsh provider config', () => {
  // dsh credentials live in ~/.molio/config.json (agents.dsh.env) — dsh reads
  // DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL solely from env (no backing file).
  // Back the stored config up and restore it so the suite never clobbers a
  // real DeepSeek key.
  let originalDshConfig: { env?: Record<string, string> } | null = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${DAEMON_API}/config/agents/dsh`);
    if (res.ok()) originalDshConfig = await res.json();
  });

  test.afterAll(async ({ request }) => {
    if (originalDshConfig === null) return; // daemon unreachable — don't wipe blindly
    await request.put(`${DAEMON_API}/config/agents/dsh`, {
      data: { env: originalDshConfig.env ?? {} },
    });
  });

  /** Navigate to Settings → Runtimes and return the dsh agent card. */
  async function openDshCard(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.locator('[data-view="settings"]').click();
    await expect(page.locator('.settings-shell')).toBeVisible();
    await page.locator('.settings-tab-btn').filter({ hasText: /Runtime|运行时/ }).click({ timeout: 5_000 });
    await expect(page.locator('.rt-shell')).toBeVisible();

    const dshCard = page.locator('.rt-agent-card').filter({ hasText: 'DeepSeek Harness' });
    // agent 列表是异步扫描渲染的，先等卡片出现再判断安装状态
    await dshCard.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    return dshCard;
  }

  test.beforeEach(async ({ page }) => {
    const dshCard = await openDshCard(page);
    // The provider config panel only renders for available agents; skip
    // gracefully where dsh isn't installed (CI).
    const installed = await dshCard.count() > 0
      && await dshCard.locator('.rt-badge--ok').count() > 0;
    test.skip(!installed, 'dsh not installed in this environment');
  });

  test('dsh provider form: env-only key field, custom base URL, no model mapping', async ({ page }) => {
    const dshCard = await openDshCard(page);
    await dshCard.locator('.rt-provider-toggle').click();
    const panel = dshCard.locator('.rt-provider-config');
    await expect(panel).toBeVisible();

    // Provider select offers exactly the two dsh presets
    const select = panel.locator('.rt-provider-form__select');
    await expect(select).toBeVisible();
    const optionValues = await select.locator('option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    expect(optionValues).toEqual(['deepseek', 'custom']);

    // The API key field shows even for the official preset — dsh reads
    // DEEPSEEK_API_KEY solely from env, so a key is always required.
    await expect(panel.locator('.rt-provider-form__input[type="password"]')).toBeVisible();
    const apiKeyLink = panel.locator('.rt-provider-form__link').filter({ hasText: 'API Key' });
    await expect(apiKeyLink).toHaveAttribute('href', 'https://platform.deepseek.com/api_keys');

    // dsh models arrive at runtime via ACP configOptions → no model-mapping UI
    await expect(panel.locator('.rt-provider-mapping-toggle')).toHaveCount(0);
    // Official preset → no base URL override field
    await expect(panel.locator('[data-testid="dsh-base-url-field"]')).toHaveCount(0);

    // Switching to custom reveals the Messages-compatible base URL field
    await select.selectOption('custom');
    const baseUrl = panel.locator('[data-testid="dsh-base-url-field"]');
    await expect(baseUrl).toBeVisible();
    await expect(baseUrl).toHaveAttribute('placeholder', 'https://api.deepseek.com/anthropic');
  });

  test('save dsh custom config, verify persistence + detection after reload', async ({ page }) => {
    const dshCard = await openDshCard(page);
    await dshCard.locator('.rt-provider-toggle').click();
    const panel = dshCard.locator('.rt-provider-config');
    await expect(panel).toBeVisible();

    await panel.locator('.rt-provider-form__select').selectOption('custom');
    await panel.locator('[data-testid="dsh-base-url-field"]').fill('https://api.example.com/anthropic');
    await panel.locator('.rt-provider-form__input[type="password"]').fill('sk-e2e-dsh-test');
    await panel.locator('.rt-provider-form__actions .rt-btn').first().click();
    await expect(panel.locator('.rt-provider-form__status--ok')).toBeVisible({ timeout: 5_000 });

    // Daemon persisted env into ~/.molio/config.json (agents.dsh.env)
    const response = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/config/agents/dsh`);
      return res.json();
    }, DAEMON_API);
    expect(response.env?.['DEEPSEEK_API_KEY']).toBe('sk-e2e-dsh-test');
    expect(response.env?.['DEEPSEEK_BASE_URL']).toBe('https://api.example.com/anthropic');

    // Full reload — the mount-time load must detect the custom provider from
    // the persisted env (detectDshProvider keys off DEEPSEEK_BASE_URL).
    const reloadedCard = await openDshCard(page);
    await expect(reloadedCard.locator('.rt-provider-toggle__current')).toHaveText(/Custom/i, { timeout: 10_000 });
    await reloadedCard.locator('.rt-provider-toggle').click();
    const reopened = reloadedCard.locator('.rt-provider-config');
    await expect(reopened.locator('.rt-provider-form__select')).toHaveValue('custom');
    await expect(reopened.locator('[data-testid="dsh-base-url-field"]'))
      .toHaveValue('https://api.example.com/anthropic');
  });

  // Error-driven regression (2026-10-05): saving the OFFICIAL preset used to
  // persist DEEPSEEK_BASE_URL: '' — dsh resolves the endpoint with `??`, an
  // empty string is not nullish, `new URL('')` throws TypeError: Invalid URL,
  // both llm-deepseek entries fail to activate and ACP initialize dies with
  // -32603 ("at file:///…/.dsh/profiles/acp/#include"). The official preset
  // must OMIT the key entirely.
  test('save dsh official config omits DEEPSEEK_BASE_URL entirely', async ({ page }) => {
    const dshCard = await openDshCard(page);
    await dshCard.locator('.rt-provider-toggle').click();
    const panel = dshCard.locator('.rt-provider-config');
    await expect(panel).toBeVisible();

    // Start from custom with a URL, then switch back to official — the saved
    // env must drop the key, not blank it.
    await panel.locator('.rt-provider-form__select').selectOption('custom');
    await panel.locator('[data-testid="dsh-base-url-field"]').fill('https://api.example.com/anthropic');
    await panel.locator('.rt-provider-form__select').selectOption('deepseek');
    await panel.locator('.rt-provider-form__input[type="password"]').fill('sk-e2e-official');
    await panel.locator('.rt-provider-form__actions .rt-btn').first().click();
    await expect(panel.locator('.rt-provider-form__status--ok')).toBeVisible({ timeout: 5_000 });

    const response = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/config/agents/dsh`);
      return res.json();
    }, DAEMON_API);
    expect(response.env?.['DEEPSEEK_API_KEY']).toBe('sk-e2e-official');
    expect(response.env).toBeDefined();
    expect(Object.keys(response.env ?? {})).not.toContain('DEEPSEEK_BASE_URL');

    // Reload → provider detection reads back as official.
    const reloadedCard = await openDshCard(page);
    await expect(reloadedCard.locator('.rt-provider-toggle__current')).toHaveText(/DeepSeek/i, { timeout: 10_000 });
  });

  test('clean up: reset dsh env via API', async ({ page }) => {
    await page.evaluate(async (api) => {
      await fetch(`${api}/config/agents/dsh`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: {} }),
      });
    }, DAEMON_API);

    const response = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/config/agents/dsh`);
      return res.json();
    }, DAEMON_API);
    expect(response.env?.['DEEPSEEK_API_KEY'] ?? '').toBe('');
    expect(response.env?.['DEEPSEEK_BASE_URL'] ?? '').toBe('');
  });
});

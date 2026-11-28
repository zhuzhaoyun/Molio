// Run against a disposable official DSH Web profile with the packed plugin installed.
// The test creates a workspace/session and uses a fixture answer so no model credentials are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('@playwright/test');
const url = process.env.MOLIO_DSH_SMOKE_URL;

test('official DSH loads the three panels, reads and follows a wiki citation', { skip: !url, timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  const vault = await mkdtemp(join(tmpdir(), 'molio-dsh-wiki-'));
  const page = await browser.newPage({ locale: 'zh-CN' });
  let endpoint;
  try {
    await writeFile(join(vault, '早期销售.md'), '---\nrelated:\n  - "[[曼行]]"\n---\n# 早期销售\n见 [[曼行|相关实体]]。');
    await writeFile(join(vault, '曼行.md'), '# 曼行\n已打开关联笔记。');
    await page.addInitScript(path => {
      if (window === window.top) {
        let selections = 0;
        window.__DSH_DIRECTORY_PICKER__ = { pick: async () => { window.__molioPickerCount = ++selections; return selections === 1 ? null : path; } };
      }
    }, vault);
    await page.goto(url);
    async function panel(title) {
      await page.getByText(title, { exact: true }).first().evaluate(button => button.click());
      const iframe = page.locator('iframe[title="' + title + '"]');
      await iframe.waitFor();
      const frame = await (await iframe.elementHandle()).contentFrame();
      await frame.locator('main.harness-page').waitFor();
      return frame;
    }
    const frame = await panel('知识');
    await frame.evaluate(() => { window.__molioPanelState = 'retained'; });
    const resources = await panel('资源');
    await resources.evaluate(() => { window.__molioPanelState = 'market'; });
    assert.equal(await (await panel('图谱')).evaluate(() => window.__molioPanelState), 'retained');
    assert.equal(await (await panel('资源')).evaluate(() => window.__molioPanelState), 'market');
    assert.equal(await (await panel('知识')).evaluate(() => window.__molioPanelState), 'retained');
    const api = new URL('/api/knowledge/vaults', frame.url());
    await frame.locator('.kb-vault-bar').evaluate(button => button.click());
    const openFolder = frame.getByTestId('vault-open-action');
    await openFolder.evaluate(button => button.click());
    await page.waitForFunction(() => window.__molioPickerCount === 1);
    await openFolder.waitFor();
    const registered = page.waitForResponse(res => res.url() === api.href && res.request().method() === 'POST');
    await frame.getByTestId('vault-open-action').evaluate(button => button.click());
    assert.ok((await registered).ok());
    const { vaults } = await (await page.request.get(api.href)).json();
    const id = vaults.find(v => v.path === vault).id;
    endpoint = api.href + '/' + encodeURIComponent(id);
    await frame.waitForFunction(id => new URLSearchParams(location.search).get('vault') === id, id);
    // Keep the iframe embedded with its real DSH parent and activate our own test vault.
    await frame.evaluate(id => {
      history.pushState({}, '', '/knowledge?vault=' + encodeURIComponent(id) + '&file=' + encodeURIComponent('早期销售.md'));
      dispatchEvent(new PopStateEvent('popstate'));
    }, id);
    await frame.getByText('见', { exact: false }).last().waitFor();
    await panel('图谱');
    await frame.getByTestId('kb-graph-pane').waitFor();
    await panel('资源');
    await panel('知识');
    await frame.getByText('见', { exact: false }).last().waitFor();
    await frame.getByTestId('kb-btn-ask-tab').evaluate(button => button.click());
    const session = page.locator('[data-conversation-session]').last();
    await session.waitFor();
    await page.getByText('早期销售.md', { exact: true }).last().waitFor();
    assert.doesNotMatch(await page.locator('[contenteditable=true]').last().innerText(), /根据知识库回答|早期销售|molio-dsh-wiki/);
    await session.evaluate(element => {
      const row = document.createElement('div');
      row.dataset.chatFlowKind = 'assistant-step';
      const code = document.createElement('code');
      code.textContent = '[[早期销售]]';
      row.append(code);
      element.append(row);
    });
    await session.getByRole('link', { name: '早期销售' }).evaluate(link => link.click());
    const preview = page.locator('[data-molio-document]').last();
    await preview.getByRole('link', { name: '曼行', exact: true }).waitFor();
    await preview.getByRole('link', { name: '相关实体' }).evaluate(link => link.click());
    await page.getByText('已打开关联笔记。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '在知识库中打开' }).last().evaluate(button => button.click());
    await page.locator('iframe[title="知识"]').waitFor();
    await frame.getByText('已打开关联笔记。', { exact: true }).last().waitFor();
  } finally {
    if (endpoint) await page.request.delete(endpoint);
    await browser.close();
    await rm(vault, { recursive: true, force: true });
  }
});

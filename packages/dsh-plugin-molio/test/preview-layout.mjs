import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { chromium } = webRequire('@playwright/test');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

test('Obsidian properties wrap in the right pane and collapse above the note', async () => {
  let Preview;
  const client = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  const loader = { load({factory}) {
    const plugin = factory(id => id === '@deepseek-ai/dsh-client-ui-primitives'
      ? { MarkdownText: ({text}) => React.createElement('section', null, text) } : webRequire(id));
    plugin.apply({
      effect() {}, inject() {},
      slots: { inject: (_, fn) => fn(), register({name}, component) {
        if (name === 'sidebar.right.tab.document') Preview = component;
      } },
    });
  } };
  runInNewContext(client, {window: {__ModuleLoader__: loader}, EventTarget});
  const names = '始皇帝 刘邦 项羽 韩信 张良 萧何 陈平 赵高 王翦 章邯 楚怀王 冒顿单于 头曼单于 资治通鉴 秦 西汉'.split(' ');
  const text = process.env.MOLIO_PREVIEW_NOTE ? await readFile(process.env.MOLIO_PREVIEW_NOTE, 'utf8')
    : ['---','type: overview','title: 秦汉之际概述','created: 2026-07-22','updated: 2026-07-22',
      'tags: [概述, 秦汉之际]', 'related:', ...names.map(n => '  - "[[' + n + ']]"'),
      'sources:','  - "[[资治通鉴]]"','---','# 秦汉之际概述'].join('\n');
  const markup = renderToStaticMarkup(React.createElement(Preview, {
    content: {kind:'text', text, eof:true}, useResource: () => ({value:{}}),
  }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(markup);
    const wiki = await readFile(new URL('../client/wiki.mjs', import.meta.url), 'utf8');
    await page.evaluate(async source => {
      const {decorateWiki} = await import(source);
      const root = document.querySelector('[data-molio-document]');
      decorateWiki(root, '[data-molio-document]', async name => { root.dataset.opened = name; });
    }, 'data:text/javascript;base64,' + Buffer.from(wiki).toString('base64'));
    const fields = page.locator('details');
    assert.equal(await fields.count(), 1);
    const related = fields.locator('div').filter({has: page.locator('> dt', {hasText:'相关笔记'})}).locator('> dd');
    assert.deepEqual(await related.getByRole('link').allTextContents(), names);
    await related.getByRole('link', {name:'刘邦', exact:true}).click();
    assert.equal(await page.locator('article').getAttribute('data-opened'), '刘邦');
    for (const width of [320, 560]) {
      await page.setViewportSize({width, height:700});
      const layout = await related.evaluate(el => Array.from(el.children, entry => ({
        y: entry.getBoundingClientRect().top, right: entry.getBoundingClientRect().right
      })));
      assert.equal(layout.length, names.length);
      assert.equal(layout[0].y, layout[1].y);
      assert.ok(layout.at(-1).y > layout[0].y);
      assert.ok(layout.every(entry => entry.right <= width));
    }
    await fields.locator('summary').click();
    assert.equal(await related.isVisible(), false);
    assert.ok(await page.locator('section').isVisible());
  } finally { await browser.close(); }
});

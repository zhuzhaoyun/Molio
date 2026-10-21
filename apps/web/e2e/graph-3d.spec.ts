/**
 * @area graph
 * @priority P1
 */
import { test, expect, type Page } from '@playwright/test';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { EngineNode } from '../src/components/graph/engine/pixiGraphEngine';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
type Node = EngineNode & { x: number; y: number; z: number };
type ThreeHandle = { instance: ForceGraph3DInstance<Node>; isPaused(): boolean };
declare global { interface Window { __threeGraph?: ThreeHandle } }
let vault: TempVault;
test.describe.configure({ timeout: 60_000 });
test.beforeAll(async () => {
  vault = await createTempVault('e2e-graph-3d');
  for (let i = 0; i < 8; i++) writeFileSync(join(vault.path, `topic-${i}.md`), `# Topic ${i}\n\nPreview content ${i}\n\n[[topic-${(i + 1) % 8}]]\n[[topic-${(i + 3) % 8}]]\n[[unresolved]]`);
});
test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
async function open(page: Page) {
  await page.goto(`/knowledge?vault=${vault.id}`);
  await clickNav(page, 'graph');
  await expect(page.getByTestId('graph-mode-2d')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('graph-mode-3d').click();
  await expect(page.getByTestId('graph-3d').locator('canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__threeGraph?.instance.graphData().nodes.length ?? 0)).toBeGreaterThan(8);
}
async function search(page: Page, query: string) {
  await page.getByTestId('graph-search-open').click();
  await page.getByTestId('graph-search-input').fill(query);
  await expect(page.getByTestId('graph-search-option').first()).toBeVisible();
  await page.getByTestId('graph-search-input').press('Enter');
}
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__threeGraph?.isPaused()), { timeout: 25_000 }).toBe(true);
}
async function clickNode(page: Page, key: string) {
  const point = await page.evaluate(key => {
    const graph = window.__threeGraph!.instance;
    const node = graph.graphData().nodes.find(n => n.key === key)!;
    const point = graph.graph2ScreenCoords(node.x, node.y, node.z);
    const rect = graph.renderer().domElement.getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  }, key);
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.float-tooltip-kap')).toBeVisible();
  await page.mouse.click(point.x, point.y);
}

test('3D uses real graph data, previews search selection, and preserves the selected mode', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('graph-export')).toHaveCount(0);
  await settled(page);
  const spatial = await page.evaluate(() => {
    const graph = window.__threeGraph!.instance;
    const { nodes, links } = graph.graphData();
    const [a, b, c, d] = nodes;
    const u = { x: b.x-a.x, y:b.y-a.y, z:b.z-a.z }, v = { x:c.x-a.x,y:c.y-a.y,z:c.z-a.z }, w = { x:d.x-a.x,y:d.y-a.y,z:d.z-a.z };
    return { volume: Math.abs(u.x*(v.y*w.z-v.z*w.y)-u.y*(v.x*w.z-v.z*w.x)+u.z*(v.x*w.y-v.y*w.x)),
      webgl: !!graph.renderer().getContext(), nodes: nodes.length, links: links.length };
  });
  expect(spatial.webgl).toBe(true);
  expect(spatial.volume).toBeGreaterThan(1);
  expect(spatial.nodes).toBe(10); // 8 notes, test.md, unresolved link
  expect(spatial.links).toBe(24);
  await search(page, 'topic-0');
  await expect(page.getByTestId('graph-preview')).toContainText('Preview content 0');
  await expect.poll(() => page.evaluate(() => {
    const g = window.__threeGraph!.instance;
    const node = g.graphData().nodes.find(n => n.key === 'topic-0.md')!;
    const p = g.cameraPosition();
    return Math.abs(Math.hypot(p.x-node.x, p.y-node.y, p.z-node.z) - 150);
  })).toBeLessThan(1);
  const selection = await page.evaluate(() => {
    const graph = window.__threeGraph!.instance;
    const color = graph.nodeColor() as (n: Node) => string;
    return graph.graphData().nodes.map(n => ({ key: n.key, color: color(n) }));
  });
  expect(selection.find(n => n.key === 'topic-0.md')?.color).toBe('#8B5CF6');
  expect(selection.find(n => n.key === 'topic-4.md')?.color).toBe('rgba(0,0,0,0.04)');
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/graph-3d-preview.png' });
  await page.reload();
  await clickNav(page, 'graph');
  await expect(page.getByTestId('graph-mode-3d')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('graph-3d').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('graph-canvas').locator('canvas')).toHaveCount(0); // no eager Pixi on persisted 3D
});

test('real node clicks preview unresolved links without creating files; explicit Open navigates and pauses hidden view', async ({ page }) => {
  await open(page);
  await settled(page);
  const projected = await page.evaluate(() => {
    const g = window.__threeGraph!.instance;
    const bounds = g.renderer().domElement.getBoundingClientRect();
    return g.graphData().nodes.map(n => {
      const p = g.graph2ScreenCoords(n.x, n.y, n.z);
      return p.x >= 0 && p.x <= bounds.width && p.y >= 0 && p.y <= bounds.height;
    });
  });
  expect(projected.every(Boolean)).toBe(true);
  await clickNode(page, '__dead__unresolved');
  await expect(page.getByTestId('graph-preview-missing')).toBeVisible();
  await expect(page.getByTestId('graph-preview-open')).toHaveCount(0);
  expect(existsSync(join(vault.path, 'unresolved.md'))).toBe(false);
  await search(page, 'topic-1');
  await expect(page.getByTestId('graph-preview')).toContainText('Preview content 1');
  await page.getByTestId('graph-preview-open').click();
  await expect(page.locator('.kb-wtab.is-active')).toContainText('topic-1.md');
  await expect.poll(() => page.evaluate(() => window.__threeGraph?.isPaused())).toBe(true);
  await clickNav(page, 'graph');
  await expect(page.getByTestId('graph-3d').locator('canvas')).toBeVisible();
});

test('rotate, pan, zoom and reset change the real camera; switching keeps exactly one 3D canvas', async ({ page }) => {
  await open(page);
  await settled(page);
  const camera = () => page.evaluate(() => window.__threeGraph!.instance.cameraPosition());
  const a = await camera();
  const box = (await page.getByTestId('graph-3d').boundingBox())!;
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .55);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .55, box.y + box.height * .65, { steps: 12 }); await page.mouse.up();
  await expect.poll(camera).not.toEqual(a);
  const b = await camera();
  await page.mouse.down({ button: 'right' }); await page.mouse.move(box.x + box.width * .65, box.y + box.height * .55, { steps: 10 }); await page.mouse.up({ button: 'right' });
  await expect.poll(camera).not.toEqual(b);
  const c = await camera();
  await page.mouse.wheel(0, 300);
  await expect.poll(camera).not.toEqual(c);
  await page.getByTestId('graph-3d-reset').click();
  await expect.poll(camera).not.toEqual(c);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('graph-mode-2d').click();
    await expect.poll(() => page.evaluate(() => window.__threeGraph?.isPaused())).toBe(true);
    await expect(page.getByTestId('graph-export')).toBeVisible();
    await page.getByTestId('graph-mode-3d').click();
    await expect(page.getByTestId('graph-3d').locator('canvas')).toBeVisible();
    await expect(page.getByTestId('graph-3d').locator('canvas')).toHaveCount(1);
  }
});

test('filters update actual nodes and a file refresh retains existing node objects and camera', async ({ page }) => {
  await open(page);
  await settled(page);
  await page.locator('.graph-settings-btn').click();
  await expect(page.locator('.graph-settings__tab')).toHaveCount(3); // no misleading 2D force controls
  await page.locator('.graph-settings__tab').last().click();
  await expect(page.getByTestId('graph-operation-hints')).toContainText('右键拖动平移');
  await expect(page.getByTestId('graph-operation-hints')).not.toContainText('打开文章');
  await page.locator('.graph-settings__tab').first().click();
  await page.locator('.graph-settings__checkbox input').last().uncheck();
  await expect.poll(() => page.evaluate(() => window.__threeGraph!.instance.graphData().nodes.some(n => n.dead))).toBe(false);
  await page.locator('.graph-settings-btn').click();
  await settled(page);
  await page.evaluate(() => {
    const graph = window.__threeGraph!.instance;
    (window as unknown as { savedNode: Node }).savedNode = graph.graphData().nodes.find(n => n.key === 'topic-0.md')!;
    (window as unknown as { savedCamera: unknown }).savedCamera = graph.cameraPosition();
  });
  writeFileSync(join(vault.path, 'new-topic.md'), '# New\n[[topic-0]]');
  await expect.poll(() => page.evaluate(() => window.__threeGraph!.instance.graphData().nodes.some(n => n.key === 'new-topic.md')), { timeout: 20_000 }).toBe(true);
  expect(await page.evaluate(() => window.__threeGraph!.instance.graphData().nodes.find(n => n.key === 'topic-0.md') === (window as unknown as { savedNode: Node }).savedNode)).toBe(true);
  const cameraShift = await page.evaluate(() => {
    const now = window.__threeGraph!.instance.cameraPosition();
    const before = (window as unknown as { savedCamera: {x:number;y:number;z:number} }).savedCamera;
    return Math.hypot(now.x-before.x, now.y-before.y, now.z-before.z);
  });
  expect(cameraShift).toBeLessThan(0.001);
  rmSync(join(vault.path, 'new-topic.md'));
});

test('WebGL startup failure keeps 3D preference and Retry recovers in place', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('molio.graph.mode', '3d');
    const original = HTMLCanvasElement.prototype.getContext;
    (window as unknown as { restoreWebGL(): void }).restoreWebGL = () => { HTMLCanvasElement.prototype.getContext = original; };
    HTMLCanvasElement.prototype.getContext = function(type: string, ...args: unknown[]) {
      if (type.includes('webgl')) return null;
      return original.apply(this, [type, ...args] as Parameters<typeof original>);
    } as typeof original;
  });
  await page.goto(`/knowledge?vault=${vault.id}`);
  await clickNav(page, 'graph');
  await expect(page.getByTestId('graph-3d-error')).toBeVisible();
  await expect(page.getByTestId('graph-mode-3d')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (window as unknown as { restoreWebGL(): void }).restoreWebGL());
  await page.getByTestId('graph-3d-retry').click();
  await expect(page.getByTestId('graph-3d-error')).toHaveCount(0);
  await expect(page.getByTestId('graph-3d').locator('canvas')).toBeVisible();
  await page.evaluate(() => window.__threeGraph!.instance.renderer().forceContextLoss());
  await expect(page.getByTestId('graph-3d-error')).toBeVisible();
  await page.getByTestId('graph-3d-retry').click();
  await expect(page.getByTestId('graph-3d-error')).toHaveCount(0);
  await expect(page.getByTestId('graph-3d').locator('canvas')).toHaveCount(1);
});
test('document preview retries a transient read failure for the same selected node', async ({ page }) => {
  await open(page);
  let reads = 0; let failRead = true;
  await page.route('**/api/knowledge/vaults/*/files/topic-0.md', async route => {
    reads++;
    if (failRead) await route.fulfill({ status: 503, body: 'Unavailable' });
    else await route.continue();
  });
  await search(page, 'topic-0');
  await expect(page.getByTestId('graph-preview').getByRole('alert')).toBeVisible();
  failRead = false;
  const failedReads = reads;
  await page.getByTestId('graph-preview-retry').click();
  await expect(page.getByTestId('graph-preview')).toContainText('Preview content 0');
  expect(reads).toBeGreaterThan(failedReads);
});

test('selected preview refreshes after editing the document while graph is hidden', async ({ page }) => {
  await open(page);
  await search(page, 'topic-0');
  await expect(page.getByTestId('graph-preview')).toContainText('Preview content 0');
  await page.getByTestId('graph-preview-open').click();
  await expect(page.locator('.kb-wtab.is-active')).toContainText('topic-0.md');
  const file = join(vault.path, 'topic-0.md');
  try {
    writeFileSync(file, '# Topic 0\n\nUpdated preview body\n\n[[topic-1]]\n[[topic-3]]\n[[unresolved]]');
    await clickNav(page, 'graph');
    await expect(page.getByTestId('graph-preview')).toContainText('Updated preview body');
    writeFileSync(file, '# Topic 0\n\nUpdated again while visible\n\n[[topic-1]]\n[[topic-3]]\n[[unresolved]]');
    await expect(page.getByTestId('graph-preview')).toContainText('Updated again while visible', { timeout: 15_000 });
  } finally {
    writeFileSync(file, '# Topic 0\n\nPreview content 0\n\n[[topic-1]]\n[[topic-3]]\n[[unresolved]]');
  }
});

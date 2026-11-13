import { test, expect } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area graph
 * @priority P1
 *
 * 拖拽侧边栏（知识库目录框 / 停靠对话面板）时图谱闪黑屏的回归测试。
 *
 * 机制：容器 resize → 引擎 ResizeObserver → renderer.resize() 只重设 canvas
 * 尺寸、不重绘。ResizeObserver 回调在 rAF 之后、上屏之前执行，清空的 WebGL
 * backing store（background 不透明 → context alpha:false）被合成器当作不透明
 * 纯黑上屏。持续拖拽 = 每帧 resize = 持续黑帧闪烁；松手即恢复。
 *
 * 断言方式（页面内打点，不依赖截图/合成器时序，无 flake）：
 * - 钩 canvas.width 属性 setter（Pixi 经属性赋值改尺寸）打「resize」点；
 * - 钩 gl.clear / drawArrays / drawElements 打「render」点；
 * - 微任务边界判定渲染与 resize 是否在同一事件循环任务：修复后 RO 回调在
 *   resize 后同步补一帧渲染（render 与 resize 同任务）；修复前渲染要等下一帧
 *   rAF（render 落在微任务翻转之后 = next-task）。
 */

let vault: TempVault;

test.describe('graph resize black-flash', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-graph-resize-flash');
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n\n[[beta]]\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n\n[[alpha]]\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('容器 resize 后必须在同一任务里补一帧渲染（否则清空缓冲以黑帧上屏）', async ({ page }) => {
    // 相对路径跟随 config 的 baseURL —— MOLIO_E2E_WEB_PORT 平移端口时不断链
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    // 引擎挂好 canvas 并开始渲染后再打点
    await page.waitForFunction(() => {
      const c = document.querySelector('.graph-pixi canvas');
      return !!c && c.width > 0 && c.height > 0;
    }, null, { timeout: 10_000 });
    await page.waitForTimeout(600); // 布局稳定，避免初始化期的 resize 混进序列

    await page.evaluate(() => {
      const canvas = document.querySelector('.graph-pixi canvas') as HTMLCanvasElement;
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (!gl) throw new Error('WebGL context not found — 图谱引擎未用 WebGL？');

      const evts: string[] = [];
      let sameTask = false;
      // Pixi 的 CanvasSource.resizeCanvas() 经属性赋值改 canvas.width
      const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!;
      Object.defineProperty(canvas, 'width', {
        configurable: true,
        get() { return desc.get!.call(this); },
        set(v: number) {
          desc.set!.call(this, v);
          evts.push('resize');
          // 微任务在当前任务末尾翻转 → 同任务的渲染发生在翻转前
          sameTask = true;
          Promise.resolve().then(() => { sameTask = false; });
        },
      });
      const mark = () => evts.push(sameTask ? 'render:same-task' : 'render:next-task');
      const origClear = gl.clear.bind(gl);
      gl.clear = (mask: number) => { mark(); return origClear(mask); };
      const origDrawArrays = gl.drawArrays.bind(gl);
      gl.drawArrays = (...args: Parameters<typeof gl.drawArrays>) => { mark(); return origDrawArrays(...args); };
      const origDrawElements = gl.drawElements.bind(gl);
      gl.drawElements = (...args: Parameters<typeof gl.drawElements>) => { mark(); return origDrawElements(...args); };

      (window as unknown as { __flashProbe: { evts: string[] } }).__flashProbe = { evts };

      // 触发一次容器 resize（等价于拖拽侧边栏期间一帧的布局变化）
      const el = document.querySelector('.graph-pixi') as HTMLElement;
      el.style.width = `${el.clientWidth - 120}px`;
    });

    await page.waitForTimeout(300); // 等下一帧 rAF 的渲染也发生，序列才完整

    const evts = await page.evaluate(
      () => (window as unknown as { __flashProbe: { evts: string[] } }).__flashProbe.evts,
    );

    const lastResizeIdx = evts.map((e, i) => [e, i] as const).filter(([e]) => e === 'resize').pop();
    expect(lastResizeIdx, '容器 resize 应触发引擎 renderer.resize（canvas.width 被重设）').toBeTruthy();

    const firstRenderAfter = evts.slice(lastResizeIdx![1] + 1).find(e => e.startsWith('render:'));
    // 修复前：render 全部落在微任务之后（下一帧 rAF）→ 拿到 'render:next-task'，测试红
    expect(
      firstRenderAfter,
      'resize 后的第一组渲染必须与 resize 同任务（同步补帧）。否则清空的不透明 WebGL 缓冲' +
      '直接上屏成黑帧——拖拽侧边栏时逐帧 resize → 持续闪黑屏',
    ).toBe('render:same-task');
  });
});

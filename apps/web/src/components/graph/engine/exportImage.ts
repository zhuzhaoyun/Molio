/**
 * 图谱「一键出图」的纯计算部分。
 *
 * 引擎（pixiGraphEngine.ts）只负责 Pixi 调用：取景、`extract.canvas`、还原视口。
 * 所有可算的东西——取景矩形、导出倍率、文件名——都在这里，便于 node:test 回归。
 * 卡片版式（标题/图例/署名）见 exportCard.ts。
 *
 * 坐标系（关键，别改错）：Pixi 的 `extract.canvas({ frame })` 走
 * `generateTexture` → `renderer.render({ container, transform: translate(-frame.x, -frame.y) })`
 * ——`AbstractRenderer.render()` 在给了 transform 时是**替换** container.localTransform，
 * 不是叠加。所以 frame 是 **world(stage-local) 空间**，画布自身的缩放/位移被忽略，
 * 导出的是「世界坐标的原尺寸切片」，与用户当时的 k/t 无关。
 *
 * 于是：取景矩形算 world 空间，画布尺寸只用来定倍率。
 * stage-local = sim + 画布中心偏移；屏幕 = stage-local * k + t。
 */

import { slugifyTitle } from '../../../utils/exportFileName.ts';

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewTransform {
  tx: number;
  ty: number;
  k: number;
}

/**
 * 画布当前可见区域反算回 world 空间。
 *
 * frame 是 world 空间的，所以「只导出看得见的部分」要在这里换算，
 * 而不是像屏幕空间那样直接夹 canvas 0..w。
 */
export function viewportWorldRect(view: ViewTransform, canvas: { w: number; h: number }): Bounds {
  return {
    // tx/ty 为 0 时走 0：否则 -(0)/k 得 -0，在矩形里没有意义还容易看花眼
    x: view.tx ? -view.tx / view.k : 0,
    y: view.ty ? -view.ty / view.k : 0,
    w: canvas.w / view.k,
    h: canvas.h / view.k,
  };
}

/**
 * 取景矩形：内容包围盒四周留 `padding`（world 单位），再夹回可见区域。
 *
 * 夹回是必须的——Pixi 会把目标纹理分配成 frame 那么大的位图，
 * 传出界/超大的矩形要么拿到空白像素，要么直接撑爆显存。
 * 内容完全不重叠或包围盒退化时返回 null，调用方据此放弃导出。
 */
export function computeExportRect(content: Bounds, viewport: Bounds, padding: number): Bounds | null {
  if (!(content.w > 0) || !(content.h > 0)) return null;

  const left = Math.max(viewport.x, content.x - padding);
  const top = Math.max(viewport.y, content.y - padding);
  const right = Math.min(viewport.x + viewport.w, content.x + content.w + padding);
  const bottom = Math.min(viewport.y + viewport.h, content.y + content.h + padding);
  if (right - left <= 0 || bottom - top <= 0) return null;

  return { x: left, y: top, w: right - left, h: bottom - top };
}

export interface ScaleOptions {
  /** 目标输出长边（device px）。 */
  target?: number;
  /** 输出长边的硬上限，防超大图谱导出巨型文件。 */
  maxOutputLongEdge?: number;
}

/**
 * 选导出倍率。`frameLongEdge` 传取景矩形的长边（world 单位 = CSS px 量级），
 * 返回值直接用 Pixi `extract` 的 `resolution`：纹理尺寸 = frame × resolution。
 *
 * 规则：先按目标长边定倍率；但不下采样到 1 world 单位对应不足 1px（宁可超出目标，
 * 也就丢不了信息）；最后按上限封顶——上限优先级最高，超大图谱宁可靠降采样换得住文件大小。
 *
 * 注意这里**不管**当前缩放 k：frame 已经是 world 空间，与 k 无关。
 * 字号之所以在导出图里稳定，是因为标签字号本身就是按 1/k 反算的。
 */
export function resolveExportScale(frameLongEdge: number, opts: ScaleOptions = {}): number {
  const target = opts.target ?? 2000;
  const maxOutputLongEdge = opts.maxOutputLongEdge ?? 4096;
  if (!(frameLongEdge > 0)) return 1;

  return Math.min(Math.max(1, target / frameLongEdge), maxOutputLongEdge / frameLongEdge);
}

/**
 * 导出文件名：`molio-graph-<库名>-20261017-1530.png`。
 *
 * 带库名，是因为「从下载文件夹里翻出一张图」时，`molio-graph-20261017.png`
 * 和 `法考刑法` 的辨识成本差一个量级。库名按 Windows 禁止字符清洗、限长；
 * 清洗后为空（纯符号库名）就退回通用名，不产出 `molio-graph---2026...` 这种名字。
 */
export function exportFileName(date: Date, title?: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const slug = slugifyTitle(title);
  const stem = slug ? `molio-graph-${slug}` : 'molio-graph';
  return `${stem}-${ymd}-${p(date.getHours())}${p(date.getMinutes())}.png`;
}


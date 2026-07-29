/**
 * Minimap — bottom-right minimap showing global node distribution and current viewport.
 *
 * Visual ref: Figma / Miro / Obsidian minimap pattern.
 *
 * 性能策略：按需重绘，不每帧轮询。
 *   • 相机变化（缩放/平移）→ camera 'updated' 事件触发
 *   • 节点移动（物理 tick / 拖拽）→ Sigma 'afterRender' 事件触发
 *   • 节流到 ~16fps，避免抢主渲染帧的 GPU
 *   • 空闲时（无交互、无物理）→ 零重绘
 */

import { useEffect, useRef } from 'react';
import type Sigma from 'sigma';

const WIDTH = 160;
const HEIGHT = 110;
const BG = '#FFFFFF';
const DOT = 'rgba(92,92,92,0.6)';
const VIEWPORT = 'rgba(139,92,246,0.5)';
const VIEWPORT_FILL = 'rgba(139,92,246,0.08)';

// 最大重绘频率（ms），~16fps 足够 minimap 这种粗粒度概览
const THROTTLE_MS = 60;

interface Props {
  sigma: Sigma | null;
  /** 节点拖拽中：跳过重绘，省每帧 ~1-2ms 主线程开销（慢机）；
   *  松手后恢复时的 sigma afterRender 会触发正常重绘 */
  isInteracting?: () => boolean;
}

export function Minimap({ sigma, isInteracting }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!sigma) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const context = ctx;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    context.scale(dpr, dpr);

    let scheduled = false;
    let lastDraw = 0;

    function draw() {
      const graph = sigma!.getGraph();
      const dims = sigma!.getDimensions();

      // 世界框必须与主相机归一化用同一基准 = customBBox || nodeExtent。
      // 关键坑：sigma.getBBox() 只返回实时 nodeExtent、无视 customBBox！拖拽时主相机被
      // setCustomBBox 冻结（normalization 用 customBBox），但「全流动」解锁的孤立节点会飞散
      // 撑大实时 nodeExtent → 若 minimap 用实时包围盒，世界框被撑大、中心簇缩成一小团 +
      // 角落飞点（用户截图的图二）。改用 getCustomBBox() ?? getBBox()——与 normalizationFunction
      // 同源：拖拽中用冻结 customBBox，世界框/视口框稳定，飞散节点画到框外被裁掉（=图一）。
      const bbox = sigma!.getCustomBBox() ?? sigma!.getBBox();
      const minX = bbox.x[0];
      const maxX = bbox.x[1];
      const minY = bbox.y[0];
      const maxY = bbox.y[1];

      if (!isFinite(minX) || !isFinite(maxX)) return;

      const gW = maxX - minX || 1;
      const gH = maxY - minY || 1;
      const pad = 0.08;
      const scaleX = (WIDTH * (1 - pad * 2)) / gW;
      const scaleY = (HEIGHT * (1 - pad * 2)) / gH;
      const scale = Math.min(scaleX, scaleY);
      const offsetX = (WIDTH - gW * scale) / 2 - minX * scale;
      const offsetY = (HEIGHT - gH * scale) / 2 - minY * scale;

      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = BG;
      context.beginPath();
      context.roundRect(0, 0, WIDTH, HEIGHT, 4);
      context.fill();
      context.strokeStyle = 'rgba(0,0,0,0.06)';
      context.lineWidth = 1;
      context.stroke();

      context.save();
      context.beginPath();
      context.roundRect(0, 0, WIDTH, HEIGHT, 4);
      context.clip();

      context.fillStyle = DOT;
      graph.forEachNode((_, attr) => {
        const x = ((attr.x as number) ?? 0) * scale + offsetX;
        const y = ((attr.y as number) ?? 0) * scale + offsetY;
        context.fillRect(x - 1, y - 1, 2, 2);
      });

      // 视口框：camera.x/y 是归一化坐标，不能和原始图坐标混用（同 zoomToNode 的
      // 坐标系坑）。改用 viewportToGraph 求四角的可视区域（原始图坐标），与
      // 节点共用同一套 scale/offset 映射，视口框才落在正确位置。
      const corners: [number, number][] = [
        [0, 0],
        [dims.width, 0],
        [0, dims.height],
        [dims.width, dims.height],
      ];
      let vMinX = Infinity, vMaxX = -Infinity, vMinY = Infinity, vMaxY = -Infinity;
      for (const [px, py] of corners) {
        const gp = sigma!.viewportToGraph({ x: px, y: py });
        if (gp.x < vMinX) vMinX = gp.x;
        if (gp.x > vMaxX) vMaxX = gp.x;
        if (gp.y < vMinY) vMinY = gp.y;
        if (gp.y > vMaxY) vMaxY = gp.y;
      }
      const vx = vMinX * scale + offsetX;
      const vy = vMinY * scale + offsetY;
      const vw = (vMaxX - vMinX) * scale;
      const vh = (vMaxY - vMinY) * scale;

      context.fillStyle = VIEWPORT_FILL;
      context.fillRect(vx, vy, vw, vh);
      context.strokeStyle = VIEWPORT;
      context.lineWidth = 1;
      context.strokeRect(vx, vy, vw, vh);

      context.restore();
    }

    // 按需 + 节流的重绘调度
    function scheduleDraw() {
      if (isInteracting?.()) return; // 节点拖拽期间跳过（松手后的 afterRender 恢复重绘）
      if (scheduled) return;
      const elapsed = performance.now() - lastDraw;
      const delay = Math.max(0, THROTTLE_MS - elapsed);
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        lastDraw = performance.now();
        requestAnimationFrame(() => draw());
      }, delay);
    }

    // 相机变化（缩放/平移/拖拽）→ 立即调度
    sigma.getCamera().on('updated', scheduleDraw);
    // 节点移动（物理 tick 后的渲染帧）→ 调度（节流到 16fps）
    sigma.on('afterRender', scheduleDraw);

    draw(); // 首次绘制

    return () => {
      sigma.getCamera().removeListener('updated', scheduleDraw);
      sigma.removeListener('afterRender', scheduleDraw);
    };
  }, [sigma]);

  return (
    <canvas
      ref={canvasRef}
      className="graph-minimap"
      width={WIDTH}
      height={HEIGHT}
    />
  );
}

/**
 * Minimap — bottom-right minimap showing global node distribution and current viewport.
 *
 * 数据来自 PixiGraphEngine.getSnapshot()（节点位置 + 视口，graph 坐标）。
 * 事件驱动重绘：订阅引擎 render 事件，仅在变化时绘制，空闲零开销
 * （取代旧版每帧 rAF 轮询）。
 * 可交互：点击任意位置跳转视口；按住拖拽视口矩形导航。
 * Visual ref: Figma / Miro / Obsidian minimap pattern.
 */

import { useEffect, useRef } from 'react';
import type { PixiGraphEngine } from './engine/pixiGraphEngine';

const WIDTH = 160;
const HEIGHT = 110;

interface Props {
  engine: PixiGraphEngine | null;
  dark?: boolean;
}

/** 最近一帧的映射参数：minimap 坐标 = graph 坐标 * scale + offset */
interface MapTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function Minimap({ engine, dark = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!engine) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const context = ctx; // TS narrowing for closure capture

    const BG = dark ? '#1A1D2A' : '#FFFFFF';
    const DOT = dark ? 'rgba(156,163,175,0.6)' : 'rgba(92,92,92,0.6)';
    const BORDER = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const VIEWPORT = 'rgba(139,92,246,0.5)';
    const VIEWPORT_FILL = 'rgba(139,92,246,0.08)';

    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ── 最近一帧的状态（pointer 事件据此做 minimap → graph 反变换）──
    let map: MapTransform | null = null;
    /** 视口矩形（minimap 像素坐标） */
    let viewRect: { x: number; y: number; w: number; h: number } | null = null;
    /** 视口（graph 坐标） */
    let viewGraph: { x: number; y: number; w: number; h: number } | null = null;

    let dragging = false;
    /** 按下点相对视口中心的偏移（graph 坐标）——抓矩形时不让它跳到光标中心 */
    let grabOffset = { x: 0, y: 0 };

    function draw() {
      const snap = engine!.getSnapshot();
      if (!snap || snap.nodes.length === 0) {
        map = null;
        viewRect = null;
        viewGraph = null;
        context.clearRect(0, 0, WIDTH, HEIGHT);
        return;
      }

      // Compute bounds
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of snap.nodes) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      if (!isFinite(minX)) return;

      const gW = maxX - minX || 1;
      const gH = maxY - minY || 1;
      const pad = 0.08;
      const scaleX = (WIDTH * (1 - pad * 2)) / gW;
      const scaleY = (HEIGHT * (1 - pad * 2)) / gH;
      const scale = Math.min(scaleX, scaleY);
      const offsetX = (WIDTH - gW * scale) / 2 - minX * scale;
      const offsetY = (HEIGHT - gH * scale) / 2 - minY * scale;
      map = { scale, offsetX, offsetY };

      // Clear and draw background
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = BG;
      context.beginPath();
      context.roundRect(0, 0, WIDTH, HEIGHT, 4);
      context.fill();
      context.strokeStyle = BORDER;
      context.lineWidth = 1;
      context.stroke();

      // Clip to rounded rect so dots don't overflow
      context.save();
      context.beginPath();
      context.roundRect(0, 0, WIDTH, HEIGHT, 4);
      context.clip();

      // Draw dots for nodes
      context.fillStyle = DOT;
      for (const n of snap.nodes) {
        const x = n.x * scale + offsetX;
        const y = n.y * scale + offsetY;
        context.fillRect(x - 1, y - 1, 2, 2);
      }

      // Viewport rectangle (graph coords → minimap coords)
      const vx = snap.view.x * scale + offsetX;
      const vy = snap.view.y * scale + offsetY;
      const vw = snap.view.w * scale;
      const vh = snap.view.h * scale;
      viewRect = { x: vx, y: vy, w: vw, h: vh };
      viewGraph = { ...snap.view };

      context.fillStyle = VIEWPORT_FILL;
      context.fillRect(vx, vy, vw, vh);
      context.strokeStyle = VIEWPORT;
      context.lineWidth = 1;
      context.strokeRect(vx, vy, vw, vh);

      context.restore();
    }

    // ── Pointer 交互：点击跳转 / 拖拽视口矩形导航 ──

    const localPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const toGraph = (mx: number, my: number) => {
      // map 由调用方保证非空
      const m = map!;
      return { x: (mx - m.offsetX) / m.scale, y: (my - m.offsetY) / m.scale };
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !map || !viewRect || !viewGraph) return;
      const p = localPos(e);
      const g = toGraph(p.x, p.y);

      const inside =
        p.x >= viewRect.x && p.x <= viewRect.x + viewRect.w &&
        p.y >= viewRect.y && p.y <= viewRect.y + viewRect.h;

      if (inside) {
        // 抓住视口矩形：记录点击点相对中心的偏移，拖拽时不跳动
        const cx = viewGraph.x + viewGraph.w / 2;
        const cy = viewGraph.y + viewGraph.h / 2;
        grabOffset = { x: g.x - cx, y: g.y - cy };
      } else {
        // 点击矩形外：先平滑跳转过去，再进入拖拽（直写会打断此动画，衔接自然）
        grabOffset = { x: 0, y: 0 };
        engine!.centerOnGraphPoint(g.x, g.y, { animate: true, durationMs: 250 });
      }

      dragging = true;
      canvas.classList.add('is-dragging');
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch { /* 合成事件/指针已释放时可能失败，忽略 */ }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !map) return;
      const p = localPos(e);
      const g = toGraph(p.x, p.y);
      // 直写跟手（setTransformImmediate 语义：打断进行中的相机动画）
      engine!.centerOnGraphPoint(g.x - grabOffset.x, g.y - grabOffset.y, { animate: false });
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      canvas.classList.remove('is-dragging');
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch { /* pointer capture 可能已释放 */ }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    // 初始一帧 + 订阅引擎渲染事件（仅变化时重绘，空闲零开销）
    draw();
    const unsubscribe = engine.subscribeRender(draw);

    return () => {
      unsubscribe();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [engine, dark]);

  return (
    <canvas
      ref={canvasRef}
      className="graph-minimap"
      data-testid="graph-minimap"
    />
  );
}

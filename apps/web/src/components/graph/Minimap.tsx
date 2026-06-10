/**
 * Minimap — bottom-right minimap showing global node distribution and current viewport.
 *
 * Visual ref: Figma / Miro / Obsidian minimap pattern.
 */

import { useEffect, useRef } from 'react';
import type Sigma from 'sigma';

const WIDTH = 160;
const HEIGHT = 110;
const BG = '#FFFFFF';
const DOT = 'rgba(92,92,92,0.6)';
const VIEWPORT = 'rgba(139,92,246,0.5)';
const VIEWPORT_FILL = 'rgba(139,92,246,0.08)';

interface Props {
  sigma: Sigma | null;
}

export function Minimap({ sigma }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!sigma) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const context = ctx; // TS narrowing for closure capture

    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    context.scale(dpr, dpr);

    let raf = 0;

    function draw() {
      raf = requestAnimationFrame(draw);

      const graph = sigma!.getGraph();
      const camera = sigma!.getCamera();
      const dims = sigma!.getDimensions();

      // Collect node positions and compute bounds
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      graph.forEachNode((_, attr) => {
        const x = (attr.x as number) ?? 0;
        const y = (attr.y as number) ?? 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });

      if (!isFinite(minX)) return;

      const gW = maxX - minX || 1;
      const gH = maxY - minY || 1;
      const pad = 0.08;
      const scaleX = (WIDTH * (1 - pad * 2)) / gW;
      const scaleY = (HEIGHT * (1 - pad * 2)) / gH;
      const scale = Math.min(scaleX, scaleY);
      const offsetX = (WIDTH - gW * scale) / 2 - minX * scale;
      const offsetY = (HEIGHT - gH * scale) / 2 - minY * scale;

      // Clear and draw background
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = BG;
      context.beginPath();
      context.roundRect(0, 0, WIDTH, HEIGHT, 4);
      context.fill();
      context.strokeStyle = 'rgba(0,0,0,0.06)';
      context.lineWidth = 1;
      context.stroke();

      // Clip to rounded rect so dots don't overflow
      context.save();
      context.beginPath();
      context.roundRect(0, 0, WIDTH, HEIGHT, 4);
      context.clip();

      // Draw dots for nodes
      context.fillStyle = DOT;
      graph.forEachNode((_, attr) => {
        const x = ((attr.x as number) ?? 0) * scale + offsetX;
        const y = ((attr.y as number) ?? 0) * scale + offsetY;
        context.fillRect(x - 1, y - 1, 2, 2);
      });

      // Compute viewport rectangle in graph coordinates
      // Camera (cx, cy) is the graph coordinate at the center of the viewport
      const viewHW = dims.width / camera.ratio / 2;
      const viewHH = dims.height / camera.ratio / 2;
      const vx = (camera.x - viewHW) * scale + offsetX;
      const vy = (camera.y - viewHH) * scale + offsetY;
      const vw = viewHW * 2 * scale;
      const vh = viewHH * 2 * scale;

      context.fillStyle = VIEWPORT_FILL;
      context.fillRect(vx, vy, vw, vh);
      context.strokeStyle = VIEWPORT;
      context.lineWidth = 1;
      context.strokeRect(vx, vy, vw, vh);

      context.restore();
    }

    draw();

    return () => {
      cancelAnimationFrame(raf);
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
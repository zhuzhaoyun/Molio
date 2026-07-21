/**
 * Camera inertia + cumulative-velocity zoom.
 *
 * ── 平移惯性 ──
 * 拖拽释放后相机滑行衰减。
 *
 * ── 缩放：累积 velocity 模型（对齐 Obsidian 丝滑感）──
 * 不用 Sigma 的"每 tick 独立 camera.animate(250ms) + 50ms 同向节流丢帧"机制，
 * 改为：wheel 事件累积 deltaY → velocity → 持续 RAF 每帧应用并衰减。
 *
 * 关键防抖点：
 *   • 每帧（60fps）调 camera.setState → 触发 Sigma 渲染 = 连续运动，非 per-tick 跳变
 *   • wheel 事件再多都吸收成累积 velocity，不丢帧
 *   • 走 Sigma 原生 getViewportZoomedState 做 zoom-to-cursor + setState 渲染管道
 *   • velocity 衰减 → 滚轮停止后惯性滑行，而非戛然而止
 *
 * 自适应步长（远大近小）：gain 随 ratio 变化，低 ratio（全景）增益大，高 ratio（近景）增益小。
 *
 * Usage:
 *   const cleanup = setupCameraInertia(sigma);
 */

import type Sigma from 'sigma';
import type { WheelCoords } from 'sigma/types';

// ── 平移惯性 ──
const PAN_DAMPING = 0.88;
const MIN_PAN_VEL = 0.15;

// ── 缩放 velocity ──
const ZOOM_VEL_DAMPING = 0.86;   // 每帧衰减，~500ms 衰减殆尽
const ZOOM_VEL_MIN = 0.0004;     // 低于此值停止循环
// gain = BASE + AMP × exp(-ratio × DECAY)，镜像自适应曲线形状
const ZOOM_GAIN_BASE = 0.0015;
const ZOOM_GAIN_AMP = 0.004;
const ZOOM_GAIN_DECAY = 0.5;

/** 根据 ratio 计算增益（远大近小）。 */
function zoomGain(ratio: number): number {
  return ZOOM_GAIN_BASE + ZOOM_GAIN_AMP * Math.exp(-ratio * ZOOM_GAIN_DECAY);
}

export function setupCameraInertia(sigma: Sigma): () => void {
  const camera = sigma.getCamera();
  const mouseCaptor = sigma.getMouseCaptor();

  // ── 平移惯性 ──
  let panRaf = 0;
  let panRunning = false;
  const panVel = { x: 0, y: 0 };
  let prevCamX = camera.x;
  let prevCamY = camera.y;
  let isDragging = false;

  function panTick() {
    if (isDragging) {
      panVel.x = camera.x - prevCamX;
      panVel.y = camera.y - prevCamY;
      prevCamX = camera.x;
      prevCamY = camera.y;
      panRaf = requestAnimationFrame(panTick);
      return;
    }
    panVel.x *= PAN_DAMPING;
    panVel.y *= PAN_DAMPING;
    if (Math.abs(panVel.x) <= MIN_PAN_VEL && Math.abs(panVel.y) <= MIN_PAN_VEL) {
      panRunning = false;
      return;
    }
    camera.x += panVel.x;
    camera.y += panVel.y;
    prevCamX = camera.x;
    prevCamY = camera.y;
    panRaf = requestAnimationFrame(panTick);
  }

  const downHandler = () => {
    isDragging = true;
    prevCamX = camera.x;
    prevCamY = camera.y;
    if (!panRunning) { panRunning = true; panRaf = requestAnimationFrame(panTick); }
  };
  const upHandler = () => {
    isDragging = false;
    if (Math.abs(panVel.x) > MIN_PAN_VEL || Math.abs(panVel.y) > MIN_PAN_VEL) {
      panVel.x *= 0.8;
      panVel.y *= 0.8;
    }
  };

  // ── 缩放：累积 velocity 模型 ──
  let zoomVel = 0;           // 累积的对数空间 velocity（>0 缩小，<0 放大）
  let zoomMouseX = 0;        // 最近一次 wheel 的视口坐标（用于 zoom-to-cursor）
  let zoomMouseY = 0;
  let zoomRaf = 0;
  let zoomRunning = false;

  function zoomTick() {
    if (Math.abs(zoomVel) < ZOOM_VEL_MIN) {
      zoomVel = 0;
      zoomRunning = false;
      return;
    }

    const ratio = camera.ratio;
    // zoomVel > 0 → 缩小（ratio 减小）；< 0 → 放大
    // 每帧应用一次：newRatio = ratio × exp(-zoomVel)
    let newRatio = ratio * Math.exp(-zoomVel);
    newRatio = Math.max(0.2, Math.min(80, newRatio));

    // zoom-to-cursor：保持鼠标位置的图坐标不动
    const target = sigma.getViewportZoomedState(
      { x: zoomMouseX, y: zoomMouseY },
      newRatio,
    );
    camera.setState(target); // 触发 Sigma 渲染

    // 衰减 velocity → 惯性滑行
    zoomVel *= ZOOM_VEL_DAMPING;

    zoomRaf = requestAnimationFrame(zoomTick);
  }

  const wheelHandler = (coords: WheelCoords) => {
    // 阻止 Sigma 原生 per-tick animate + 50ms 节流丢帧
    coords.preventSigmaDefault();

    // coords.x/y 已是相对 container 的视口坐标，直接用于 zoom-to-cursor
    zoomMouseX = coords.x;
    zoomMouseY = coords.y;

    // 累积 velocity，gain 随 ratio 自适应（远大近小）
    const gain = zoomGain(camera.ratio);
    // coords.delta 是 Sigma 归一化后的 wheel delta（>0 缩小方向）
    zoomVel += coords.delta * gain;

    if (!zoomRunning) {
      zoomRunning = true;
      zoomRaf = requestAnimationFrame(zoomTick);
    }
  };

  mouseCaptor.on('wheel', wheelHandler);
  sigma.on('downStage', downHandler);
  sigma.on('upStage', upHandler);

  return () => {
    cancelAnimationFrame(panRaf);
    cancelAnimationFrame(zoomRaf);
    mouseCaptor.removeListener('wheel', wheelHandler);
    sigma.removeListener('downStage', downHandler);
    sigma.removeListener('upStage', upHandler);
    panRunning = false;
    zoomRunning = false;
  };
}

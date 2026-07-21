/**
 * simulation.worker.ts — d3-force physics in a Web Worker.
 *
 * Used only for large graphs (> WORKER_THRESHOLD nodes) to avoid
 * blocking the main thread with expensive forceManyBody calculations.
 *
 * For small graphs, useSimulation runs d3-force on the main thread instead.
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

// ── Types ──

interface WorkerNode extends SimulationNodeDatum {
  id: string;
  radius: number;
}

interface WorkerLink extends SimulationLinkDatum<WorkerNode> {
  source: string;
  target: string;
}

interface ForceParams {
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}

// ── State ──

let sim: ReturnType<typeof forceSimulation<WorkerNode>> | null = null;
let nodes: WorkerNode[] = [];
let tickCount = 0;
// Throttle: send every Nth tick to avoid flooding main thread
const TICK_THROTTLE = 3;

// ── Message Handler ──

self.onmessage = function (e: MessageEvent) {
  const { type } = e.data as { type: string };

  switch (type) {
    case 'init':
      handleInit(e.data);
      break;
    case 'wake':
      handleWake(e.data);
      break;
    case 'stop':
      handleStop();
      break;
    case 'setForce':
      handleSetForce(e.data);
      break;
    case 'drag':
      handleDrag(e.data);
      break;
  }
};

// ── Init ──

interface InitMessage {
  type: 'init';
  nodes: WorkerNode[];
  links: WorkerLink[];
  params: ForceParams;
}

function handleInit(msg: InitMessage) {
  nodes = msg.nodes;
  const links: WorkerLink[] = msg.links;
  const p = msg.params;

  sim = forceSimulation<WorkerNode>(nodes)
    .force(
      'link',
      forceLink<WorkerNode, WorkerLink>(links)
        .id((d) => d.id)
        .distance(p.linkDistance)
        .strength(p.linkStrength),
    )
    .force('charge', forceManyBody<WorkerNode>().strength(p.repelStrength).distanceMax(250))
    // 边界距离碰撞：padding 按半径比例 + 多次迭代，与主线程模式一致
    .force('collide', forceCollide<WorkerNode>()
      .radius((d) => d.radius * (1 + 0.35))
      .iterations(3))
    .force('x', forceX<WorkerNode>((d) => (d.fx != null ? d.fx : 0)).strength(p.centerStrength))
    .force('y', forceY<WorkerNode>((d) => (d.fy != null ? d.fy : 0)).strength(p.centerStrength))
    .alphaDecay(0.03)
    .velocityDecay(0.35)
    .on('tick', onTick);

  self.postMessage({ type: 'ready' });
}

function onTick() {
  tickCount++;
  if (tickCount % TICK_THROTTLE !== 0) return;

  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    positions[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
  }
  if (sim) {
    self.postMessage({ type: 'tick', positions });
  }
}

// ── Wake ──

function handleWake(msg: { alpha: number }) {
  if (sim) sim.alpha(msg.alpha ?? 0.15).restart();
}

// ── Stop ──

function handleStop() {
  if (sim) sim.stop();
}

// ── Set Force Param ──

function handleSetForce(msg: { name: string; value: number }) {
  if (!sim) return;
  const { name, value } = msg;

  switch (name) {
    case 'centerStrength': {
      (sim.force('x') as any)?.strength(value);
      (sim.force('y') as any)?.strength(value);
      break;
    }
    case 'repelStrength':
      (sim.force('charge') as any)?.strength(value);
      break;
    case 'linkStrength':
      (sim.force('link') as any)?.strength(value);
      break;
    case 'linkDistance':
      (sim.force('link') as any)?.distance(value);
      break;
  }
  sim.alpha(0.3).restart();
}

// ── Drag ──

function handleDrag(msg: { id: string; fx: number | null; fy: number | null }) {
  const node = nodes.find((n) => n.id === msg.id);
  if (node) {
    node.fx = msg.fx;
    node.fy = msg.fy;
  }
}

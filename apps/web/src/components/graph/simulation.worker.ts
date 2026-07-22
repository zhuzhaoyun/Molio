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

// ── Multi-Level Layout Types ──

interface CoarseNode {
  id: number;
  members: string[];
  radius: number;
  edgeWeights: Map<number, number>;
  degree: number;
}

interface CoarseEdge {
  source: number;
  target: number;
  weight: number;
}

interface CoarseLevel {
  level: number;
  supernodes: CoarseNode[];
  edges: CoarseEdge[];
  nodeToSuper: Map<string, number>;
}

// ── State ──

let sim: ReturnType<typeof forceSimulation<WorkerNode>> | null = null;
let nodes: WorkerNode[] = [];
let tickCount = 0;
// Throttle: send every Nth tick to avoid flooding main thread
const TICK_THROTTLE = 3;

// ── Multi-Level Layout State ──
let mlLevels: CoarseLevel[] = [];
let mlRunning = false;

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

// ── Multi-Level: Walshaw Coarsening ──

function coarsen(
  prevNodes: { id: string; radius: number }[],
  prevEdges: { source: string; target: string }[],
  nodeCount: number,
): { nodes: CoarseNode[]; edges: CoarseEdge[]; nodeToSuper: Map<string, number> } {
  // Random permutation
  const perm = Array.from({ length: nodeCount }, (_, i) => prevNodes[i].id);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }

  // Adjacency
  const adj = new Map<string, Set<string>>();
  for (const n of prevNodes) adj.set(n.id, new Set());
  for (const e of prevEdges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }

  const radii = new Map<string, number>();
  for (const n of prevNodes) radii.set(n.id, n.radius);

  // Matching pass
  const matched = new Set<string>();
  const nodeToSuper = new Map<string, number>();
  const supernodes: CoarseNode[] = [];
  let superId = 0;

  for (const vid of perm) {
    if (matched.has(vid)) continue;

    const neighbors = adj.get(vid);
    let matchTarget: string | null = null;
    if (neighbors && neighbors.size > 0) {
      const candidates = [...neighbors].filter((n) => !matched.has(n));
      if (candidates.length > 0) {
        let bestDeg = -1;
        for (const c of candidates) {
          const deg = adj.get(c)?.size ?? 0;
          if (deg > bestDeg) { bestDeg = deg; matchTarget = c; }
        }
      }
    }

    if (matchTarget) {
      const r1 = radii.get(vid) ?? 6;
      const r2 = radii.get(matchTarget) ?? 6;
      matched.add(vid); matched.add(matchTarget);
      nodeToSuper.set(vid, superId); nodeToSuper.set(matchTarget, superId);
      supernodes.push({
        id: superId,
        members: [vid, matchTarget],
        radius: Math.sqrt(r1 * r1 + r2 * r2),
        edgeWeights: new Map(),
        degree: 0,
      });
    } else {
      matched.add(vid);
      nodeToSuper.set(vid, superId);
      supernodes.push({
        id: superId,
        members: [vid],
        radius: radii.get(vid) ?? 6,
        edgeWeights: new Map(),
        degree: 0,
      });
    }
    superId++;
  }

  // Edge merging
  const edgeMap = new Map<string, CoarseEdge>();
  for (const e of prevEdges) {
    const sa = nodeToSuper.get(e.source);
    const sb = nodeToSuper.get(e.target);
    if (sa === undefined || sb === undefined || sa === sb) continue;
    const key = sa < sb ? `${sa}|${sb}` : `${sb}|${sa}`;
    if (edgeMap.has(key)) {
      edgeMap.get(key)!.weight++;
    } else {
      edgeMap.set(key, { source: sa, target: sb, weight: 1 });
      supernodes[sa].degree++;
      supernodes[sb].degree++;
    }
  }

  return { nodes: supernodes, edges: [...edgeMap.values()], nodeToSuper };
}

function buildCoarseLevels(
  nodes: { id: string; radius: number }[],
  edges: { source: string; target: string }[],
  maxLevels: number,
  minFraction: number,
): { levels: CoarseLevel[]; coarsestNodes: CoarseNode[]; coarsestEdges: CoarseEdge[] } {
  const originalCount = nodes.length;
  const threshold = Math.max(30, Math.ceil(originalCount * minFraction));
  const levels: CoarseLevel[] = [];

  let currentNodes: { id: string; radius: number }[] = nodes;
  let currentEdges = edges;
  let currentNodeCount = originalCount;

  for (let level = 1; level <= maxLevels; level++) {
    const result = coarsen(currentNodes, currentEdges, currentNodeCount);
    levels.push({
      level,
      supernodes: result.nodes,
      edges: result.edges,
      nodeToSuper: result.nodeToSuper,
    });

    if (result.nodes.length <= threshold || result.nodes.length <= 30) {
      return { levels, coarsestNodes: result.nodes, coarsestEdges: result.edges };
    }

    currentNodes = result.nodes.map((sn) => ({ id: String(sn.id), radius: sn.radius }));
    currentEdges = result.edges.map((e) => ({ source: String(e.source), target: String(e.target) }));
    currentNodeCount = result.nodes.length;
  }

  const last = levels[levels.length - 1];
  return { levels, coarsestNodes: last.supernodes, coarsestEdges: last.edges };
}

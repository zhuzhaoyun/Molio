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
    case 'multi-level-init':
      handleMultiLevelInit(e.data);
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
    .force('charge', forceManyBody<WorkerNode>().strength(p.repelStrength))
    // 边界距离碰撞：padding 按半径比例 + 多次迭代，与主线程模式一致
    .force('collide', forceCollide<WorkerNode>()
      .radius((d) => d.radius * (1 + 0.5))
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
        degree: 0,
      });
    } else {
      matched.add(vid);
      nodeToSuper.set(vid, superId);
      supernodes.push({
        id: superId,
        members: [vid],
        radius: radii.get(vid) ?? 6,
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

// ── Multi-Level: Coarse Layout ──

/**
 * Synchronous d3-force layout on the coarsest graph.
 * Uses enhanced repulsion + weak centering for cluster separation.
 */
function coarseLayoutSync(
  supernodes: CoarseNode[],
  edges: CoarseEdge[],
  params: ForceParams,
  onPositionUpdate: (positions: Record<string, { x: number; y: number }>) => void,
  originalPositions?: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  // Build flat d3-force nodes using member centroids as initial positions.
  // This preserves the existing layout structure (circular) and only
  // lets the coarse layout improve cluster separation from a good start.
  const d3Nodes = supernodes.map((n) => {
    let cx = 0, cy = 0, cnt = 0;
    const initPos = originalPositions;
    if (initPos) {
      for (const m of n.members) {
        const p = initPos.get(m);
        if (p) { cx += p.x; cy += p.y; cnt++; }
      }
    }
    if (cnt > 0) { cx /= cnt; cy /= cnt; }
    return {
      id: n.id,
      x: cnt > 0 ? cx : (Math.random() - 0.5) * 50,
      y: cnt > 0 ? cy : (Math.random() - 0.5) * 50,
      radius: n.radius,
    };
  });

  const maxWeight = Math.max(1, ...edges.map((e) => e.weight));
  const d3Links = edges.map((e) => ({
    source: e.source,
    target: e.target,
    strength: (params.linkStrength * e.weight) / maxWeight,
  }));

  const sim = forceSimulation(d3Nodes as any)
    .force('link', forceLink(d3Links)
      .id((d: any) => d.id)
      .distance(params.linkDistance)
      .strength((d: any) => d.strength))
    .force('charge', forceManyBody().strength(params.repelStrength))
    .force('collide', forceCollide().radius((d: any) => d.radius * 1.5).iterations(3))
    .force('x', forceX().strength(params.centerStrength))
    .force('y', forceY().strength(params.centerStrength))
    .alphaDecay(0.03)
    .velocityDecay(0.35);

  let tickCount = 0;
  const MAX_TICKS = 2000;
  const SEND_INTERVAL = 12;

  while (sim.alpha() >= 0.001 && tickCount < MAX_TICKS) {
    sim.tick();
    tickCount++;

    if (tickCount % SEND_INTERVAL === 0) {
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of d3Nodes) pos[String(n.id)] = { x: n.x ?? 0, y: n.y ?? 0 };
      onPositionUpdate(pos);
    }
  }
  sim.stop();

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of d3Nodes) positions.set(String(n.id), { x: n.x ?? 0, y: n.y ?? 0 });
  return positions;
}

// ── Multi-Level: Prolongation + Refinement ──

/**
 * Prolongate coarse positions level-by-level, then refine original graph.
 * The final refinement uses weak repulsion (30 %) to avoid breaking cluster structure.
 */
function prolongateAndRefine(
  levels: CoarseLevel[],
  coarsestPositions: Map<string, { x: number; y: number }>,
  originalNodes: { id: string; radius: number }[],
  originalEdges: { source: string; target: string }[],
  params: ForceParams,
  refineTicks: number,
): Record<string, { x: number; y: number }> {
  // All positions stored with string keys consistently across levels
  // during prolongation; type widened to support both.
  let currentPositions: Map<string, { x: number; y: number }> = coarsestPositions;

  // Prolongate: coarsest → level[last - 1] → ... → level[0] (which maps to original nodes)
  for (let li = levels.length - 1; li >= 0; li--) {
    const level = levels[li];
    const nextPositions = new Map<string, { x: number; y: number }>();

    for (const sn of level.supernodes) {
      const superPos = currentPositions.get(String(sn.id));
      if (!superPos) continue;
      const scale = Math.max(1, sn.radius * 0.05);
      for (const memberId of sn.members) {
        nextPositions.set(memberId, {
          x: superPos.x + (Math.random() - 0.5) * scale,
          y: superPos.y + (Math.random() - 0.5) * scale,
        });
      }
    }
    currentPositions = nextPositions;
  }

  // Now currentPositions has positions for all original node IDs
  // Run short refinement on the full graph
  const d3Nodes = originalNodes.map((n) => {
    const pos = currentPositions.get(n.id);
    return {
      id: n.id,
      x: pos?.x ?? (Math.random() - 0.5) * 100,
      y: pos?.y ?? (Math.random() - 0.5) * 100,
      radius: n.radius,
    };
  });

  const d3Links = originalEdges.map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(d3Nodes as any)
    .force('link', forceLink(d3Links).id((d: any) => d.id)
      .distance(params.linkDistance).strength(params.linkStrength))
    .force('charge', forceManyBody().strength(params.repelStrength))
    .force('collide', forceCollide().radius((d: any) => d.radius * 1.5).iterations(3))
    .force('x', forceX().strength(params.centerStrength))
    .force('y', forceY().strength(params.centerStrength))
    .alphaDecay(0.03)
    .velocityDecay(0.35);

  for (let i = 0; i < refineTicks; i++) sim.tick();
  sim.stop();

  const result: Record<string, { x: number; y: number }> = {};
  for (const n of d3Nodes) result[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
  return result;
}

// ── Multi-Level: Init Handler ──

function handleMultiLevelInit(msg: {
  nodes: { id: string; x: number; y: number; radius: number }[];
  links: { source: string; target: string }[];
  params: ForceParams;
  maxLevels?: number;
  minFraction?: number;
  refineTicks?: number;
}) {
  if (mlRunning) return;
  mlRunning = true;

  try {
    const maxLevels = msg.maxLevels ?? 5;
    const minFraction = msg.minFraction ?? 0.05;
    const refineTicks = msg.refineTicks ?? 250;
    const origNodes = msg.nodes.map((n) => ({ id: n.id, radius: n.radius }));
    const origEdges = msg.links;

    // Phase 1: Coarsening
    self.postMessage({ type: 'multi-level-progress', phase: 'coarsen', progress: 0.1 });
    const { levels, coarsestNodes, coarsestEdges } = buildCoarseLevels(
      origNodes, origEdges, maxLevels, minFraction,
    );
    self.postMessage({ type: 'multi-level-progress', phase: 'coarsen', progress: 0.3 });

    // Phase 2: Coarse layout (sends coarse-tick during simulation)
    self.postMessage({ type: 'multi-level-progress', phase: 'coarse-layout', progress: 0.35 });
    // Build original positions map for centroid-based initial positions
    const origPositions = new Map<string, { x: number; y: number }>();
    for (const n of msg.nodes) origPositions.set(n.id, { x: n.x, y: n.y });
    const coarsePositions = coarseLayoutSync(
      coarsestNodes, coarsestEdges, msg.params,
      (pos) => {
        // Map supernode positions to member IDs for progressive rendering
        const mapped: Record<string, { x: number; y: number }> = {};
        for (const sn of coarsestNodes) {
          const p = pos[String(sn.id)];
          if (p) for (const m of sn.members) mapped[m] = p;
        }
        self.postMessage({ type: 'coarse-tick', positions: mapped });
      },
      origPositions,
    );
    self.postMessage({ type: 'multi-level-progress', phase: 'coarse-layout', progress: 0.6 });

    // Phase 3: Prolongation + Refinement
    self.postMessage({ type: 'multi-level-progress', phase: 'refine', progress: 0.65 });
    const finalPositions = prolongateAndRefine(
      levels, coarsePositions, origNodes, origEdges, msg.params, refineTicks,
    );
    self.postMessage({ type: 'multi-level-progress', phase: 'refine', progress: 0.95 });

    self.postMessage({ type: 'multi-level-done', positions: finalPositions });
  } catch (err) {
    self.postMessage({
      type: 'multi-level-error',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    mlRunning = false;
  }
}

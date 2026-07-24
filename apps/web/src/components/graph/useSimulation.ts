/**
 * useSimulation — d3-force physics engine, adaptive Web Worker.
 *
 * Automatically selects execution mode based on graph size:
 *   <  WORKER_THRESHOLD = main-thread d3-force (zero extra overhead)
 *   >= WORKER_THRESHOLD = Web Worker (avoids blocking rendering)
 *
 * Both modes expose the same SimulationAPI — GraphPage needs zero changes.
 */

import { useRef, useCallback } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type ForceX,
  type ForceY,
  type ForceManyBody,
  type ForceLink,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type Graph from 'graphology';
import type Sigma from 'sigma';
import type { ForceParams, MultiLevelParams } from './types';
import { DEFAULT_FORCE_PARAMS } from './types';
import { tileIsolatedNodes, centerStrengthForDegree, linkStrengthFor } from './graph-utils';

// ── Constants ──

/** Switch to Web Worker when graph has more nodes than this. */
const WORKER_THRESHOLD = 1000;

// ── 碰撞力参数 ──
// padding 按半径比例，大节点留白更多（替代固定 +6），排布更均匀。
// 0.5 让相邻节点视觉边缘保留约一个半径的空隙，中心连线不至于糊成团。
const COLLIDE_PADDING_RATIO = 0.5;
// 多次迭代充分解析簇内重叠（默认 1 次常残留重叠）
const COLLIDE_ITERATIONS = 3;

// ── Types ──

interface D3Node extends SimulationNodeDatum {
  id: string;
  radius: number;
  degree: number;
}

interface D3Link extends SimulationLinkDatum<D3Node> {
  source: string;
  target: string;
}

/**
 * Unified node handle — used by both modes.
 * In main-thread mode: getters/setters delegate to the d3 node in memory.
 * In Worker mode: getters/setters keep local state + postMessage on fx/fy changes.
 */
export interface NodeHandle {
  x: number;
  y: number;
  fx: number | null;
  fy: number | null;
}

type SimulationMode = 'main-thread' | 'worker';

export interface SimulationAPI {
  init: (graph: Graph, sigma: Sigma, _onTick?: () => void) => void;
  wake: (alpha?: number) => void;
  stop: () => void;
  getNode: (id: string) => NodeHandle | undefined;
  setForceParam: (name: string, value: number) => void;
  multiLevel: (params?: MultiLevelParams) => void;
}

// ── Hook ──

export function useSimulation(): SimulationAPI {
  // Shared state
  const modeRef = useRef<SimulationMode | null>(null);
  const nodeHandlesRef = useRef<Map<string, NodeHandle>>(new Map());
  const graphRef = useRef<Graph | null>(null);
  const initParamsRef = useRef<ForceParams>({ ...DEFAULT_FORCE_PARAMS });

  // Main-thread specific
  const simRef = useRef<ReturnType<typeof forceSimulation<D3Node>> | null>(null);
  const d3NodesRef = useRef<D3Node[]>([]);

  // Worker specific
  const workerRef = useRef<Worker | null>(null);

  // Multi-level layout state
  const mlRunningRef = useRef(false);
  const mlOnProgressRef = useRef<((phase: string, progress: number) => void) | null>(null);
  // 每次 d3 tick 的回调（GraphPage 传 renderer.refresh），让模拟过程中其他节点
  // 的位置变化实时重绘——否则拖拽时只看到被拖节点动、其他节点"不联动"。
  const onTickRef = useRef<(() => void) | null>(null);

  // ── Stop ──

  const stop = useCallback(() => {
    const mode = modeRef.current;
    if (mode === 'worker' && workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    if (mode === 'main-thread' && simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }
    simRef.current = null;
    d3NodesRef.current = [];
    nodeHandlesRef.current.clear();
    graphRef.current = null;
    modeRef.current = null;
    mlRunningRef.current = false;
    mlOnProgressRef.current = null;
  }, []);

  // ── Worker message handler ──

  function createWorkerHandler() {
    return (e: MessageEvent) => {
      const data = e.data as {
        type: string;
        positions?: Record<string, { x: number; y: number }>;
        phase?: string;
        progress?: number;
        error?: string;
      };

      const g = graphRef.current;
      if (!g) return;

      switch (data.type) {
        case 'tick':
          if (data.positions) {
            for (const [id, pos] of Object.entries(data.positions)) {
              if (g.hasNode(id)) g.setNodeAttribute(id, 'x', pos.x);
              if (g.hasNode(id)) g.setNodeAttribute(id, 'y', pos.y);
            }
          }
          break;

        case 'multi-level-progress':
          mlOnProgressRef.current?.(data.phase ?? '', data.progress ?? 0);
          break;

        case 'coarse-tick':
          if (data.positions) {
            for (const [id, pos] of Object.entries(data.positions)) {
              if (g.hasNode(id)) g.setNodeAttribute(id, 'x', pos.x);
              if (g.hasNode(id)) g.setNodeAttribute(id, 'y', pos.y);
            }
          }
          break;

        case 'multi-level-done':
          if (data.positions) {
            for (const [id, pos] of Object.entries(data.positions)) {
              if (g.hasNode(id)) g.setNodeAttribute(id, 'x', pos.x);
              if (g.hasNode(id)) g.setNodeAttribute(id, 'y', pos.y);
            }
          }
          mlRunningRef.current = false;
          window.dispatchEvent(new CustomEvent('graph-ml-done'));

          // 把孤立节点平铺成外围圆环并固定（对齐 Obsidian tile）。
          // 必须在写 ML 位置之后、构建后续模拟之前——平铺用收敛后的连接
          // 节点位置算质心/半径，且平铺写入的 fx/fy 要被下面的模拟读到。
          tileIsolatedNodes(g);

          // After ML, switch to the optimal simulation mode for smooth drag:
          // small graphs (< WORKER_THRESHOLD) → main-thread simulation
          // (zero postMessage latency during drag + collision)
          // large graphs → worker mode (init + stop, wakes on drag)
          const mlW = workerRef.current;
          if (mlW && g && g.order < WORKER_THRESHOLD) {
            mlW.terminate();
            workerRef.current = null;
            modeRef.current = 'main-thread';

            const p = { ...initParamsRef.current };
            const mtNodes: D3Node[] = [];
            const mtLinks: D3Link[] = [];
            const mtHandles = new Map<string, NodeHandle>();

            g.forEachNode((key, attrs) => {
              const node: D3Node = {
                id: key,
                x: (attrs.x as number) ?? 0,
                y: (attrs.y as number) ?? 0,
                // 读平铺/拖拽固定的 fx/fy，让模拟尊重固定位置
                fx: (attrs.fx as number | undefined) ?? null,
                fy: (attrs.fy as number | undefined) ?? null,
                radius: Math.max((attrs.size as number) ?? 6, 4),
                degree: g.degree(key),
              };
              mtNodes.push(node);
              mtHandles.set(key, createMainThreadNodeHandle(node));
            });
            g.forEachEdge((_k, _attrs, source, target) => {
              mtLinks.push({ source: source as string, target: target as string });
            });

            d3NodesRef.current = mtNodes;
            nodeHandlesRef.current = mtHandles;

            const mtSim = forceSimulation<D3Node>(mtNodes)
              .force('link', forceLink<D3Node, D3Link>(mtLinks)
                .id((d) => d.id)
                .distance(p.linkDistance)
                .strength((link: D3Link) => linkStrengthFor(link, p.linkStrength)))
              // 不设 distanceMax：全局 Barnes-Hut 排斥让低度节点持续受中心
              // 累积推力，涌现"度越高越靠中心"的径向梯度（对齐 Obsidian）。
              .force('charge', forceManyBody<D3Node>().strength(p.repelStrength))
              .force('collide', forceCollide<D3Node>()
                .radius((d) => d.radius * (1 + COLLIDE_PADDING_RATIO))
                .iterations(COLLIDE_ITERATIONS))
              .force('x', forceX<D3Node>((d) => (d.fx != null ? d.fx : 0)).strength((d) => centerStrengthForDegree(d.degree, p.centerStrength)))
              .force('y', forceY<D3Node>((d) => (d.fy != null ? d.fy : 0)).strength((d) => centerStrengthForDegree(d.degree, p.centerStrength)))
              .alphaDecay(0.03)
              .velocityDecay(0.35)
              .on('tick', () => {
                for (const d of mtNodes) {
                  if (g.hasNode(d.id)) {
                    g.setNodeAttribute(d.id, 'x', d.x);
                    g.setNodeAttribute(d.id, 'y', d.y);
                  }
                }
                // 实时重绘：让拖拽时其他节点的位置变化可见（流体联动），
                // 否则只有被拖节点动、其他"不联动"显得像漂移
                onTickRef.current?.();
              });

            // 防御：sim 创建时给 degree0 兜底固定（tile 通常已设 fx；非 ML 路径/
            // savedPositions 无 fx 时钉到当前位置，防初始漂移）。拖拽"全流动"会临时
            // 解锁它们让其流动，松手 tile 再固定。
            for (const n of mtNodes) {
              if (n.degree === 0 && n.fx == null) {
                n.fx = n.x ?? 0;
                n.fy = n.y ?? 0;
              }
            }

            // ML 位置已收敛，禁止模拟自动重跑（否则连接节点会抖动、
            // 未固定的节点会被向心力拉移）。仅拖拽时 wake() 才跑。
            mtSim.stop();
            simRef.current = mtSim;
          } else if (mlW && g) {
            // Large graph: keep worker mode, init for drag/collision
            const initNodes: {
              id: string; x: number; y: number; radius: number;
              fx: number | null; fy: number | null; degree: number;
            }[] = [];
            g.forEachNode((key, attrs) => {
              initNodes.push({
                id: key,
                x: (attrs.x as number) ?? 0,
                y: (attrs.y as number) ?? 0,
                fx: (attrs.fx as number | undefined) ?? null,
                fy: (attrs.fy as number | undefined) ?? null,
                radius: Math.max((attrs.size as number) ?? 6, 4),
                degree: g.degree(key),
              });
            });
            const initLinks: { source: string; target: string }[] = [];
            g.forEachEdge((_k, _attrs, source, target) => {
              initLinks.push({ source: source as string, target: target as string });
            });
            mlW.postMessage({
              type: 'init',
              nodes: initNodes,
              links: initLinks,
              params: { ...initParamsRef.current },
            });
            mlW.postMessage({ type: 'stop' });
          }
          break;

        case 'multi-level-error':
          console.warn('[worker] multi-level error:', data.error);
          mlRunningRef.current = false;
          break;
      }
    };
  }

  // ── Init ──

  const init = useCallback((graph: Graph, sigma: Sigma, onTick?: () => void) => {
    // Reset ML state in case init is called mid-ML
    mlRunningRef.current = false;
    mlOnProgressRef.current = null;
    onTickRef.current = onTick ?? null;

    // Kill previous
    const prevMode = modeRef.current;
    if (prevMode === 'worker' && workerRef.current) {
      workerRef.current.terminate();
    }
    if (prevMode === 'main-thread' && simRef.current) {
      simRef.current.stop();
    }
    nodeHandlesRef.current.clear();
    graphRef.current = graph;

    if (graph.order === 0) {
      modeRef.current = null;
      return;
    }

    const params = { ...initParamsRef.current };

    if (graph.order >= WORKER_THRESHOLD) {
      initWorkerMode(graph, params);
    } else {
      initMainThreadMode(graph, params);
    }
  }, []);

  // ── Main-thread mode ──

  function initMainThreadMode(graph: Graph, params: ForceParams) {
    modeRef.current = 'main-thread';

    const d3Nodes: D3Node[] = [];
    const d3Links: D3Link[] = [];
    const handles = new Map<string, NodeHandle>();

    graph.forEachNode((key, attrs) => {
      const x = (attrs.x as number) ?? Math.random() * 100;
      const y = (attrs.y as number) ?? Math.random() * 100;
      const node: D3Node = {
        id: key,
        x, y,
        // 读 savedPositions 恢复的固定位置（孤立节点圆环 / 用户拖拽锁定）
        fx: (attrs.fx as number | undefined) ?? null,
        fy: (attrs.fy as number | undefined) ?? null,
        radius: Math.max((attrs.size as number) ?? 6, 4),
        degree: graph.degree(key),
      };
      d3Nodes.push(node);
      handles.set(key, createMainThreadNodeHandle(node));
    });

    graph.forEachEdge((_key, _attrs, source, target) => {
      d3Links.push({ source: source as string, target: target as string });
    });

    d3NodesRef.current = d3Nodes;
    nodeHandlesRef.current = handles;

    const simulation = forceSimulation<D3Node>(d3Nodes)
      .force('link', forceLink<D3Node, D3Link>(d3Links)
        .id((d) => d.id)
        .distance(params.linkDistance)
        .strength((link: D3Link) => linkStrengthFor(link, params.linkStrength)))
      // 不设 distanceMax：全局排斥涌现度→半径梯度（见 multi-level-done 注释）
      .force('charge', forceManyBody<D3Node>().strength(params.repelStrength))
      // 边界距离碰撞：padding 按半径比例（大节点更大留白）+ 3 次迭代充分解析重叠
      .force('collide', forceCollide<D3Node>()
        .radius((d) => d.radius * (1 + COLLIDE_PADDING_RATIO))
        .iterations(COLLIDE_ITERATIONS))
      .force('x', forceX<D3Node>((d) => (d.fx != null ? d.fx : 0)).strength((d) => centerStrengthForDegree(d.degree, params.centerStrength)))
      .force('y', forceY<D3Node>((d) => (d.fy != null ? d.fy : 0)).strength((d) => centerStrengthForDegree(d.degree, params.centerStrength)))
      .alphaDecay(0.03)
      .velocityDecay(0.35)
      .on('tick', () => {
        for (const d of d3Nodes) {
          if (graph.hasNode(d.id)) {
            graph.setNodeAttribute(d.id, 'x', d.x);
            graph.setNodeAttribute(d.id, 'y', d.y);
          }
        }
        // 实时重绘：让模拟过程中节点位置变化可见（同 mtSim）
        onTickRef.current?.();
      });

    // 防御：同 mtSim，sim 创建时给 degree0 兜底钉住，防初始漂移
    for (const n of d3Nodes) {
      if (n.degree === 0 && n.fx == null) {
        n.fx = n.x ?? 0;
        n.fy = n.y ?? 0;
      }
    }

    simRef.current = simulation;
  }

  // ── Worker mode ──

  function initWorkerMode(graph: Graph, params: ForceParams) {
    modeRef.current = 'worker';

    const nodes: {
      id: string; x: number; y: number; radius: number;
      fx: number | null; fy: number | null; degree: number;
    }[] = [];
    const links: { source: string; target: string }[] = [];
    const handles = new Map<string, NodeHandle>();

    graph.forEachNode((key, attrs) => {
      const x = (attrs.x as number) ?? Math.random() * 100;
      const y = (attrs.y as number) ?? Math.random() * 100;
      nodes.push({
        id: key, x, y,
        fx: (attrs.fx as number | undefined) ?? null,
        fy: (attrs.fy as number | undefined) ?? null,
        radius: Math.max((attrs.size as number) ?? 6, 4),
        degree: graph.degree(key),
      });
      handles.set(key, createWorkerNodeHandle(key, workerRef));
    });

    graph.forEachEdge((_key, _attrs, source, target) => {
      links.push({ source: source as string, target: target as string });
    });

    nodeHandlesRef.current = handles;

    const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = createWorkerHandler();

    worker.postMessage({ type: 'init', nodes, links, params });
  }

  // ── Wake ──

  const wake = useCallback((alpha = 0.15) => {
    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'wake', alpha });
    } else if (simRef.current) {
      simRef.current.alpha(alpha).restart();
    }
  }, []);

  // ── Get Node Handle ──

  const getNode = useCallback((id: string): NodeHandle | undefined => {
    return nodeHandlesRef.current.get(id);
  }, []);

  // ── Set Force Param ──

  const setForceParam = useCallback((name: string, value: number) => {
    (initParamsRef.current as unknown as Record<string, number>)[name] = value;

    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'setForce', name, value });
      return;
    }

    const sim = simRef.current;
    if (!sim) return;

    switch (name) {
      case 'centerStrength':
        sim.force<ForceX<D3Node>>('x')?.strength(value);
        sim.force<ForceY<D3Node>>('y')?.strength(value);
        break;
      case 'repelStrength':
        sim.force<ForceManyBody<D3Node>>('charge')?.strength(value);
        break;
      case 'linkStrength':
        sim.force<ForceLink<D3Node, D3Link>>('link')?.strength(value);
        break;
      case 'linkDistance':
        sim.force<ForceLink<D3Node, D3Link>>('link')?.distance(value);
        break;
    }
    sim.alpha(0.3).restart();
  }, []);

  // ── Multi-Level Layout ──

  const multiLevel = useCallback((params?: MultiLevelParams) => {
    if (mlRunningRef.current) return;

    const graph = graphRef.current;
    if (!graph || graph.order === 0) return;

    // Check skip conditions
    const minNodes = params?.minNodes ?? 50;
    if (graph.order < minNodes) return;

    // Skip for disconnected graphs (few edges relative to nodes)
    const edgeRatio = graph.size / Math.max(1, graph.order);
    if (edgeRatio < 0.2) {
      mlRunningRef.current = false;
      return;
    }

    mlRunningRef.current = true;
    mlOnProgressRef.current = params?.onProgress ?? null;

    // Collect node data
    const nodes: { id: string; x: number; y: number; radius: number; degree: number }[] = [];
    graph.forEachNode((key, attrs) => {
      nodes.push({
        id: key,
        x: (attrs.x as number) ?? 0,
        y: (attrs.y as number) ?? 0,
        radius: Math.max((attrs.size as number) ?? 6, 4),
        degree: graph.degree(key),
      });
    });

    const links: { source: string; target: string }[] = [];
    graph.forEachEdge((_key, _attrs, source, target) => {
      links.push({ source: source as string, target: target as string });
    });

    // Ensure worker exists (if main-thread mode, create one for ML)
    if (modeRef.current !== 'worker' || !workerRef.current) {
      if (simRef.current) {
        simRef.current.stop();
        simRef.current = null;
      }
      const worker = new Worker(
        new URL('./simulation.worker.ts', import.meta.url),
        { type: 'module' },
      );
      workerRef.current = worker;
      modeRef.current = 'worker';
      worker.onmessage = createWorkerHandler();

      // Rebuild node handles for worker mode — existing handles from
      // main-thread mode are stale (bound to old D3Nodes).
      const newHandles = new Map<string, NodeHandle>();
      graphRef.current?.forEachNode((key) => {
        newHandles.set(key, createWorkerNodeHandle(key, workerRef));
      });
      nodeHandlesRef.current = newHandles;
    }

    workerRef.current.postMessage({
      type: 'multi-level-init',
      nodes,
      links,
      params: { ...initParamsRef.current },
      maxLevels: params?.maxLevels ?? 5,
      minFraction: params?.minSizeFraction ?? 0.05,
      // 精化需充分收敛才能让向心力/排斥力把节点推到平衡位置；
      // 80 tick 在 alphaDecay 0.03 下 alpha 仍 ~0.09，远未收敛。
      refineTicks: params?.refineTicks ?? 250,
    });
  }, []);

  return { init, wake, stop, getNode, setForceParam, multiLevel };
}

// ── Main-Thread Node Handle ──

function createMainThreadNodeHandle(node: D3Node): NodeHandle {
  return {
    get x() { return node.x ?? 0; },
    set x(v: number) { node.x = v; },
    get y() { return node.y ?? 0; },
    set y(v: number) { node.y = v; },
    get fx() { return node.fx ?? null; },
    set fx(v: number | null) { node.fx = v; },
    get fy() { return node.fy ?? null; },
    set fy(v: number | null) { node.fy = v; },
  };
}

// ── Worker Node Handle ──
// Keeps local fx/fy state; setting them sends 'drag' to the Worker.
// x/y are also tracked locally (for parity) but not sent — the Worker
// manages its own coordinates from tick constraints.

function createWorkerNodeHandle(
  id: string,
  workerRef: { current: Worker | null },
): NodeHandle {
  let x = 0, y = 0, fx: number | null = null, fy: number | null = null;

  const syncDrag = () => {
    workerRef.current?.postMessage({ type: 'drag', id, fx, fy });
  };

  return {
    get x() { return x; },
    set x(v: number) { x = v; },
    get y() { return y; },
    set y(v: number) { y = v; },
    get fx() { return fx; },
    set fx(v: number | null) { fx = v; syncDrag(); },
    get fy() { return fy; },
    set fy(v: number | null) { fy = v; syncDrag(); },
  };
}

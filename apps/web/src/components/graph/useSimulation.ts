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
  forceCenter,
  forceX,
  forceY,
  type ForceX,
  type ForceY,
  type ForceManyBody,
  type ForceLink,
  type ForceCollide,
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

// ── 拖拽期「拴绳」强度（路线 B：按距离门控 + 三类节点）──
// 每个非拖拽节点被一根拉回「拖拽前锚点」的弹簧拴住，强度 = f(到被拖节点当前距离)，且按节点类别分档：
//   直接邻居      → NEIGHBOR_TETHER(0.3)：拖拽期被牵动但**部分**跟走(不完全跟随) → 松手时边存有残余张力。
//                   配合「被拖节点松手放开」，使被拖节点弹回「落点↔原位」之间(弹回一截，既保留拖拽意义又有明显回弹)。
//                   不能=0：=0 邻居完全跟走 → 松手无张力 → 无回弹；不能太高：太高邻居僵、且回弹趋近"完全弹回原位"。
//   连接非邻居    → 近 CONN_NEAR(=0，磁铁推开后就地重组、不弹回旧锚点) → 远 CONN_FAR(≈钉死)
//   孤立节点      → 近 ISO_NEAR → 远 ISO_FAR（中等牵引绳：磁铁近时能被推开一点，绳子拽住防飞散）
// 距离→强度在 [rInner, rOuter]（图坐标，GraphPage 按屏幕像素换算传入）线性插值。
// 注：CONN_NEAR=0 是关键——非邻居若也拴回旧锚点，被磁铁推开后会"回弹"(用户曾反馈的坏回弹引力)。
// 历史教训：曾把被拖节点「钉死在落点」想做"落点定格+邻域回弹"，结果落点非平衡点→钉死造成永久张力→
//   邻居围着矛盾点振荡=**抖动**，且被拖节点无法释放弹力=看不到回弹。物理正确的回弹必须放开被拖节点。
const NEIGHBOR_TETHER = 0.3;
const CONN_NEAR = 0;
const CONN_FAR = 0.85;
const ISO_NEAR = 0.18;
const ISO_FAR = 0.6;

// ── 回弹节奏（迭代六：用户反馈"回弹太快"→放慢，但绝不回到抖动/延迟动画）──
// 放慢回弹 = 把同样的回弹位移"慢放"而非减小幅度：降低回弹期 alphaDecay 让弹簧力作用更久。
// 阻尼略高于拖拽档(0.4>0.35)→ 慢滑且零 overshoot/抖动。alphaDecay 不可过低(<0.012)否则回弹拖成数秒=
// 又成"延迟动画"。回弹档参数在 beginDrag 恢复拖拽档（init 字面量 0.03/0.35 与拖拽档同值）。
const DAMP_DRAG = 0.35;
const DAMP_REBOUND = 0.3; // 回弹阻尼：略低于拖拽档，回弹更可见、带轻微回弹（过高=回弹消失）
const DRAG_ALPHA_DECAY = 0.03;
const REBOUND_ALPHA_DECAY = 0.018;

// ── 拖拽期「磁铁」排斥场强度（中程、平滑衰减，制造"未接触即避让"的磁铁手感）──
// 以被拖节点为中心、rMagnet 为半径，场内节点受向外推力 ∝ (1-dist/rMagnet)²；
// 近强远弱 → 节点像被磁铁犁开；场外不受影响（与"远节点不动"一致）。邻居除外（走牵引）。
// 密集图节点被边/碰撞"焊"得硬，需较强磁铁才犁得动；过强会爆，由 E2E span 防爆断言兜底。
const MAGNET_STRENGTH = 2.0;

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
  init: (graph: Graph, sigma: Sigma, _onTick?: () => void, autoRun?: boolean) => void;
  wake: (alpha?: number) => void;
  stop: () => void;
  /** 非破坏性停 tick：仅停止物理 tick，保留 sim/worker/节点句柄/图引用，使下次拖拽仍能移动节点+跑流体。
   *  供 GraphPage 松手定格使用。区别于 stop()（破坏性，用于卸载/重建：terminate worker + 清句柄）。 */
  halt: () => void;
  /** 冷加载小图：同步预结算 iters 步（停 timer + 手动 tick，不渲染），把终态写进 graph。 */
  preSettle: (iterations: number) => void;
  /** 把 graph 当前坐标同步进 sim 内部并停 sim（暖加载/入场后调用，防首次拖拽 1 帧抖动）。 */
  syncToGraph: () => void;
  getNode: (id: string) => NodeHandle | undefined;
  setForceParam: (name: string, value: number) => void;
  multiLevel: (params?: MultiLevelParams) => void;
  /** 移动时降质：拖拽期间 collide 迭代 3→1（每 tick 最大 CPU 成本），松手恢复 */
  setMotionMode: (active: boolean) => void;
  /** 质心锁：用 forceCenter 把整簇质心钉在 target，防整簇平移。现在仅用于「松手后沉降」阶段
   *  （拖拽中改用 beginDrag 的拴绳保证局部性，不再用质心锁）。松手后由 onTick 在接近静止时自动解除。 */
  setCentroidLock: (target: { x: number; y: number } | null) => void;
  /** 进入拖拽：快照锚点、装按距离门控的三类拴绳 + 磁铁排斥场、关闭全局向心力（径向向心不抗旋转，
   *  是整簇旋转帮凶）。rInner/rOuter/rMagnet 为图坐标半径（GraphPage 按屏幕像素 × 冻结映射换算）。 */
  beginDrag: (draggedId: string, rInner: number, rOuter: number, rMagnet: number) => void;
  /** 退出拖拽：撤拴绳、恢复全局向心力。 */
  endDrag: () => void;
}

// ── Hook ──

export function useSimulation(): SimulationAPI {
  // Shared state
  const modeRef = useRef<SimulationMode | null>(null);
  const nodeHandlesRef = useRef<Map<string, NodeHandle>>(new Map());
  const graphRef = useRef<Graph | null>(null);
  const initParamsRef = useRef<ForceParams>({ ...DEFAULT_FORCE_PARAMS });
  // 是否处于「拖拽移动」中（setMotionMode 镜像）。onTick 据此判断能否自动解除质心锁：
  // 拖拽中(含按住暂停)绝不解除，松手后运动模式关闭、接近静止时才解除。
  const motionModeRef = useRef(false);

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

  // ── Halt（非破坏性停 tick）──
  // 只停物理 tick，不动 simRef/workerRef/句柄/引用 → 下次 mousedown 的 getNode/beginDrag/wake 仍可用。
  // worker 发 'stop'（worker 内 sim.stop()，不 terminate）；主线程 sim.stop() 停 timer 但 simRef 保留。
  // 若误用 stop() 做松手定格，会清空句柄 → 之后拖拽 getNode=undefined → 被拖节点写坐标被跳过 → 拖不动。
  const halt = useCallback(() => {
    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'stop' });
    } else if (simRef.current) {
      simRef.current.stop();
    }
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
                // 质心锁自动解除（见 initMainThreadMode 的同款注释）
                if (!motionModeRef.current && mtSim.alpha() < 0.02) {
                  if (mtSim.force('centroidLock')) mtSim.force('centroidLock', null);
                  if (mtSim.force('tetherX')) {
                    mtSim.force('tetherX', null);
                    mtSim.force('tetherY', null);
                  }
                }
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

  const init = useCallback((graph: Graph, sigma: Sigma, onTick?: () => void, autoRun = true) => {
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

    // 入场默认不自动跑（避免初始抖动）；布局由 GraphPage 显式驱动（preSettle / ML / 缓存终态）。
    if (!autoRun) {
      if (modeRef.current === 'worker') workerRef.current?.postMessage({ type: 'stop' });
      else simRef.current?.stop();
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
        // 质心锁自动解除：拖拽中(motionModeRef true)绝不解除(含按住暂停，避免暂停后移动又滑移)；
        // 松手后运动模式关闭、alpha 衰减到接近静止时移除 forceCenter，既无需脆弱定时器，
        // 也不残留幽灵力去污染后续调力参数滑块等唤醒。
        if (!motionModeRef.current && simulation.alpha() < 0.02) {
          if (simulation.force('centroidLock')) simulation.force('centroidLock', null);
          // 沉降接近静止后撤拴绳：alpha≈0 此刻不产生位移；撤拴绳后向心(保持开启)接管，布局回到可交互态
          // （孤立节点另有 fx 硬钉保圆环，不会被向心拉走）。
          if (simulation.force('tetherX')) {
            simulation.force('tetherX', null);
            simulation.force('tetherY', null);
          }
        }
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

  // ── Motion Mode ──
  // 移动时降质：拖拽期间把 collide 迭代从 COLLIDE_ITERATIONS(3) 降到 1。
  // collide 是每 tick 的最大 CPU 成本（四叉树 ×迭代数）；移动中允许近似解析，
  // 松手后 wake(0.3) 的 tick 会以 3 次迭代解析残留重叠。

  const setMotionMode = useCallback((active: boolean) => {
    motionModeRef.current = active; // 供 onTick 判断能否自动解除质心锁
    const iterations = active ? 1 : COLLIDE_ITERATIONS;

    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'setCollideIterations', value: iterations });
      return;
    }

    simRef.current?.force<ForceCollide<D3Node>>('collide')?.iterations(iterations);
  }, []);

  // ── Centroid Lock（质心锁）──
  // 拖拽「全流动」解锁全图后，被拖节点钉在光标处会跑到很远的图坐标，链接力把整簇质心一起拽过去；
  // 相机被冻结不会跟随 → 整簇在屏幕上滑出视野。装一个 forceCenter 把质心硬钉在按下瞬间位置，
  // 流体只能围绕固定质心局部填补，整簇不整体平移 → 图谱稳定停在视野中央。
  // 解除时机不在这里硬清，而由 onTick 在「非拖拽 + 接近静止」时自动移除（见各 on('tick')）。
  const setCentroidLock = useCallback((target: { x: number; y: number } | null) => {
    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'setCentroidLock', target });
      return;
    }
    const sim = simRef.current;
    if (!sim) return;
    sim.force('centroidLock', target ? forceCenter<D3Node>(target.x, target.y) : null);
  }, []);

  // ── 拖拽局部流体（路线 B）──
  // 旧实现「全解锁 + 全程高温全局力松弛」会让整簇绕质心刚体旋转、远处节点也乱抖（与 Obsidian 差距大）。
  // 现改为：拖拽期给每个非拖拽节点装一根拉回「拖拽前锚点」的拴绳，强度按到被拖节点当前距离门控
  // （远=钉死、近=可流、邻居=0 受牵引），并关闭全局向心力——向心是径向力、对质心力矩为零，既不抗
  // 旋转、又会和拴绳打架把远节点拽离锚点；拴绳本身已提供局部约束 + 抗旋转（每根拴绳都抵抗位移）。
  // 这样碰撞/级联/动态距离/滞后全交给真实力模拟每 tick 在活位置上重算（collide/manyBody/link），
  // 拴绳只回答「你这个节点允许离开锚点多远」——既保住流体观感，又让远节点纹丝不动。
  const beginDrag = useCallback((draggedId: string, rInner: number, rOuter: number, rMagnet: number) => {
    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'beginDrag', draggedId, rInner, rOuter, rMagnet });
      return;
    }
    const sim = simRef.current;
    const graph = graphRef.current;
    if (!sim || !graph) return;

    sim.velocityDecay(DAMP_DRAG); // 恢复拖拽档阻尼/alpha 衰减（上一轮松手设了回弹慢放档）
    sim.alphaDecay(DRAG_ALPHA_DECAY);
    // §12.2 第 1 层：装「按下瞬间质心锁」= forceCenter(全部 d3 节点均值)。
    // 替换旧的 sim.force('centroidLock', null)（只清残留、不装锁 → 磁铁每 tick 写 vx/vy 的净动量
    // 每次拖拽都把整簇推走 = 漂移主因，终端机判别实验确认）。
    // 质心与 forceCenter 内部同集（全部节点），自洽；装锁后磁铁/拴绳只绕固定质心做局部流动，整簇不平移。
    // 不硬清：拖拽期 + 回弹期都保留，由 onTick 在 alpha<0.02 且非拖拽时自动解除（§6.3 生命周期）。
    let cx = 0, cy = 0, cn = 0;
    for (const n of d3NodesRef.current) { cx += n.x ?? 0; cy += n.y ?? 0; cn++; }
    if (cn > 0) { cx /= cn; cy /= cn; }
    sim.force('centroidLock', forceCenter<D3Node>(cx, cy));

    // 快照拖拽前锚点（用 d3 当前坐标）
    const anchors = new Map<string, { x: number; y: number }>();
    for (const n of d3NodesRef.current) anchors.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    // 直接邻居集合（拓扑在拖拽期不变，算一次即可）
    const neighbors = new Set<string>(graph.neighbors(draggedId));
    // 被拖节点 handle：.x/.y getter 读 d3 实时坐标，供每 tick 取「被拖节点当前位置」
    const dragHandle = nodeHandlesRef.current.get(draggedId);
    const dragX = () => dragHandle?.x ?? 0;
    const dragY = () => dragHandle?.y ?? 0;

    // 注：不再关闭全局向心力——它与排斥/边力在平衡态相互抵消，拖拽期对局部气泡的影响可忽略；
    // 松手后节点被就地钉死 + 停模拟，向心无从作用，故无需 disable/restore（少一处状态切换=少一处 bug）。

    const tetherT = (d: D3Node): number => {
      const dist = Math.hypot((d.x ?? 0) - dragX(), (d.y ?? 0) - dragY());
      return rOuter > rInner ? Math.min(1, Math.max(0, (dist - rInner) / (rOuter - rInner))) : 1;
    };
    const strengthOf = (d: D3Node): number => {
      if (d.id === draggedId) return 0;
      if (neighbors.has(d.id)) return NEIGHBOR_TETHER; // 邻居：中等拴绳（牵动 + 为松手回弹蓄张力）
      const t = tetherT(d);
      if (d.degree === 0) return ISO_NEAR + (ISO_FAR - ISO_NEAR) * t; // 孤立：中等牵引绳（防飞 + 能反应）
      return CONN_NEAR + (CONN_FAR - CONN_NEAR) * t; // 连接：近自由(无回弹)、远钉死
    };
    sim.force('tetherX', forceX<D3Node>((d) => anchors.get(d.id)?.x ?? 0).strength(strengthOf));
    sim.force('tetherY', forceY<D3Node>((d) => anchors.get(d.id)?.y ?? 0).strength(strengthOf));

    // 磁铁排斥场：场内节点被平滑向外推（未接触即避让，磁铁手感）；邻居除外（走牵引）。
    // 推力 ∝ (1-dist/rMagnet)² / dist，近强远弱、场外为 0；直接写 vx/vy，由 velocityDecay 阻尼。
    const magnetForce = () => {
      const fx = dragX();
      const fy = dragY();
      for (const n of d3NodesRef.current) {
        if (n.id === draggedId || neighbors.has(n.id)) continue;
        const dx = (n.x ?? 0) - fx;
        const dy = (n.y ?? 0) - fy;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-6 || dist > rMagnet) continue;
        const fall = 1 - dist / rMagnet;
        const f = (MAGNET_STRENGTH * fall * fall) / dist;
        n.vx = (n.vx ?? 0) + dx * f;
        n.vy = (n.vy ?? 0) + dy * f;
      }
    };
    sim.force('magnet', magnetForce);
  }, []);

  const endDrag = useCallback(() => {
    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'endDrag' });
      return;
    }
    const sim = simRef.current;
    if (!sim) return;
    // 撤磁铁（拖拽专用，松手后不应继续往外推）。
    sim.force('magnet', null);
    // 撤拴绳：让被拖节点 + 邻居在松手后靠内部力做自然回弹（=用户要的"回弹效果"）。
    // 先前"保留拴绳+钉死被拖节点"会把邻居拴在锚点、被拖节点也弹不回 → 回弹效果消失。
    // 向心保持开启：与内部力一起把整簇稳在中心附近（布局紧凑，回居中位移很小）；孤立另有 fx 硬钉不飞。
    sim.force('tetherX', null);
    sim.force('tetherY', null);
    // 回弹节奏：放慢回弹（降 alphaDecay 慢放 + 阻尼 0.3 带轻微回弹）。
    sim.velocityDecay(DAMP_REBOUND);
    sim.alphaDecay(REBOUND_ALPHA_DECAY);
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

  // ── 冷加载小图：同步预结算（不渲染）拿终态，消除"圆形中间态"──
  const preSettle = useCallback((iterations: number) => {
    if (modeRef.current !== 'main-thread') return; // <WORKER_THRESHOLD 才走主线程，cold-small 必为主线程
    const sim = simRef.current;
    const g = graphRef.current;
    if (!sim || !g) return;
    sim.stop();
    // 注意：手动 sim.tick() 不触发 onTick 监听，循环结束后必须手动把 d3 终态写回 graph，
    // 否则 graph 停在初始聚团 → 入场 bloom 无展开 → 归一化框极小 → 节点被放大成巨球。
    for (let i = 0; i < iterations; i++) sim.tick();
    for (const d of d3NodesRef.current) {
      if (g.hasNode(d.id)) {
        g.setNodeAttribute(d.id, 'x', d.x ?? 0);
        g.setNodeAttribute(d.id, 'y', d.y ?? 0);
      }
    }
    sim.stop();
  }, []);

  // ── 把 graph 当前坐标(+fx/fy)同步进 sim 内部并停 sim（暖加载/入场后，防首次拖拽 1 帧抖动）──
  const syncToGraph = useCallback(() => {
    const g = graphRef.current;
    if (modeRef.current === 'worker') {
      if (!g) return;
      const positions: Record<string, { x: number; y: number; fx: number | null; fy: number | null }> = {};
      g.forEachNode((k, a) => {
        positions[k] = {
          x: (a.x as number) ?? 0,
          y: (a.y as number) ?? 0,
          fx: (a.fx as number | undefined) ?? null,
          fy: (a.fy as number | undefined) ?? null,
        };
      });
      workerRef.current?.postMessage({ type: 'sync', positions });
      return;
    }
    const sim = simRef.current;
    if (!sim || !g) return;
    for (const d of d3NodesRef.current) {
      if (!g.hasNode(d.id)) continue;
      d.x = (g.getNodeAttribute(d.id, 'x') as number) ?? d.x;
      d.y = (g.getNodeAttribute(d.id, 'y') as number) ?? d.y;
      d.fx = (g.getNodeAttribute(d.id, 'fx') as number | undefined) ?? null;
      d.fy = (g.getNodeAttribute(d.id, 'fy') as number | undefined) ?? null;
      d.vx = 0;
      d.vy = 0;
    }
    sim.stop();
  }, []);

  return { init, wake, stop, halt, preSettle, syncToGraph, getNode, setForceParam, multiLevel, setMotionMode, setCentroidLock, beginDrag, endDrag };
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

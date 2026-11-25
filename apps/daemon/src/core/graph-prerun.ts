/**
 * 布局预跑（H3 种子初始位置，docs/2026-11-25-graph-h3-seeded-positions-design.md §3.1）。
 *
 * 在 vault worker 线程里用**与浏览器引擎同款**的力配方（@molio/contracts 单一来源）
 * 把全量图布局算到 alpha 耗尽，产出近终态坐标——浏览器拿到即「出生定形」，
 * 只做低温精修。实验（设计 §二）：10k 库首帧平均跳变 287.8px → 19.6px。
 *
 * 分片推进是可抢占性的前提：stepPrerun 每次同步 tick ≤maxTicks，片间由调用方
 * （vault-worker-entry 的后台调度）setImmediate 让路——排队的图/树任务先服务，
 * 预跑随后续跑。d3 的仿真状态就是节点数组，天然可恢复。
 *
 * 增量继承：图重建（编辑后失效）不必全量重跑——存活节点带旧位置起步、新节点
 * 在图质心附近 phyllotaxis 落位，alpha 从 0.3 起步（实验 D2：10% 失配无碍）。
 */

import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
} from 'd3-force';
import type { SimulationNodeDatum } from 'd3-force';
import {
  GRAPH_LAYOUT_RECIPE,
  autoLinkStrength,
  collideRadiusValue as collideRadius,
  REFINE_ALPHA_PARTIAL,
  REFINE_ALPHA_DECAY,
  type GraphPositions,
} from '@molio/contracts';

interface PrerunNode extends SimulationNodeDatum {
  id: string;
  radius: number;
}

export interface PrerunState {
  sim: Simulation<PrerunNode, SimulationLinkDatum<PrerunNode>>;
  nodes: PrerunNode[];
  /** 继承命中率（0-1；无 inherit 输入 = 0）——测试与调度口径用 */
  inheritHitRatio: number;
  /** alpha 起点：增量档 0.3（快衰减）/ 全量档 1（d3 默认衰减） */
  alphaStart: number;
  done: boolean;
}

/** 增量落位的 phyllotaxis 点距（图质心附近新节点抖散）。 */
const NEW_NODE_SPACING = 100;
/** 继承命中率 ≥ 此值走增量短重跑档（设计 §3.1）。 */
const INCREMENTAL_RATIO = 0.5;

/**
 * 新键集与旧位置表的命中率（0-1）。PositionStore 的存废判据：
 * <0.5 视为图大换血，清空重跑（Task 3 接口约定）。
 */
export function inheritOverlap(newKeys: Iterable<string>, storeKeys: Map<string, { x: number; y: number }>): number {
  let hit = 0;
  let total = 0;
  for (const k of newKeys) {
    total++;
    if (storeKeys.has(k)) hit++;
  }
  return total === 0 ? 0 : hit / total;
}

/**
 * 装配预跑状态。初始位置：inherit 命中者用旧位；未命中者绕图质心（无继承时原点）
 * phyllotaxis 落位。节点半径 = (2+√deg)×2（layoutWorker 同口径，nodeScale=1）。
 */
export function createPrerun(
  nodeKeys: string[],
  links: Array<{ source: string; target: string }>,
  degrees: Map<string, number>,
  inherit?: Map<string, { x: number; y: number }>,
): PrerunState {
  const hit = inherit ? inheritOverlap(nodeKeys, inherit) : 0;

  // 图质心 = 继承位置的均值（无继承退化为原点）
  let cx = 0;
  let cy = 0;
  let inheritedCount = 0;
  if (inherit) {
    for (const k of nodeKeys) {
      const p = inherit.get(k);
      if (p) {
        cx += p.x;
        cy += p.y;
        inheritedCount++;
      }
    }
    if (inheritedCount > 0) {
      cx /= inheritedCount;
      cy /= inheritedCount;
    }
  }

  const nodes: PrerunNode[] = nodeKeys.map((id, i) => {
    const prev = inherit?.get(id);
    const radius = (2 + Math.sqrt(degrees.get(id) ?? 0)) * 2;
    if (prev) return { id, radius, x: prev.x, y: prev.y };
    // 新节点：图质心附近黄金螺旋（无放射条纹，间距自适应）
    const r = (NEW_NODE_SPACING / Math.sqrt(Math.PI)) * Math.sqrt(i + 1);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    return { id, radius, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });

  const simLinks: SimulationLinkDatum<PrerunNode>[] = links
    .filter((l) => l.source !== l.target)
    .map((l) => ({ source: l.source, target: l.target }));

  const f = GRAPH_LAYOUT_RECIPE;
  const sim = forceSimulation<PrerunNode>(nodes)
    .force('charge', forceManyBody<PrerunNode>().strength(f.repelStrength).distanceMin(f.distanceMin))
    .force('center', forceCenter<PrerunNode>(0, 0).strength(f.centerStrength))
    .force(
      'link',
      forceLink<PrerunNode, SimulationLinkDatum<PrerunNode>>(simLinks)
        .id((d) => d.id)
        .distance(f.linkDistance)
        .strength((l) => {
          const s = l.source as PrerunNode;
          const t = l.target as PrerunNode;
          return autoLinkStrength(degrees.get(s.id) ?? 1, degrees.get(t.id) ?? 1);
        }),
    )
    .force('x', forceX<PrerunNode>(0).strength(f.containStrength))
    .force('y', forceY<PrerunNode>(0).strength(f.containStrength))
    .force(
      'collide',
      forceCollide<PrerunNode>().radius((d) => collideRadius(d.radius)).iterations(f.collideIterations),
    )
    .stop();

  const alphaStart = hit >= INCREMENTAL_RATIO ? REFINE_ALPHA_PARTIAL : 1;
  if (hit >= INCREMENTAL_RATIO) {
    // 增量短重跑：快衰减，alphaMin 保持默认 0.001（~87 ticks 收工）
    sim.alphaDecay(REFINE_ALPHA_DECAY);
  } else {
    // 全量预跑：alphaMin 压到 0.0001 —— d3 在 0.001 就停摆但布局仍在终端漂移途中
    //（实验 A 末速 ~5.9px/tick），冻结太早会把漂移留给浏览器精修（10k 实测 452px
    // 残余位移）。多烧 ~140 tick 换更深静息，后台成本 +35% 换「出生即定形」成色。
    sim.alphaMin(0.0001);
  }
  sim.alpha(alphaStart);

  return { sim, nodes, inheritHitRatio: hit, alphaStart, done: false };
}

/** 推进 ≤maxTicks。任何时候返回当前快照（坐标取整 1 位）——调用方可以在任意片间
 * 读走「半成品」位置应急（如 worker 即将退出）；正常路径跑到 done 才入库。
 */
export function stepPrerun(state: PrerunState, maxTicks: number): { done: boolean; positions: GraphPositions } {
  if (!state.done) {
    let n = 0;
    while (n < maxTicks && state.sim.alpha() > state.sim.alphaMin()) {
      state.sim.tick();
      n++;
    }
    if (state.sim.alpha() <= state.sim.alphaMin()) state.done = true;
  }
  return { done: state.done, positions: snapshotPositions(state) };
}

function snapshotPositions(state: PrerunState): GraphPositions {
  return state.nodes.map((n) => [n.id, round1(n.x ?? 0), round1(n.y ?? 0)] as [string, number, number]);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

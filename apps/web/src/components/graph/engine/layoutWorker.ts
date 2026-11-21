/**
 * 后台全量布局 worker（H2，设计 §4.2）。输入全图节点/边，同步跑 d3-force 至收敛，
 * postMessage 一份全量位置表。主线程零占（27s 级收敛在 worker 里跑；代拍 E：trunk
 * 可交互后 idle 启动）。配方 = DEFAULT_FORCE_PARAMS 固定（代拍 P：与用户 forces 解耦），
 * 与全量图/mini-sim 同源（trunkExpand.computeMiniSim 同款强度语义）。
 *
 * 协议：{type:'layout', gen, nodeKeys, links} → {type:'done', gen, positions: [id,x,y][]}
 * （gen 防串：service 换键重启后，旧 worker 的迟到回包按 gen 丢弃）。
 *
 * tsconfig 是 dom lib 语境（无 webworker lib）——用 `self as unknown as Worker` 桥接，
 * 不加 `/// <reference lib="webworker" />`（与 dom 全局冲突）。确定性：radial 黄金角
 * 初始化 + 无随机力 → 同输入同输出（探针/验收可复现）。
 */
import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { DEFAULT_FORCE_PARAMS } from '../types.ts';
import { collideRadiusValue } from './graphUtils.ts';

interface LayoutRequest {
  type: 'layout';
  gen: number;
  nodeKeys: string[];
  links: Array<{ source: string; target: string }>;
}

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  radius: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const RING = 40;
/** 收敛上限（防退化输入死循环；7k 节点实测 ~27s 在此内） */
const MAX_TICKS = 6000;

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<LayoutRequest>) => {
  const msg = e.data;
  if (!msg || msg.type !== 'layout') return;

  const deg = new Map<string, number>();
  for (const l of msg.links) {
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
  }
  const nodes: LayoutNode[] = msg.nodeKeys.map((id, i) => {
    const ring = RING * Math.sqrt(i + 1);
    const angle = GOLDEN_ANGLE * i;
    return {
      id,
      x: ring * Math.cos(angle),
      y: ring * Math.sin(angle),
      radius: (2 + Math.sqrt(deg.get(id) ?? 0)) * 2, // 引擎 radiusOf 口径（nodeScale=1）
    };
  });
  const links: SimulationLinkDatum<LayoutNode>[] = msg.links.map((l) => ({ source: l.source, target: l.target }));

  const f = DEFAULT_FORCE_PARAMS;
  const sim = forceSimulation<LayoutNode>(nodes)
    .force('charge', forceManyBody<LayoutNode>().strength(f.repelStrength))
    .force('center', forceCenter<LayoutNode>(0, 0).strength(f.centerStrength))
    .force(
      'link',
      forceLink<LayoutNode, SimulationLinkDatum<LayoutNode>>(links)
        .id((d) => d.id)
        .distance(f.linkDistance)
        // 0 = d3 默认按度数加权（1/min(deg)）——与引擎 setForces 同语义
        .strength(
          f.linkStrength > 0
            ? f.linkStrength
            : (l) => {
                const s = l.source as LayoutNode;
                const t = l.target as LayoutNode;
                return 1 / Math.max(Math.min(deg.get(s.id) ?? 1, deg.get(t.id) ?? 1), 1);
              },
        ),
    )
    .force('collide', forceCollide<LayoutNode>().radius((d) => collideRadiusValue(d.radius)).iterations(3));

  let ticks = 0;
  while (sim.alpha() > sim.alphaMin() && ticks++ < MAX_TICKS) sim.tick();
  sim.stop();

  const positions: Array<[string, number, number]> = nodes.map((n) => [n.id, n.x ?? 0, n.y ?? 0]);
  ctx.postMessage({ type: 'done', gen: msg.gen, positions });
};

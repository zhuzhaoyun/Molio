/**
 * 统一标签 LOD 规则（H2，设计 docs/2026-11-18-graph-h2-expand-interaction-design.md §4.3）。
 *
 * 一条规则同时管常显与 hover（替代旧「焦点邻域全显 + LABEL_BUDGET 度数池」——hover 邻居
 * 无条件显名正是大库「文字干扰」的根）：
 *   1. 候选 = 视口内节点（中心落在 view rect 外扩 radius 的范围内）；
 *   2. eligible = forceShow（trunk blob，直径恒过阈是 T2 的「簇名常显」承诺）|| hovered（拍板 #2
 *      无条件显）|| 屏幕直径 2·radius·k ≥ minScreenDiameter（代拍 C：判屏幕 px 不绑绝对 zoom，
 *      换分辨率/窗口大小不用重调）；
 *   3. 排序 hovered > neighbour > forceShow > 度数降序（同级按 key 字典序稳定）；
 *   4. 截 maxOnScreen——同屏名字总数上限，防边界 zoom 档位上的新汤（neighbour 享优先不豁免）。
 *
 * 纯函数无 Pixi 依赖（node:test 直测，trunkScene.ts 同款纪律）；贪心碰撞检测仍在引擎
 * syncLabels 里做（greedyLabelLayout），本模块只产出「按优先级排序的可见 key 列表」。
 */

export interface LabelLodNode {
  key: string;
  x: number;
  y: number;
  radius: number;
  degree: number;
  /** trunk 簇团 blob：直径豁免（远景簇名不消失，T2 行为不变） */
  forceShow?: boolean;
}

export interface LabelLodInput {
  nodes: LabelLodNode[];
  /** sim 坐标系视口（getSnapshot 的 view 口径：x/y 为左上角，w/h 为世界宽高） */
  view: { x: number; y: number; w: number; h: number };
  /** 当前缩放（屏幕直径 = 2·radius·k） */
  k: number;
  hoveredKey: string | null;
  neighbourKeys: ReadonlySet<string>;
  /** 屏幕直径阈值（px），默认 8（代拍 B，验收校准后钉死） */
  minScreenDiameter?: number;
  /** 同屏可见标签总数上限，默认 60（代拍 B） */
  maxOnScreen?: number;
}

/** 优先级：hovered(0) > neighbour(1) > forceShow(2) > 普通(3) */
function priorityClass(node: LabelLodNode, hoveredKey: string | null, neighbourKeys: ReadonlySet<string>): number {
  if (node.key === hoveredKey) return 0;
  if (neighbourKeys.has(node.key)) return 1;
  if (node.forceShow) return 2;
  return 3;
}

/** 按优先级有序的可见 key 列表（供引擎贪心碰撞检测按序放置）。 */
export function selectLabels(input: LabelLodInput): string[] {
  const {
    nodes,
    view,
    k,
    hoveredKey,
    neighbourKeys,
    minScreenDiameter = 8,
    maxOnScreen = 60,
  } = input;

  const candidates: Array<{ node: LabelLodNode; cls: number }> = [];
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue;
    // 视口过滤：中心落在 rect 外扩 radius 的范围内（贴边节点标签可半出屏）
    if (
      node.x < view.x - node.radius ||
      node.x > view.x + view.w + node.radius ||
      node.y < view.y - node.radius ||
      node.y > view.y + view.h + node.radius
    ) {
      continue;
    }
    const cls = priorityClass(node, hoveredKey, neighbourKeys);
    // eligible：hovered 无条件（拍板 #2）；blob forceShow 豁免；neighbour 只享排序优先、
    // 不豁免直径门（镜头远时关联点高亮但不显名——治汤的关键口径）
    const eligible =
      node.key === hoveredKey ||
      !!node.forceShow ||
      2 * node.radius * k >= minScreenDiameter;
    if (eligible) candidates.push({ node, cls });
  }

  candidates.sort((a, b) => {
    if (a.cls !== b.cls) return a.cls - b.cls;
    if (a.node.degree !== b.node.degree) return b.node.degree - a.node.degree;
    return a.node.key < b.node.key ? -1 : a.node.key > b.node.key ? 1 : 0;
  });

  return candidates.slice(0, maxOnScreen).map((c) => c.node.key);
}

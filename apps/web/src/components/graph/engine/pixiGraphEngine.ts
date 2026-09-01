/**
 * PixiGraphEngine — force-directed knowledge graph renderer.
 *
 * 忠实移植 Quartz v4 的 graph.inline.ts（MIT License, jackyzha0/quartz）：
 *   - per-node / per-link Graphics（PixiJS 8），d3-force 只算坐标不渲染
 *   - 标签 Text 用 resolution: devicePixelRatio * 4 —— 高分辨率栅格化，缩放不糊
 *   - d3-zoom（缩放/平移/触控 pinch）+ d3-drag（节点拖拽，<500ms 判为点击）
 *   - @tweenjs/tween.js 做 hover/焦点 alpha 平滑过渡
 *   - 手动 rAF 渲染循环（app autoStart:false），节点坐标 + 画布中心偏移
 *   - 力模型 v6：charge(repelStrength) + center(centerStrength) + forceX/Y 谐波约束 +
 *     link(distance/strength) + collide(绘制半径×5+4, iterations 3)。
 *     collide 半径远大于绘制半径 → 远看均布、放大后节点彼此分离（Obsidian 同款空气感）
 *
 * 为 Molio 适配（仅扩展，不改变 Quartz 渲染模型）：
 *   - setData(统一节点/边) 之外保留 Minimap getSnapshot/subscribeRender、
 *     搜索 focusNode、设置面板 setForces/setStyle 等公共 API
 *   - hover 高亮节点与连线（焦点模式，hover 优先于搜索选中）；单击节点跳转文档；
 *     点击空白清除搜索选中；双击空白 fit
 */
import { Application, Container, Graphics, Text, Circle } from 'pixi.js';
import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
  forceLink,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
  type ForceLink,
  type ForceManyBody,
  type ForceCenter,
  type ForceCollide,
} from 'd3-force';
import { select } from 'd3-selection';
import { drag, type D3DragEvent } from 'd3-drag';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { Group, Tween } from '@tweenjs/tween.js';
import { NODE_TYPE_COLORS, type ForceParams, type ThemeColors } from '../types';
import {
  clamp,
  easeCubicOut,
  dedupeEdges,
  computeFitTransform,
  greedyLabelLayout,
  tileIsolatedNodes,
  SUPER_HUB_DEGREE,
  type GraphDegreeNode,
} from './graphUtils';

// ── Public types ──

export interface EngineNode {
  key: string;
  label: string;
  path: string;
  linkCount: number;
  nodeType?: string | null;
  /** Dead link placeholder node（未解析的 wikilink） */
  dead?: boolean;
}

export interface EngineEdge {
  source: string;
  target: string;
}

export interface EngineCallbacks {
  /** 单击节点（非拖拽）—— Molio 用于跳转文档 */
  onNodeClick?: (key: string, node: EngineNode) => void;
  onNodeDoubleClick?: (key: string, node: EngineNode) => void;
  onHoverChange?: (key: string | null) => void;
}

export interface EngineOptions {
  theme: ThemeColors;
  forces: ForceParams;
  nodeScale: number;
  edgeWidth: number;
}

export interface GraphSnapshot {
  nodes: Array<{ x: number; y: number }>;
  /** 当前视口（simulation 坐标） */
  view: { x: number; y: number; w: number; h: number };
}

// ── Simulation / render types ──

interface SimNode extends SimulationNodeDatum {
  id: string;
  text: string;
  path: string;
  linkCount: number;
  nodeType?: string | null;
  dead?: boolean;
  radius: number;
  /** 度数排名（0 = 最高），标签显隐预算用 */
  rank: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  // source/target 由 forceLink 解析为 SimNode 对象
}

interface NodeRenderData {
  simulationData: SimNode;
  gfx: Graphics;
  label: Text;
  /** 标签逻辑尺寸（与 resolution 无关），标签碰撞检测用（创建时测量一次） */
  labelW: number;
  labelH: number;
  alpha: number;
  active: boolean;
}

interface LinkRenderData {
  simulationData: SimLink;
  gfx: Graphics;
  color: string;
  alpha: number;
  active: boolean;
}

type TweenNode = { update: (time: number) => void; stop: () => void };

export function nodeColorFor(
  nodeType: string | null | undefined,
  linkCount: number,
  theme: ThemeColors,
): string {
  if (nodeType && NODE_TYPE_COLORS[nodeType]) return NODE_TYPE_COLORS[nodeType]!;
  if (linkCount === 0) return theme.isolated;
  return theme.node;
}

// ── Constants（Quartz 配方）──

const LABEL_FONT = 'Inter, PingFang SC, -apple-system, sans-serif';
const LABEL_FONT_SIZE = 12;
/** 焦点模式下非邻居的淡出透明度（hover / 选中） */
const FADE_ALPHA_HOVER = 0.2;
const FADE_ALPHA_SELECTED = 0.08;
/** hover 细化两档：非关联节点尺寸保留比例（hover 75%，选中 60%） */
const HOVER_DIM_SIZE_RATIO = 0.25;
const FOCUS_DIM_SIZE_RATIO = 0.4;
/** 焦点节点放大倍数（hover 1.2×，选中 1.4×）；hover 时关联节点微缩 */
const HOVER_NODE_SCALE = 1.2;
const SELECTED_NODE_SCALE = 1.4;
const HOVER_ACTIVE_SCALE = 0.85;
/** hover 离开后的迟滞（ms）：跨节点移动时防高亮闪烁 */
const HOVER_LINGER_MS = 150;
/** 单击判定：按下→抬起指针位移 ≤ 该值（canvas CSS px）才算点击，避免快速拖拽误触跳转 */
const CLICK_MOVE_TOLERANCE = 4;
/** 位移场安装阈值：mousedown 不装位移场，位移超过该值（canvas CSS px）才装（=单击零力零运动） */
const DRAG_THRESHOLD = 4;
/** collide 迭代：静止时 3（质量优先），位移场期降到 1（拖拽降质） */
const COLLIDE_ITERATIONS = 3;
/** 标签显隐：屏幕半径阈值（太小不显示）+ 度数预算（候选池上限，实际可见数由碰撞检测决定） */
const LABEL_MIN_SCREEN_RADIUS = 3;
/** 标签与节点顶部的屏幕间距（px，不随缩放变化） */
const LABEL_GAP_SCREEN = 4;
const LABEL_BUDGET = 150;
/** 标签碰撞检测的四周留白（stage-local 单位） */
const LABEL_PAD = 2;
const K_MIN = 0.1;
const K_MAX = 4;
const FIT_PADDING = 80;
/** v6 配方：forceX/Y 谐波约束强度 —— 让长弹簧向心屈服，整体紧凑、局部由 collide 撑开 */
const CONTAIN_STRENGTH = 0.06;
/** v6 配方：collide 半径 = 绘制半径 × MULT + PAD —— 远看均布、放大后节点彼此分离（Obsidian 同款空气感） */
const COLLIDE_RADIUS_MULT = 5;
const COLLIDE_PAD = 4;
/** collide 半径上限：防止度极高的超级 hub 产生非直觉的巨大排斥圈（见 collideRadius 注释） */
const COLLIDE_MAX = 100;
/** manyBody 电荷分母下限：d<DISTANCE_MIN 时按 DISTANCE_MIN 计，封顶 1/d² 电荷爆（拖拽级联的节点瞬时重叠加速） */
const DISTANCE_MIN = 20;
/** 位移场期 collide 迭代降到 1（拖拽降质：collide 是每 tick 最大 CPU 成本） */
const COLLIDE_ITERATIONS_MOTION = 1;
/** 拖拽期 link 强度倍率：调软防「被拖 hub 的 683 条弹簧把整图拽向内收缩」，松手恢复全强度 */
const DRAG_LINK_MULT = 0.4;
/** 拖拽期 alphaTarget：中温保证邻居流体跟随；过高 → 存太多势能松手爆炸，过低 → 僵硬不跟手 */
const DRAG_ALPHA_TARGET = 0.2;
/** 拖拽期 velocityDecay：拖拽与松手共用，吸收回弹能量；过高 → 蠕行缓慢，过低 → 弹跳剧烈 */
const DRAG_VELOCITY_DECAY = 0.6;

export class PixiGraphEngine {
  private container: HTMLElement;
  private app!: Application;
  private canvas!: HTMLCanvasElement;
  private stage!: Container;
  private labelsLayer!: Container<Text>;
  private nodesLayer!: Container<Graphics>;
  private linkLayer!: Container<Graphics>;
  private selectionGfx!: Graphics;

  private theme: ThemeColors;
  private forces: ForceParams;
  private nodeScale: number;
  private edgeWidth: number;

  private sim: Simulation<SimNode, SimLink> | null = null;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private nodeById = new Map<string, SimNode>();
  private adjacency = new Map<string, Set<string>>();
  private nodeRenderData: NodeRenderData[] = [];
  private linkRenderData: LinkRenderData[] = [];

  private tweens = new Map<string, TweenNode>();

  private hoveredNodeId: string | null = null;
  private selectedId: string | null = null;
  /** hover 离开迟滞定时器（150ms）：跨节点移动时防高亮闪烁 */
  private hoverLingerTimer: ReturnType<typeof setTimeout> | null = null;
  private focusedNeighbours = new Set<string>();

  private callbacks: EngineCallbacks = {};
  private destroyed = false;
  private paused = false;

  private width = 0;
  private height = 0;

  private zoomBehavior!: ZoomBehavior<HTMLCanvasElement, unknown>;
  private currentTransform: ZoomTransform = zoomIdentity;
  private suppressZoom = false;
  private viewportAnim: {
    fromTx: number;
    fromTy: number;
    fromK: number;
    toTx: number;
    toTy: number;
    toK: number;
    startTime: number;
    durationMs: number;
  } | null = null;

  private hasUserInteracted = false;
  private hasFitFirstLayout = false;
  private refitTimer: ReturnType<typeof setTimeout> | null = null;
  private rafId = 0;
  private dragStartTime = 0;
  private dragging = false;
  /** drag start 时的指针位置（canvas CSS px），单击位移判定用 */
  private dragStartXY: { x: number; y: number } | null = null;

  // ── 拖拽近流体（P0-1）状态 ──
  /** 被拖节点在 mousedown 时的图坐标（累计位移与单击判定基准） */
  private dragNodeAnchor: { x: number; y: number } | null = null;
  /** 近流体是否已启动——过 DRAG_THRESHOLD 才 true（单击路径恒 false → 零力零运动） */
  private dragFluidActive = false;
  /** 被拖节点 id */
  private dragNodeKey: string | null = null;
  /** 移动降质：true 时隐藏标签 + collide→1 + minimap 暂停 */
  private motionMode = false;

  private renderListeners = new Set<() => void>();
  /** 上次同步标签 scale 的 k —— 标签恒定屏幕尺寸（scale=1/k），k 变化时才批量更新 */
  private lastLabelK = 0;

  private constructor(container: HTMLElement, opts: EngineOptions) {
    this.container = container;
    this.theme = opts.theme;
    this.forces = { ...opts.forces };
    this.nodeScale = opts.nodeScale;
    this.edgeWidth = opts.edgeWidth;
  }

  static async create(container: HTMLElement, opts: EngineOptions): Promise<PixiGraphEngine> {
    const engine = new PixiGraphEngine(container, opts);
    await engine.init();
    return engine;
  }

  private async init(): Promise<void> {
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;

    const app = new Application();
    await app.init({
      resizeTo: this.container,
      antialias: true,
      autoStart: false, // 手动 rAF 驱动渲染（quartz 同款）
      autoDensity: true,
      background: this.theme.bg,
      preference: 'webgl',
      resolution: window.devicePixelRatio,
    });
    if (this.destroyed) {
      app.destroy(true);
      return;
    }
    this.app = app;
    this.width = app.screen.width;
    this.height = app.screen.height;
    this.canvas = app.canvas;
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.container.appendChild(this.canvas);

    this.stage = app.stage;
    // passive：stage 自身不发射事件，但子节点（节点 Graphics）可命中测试
    // （不能用 'none' —— 会剪枝整棵子树，子节点 hover 全部失效）
    this.stage.eventMode = 'passive';

    this.linkLayer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true, sortableChildren: true });
    this.nodesLayer = new Container<Graphics>({ zIndex: 2, isRenderGroup: true });
    this.labelsLayer = new Container<Text>({ zIndex: 3, isRenderGroup: true });
    this.stage.addChild(this.linkLayer, this.nodesLayer, this.labelsLayer);

    this.selectionGfx = new Graphics();
    this.nodesLayer.addChild(this.selectionGfx);

    this.bindZoomAndDrag();
    this.bindNativeEvents();

    this.rafId = requestAnimationFrame(this.renderFrame);

    const ro = new ResizeObserver(() => {
      this.width = this.container.clientWidth;
      this.height = this.container.clientHeight;
      this.app.renderer.resize(this.width, this.height);
    });
    ro.observe(this.container);
  }

  // ── Public API ──

  setCallbacks(cb: EngineCallbacks): void {
    this.callbacks = cb;
  }

  /** Pause/resume the render loop and force simulation, keeping node positions
   *  and viewport intact. Used when the graph tab is tabbed-away but kept alive —
   *  stop burning rAF/CPU on a hidden canvas without losing the layout state. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      cancelAnimationFrame(this.rafId);
      this.sim?.stop();
    } else {
      this.rafId = requestAnimationFrame(this.renderFrame);
      this.sim?.restart();
    }
  }

  setData(nodes: EngineNode[], edges: EngineEdge[]): void {
    if (this.destroyed) return;

    const nodeById = new Map<string, SimNode>();
    const simNodes: SimNode[] = [];
    for (const n of nodes) {
      simNodes.push({
        id: n.key,
        text: n.label,
        path: n.path,
        linkCount: n.linkCount,
        nodeType: n.nodeType ?? null,
        dead: n.dead,
        radius: this.radiusOf(n),
        rank: 0,
      });
    }
    for (const n of simNodes) nodeById.set(n.id, n);
    this.nodes = simNodes;
    this.nodeById = nodeById;

    const simLinks: SimLink[] = dedupeEdges(edges, (k) => nodeById.has(k)).map((e) => ({
      source: nodeById.get(e.source)!,
      target: nodeById.get(e.target)!,
    }));
    this.links = simLinks;

    const adjacency = new Map<string, Set<string>>();
    for (const n of simNodes) adjacency.set(n.id, new Set());
    for (const l of simLinks) {
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      adjacency.get(s.id)!.add(t.id);
      adjacency.get(t.id)!.add(s.id);
    }
    this.adjacency = adjacency;
    const byDegree = [...simNodes].sort(
      (a, b) => (adjacency.get(b.id)?.size ?? 0) - (adjacency.get(a.id)?.size ?? 0),
    );
    byDegree.forEach((n, i) => {
      n.rank = i;
    });

    this.rebuildRendering();

    if (!this.hasFitFirstLayout) {
      this.fitView();
      this.hasFitFirstLayout = true;
      if (this.refitTimer) clearTimeout(this.refitTimer);
      this.refitTimer = setTimeout(() => {
        if (!this.hasUserInteracted && !this.destroyed) this.fitView({ animate: true });
      }, 1500);
    }
  }

  resetPositions(): void {
    this.selectedId = null;
    this.hoveredNodeId = null;
    this.hasFitFirstLayout = false;
    this.updateFocusAndRender();
  }

  setForces(f: ForceParams): void {
    this.forces = { ...f };
    const sim = this.sim;
    if (!sim) return;
    sim.force<ForceManyBody<SimNode>>('charge')?.strength(f.repelStrength);
    sim.force<ForceCenter<SimNode>>('center')?.strength(f.centerStrength);
    const link = sim.force<ForceLink<SimNode, SimLink>>('link');
    if (link) {
      link.distance(f.linkDistance);
      // 0 = d3 默认（按度数加权，hub 连线自动变软）；>0 = 手动覆盖
      link.strength(f.linkStrength > 0 ? f.linkStrength : defaultLinkStrength(this.adjacency));
    }
    // 不 restart —— 让布局自然收敛（Quartz 从不重新加热仿真）
  }

  setStyle(style: { theme?: ThemeColors; nodeScale?: number; edgeWidth?: number }): void {
    if (style.theme) {
      this.theme = style.theme;
      this.app.renderer.background.color = style.theme.bg;
    }
    if (style.nodeScale !== undefined) this.nodeScale = style.nodeScale;
    if (style.edgeWidth !== undefined) this.edgeWidth = style.edgeWidth;

    if (style.nodeScale !== undefined) {
      for (const n of this.nodeById.values()) {
        n.radius = this.radiusOf({ linkCount: n.linkCount, dead: n.dead });
      }
      this.sim?.force<ForceCollide<SimNode>>('collide')?.radius(collideRadius);
    }
    this.redrawAllNodes();
  }

  fitView(opts?: { animate?: boolean; durationMs?: number }): void {
    if (this.nodes.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x == null || n.y == null) continue;
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) return;
    // 节点 stage-local 坐标 = sim + 画布中心偏移
    const cx = this.width / 2;
    const cy = this.height / 2;
    const { tx, ty, k } = computeFitTransform(
      { minX: minX + cx, maxX: maxX + cx, minY: minY + cy, maxY: maxY + cy },
      this.width,
      this.height,
      FIT_PADDING,
      K_MIN,
      K_MAX,
    );
    if (opts?.animate) {
      this.animateToViewport(tx, ty, k, opts.durationMs ?? 500);
    } else {
      this.setTransform(tx, ty, k);
    }
  }

  /** 把 simulation 坐标 (x, y) 移到屏幕中心（minimap 导航用） */
  centerOnGraphPoint(x: number, y: number, opts?: { animate?: boolean; durationMs?: number }): void {
    this.hasUserInteracted = true;
    const k = this.currentTransform.k;
    const tx = this.width / 2 - (x + this.width / 2) * k;
    const ty = this.height / 2 - (y + this.height / 2) * k;
    if (opts?.animate) {
      this.animateToViewport(tx, ty, k, opts.durationMs ?? 250);
    } else {
      this.setTransform(tx, ty, k);
    }
  }

  /** 定位并选中节点（搜索用）：平滑居中缩放 */
  focusNode(key: string, opts?: { targetK?: number; durationMs?: number }): boolean {
    if (this.destroyed) return false;
    const node = this.nodeById.get(key);
    if (!node || node.x == null || node.y == null) return false;
    this.selectedId = key;
    this.updateFocusAndRender();
    const targetK = clamp(opts?.targetK ?? 1.5, K_MIN, K_MAX);
    const tx = this.width / 2 - (node.x + this.width / 2) * targetK;
    const ty = this.height / 2 - (node.y + this.height / 2) * targetK;
    this.animateToViewport(tx, ty, targetK, opts?.durationMs ?? 600);
    return true;
  }

  getSelectedKey(): string | null {
    return this.selectedId;
  }

  getViewport(): { tx: number; ty: number; k: number } {
    const t = this.currentTransform;
    return { tx: t.x, ty: t.y, k: t.k };
  }

  /** 调试用：仿真运行态（alpha / alphaTarget / velocityDecay / 是否正在拖拽全流动）。 */
  getSimState(): { alpha: number; alphaTarget: number; velocityDecay: number; dragging: boolean } {
    const sim = this.sim;
    return {
      alpha: sim ? sim.alpha() : 0,
      alphaTarget: sim ? sim.alphaTarget() : 0,
      velocityDecay: sim ? sim.velocityDecay() : 0,
      dragging: this.dragging,
    };
  }

  /** Minimap / e2e 快照：节点位置 + 视口（simulation 坐标） */
  getSnapshot(): GraphSnapshot | null {
    if (this.nodes.length === 0) return null;
    const t = this.currentTransform;
    return {
      nodes: this.nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 })),
      view: {
        x: (0 - t.x) / t.k - this.width / 2,
        y: (0 - t.y) / t.k - this.height / 2,
        w: this.width / t.k,
        h: this.height / t.k,
      },
    };
  }

  /**
   * 订阅渲染事件：每帧 render 后同步触发。回调内只读，禁止写引擎（防同帧重入）。
   */
  subscribeRender(listener: () => void): () => void {
    this.renderListeners.add(listener);
    return () => {
      this.renderListeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.refitTimer) clearTimeout(this.refitTimer);
    if (this.hoverLingerTimer) clearTimeout(this.hoverLingerTimer);
    this.viewportAnim = null;
    this.tweens.forEach((t) => t.stop());
    this.tweens.clear();
    this.renderListeners.clear();
    cancelAnimationFrame(this.rafId);
    this.sim?.stop();
    if (this.app) {
      this.app.destroy(true, { children: true });
    }
  }

  // ── Internals: 布局 / 渲染 ──

  /** Obsidian 视觉权重：半径 2 倍于 Quartz 式配方，fit 缩放(~0.3)下叶子≈4px、hub≈20px */
  private radiusOf(n: { linkCount: number; dead?: boolean }): number {
    if (n.dead) return 3 * this.nodeScale;
    return (2 + Math.sqrt(n.linkCount)) * 2 * this.nodeScale;
  }


  private rebuildRendering(): void {
    this.sim?.stop();
    this.lastLabelK = 0; // 新标签 scale=1，需重新同步 1/k
    this.nodeRenderData = [];
    this.linkRenderData = [];
    this.tweens.forEach((t) => t.stop());
    this.tweens.clear();

    this.nodesLayer.removeChildren().forEach((c) => c.destroy());
    this.labelsLayer.removeChildren().forEach((c) => c.destroy());
    this.linkLayer.removeChildren().forEach((c) => c.destroy());
    this.selectionGfx = new Graphics();
    this.nodesLayer.addChild(this.selectionGfx);

    const sim = forceSimulation<SimNode>(this.nodes)
      .force('charge', forceManyBody<SimNode>().strength(this.forces.repelStrength).distanceMin(DISTANCE_MIN))
      .force('center', forceCenter<SimNode>(0, 0).strength(this.forces.centerStrength))
      .force(
        'link',
        forceLink<SimNode, SimLink>(this.links)
          .id((d) => d.id)
          .distance(this.forces.linkDistance)
          .strength(
            this.forces.linkStrength > 0 ? this.forces.linkStrength : defaultLinkStrength(this.adjacency),
          ),
      )
      .force('x', forceX<SimNode>(0).strength(CONTAIN_STRENGTH))
      .force('y', forceY<SimNode>(0).strength(CONTAIN_STRENGTH))
      .force('collide', forceCollide<SimNode>().radius(collideRadius).iterations(COLLIDE_ITERATIONS));
    // 仿真收敛后布局范围才稳定 —— 若用户未交互过，重新 fit 一次，
    // 避免「早期小范围 fit 的缩放」看「后期大范围布局」导致放大叠团的错觉
    sim.on('end', () => {
      if (!this.hasUserInteracted && !this.destroyed) this.fitView({ animate: true });
    });
    this.sim = sim;

    const dpr = window.devicePixelRatio;

    for (const n of this.nodes) {
      // 死链节点用虚线感的中性色区分（theme.deadNode）
      const color = n.dead ? this.theme.deadNode : nodeColorFor(n.nodeType, n.linkCount, this.theme);
      const gfx = new Graphics({
        interactive: true,
        eventMode: 'static',
        hitArea: new Circle(0, 0, n.radius + 3),
        cursor: 'pointer',
      })
        .circle(0, 0, n.radius)
        .fill({ color });
      gfx.on('pointerover', () => this.onNodePointerOver(n.id));
      gfx.on('pointerleave', () => this.onNodePointerLeave(n.id));
      this.nodesLayer.addChild(gfx);

      const label = new Text({
        interactive: false,
        eventMode: 'none',
        text: n.text,
        alpha: 0,
        anchor: { x: 0.5, y: 1 }, // 底边中点对齐 position；position 每帧设在节点上方（屏幕间距）
        style: {
          fontSize: LABEL_FONT_SIZE,
          fill: this.theme.label,
          fontFamily: LABEL_FONT,
        },
        // 高分辨率栅格化：缩放时文字不糊（Quartz 同款，关键）
        resolution: dpr * 4,
      });
      this.labelsLayer.addChild(label);

      this.nodeRenderData.push({
        simulationData: n,
        gfx,
        label,
        labelW: label.width,
        labelH: label.height,
        alpha: 1,
        active: false,
      });
    }

    for (const l of this.links) {
      const gfx = new Graphics({ interactive: false, eventMode: 'none' });
      this.linkLayer.addChild(gfx);
      this.linkRenderData.push({ simulationData: l, gfx, color: this.theme.edge, alpha: 1, active: false });
    }

    this.updateFocusAndRender();
  }

  private redrawAllNodes(): void {
    for (const n of this.nodeRenderData) {
      const d = n.simulationData;
      n.gfx.clear();
      n.gfx.circle(0, 0, d.radius).fill({
        color: d.dead ? this.theme.deadNode : nodeColorFor(d.nodeType, d.linkCount, this.theme),
      });
    }
    for (const l of this.linkRenderData) {
      l.color = this.theme.edge;
    }
  }

  // ── hover / 焦点 ──

  private onNodePointerOver(id: string): void {
    if (this.dragging) return;
    if (this.hoverLingerTimer) {
      clearTimeout(this.hoverLingerTimer);
      this.hoverLingerTimer = null;
    }
    this.hoveredNodeId = id;
    this.callbacks.onHoverChange?.(id);
    this.updateFocusAndRender();
  }

  private onNodePointerLeave(_id: string): void {
    if (this.dragging) return;
    // 150ms 迟滞：快速跨过多个节点时不闪烁；期间重新进入（over）则取消。
    if (this.hoverLingerTimer) clearTimeout(this.hoverLingerTimer);
    this.hoverLingerTimer = setTimeout(() => {
      this.hoveredNodeId = null;
      this.callbacks.onHoverChange?.(null);
      this.updateFocusAndRender();
      this.hoverLingerTimer = null;
    }, HOVER_LINGER_MS);
  }

  /** 当前焦点：hover 优先于搜索选中 —— hover 永远即时高亮指针下的节点 */
  private get focusId(): string | null {
    return this.hoveredNodeId ?? this.selectedId;
  }

  /** 重算焦点邻居 + 各元素 active 标记 */
  private updateFocus(): void {
    const focusId = this.focusId;
    const neighbours = new Set<string>();
    if (focusId) {
      neighbours.add(focusId);
      const adj = this.adjacency.get(focusId);
      if (adj) for (const id of adj) neighbours.add(id);
    }
    this.focusedNeighbours = neighbours;
    for (const n of this.nodeRenderData) {
      n.active = neighbours.has(n.simulationData.id);
    }
    for (const l of this.linkRenderData) {
      const s = l.simulationData.source as SimNode;
      const t = l.simulationData.target as SimNode;
      l.active = s.id === focusId || t.id === focusId;
    }
  }

  private updateFocusAndRender(): void {
    this.updateFocus();
    this.renderNodesTween();
    this.renderLinksTween();
    this.syncLabels();
  }

  // ── tween 渲染（Quartz 同款）──

  private renderNodesTween(): void {
    this.tweens.get('hover')?.stop();
    const group = new Group();
    const focusId = this.focusId;
    const isSelected = focusId !== null && focusId === this.selectedId;
    const dim = isSelected ? FADE_ALPHA_SELECTED : FADE_ALPHA_HOVER;
    for (const n of this.nodeRenderData) {
      const id = n.simulationData.id;
      const active = focusId !== null && n.active;
      const alpha = focusId === null ? 1 : active ? 1 : dim;
      // 两档淡化：focus 放大（hover 1.2× / 选中 1.4×）；关联 hover 微缩 0.85；
      // 非关联按档位缩小（hover 75% / 选中 60%）。alpha + scale 一并 tween。
      let targetScale = 1;
      if (focusId !== null) {
        if (id === focusId) targetScale = isSelected ? SELECTED_NODE_SCALE : HOVER_NODE_SCALE;
        else if (active) targetScale = isSelected ? 1 : HOVER_ACTIVE_SCALE;
        else targetScale = 1 - (isSelected ? FOCUS_DIM_SIZE_RATIO : HOVER_DIM_SIZE_RATIO);
      }
      const holder = { a: n.gfx.alpha, s: n.gfx.scale.x };
      group.add(
        new Tween(holder)
          .to({ a: alpha, s: targetScale }, 200)
          .onUpdate(() => {
            n.gfx.alpha = holder.a;
            n.gfx.scale.set(holder.s, holder.s);
          }),
      );
    }
    group.getAll().forEach((tw) => tw.start());
    this.tweens.set('hover', makeTweenNode(group));
  }

  private renderLinksTween(): void {
    this.tweens.get('link')?.stop();
    const group = new Group();
    const focusId = this.focusId;
    for (const l of this.linkRenderData) {
      const alpha = focusId === null ? 1 : l.active ? 1 : 0.2;
      l.color = l.active ? this.theme.edgeHover : this.theme.edge;
      // 高亮边置顶（zIndex 1），不被淡化边遮挡；无焦点时归位 0
      l.gfx.zIndex = l.active ? 1 : 0;
      group.add(new Tween<LinkRenderData>(l).to({ alpha }, 200));
    }
    group.getAll().forEach((tw) => tw.start());
    this.tweens.set('link', makeTweenNode(group));
  }

  /**
   * 标签显隐 + Obsidian 式去重：同一时刻可见标签互不重叠，且随缩放渐进显隐。
   *
   * 标签恒定屏幕尺寸（scale = 1/k），因此 stage-local 包围盒 = 屏幕尺寸 / k：
   * 放大时盒变小 → 更多标签放得下 → 渐进显示；缩小时反之。这正是 Obsidian
   * 「远看只有 hub 有文字、放大后文字逐个浮现」的行为。
   *
   * 1. 候选：焦点邻域（总是显示）∪（屏幕半径达标 且 度数排名在候选池内）
   * 2. 贪心碰撞检测：焦点标签先放置且总是显示；普通标签按度数排名放置，
   *    与已放置标签重叠则隐藏——「文字永不叠在一起」。
   */
  private syncLabels(): void {
    const focusId = this.focusId;
    const dim = focusId !== null && focusId === this.selectedId ? FADE_ALPHA_SELECTED : FADE_ALPHA_HOVER;
    const k = this.currentTransform.k;
    const cx = this.width / 2;
    const cy = this.height / 2;

    // 标签恒定屏幕尺寸：k 变化时批量同步 scale（1/k）
    if (k !== this.lastLabelK) {
      this.lastLabelK = k;
      const s = 1 / k;
      for (const rd of this.nodeRenderData) rd.label.scale.set(s, s);
    }

    interface Candidate {
      rd: NodeRenderData;
      focused: boolean;
    }
    const focusedCands: Candidate[] = [];
    const normalCands: Candidate[] = [];

    for (const rd of this.nodeRenderData) {
      const d = rd.simulationData;
      if (d.x == null || d.y == null) {
        rd.label.visible = false;
        continue;
      }
      if (focusId !== null && this.focusedNeighbours.has(d.id)) {
        focusedCands.push({ rd, focused: true });
        continue;
      }
      rd.label.visible = false; // 先隐藏非焦点标签，碰撞检测后再点亮
      if (d.radius * k >= LABEL_MIN_SCREEN_RADIUS && d.rank < LABEL_BUDGET) {
        normalCands.push({ rd, focused: false });
      }
    }
    // 度数高的标签优先显示
    normalCands.sort((a, b) => a.rd.simulationData.rank - b.rd.simulationData.rank);

    const ordered = focusedCands.concat(normalCands);
    // 包围盒（stage-local）= 屏幕尺寸 / k；标签底边位于节点上方 LABEL_GAP_SCREEN 屏幕像素
    const boxes = ordered.map(({ rd }) => {
      const d = rd.simulationData;
      const lx = d.x! + cx;
      const top = d.y! + cy - d.radius - LABEL_GAP_SCREEN / k;
      const w = rd.labelW / k;
      const h = rd.labelH / k;
      const pad = LABEL_PAD / k;
      return {
        x0: lx - w / 2 - pad,
        x1: lx + w / 2 + pad,
        y0: top - h - pad,
        y1: top + pad,
      };
    });
    const visible = greedyLabelLayout(
      boxes,
      ordered.map((c) => c.focused),
    );

    for (let i = 0; i < ordered.length; i++) {
      const { rd, focused } = ordered[i]!;
      rd.label.visible = visible[i]!;
      rd.label.alpha = focusId !== null && !focused ? dim : 1;
    }
  }

  private syncSelectionRing(): void {
    const node = this.selectedId ? this.nodeById.get(this.selectedId) : null;
    const cx = this.width / 2;
    const cy = this.height / 2;
    this.selectionGfx.clear();
    if (node && node.x != null && node.y != null) {
      this.selectionGfx
        .circle(node.x + cx, node.y + cy, node.radius + 2)
        .stroke({ width: 2, color: this.theme.selectedBorder });
    }
  }

  // ── 视口变换 ──

  private setTransform(tx: number, ty: number, k: number): void {
    this.viewportAnim = null;
    const t = zoomIdentity.translate(tx, ty).scale(k);
    this.applyTransform(t);
    this.syncD3Transform(t);
  }

  private applyTransform(t: ZoomTransform): void {
    this.currentTransform = t;
    this.stage.scale.set(t.k, t.k);
    this.stage.position.set(t.x, t.y);
    this.syncLabels();
    this.syncSelectionRing();
  }

  /** 静默同步 d3-zoom 内部状态（不触发用户手势副作用） */
  private syncD3Transform(t: ZoomTransform): void {
    this.suppressZoom = true;
    this.zoomBehavior.transform(select(this.canvas), t);
    this.suppressZoom = false;
  }

  private animateToViewport(tx: number, ty: number, k: number, durationMs = 500): void {
    const kClamped = clamp(k, K_MIN, K_MAX);
    if (durationMs <= 0) {
      this.setTransform(tx, ty, kClamped);
      return;
    }
    this.viewportAnim = {
      fromTx: this.currentTransform.x,
      fromTy: this.currentTransform.y,
      fromK: this.currentTransform.k,
      toTx: tx,
      toTy: ty,
      toK: kClamped,
      startTime: performance.now(),
      durationMs,
    };
    this.hasUserInteracted = true;
  }

  private advanceViewport(): void {
    const anim = this.viewportAnim;
    if (!anim) return;
    const t = Math.min((performance.now() - anim.startTime) / anim.durationMs, 1);
    const e = easeCubicOut(t);
    const tx = anim.fromTx + (anim.toTx - anim.fromTx) * e;
    const ty = anim.fromTy + (anim.toTy - anim.fromTy) * e;
    const k = anim.fromK + (anim.toK - anim.fromK) * e;
    const next = zoomIdentity.translate(tx, ty).scale(k);
    this.applyTransform(next);
    if (t >= 1) {
      this.viewportAnim = null;
      this.syncD3Transform(next);
    }
  }

  // ── 拖拽全流动流体（P0-1）+ 移动降质（P0-2）──

  /** 由当前 nodes/adjacency 构建平铺函数所需的 degree 节点数组 */
  private degreeNodes(): GraphDegreeNode[] {
    return this.nodes.map((n) => ({
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      degree: this.adjacency.get(n.id)?.size ?? 0,
    }));
  }

  /** 把被拖节点钉到指定图坐标（写 x/y/fx/fy；sim 运行时 fx/fy 固定，x/y 落在 fx/fy 处） */
  private pinGraph(node: SimNode, x: number, y: number): void {
    node.x = x;
    node.y = y;
    node.fx = x;
    node.fy = y;
  }

  /** 解除所有节点的 fx/fy（单击路径复位，让图恢复自由布局）。 */
  private unpinAllNodes(): void {
    for (const n of this.nodes) {
      n.fx = null;
      n.fy = null;
    }
  }

  /**
   * activateDragFluid：过 DRAG_THRESHOLD 后启动拖拽（Obsidian 标准：整图自由流动 + 中温 alphaTarget 0.3）。
   */
  /** 设置 link 强度：base(常量或按度数加权) × mult——拖拽期调软防 hub 把整图拽向内，松手恢复全强度。 */
  private setDragLinkStrength(mult: number): void {
    const force = this.sim?.force<ForceLink<SimNode, SimLink>>('link');
    if (!force) return;
    const base = this.forces.linkStrength > 0 ? this.forces.linkStrength : defaultLinkStrength(this.adjacency);
    if (typeof base === 'number') force.strength(base * mult);
    else force.strength((l) => base(l) * mult);
  }

  private activateDragFluid(): void {
    const sim = this.sim;
    if (!sim) return;
    this.dragFluidActive = true;
    this.setMotionMode(true); // 拖拽降质：藏标签 + minimap 暂停
    // Obsidian 标准拖拽（整图自由流动，中温保温）+ hub 专用稳定：
    // ① 被拖节点 collide 半径调小（deg683 hub 的 285 半径球碾压集群 → 电荷爆），
    // ② link 调软（hub 的 683 条弹簧把整图拽向内收缩）。整图仍自由流动。
    const dragKey = this.dragNodeKey;
    sim.force<ForceCollide<SimNode>>('collide')?.radius((d: SimNode) =>
      dragKey && d.id === dragKey ? d.radius + COLLIDE_PAD : collideRadius(d),
    );
    sim.force<ForceCollide<SimNode>>('collide')?.strength(1);
    this.setDragLinkStrength(DRAG_LINK_MULT);
    sim.velocityDecay(DRAG_VELOCITY_DECAY);
    sim.alphaTarget(DRAG_ALPHA_TARGET).restart();
  }

  /**
   * endDragFluid：松手。恢复 rest 力配置（collide 半径 / link 强度 / damping），
   * Obsidian 标准松手 alphaTarget(0) 冷却：整图（含被拖节点，fx/fy 已在 end 复位为 null）
   * 自然沉降、边像弹簧一样回弹收敛，不被钉在落点。
   */
  private endDragFluid(): void {
    this.dragFluidActive = false;
    this.dragNodeKey = null;
    this.setMotionMode(false);
    this.tileIsolated();
    const sim = this.sim;
    if (!sim) return;
    sim.force<ForceCollide<SimNode>>('collide')?.radius(collideRadius);
    sim.force<ForceCollide<SimNode>>('collide')?.strength(1);
    this.setDragLinkStrength(1);
    sim.velocityDecay(DRAG_VELOCITY_DECAY);
    sim.alphaTarget(0);
  }

  /** 重铺孤立节点到外围圆环并钉住（拖拽全流动解锁后归位）。 */
  private tileIsolated(): void {
    const tiled = tileIsolatedNodes(this.degreeNodes());
    if (tiled.size === 0) return;
    for (const [id, p] of tiled) {
      const n = this.nodeById.get(id);
      if (!n) continue;
      n.x = p.x;
      n.y = p.y;
      n.fx = p.x;
      n.fy = p.y;
    }
  }

  /** 移动降质：拖拽期间隐藏标签 + minimap 暂停（collide 不迭代降级——保帧也保 spring 手感）。 */
  setMotionMode(active: boolean): void {
    this.motionMode = active;
    if (active) {
      // 隐藏标签：拖拽期不重测/重传标签纹理
      for (const rd of this.nodeRenderData) rd.label.visible = false;
    }
  }

  // ── 交互（d3-zoom + d3-drag，Quartz 同款）──

  private bindZoomAndDrag(): void {
    const canvas = this.canvas;

    this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .extent([
        [0, 0],
        [this.width, this.height],
      ])
      .scaleExtent([K_MIN, K_MAX])
      .on('zoom', (event: { transform: ZoomTransform }) => {
        if (this.suppressZoom) return;
        this.viewportAnim = null;
        this.hasUserInteracted = true;
        this.applyTransform(event.transform);
      });
    // 关键：drag 必须先于 zoom 注册。d3-zoom 的 mousedown 每次都会
    // stopImmediatePropagation()；而 d3-drag 仅在命中 subject（节点）时才 stop
    // —— 先注册 drag，则「命中节点 → 拖节点」「空白 → d3-drag 提前 return → zoom 平移」。
    select<HTMLCanvasElement, SimNode | undefined>(canvas).call(
      drag<HTMLCanvasElement, SimNode | undefined>()
        .container(() => canvas)
        .subject(() => (this.hoveredNodeId ? this.nodeById.get(this.hoveredNodeId) : undefined))
        .on('start', (event: D3DragEvent<HTMLCanvasElement, SimNode | undefined, SimNode | undefined>) => {
          const subj = event.subject;
          if (!subj) return;
          // 单击判定基准 + 全图质心：mousedown 只记录，不装流体、不 wake（=单击零力零运动，
          // 消除「单击选中时图呼吸抖动」）。仅锁被拖节点防碰撞推走，并解锁其余节点（拖拽全流动）。
          this.dragStartTime = Date.now();
          this.dragStartXY = { x: event.x, y: event.y };
          this.dragNodeAnchor = { x: subj.x!, y: subj.y! };
          this.dragFluidActive = false;
          this.dragNodeKey = subj.id;
          this.dragging = true;
          this.hasUserInteracted = true; // 交互过 → 拖拽松手后 sim end 不再重新 fit（防视口 pop）
          // Obsidian 标准：整图自由（无 far-anchor），只钉被拖节点；sim 静止时点击零运动
          this.pinGraph(subj, subj.x!, subj.y!);
        })
        .on('drag', (event: D3DragEvent<HTMLCanvasElement, SimNode | undefined, SimNode | undefined>) => {
          const subj = event.subject;
          if (!subj || !this.dragStartXY || !this.dragNodeAnchor) return;
          const startPx = this.dragStartXY;
          const moveDist = Math.hypot(event.x - startPx.x, event.y - startPx.y);
          const k = this.currentTransform.k;
          // 累计图坐标位移（屏幕位移/k，拖拽期相机冻结，k 恒定）
          const accum = { x: (event.x - startPx.x) / k, y: (event.y - startPx.y) / k };
          const gx = this.dragNodeAnchor.x + accum.x;
          const gy = this.dragNodeAnchor.y + accum.y;

          if (!this.dragFluidActive) {
            if (moveDist > DRAG_THRESHOLD) {
              // 过阈值才启动流体：延后到此刻（mousedown 不装）→ 单击选中不触发任何位移，无点击抖动
              this.activateDragFluid();
            } else {
              // 未过阈值：仅钉被拖节点跟随光标（不动其它、不加热 sim、不进入降质）
              this.pinGraph(subj, gx, gy);
              return;
            }
          }

          if (!this.dragFluidActive) return; // activateDragFluid 可能因 sim 缺失等提前返回（安全兜底）
          // 近流体：被拖节点钉跟光标；其余已释放节点交给物理自由流动（有机流体、沿图边流动）
          this.pinGraph(subj, gx, gy);
        })
        .on('end', (event: D3DragEvent<HTMLCanvasElement, SimNode | undefined, SimNode | undefined>) => {
          const subj = event.subject;
          if (!subj) return;
          const wasFluid = this.dragFluidActive;
          subj.fx = null;
          subj.fy = null;
          this.dragging = false;
          const moved = this.dragStartXY
            ? Math.hypot(event.x - this.dragStartXY.x, event.y - this.dragStartXY.y)
            : Infinity;
          this.dragStartXY = null;
          if (wasFluid) {
            this.endDragFluid(); // 撤质心锚定 + 孤立重铺 + 物理回弹
          } else {
            // 单击路径（未过阈值）：零力零运动。清掉 start 时记录的拖拽状态（fluid 未启动，不触发物理）。
            this.dragNodeAnchor = null;
            this.dragNodeKey = null;
            this.unpinAllNodes(); // mousedown 钉过全部，单击也要解除，否则图被钉住
            if (Date.now() - this.dragStartTime < 500 && moved <= CLICK_MOVE_TOLERANCE) {
              this.callbacks.onNodeClick?.(subj.id, toEngineNode(subj));
            }
          }
        }),
    );

    select<HTMLCanvasElement, unknown>(canvas).call(this.zoomBehavior);
    // 关闭 d3-zoom 默认双击缩放，由 Molio 处理双击（打开文件 / fit）
    // 注意：dblclick.zoom 是 selection 层 DOM 监听，须用 select().on() 移除（zoomBehavior.on 只认 start/zoom/end）
    select<HTMLCanvasElement, unknown>(canvas).on('dblclick.zoom', null);
  }

  private bindNativeEvents(): void {
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.canvas.addEventListener('click', this.onCanvasClick);
  }

  /** 点击空白：清除搜索选中（选中态的强淡出会压制 hover，给用户一个还原手段） */
  private onCanvasClick = (e: MouseEvent): void => {
    if (this.selectedId === null) return;
    if (this.hitTest(e)) return; // 点中节点：跳转由 drag end 的单击判定负责
    this.selectedId = null;
    this.updateFocusAndRender();
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const node = this.hitTest(e);
    this.hasUserInteracted = true;
    if (node) {
      // 死链节点也触发双击（由 GraphPage 决定：新建空白页并打开）
      this.callbacks.onNodeDoubleClick?.(node.id, toEngineNode(node));
    } else {
      this.fitView({ animate: true });
    }
  };

  /** 双击命中检测：canvas 坐标 → simulation 坐标 */
  private hitTest(e: MouseEvent): SimNode | null {
    const rect = this.canvas.getBoundingClientRect();
    const gx = (e.clientX - rect.left - this.currentTransform.x) / this.currentTransform.k - this.width / 2;
    const gy = (e.clientY - rect.top - this.currentTransform.y) / this.currentTransform.k - this.height / 2;
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of this.nodeById.values()) {
      if (n.x == null || n.y == null) continue;
      const dist = Math.hypot(n.x - gx, n.y - gy);
      if (dist < Math.max(n.radius * 1.5, 8) && dist < bestDist) {
        bestDist = dist;
        best = n;
      }
    }
    return best;
  }

  private readonly renderFrame = (time: number): void => {
    if (this.destroyed) return;
    this.advanceViewport();
    for (const t of this.tweens.values()) t.update(time);

    const cx = this.width / 2;
    const cy = this.height / 2;
    for (const n of this.nodeRenderData) {
      const d = n.simulationData;
      if (d.x == null || d.y == null) continue;
      const x = d.x + cx;
      const y = d.y + cy;
      n.gfx.position.set(x, y);
      n.label.position.set(x, y - d.radius - LABEL_GAP_SCREEN / this.currentTransform.k);
    }
    for (const l of this.linkRenderData) {
      const d = l.simulationData;
      const s = d.source as SimNode;
      const t = d.target as SimNode;
      if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
      l.gfx.clear();
      l.gfx
        .moveTo(s.x + cx, s.y + cy)
        .lineTo(t.x + cx, t.y + cy)
        .stroke({ alpha: l.alpha, width: this.edgeWidth, color: l.color });
    }

    // 拖拽降质：位移场期跳过标签重排（标签已隐藏）与 minimap 重绘监听
    if (!this.motionMode) {
      this.syncLabels();
      for (const listener of this.renderListeners) listener();
    }
    this.syncSelectionRing();

    this.app.renderer.render(this.stage);
    this.rafId = requestAnimationFrame(this.renderFrame);
  };
}

// ── Helpers ──

function makeTweenNode(group: Group): TweenNode {
  return {
    update: (time) => group.update(time),
    stop() {
      group.getAll().forEach((tw) => tw.stop());
    },
  };
}

/** d3 forceLink 默认强度：1/min(度数source, 度数target)；但当一边是超级 hub（度数>阈值）时按 1/√max 大幅减弱 */
function defaultLinkStrength(adjacency: ReadonlyMap<string, ReadonlySet<string>>) {
  return (l: SimLink) => {
    const s = l.source as SimNode;
    const t = l.target as SimNode;
    const ds = Math.max(adjacency.get(s.id)?.size ?? 1, 1);
    const dt = Math.max(adjacency.get(t.id)?.size ?? 1, 1);
    const hi = Math.max(ds, dt);
    if (hi > SUPER_HUB_DEGREE) return 1 / Math.sqrt(hi);
    return 1 / Math.min(ds, dt);
    // 与 graphUtils.makeAutoLinkStrength 保持一致（单一来源 SUPER_HUB_DEGREE）
  };
}

function collideRadius(d: SimNode): number {
  // 上限：deg-683 巨型 hub 的 collide（radius*5+4 = 285）会让任何扰动在星形图里被放大成连锁爆炸；
  // 封顶到 COLLIDE_MAX，使单个超级节点不至于用「违反直觉的 285 半径球」碾压整张图。
  return Math.min(d.radius * COLLIDE_RADIUS_MULT + COLLIDE_PAD, COLLIDE_MAX);
}

function toEngineNode(n: SimNode): EngineNode {
  return {
    key: n.id,
    label: n.text,
    path: n.path,
    linkCount: n.linkCount,
    nodeType: n.nodeType ?? null,
    dead: n.dead,
  };
}

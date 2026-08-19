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
 *   - 单击选中（焦点模式），双击节点打开文件、双击空白 fit
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
  type ForceX,
  type ForceY,
  type ForceCollide,
} from 'd3-force';
import { select } from 'd3-selection';
import { drag, type D3DragEvent } from 'd3-drag';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { Group, Tween } from '@tweenjs/tween.js';
import { NODE_TYPE_COLORS, type ForceParams, type ThemeColors } from '../types';
import { clamp, easeCubicOut, dedupeEdges, computeFitTransform, greedyLabelLayout } from './graphUtils';

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
  /** drag start 记录的初始位置（quartz 同款） */
  initialDragPos?: { x: number; y: number; fx: number | null; fy: number | null };
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
/** 标签显隐：屏幕半径阈值（太小不显示）+ 度数预算（候选池上限，实际可见数由碰撞检测决定） */
const LABEL_MIN_SCREEN_RADIUS = 3;
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
  private focusedNeighbours = new Set<string>();

  private callbacks: EngineCallbacks = {};
  private destroyed = false;

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

  private renderListeners = new Set<() => void>();

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

    this.linkLayer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true });
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
      .force('charge', forceManyBody<SimNode>().strength(this.forces.repelStrength))
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
      .force('collide', forceCollide<SimNode>().radius(collideRadius).iterations(3));
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
        anchor: { x: 0.5, y: 1.2 },
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
    this.hoveredNodeId = id;
    this.callbacks.onHoverChange?.(id);
    this.updateFocusAndRender();
  }

  private onNodePointerLeave(_id: string): void {
    if (this.dragging) return;
    this.hoveredNodeId = null;
    this.callbacks.onHoverChange?.(null);
    this.updateFocusAndRender();
  }

  private toggleSelect(id: string): void {
    this.selectedId = this.selectedId === id ? null : id;
    this.updateFocusAndRender();
    const node = this.nodeById.get(id);
    if (node) this.callbacks.onNodeClick?.(id, toEngineNode(node));
  }

  /** 重算焦点邻居 + 各元素 active 标记 */
  private updateFocus(): void {
    const focusId = this.selectedId ?? this.hoveredNodeId;
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
    const focusId = this.selectedId ?? this.hoveredNodeId;
    const dim = this.selectedId ? FADE_ALPHA_SELECTED : FADE_ALPHA_HOVER;
    for (const n of this.nodeRenderData) {
      const alpha = focusId === null ? 1 : n.active ? 1 : dim;
      group.add(new Tween<Graphics>(n.gfx).to({ alpha }, 200));
    }
    group.getAll().forEach((tw) => tw.start());
    this.tweens.set('hover', makeTweenNode(group));
  }

  private renderLinksTween(): void {
    this.tweens.get('link')?.stop();
    const group = new Group();
    const focusId = this.selectedId ?? this.hoveredNodeId;
    for (const l of this.linkRenderData) {
      const alpha = focusId === null ? 1 : l.active ? 1 : 0.2;
      l.color = l.active ? this.theme.edgeHover : this.theme.edge;
      group.add(new Tween<LinkRenderData>(l).to({ alpha }, 200));
    }
    group.getAll().forEach((tw) => tw.start());
    this.tweens.set('link', makeTweenNode(group));
  }

  /**
   * 标签显隐 + Obsidian 式去重：可见标签在任何缩放级别下都不重叠。
   *
   * 1. 候选：焦点邻域（总是显示）∪（屏幕半径达标 且 度数排名在候选池内）
   * 2. 贪心碰撞检测：stage-local 坐标下算包围盒（均匀缩放不改变重叠关系，
   *    结果与缩放无关）。焦点标签先放置且总是显示；普通标签按度数排名放置，
   *    与已放置标签重叠则隐藏——这就是 Obsidian「文字永不叠在一起」的来源。
   */
  private syncLabels(): void {
    const focusId = this.selectedId ?? this.hoveredNodeId;
    const dim = this.selectedId ? FADE_ALPHA_SELECTED : FADE_ALPHA_HOVER;
    const k = this.currentTransform.k;
    const cx = this.width / 2;
    const cy = this.height / 2;

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

    // anchor {x:0.5, y:1.2} → 标签整体位于节点上方：
    // 上边缘 ly-1.2h，下边缘 ly-0.2h，水平居中于节点
    const ordered = focusedCands.concat(normalCands);
    const boxes = ordered.map(({ rd }) => {
      const d = rd.simulationData;
      const lx = d.x! + cx;
      const ly = d.y! + cy;
      return {
        x0: lx - rd.labelW / 2 - LABEL_PAD,
        x1: lx + rd.labelW / 2 + LABEL_PAD,
        y0: ly - 1.2 * rd.labelH - LABEL_PAD,
        y1: ly - 0.2 * rd.labelH + LABEL_PAD,
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
          if (!event.active) this.sim?.alphaTarget(1).restart();
          subj.fx = subj.x;
          subj.fy = subj.y;
          subj.initialDragPos = { x: subj.x!, y: subj.y!, fx: subj.fx ?? null, fy: subj.fy ?? null };
          this.dragStartTime = Date.now();
          this.dragging = true;
        })
        .on('drag', (event: D3DragEvent<HTMLCanvasElement, SimNode | undefined, SimNode | undefined>) => {
          const subj = event.subject;
          if (!subj || !subj.initialDragPos) return;
          const init = subj.initialDragPos;
          // 补偿缩放：屏幕位移 / k 转 graph 位移（Quartz 同款）
          subj.fx = init.x + (event.x - init.x) / this.currentTransform.k;
          subj.fy = init.y + (event.y - init.y) / this.currentTransform.k;
        })
        .on('end', (event: D3DragEvent<HTMLCanvasElement, SimNode | undefined, SimNode | undefined>) => {
          const subj = event.subject;
          if (!subj) return;
          if (!event.active) this.sim?.alphaTarget(0);
          subj.fx = null;
          subj.fy = null;
          this.dragging = false;
          if (Date.now() - this.dragStartTime < 500) {
            this.toggleSelect(subj.id);
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
  }

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
      n.label.position.set(x, y);
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

    this.syncLabels();
    this.syncSelectionRing();

    this.app.renderer.render(this.stage);
    for (const listener of this.renderListeners) listener();
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

/** d3 forceLink 默认强度：1/min(度数source, 度数target) */
function defaultLinkStrength(adjacency: ReadonlyMap<string, ReadonlySet<string>>) {
  return (l: SimLink) => {
    const s = l.source as SimNode;
    const t = l.target as SimNode;
    const ds = Math.max(adjacency.get(s.id)?.size ?? 1, 1);
    const dt = Math.max(adjacency.get(t.id)?.size ?? 1, 1);
    return 1 / Math.min(ds, dt);
  };
}

function collideRadius(d: SimNode): number {
  return d.radius * COLLIDE_RADIUS_MULT + COLLIDE_PAD;
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

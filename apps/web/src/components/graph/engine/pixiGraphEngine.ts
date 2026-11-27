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
 *   - trunk 模式（T2，设计 §4.2）：setTrunkData 把 hub+簇团+聚合边表示成常规
 *     引擎节点/边——zoom/fit/snapshot/minimap/hover/脏标记协议全复用；簇团只是
 *     「带 trunkCluster 标记的节点」（blob 半径/簇色/常显标签），聚合边是「带
 *     trunkWeight 的边」（宽 ∝ log weight）。仿真用固定配方 TRUNK_FORCE（用户
 *     forces 只作用全量图），几十对象同步 settle 后立即 fit——不跑收敛三段式。
 */
import { Application, Container, Graphics, Text, Circle, Rectangle, type ContainerChild } from 'pixi.js';
import { computeExportRect, resolveExportScale, viewportWorldRect, type Bounds } from './exportImage';
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
import { GRAPH_LAYOUT_RECIPE, autoLinkStrength } from '@molio/contracts';
import { planSeedRefine } from '../seedPolicy';
import {
  trunkBlobRadius,
  trunkEdgeWidth,
  trunkClusterColor,
  type TrunkScene,
} from '../trunkScene';
import {
  clamp,
  easeCubicOut,
  dedupeEdges,
  computeFitTransform,
  greedyLabelLayout,
  tileIsolatedNodes,
  SUPER_HUB_DEGREE,
  collideRadiusValue,
  COLLIDE_PAD,
  type GraphDegreeNode,
} from './graphUtils';
import { selectLabels, type LabelLodNode } from '../labelLod';
import type { ExpansionPayload } from '../trunkExpand';

// ── Public types ──

export interface EngineNode {
  key: string;
  label: string;
  path: string;
  linkCount: number;
  nodeType?: string | null;
  /** Dead link placeholder node（未解析的 wikilink） */
  dead?: boolean;
  /** trunk 模式：本节点是簇团（blob 渲染：半径 ∝ √size、簇色、标签常显） */
  trunkCluster?: { size: number };
}

export interface EngineEdge {
  source: string;
  target: string;
  /** trunk 展开 spoke（成员↔收起团）的真实边数：宽 ∝ log（trunkExpand.buildExpansion 产出） */
  trunkWeight?: number;
}

export interface EngineCallbacks {
  /** 单击节点（非拖拽）—— Molio 用于跳转文档 */
  onNodeClick?: (key: string, node: EngineNode) => void;
  onNodeDoubleClick?: (key: string, node: EngineNode) => void;
  onHoverChange?: (key: string | null) => void;
  /** trunk 模式：单击簇团（H1 过渡期行为由宿主决定：切全量+框邻域） */
  onTrunkClusterClick?: (clusterId: string) => void;
  /** trunk 展开：点「收起」chip（H2）——宿主调 collapseTrunkCluster */
  onTrunkCollapseClick?: (clusterId: string) => void;
}

export interface EngineOptions {
  theme: ThemeColors;
  forces: ForceParams;
  nodeScale: number;
  edgeWidth: number;
}

export interface GraphSnapshot {
  /** key 让 e2e 能按节点身份比对坐标（Minimap 只用 x/y） */
  nodes: Array<{ key: string; x: number; y: number }>;
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
  /** trunk 模式：簇团标记（blob 渲染） */
  trunkCluster?: { size: number };
  radius: number;
  /** 度数排名（0 = 最高），标签显隐预算用 */
  rank: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  /** trunk 模式：聚合边真实权重（宽度 ∝ log2）；全量边恒 undefined */
  trunkWeight?: number;
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
  color: string;
  alpha: number;
  active: boolean;
  /** 边宽倍率：全量恒 1（=this.edgeWidth）；trunk 聚合边 = 1+log2(weight) */
  widthMult: number;
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
/** collide 迭代：静止时 3（质量优先），位移场期降到 1（拖拽降质）。值自 contracts recipe（H3 单一来源）。 */
const COLLIDE_ITERATIONS = GRAPH_LAYOUT_RECIPE.collideIterations;
/** 标签 LOD（H2 统一规则 labelLod.ts）：屏幕直径阈值 + 同屏可见总数上限（防汤，代拍 B） */
const LABEL_MIN_SCREEN_DIAMETER = 8;
const LABEL_MAX_ONSCREEN = 60;
/** 标签与节点顶部的屏幕间距（px，不随缩放变化） */
const LABEL_GAP_SCREEN = 4;
/** 标签碰撞检测的四周留白（stage-local 单位） */
const LABEL_PAD = 2;
const K_MIN = 0.1;
const K_MAX = 4;
const FIT_PADDING = 80;
/** 出图：内容四周留白（屏幕 px，换算成 world 单位后使用） */
const EXPORT_MARGIN_SCREEN = 48;
/** 出图：目标输出长边（device px）；不卡死，实际受 1:1 下限与 4096 上限夹逼 */
const EXPORT_TARGET_LONG_EDGE = 2000;
/** v6 配方：forceX/Y 谐波约束强度 —— 让长弹簧向心屈服，整体紧凑、局部由 collide 撑开。值自 contracts recipe（H3 单一来源） */
const CONTAIN_STRENGTH = GRAPH_LAYOUT_RECIPE.containStrength;
// collide 半径公式（×5+4 封顶 100）与 COLLIDE_PAD 已移 graphUtils（单一来源，mini-sim/worker 共用）
/** manyBody 电荷分母下限：d<DISTANCE_MIN 时按 DISTANCE_MIN 计，封顶 1/d² 电荷爆（拖拽级联的节点瞬时重叠加速）。值自 contracts recipe（H3 单一来源） */
const DISTANCE_MIN = GRAPH_LAYOUT_RECIPE.distanceMin;
/** 位移场期 collide 迭代降到 1（拖拽降质：collide 是每 tick 最大 CPU 成本） */
const COLLIDE_ITERATIONS_MOTION = 1;
/** 拖拽期 link 强度倍率：调软防「被拖 hub 的 683 条弹簧把整图拽向内收缩」，松手恢复全强度 */
const DRAG_LINK_MULT = 0.4;
/** 拖拽期 alphaTarget：中温保证邻居流体跟随；过高 → 存太多势能松手爆炸，过低 → 僵硬不跟手 */
const DRAG_ALPHA_TARGET = 0.2;
/** 拖拽期 velocityDecay：拖拽与松手共用，吸收回弹能量；过高 → 蠕行缓慢，过低 → 弹跳剧烈 */
const DRAG_VELOCITY_DECAY = 0.6;
/** trunk 仿真固定配方（设计 §4.2 评审 #6：几十个对象的布局语义与全量图不同，
 *  用户调的 forces 只为全量图生效）：强排斥撑开 + 中距弹簧 + 同步 settle 到位 */
const TRUNK_FORCE = {
  centerStrength: 0.1,
  repelStrength: -800,
  linkStrength: 0.4,
  linkDistance: 140,
  /** 同步 settle 上限 tick 数（~30 对象实际远小于此，毫秒级） */
  settleTicks: 400,
} as const;
/** 聚合边权重查表的 pairKey 分隔符（与 daemon graph-communities 同款 NUL 转义写法——
 *  别用裸 \x00 字节：源码会被工具判成二进制，grep 静默零命中） */
const TRUNK_PAIR_SEP = '\u0000';
/** 无焦点时的空邻居集（labelLod 入参，免每帧分配） */
const NO_NEIGHBOURS: ReadonlySet<string> = new Set();
/** 簇团单击派发延迟（ms）：给双击留出取消窗——双击簇团 no-op（T2 deferred minor）。
 *  成员/hub 单击零延迟（打开文件铁律不等待）。 */
const TRUNK_CLUSTER_CLICK_DEFER_MS = 250;

export class PixiGraphEngine {
  private container: HTMLElement;
  private app!: Application;
  private canvas!: HTMLCanvasElement;
  private stage!: Container;
  private labelsLayer!: Container<Text>;
  /** 收起 chip 顶层（在成员/标签之上——chip 是展开态的主出口，被盖住等于没有） */
  private chipsLayer!: Container<ContainerChild>;
  private nodesLayer!: Container<ContainerChild>;
  private linkLayer!: Container<Graphics>;
  /** P0-2：全部边共用这一个 Graphics（替代 per-link Graphics，23k 边 23k→1 显示对象） */
  private edgesGfx!: Graphics;
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
  private resizeObserver: ResizeObserver | null = null;

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

  /** 下一次 setData 是否让同名节点继承当前坐标（一次性开关，读取后立刻复位）。
   *  刷新（库变了）要继承——否则「只加了一个文件、整个布局重炸」；换 vault 不能继承——
   *  两个库的图没有可比性，沿用旧坐标会让新库长成旧库的形状。 */
  private inheritPositions = true;
  /** H3 布局种子（daemon 预跑 positions）：仅全量模式消费，setData 注入、trunk 不吃。 */
  private pendingSeed: Map<string, { x: number; y: number }> | null = null;
  private hasUserInteracted = false;
  private hasFitFirstLayout = false;
  private refitTimer: ReturnType<typeof setTimeout> | null = null;
  /** 仿真收敛后要执行的取景（见 reframeAfterSettle）；用户中途交互则放弃 */
  private pendingReframe: (() => void) | null = null;
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

  // ── trunk 模式（T2）──
  /** 当前处于 trunk 场景（setTrunkData 置位 / setData 复位）：渲染分支 + 力参/标签/回调路由 */
  private trunkMode = false;

  // ── trunk 展开/收起（H2，设计 §4.1）──
  /** 当前 trunk 场景（collapse 重建聚合边 / chip 文案用；setTrunkData 存、setData 清） */
  private trunkSceneRef: TrunkScene | null = null;
  /** 展开时 blob 坐标缓存：收起回位（G：再展开复用由宿主缓存位置，blob 位由引擎记） */
  private trunkBlobPos = new Map<string, { x: number; y: number }>();
  /** 已展开簇：clusterId → 质心（chip 锚点 + appendTrunkMembers 的兜底锚） */
  private trunkExpanded = new Map<string, { centroid: { x: number; y: number } }>();
  /** 已展开簇的成员 key 集（收起移除用；重复注入幂等） */
  private trunkExpandedMembers = new Map<string, Set<string>>();
  /** 收起动画进行中的簇（applyCollapse 落地前阻止再次展开/追加） */
  private trunkCollapsing = new Set<string>();
  /** 收起动画完成定时器（destroy 清理） */
  private trunkCollapseTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 各簇展开载荷（收起后给其他已展开簇重挂 spoke 用——pair 去重保证幂等） */
  private trunkPayloads = new Map<string, ExpansionPayload>();
  /** 收起 chip 显示对象（挂 chipsLayer 顶层；pointertap → onTrunkCollapseClick）+ 团心 sim 坐标（resize 重定位） */
  private trunkChips = new Map<string, { root: Container; centroid: { x: number; y: number } }>();
  /** 簇团单击的延迟派发定时器（双击取消窗） */
  private trunkClickDefer: ReturnType<typeof setTimeout> | null = null;

  private renderListeners = new Set<() => void>();
  /** 上次同步标签 scale 的 k —— 标签恒定屏幕尺寸（scale=1/k），k 变化时才批量更新 */
  private lastLabelK = 0;

  // ── P0-1 帧循环脏标记（失效协议，T2 trunk 渲染沿用）──
  /** 几何动了（sim tick / 拖拽钉点 / 孤立重铺 / resize / nodeScale）→ 重写节点位置 + 重画边 */
  private geometryDirty = true;
  /** 只有变换动了（zoom/pan/fit/视口动画）→ 只同步标签 + minimap + 选中环，边几何不失效 */
  private transformDirty = true;
  /** 边样式动了（hover 边 alpha tween 逐帧变 / color 即时切）→ 只重画边 */
  private edgesDirty = false;
  /** 选中态变了（selectNode / 点空白清除）→ 只重画选中环 */
  private selectionDirty = true;
  /** hover tween 活动窗口的截止时刻（rAF 时钟）：期间帧必须照常上屏，过后可跳过 render */
  private tweenUntil = 0;
  /** getSnapshot 的节点数组缓冲（P0-3 搭车）：长度不变时原地改写，消 minimap 每帧大库对象分配 */
  private snapshotBuf: { key: string; x: number; y: number }[] = [];

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
    // 收起 chip 独立顶层（H2 验收反馈：与成员同层时，后续批次的成员会盖住团心的 chip）
    this.chipsLayer = new Container<ContainerChild>({ zIndex: 4, isRenderGroup: true });
    this.stage.addChild(this.linkLayer, this.nodesLayer, this.labelsLayer, this.chipsLayer);

    this.selectionGfx = new Graphics();
    this.nodesLayer.addChild(this.selectionGfx);

    // edgesGfx 必须在首帧前存在：rAF 循环（下方启动）早于首次 rebuildRendering，
    // 而 renderFrame 每帧都调 redrawEdges——否则首帧 TypeError 且抛点在 rAF 重新
    // 排队之前，整个渲染循环永久死亡（实测：相机/搜索 4 个 spec 超时的根因）。
    // selectionGfx 同款模式：init 建一份，rebuildRendering 清层后重建。
    this.edgesGfx = new Graphics({ interactive: false, eventMode: 'none' });
    this.linkLayer.addChild(this.edgesGfx);

    this.bindZoomAndDrag();
    this.bindNativeEvents();

    this.rafId = requestAnimationFrame(this.renderFrame);

    this.resizeObserver = new ResizeObserver(() => {
      this.width = this.container.clientWidth;
      this.height = this.container.clientHeight;
      this.app.renderer.resize(this.width, this.height);
      // resize 后必须立即补一帧：renderer.resize 只重设 canvas 尺寸、不重绘，而
      // ResizeObserver 回调在 rAF 之后、上屏之前执行——清空的 backing store 会
      // 直接合成上屏。引擎 background 不透明 → WebGL context alpha:false →
      // 清空帧 = 不透明纯黑。拖拽侧边栏（目录框/停靠对话面板，逐帧 resize）时
      // 表现为图谱持续闪黑屏；窗口 resize 同理。Pixi 官方 ResizePlugin 的
      // resize() 就是 resize 后紧跟 render() 的成对模式。
      this.geometryDirty = true; // cx/cy 变 → 所有 stage-local 坐标全变（#411 同步补帧保留）
      this.app.renderer.render(this.stage);
    });
    this.resizeObserver.observe(this.container);
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
      // A hidden pane has zero size — don't let it resize the renderer to 0.
      this.resizeObserver?.disconnect();
    } else {
      this.rafId = requestAnimationFrame(this.renderFrame);
      // Only resume motion if the sim was still settling; otherwise just
      // re-render the static layout (no re-motion jitter after a pause).
      if (this.sim && this.sim.alpha() > 0) this.sim.restart();
      this.resizeObserver?.observe(this.container);
    }
  }

  setData(nodes: EngineNode[], edges: EngineEdge[], seed?: Map<string, { x: number; y: number }>): void {
    if (this.destroyed) return;
    this.trunkMode = false;
    this.pendingSeed = seed ?? null;
    this.buildAndRender(
      nodes,
      edges.map((e) => ({ ...e })),
      null,
    );
  }

  /**
   * 进入/重建 trunk 场景（T2，设计 §4.2）：hub = 常规节点（真实度数 → 大半径），
   * 簇团 = blob 节点（trunkCluster 标记：半径 4+√size、簇色、标签常显），聚合边带
   * trunkWeight（宽 1+log2）。固定力参 TRUNK_FORCE + 同步 settle + 立即 fit——
   * 几十个对象毫秒级到位，不跑「先落位、收敛后再取景」的三段式。
   */
  setTrunkData(scene: TrunkScene, opts?: { preserveViewport?: boolean }): void {
    if (this.destroyed) return;
    this.trunkMode = true;
    this.pendingSeed = null;
    this.trunkSceneRef = scene;
    // 场景重建 = 展开态清零（刷新保态由宿主 matchExpansionsOnRefresh 后重注入；chip 随层销毁）
    this.trunkBlobPos.clear();
    this.trunkExpanded.clear();
    this.trunkExpandedMembers.clear();
    this.trunkPayloads.clear();
    this.trunkChips.clear();
    const nodes: EngineNode[] = [
      ...scene.hubs.map((h) => ({
        key: h.key,
        label: h.label,
        path: h.path,
        linkCount: h.linkCount,
        nodeType: h.nodeType,
      })),
      ...scene.clusters.map((c) => ({
        key: c.id,
        label: c.label,
        path: '',
        linkCount: 0,
        trunkCluster: { size: c.size },
      })),
    ];
    const edges: EngineEdge[] = scene.links.map((l) => ({ source: l.source, target: l.target }));
    this.buildAndRender(nodes, edges, scene, opts?.preserveViewport ?? false);
  }

  /**
   * 展开一簇（H2，设计 §4.1）：blob 移除 → batchKeys 成员增量注入（位置由外部给：worker
   * 布局质心对齐平移，或 mini-sim）；payload.edges 里两端此刻都在场的边一并注入（spoke 带
   * weight、宽 ∝ log）。**不重启 sim、不 re-settle**（alpha 保持 0——反目标「整图跳动」的
   * 防线；拖拽照常唤醒物理）。质心留「收起」chip。opts.animate 是 Task 6 过渡动画的钩子
   * （本任务即时落位）。
   */
  expandTrunkCluster(
    clusterId: string,
    payload: ExpansionPayload,
    positions: ReadonlyMap<string, { x: number; y: number }>,
    batchKeys: string[],
    opts?: { animate?: boolean },
  ): boolean {
    if (this.destroyed || !this.trunkMode) return false;
    if (this.trunkCollapsing.has(clusterId)) return false; // 收起动画进行中
    const blob = this.nodeById.get(clusterId);
    if (!blob || !blob.trunkCluster) return false; // 不存在或已展开
    const centroid = { x: blob.x ?? 0, y: blob.y ?? 0 };
    this.trunkBlobPos.set(clusterId, centroid);
    this.trunkPayloads.set(clusterId, payload);
    this.pruneEdgesBy((id) => id === clusterId); // 聚合边撤 + 其他簇指向本 blob 的 spoke（由本簇真实边取代）
    this.removeSimNode(clusterId);
    this.addExpansionMembers(clusterId, payload, positions, batchKeys, centroid);
    this.addExpansionEdges(payload);
    this.addTrunkChip(clusterId, centroid);
    // 过渡动画（设计 §4.1：300-400ms 成员从质心 stagger 外扩）；motionMode 降质 = 直接落位
    if (opts?.animate !== false && !this.motionMode) {
      this.animateExpansionFrom(clusterId, batchKeys, positions, centroid);
    }
    this.afterTrunkMutation();
    return true;
  }

  /** 后续批次流式注入（巨簇分批，代拍 F）：只加节点 + 新变完整的边；落位后 150ms 淡入。 */
  appendTrunkMembers(
    clusterId: string,
    payload: ExpansionPayload,
    positions: ReadonlyMap<string, { x: number; y: number }>,
    batchKeys: string[],
  ): boolean {
    if (this.destroyed || !this.trunkMode) return false;
    if (this.trunkCollapsing.has(clusterId)) return false;
    const state = this.trunkExpanded.get(clusterId);
    if (!state) return false; // 未展开（可能已被收起/场景重建）
    this.trunkPayloads.set(clusterId, payload);
    this.addExpansionMembers(clusterId, payload, positions, batchKeys, state.centroid);
    this.addExpansionEdges(payload);
    if (!this.motionMode) this.animateBatchFadeIn(clusterId, batchKeys);
    this.afterTrunkMutation();
    return true;
  }

  /**
   * 收起一簇：成员 250ms tween 回质心淡出、blob 于质心淡入（motionMode 直接落位）；
   * 动画完成后 applyCollapse 真正撤成员/重建聚合边。聚合边按 scene.links 重建（对端
   * 不在场的跳过——对方簇仍展开时其真实边/spoke 语义自洽），其他已展开簇的 spoke 借载荷
   * 重挂（pair 去重幂等）。
   */
  collapseTrunkCluster(clusterId: string): boolean {
    if (this.destroyed || !this.trunkMode) return false;
    if (this.trunkCollapsing.has(clusterId)) return false; // 收起动画进行中：重入会双份重建聚合边
    const members = this.trunkExpandedMembers.get(clusterId);
    const blobPos = this.trunkBlobPos.get(clusterId);
    if (!members || !blobPos || !this.trunkSceneRef?.clusters.some((c) => c.id === clusterId)) return false;
    if (this.motionMode) {
      this.applyCollapse(clusterId, members);
      return true;
    }
    // blob 立即回位（alpha 0 淡入），成员向质心收拢淡出
    const blobRd = this.restoreBlobNode(clusterId);
    if (blobRd) blobRd.gfx.alpha = 0;
    this.trunkCollapsing.add(clusterId);
    const tweenKey = `collapse:${clusterId}`;
    this.tweens.get(tweenKey)?.stop();
    const group = new Group();
    const chip = this.trunkChips.get(clusterId);
    for (const key of members) {
      const node = this.nodeById.get(key);
      const rd = this.nodeRenderData.find((r) => r.simulationData.id === key);
      if (!node || !rd || node.x == null || node.y == null) continue;
      const from = { x: node.x, y: node.y };
      const holder = { t: 0 };
      group.add(
        new Tween(holder)
          .to({ t: 1 }, 250)
          .onUpdate(() => {
            const e = easeCubicOut(holder.t);
            node.x = from.x + (blobPos.x - from.x) * e;
            node.y = from.y + (blobPos.y - from.y) * e;
            rd.gfx.alpha = 1 - holder.t;
            this.geometryDirty = true;
          }),
      );
    }
    if (blobRd) {
      const holder = { t: 0 };
      group.add(
        new Tween(holder)
          .to({ t: 1 }, 250)
          .onUpdate(() => {
            blobRd.gfx.alpha = holder.t;
          }),
      );
    }
    if (chip) {
      const holder = { t: 0 };
      group.add(
        new Tween(holder)
          .to({ t: 1 }, 150)
          .onUpdate(() => {
            chip.root.alpha = 1 - holder.t;
          }),
      );
    }
    group.getAll().forEach((tw) => tw.start());
    this.tweens.set(tweenKey, makeTweenNode(group));
    this.tweenUntil = Math.max(this.tweenUntil, performance.now() + 350);
    const timer = setTimeout(() => {
      this.trunkCollapseTimers.delete(timer);
      this.applyCollapse(clusterId, members);
    }, 280);
    this.trunkCollapseTimers.add(timer);
    return true;
  }

  /** e2e/调试：当前展开簇 id 列表。 */
  getTrunkExpandedClusters(): string[] {
    return [...this.trunkExpanded.keys()];
  }

  /** e2e 点 chip 用：收起 chip 的 canvas 内 CSS px 坐标（测试自行加 getBoundingClientRect）。 */
  getTrunkCollapseChipPos(clusterId: string): { sx: number; sy: number } | null {
    const chip = this.trunkChips.get(clusterId);
    if (!chip) return null;
    const t = this.currentTransform;
    return { sx: chip.root.x * t.k + t.x, sy: chip.root.y * t.k + t.y };
  }

  // ── trunk 展开的私有机器 ──

  private addExpansionMembers(
    clusterId: string,
    payload: ExpansionPayload,
    positions: ReadonlyMap<string, { x: number; y: number }>,
    batchKeys: string[],
    centroid: { x: number; y: number },
  ): void {
    const memberSet = this.trunkExpandedMembers.get(clusterId) ?? new Set<string>();
    this.trunkExpandedMembers.set(clusterId, memberSet);
    this.trunkExpanded.set(clusterId, { centroid });
    const byKey = new Map(payload.memberNodes.map((m) => [m.key, m] as const));
    batchKeys.forEach((key, i) => {
      if (this.nodeById.has(key) || memberSet.has(key)) return; // 幂等
      const m = byKey.get(key);
      if (!m) return;
      const p = positions.get(key);
      // 缺位兜底：质心外黄金角散布（确定性），别让成员叠在质心上
      const ring = 24 * Math.sqrt(i + 1);
      const ang = Math.PI * (3 - Math.sqrt(5)) * i;
      const node: SimNode = {
        id: key,
        text: m.label,
        path: m.path,
        linkCount: m.linkCount,
        nodeType: m.nodeType ?? null,
        dead: false,
        radius: this.radiusOf({ linkCount: m.linkCount }),
        rank: 0,
        x: p ? p.x : centroid.x + ring * Math.cos(ang),
        y: p ? p.y : centroid.y + ring * Math.sin(ang),
      };
      this.nodes.push(node);
      this.nodeById.set(key, node);
      memberSet.add(key);
      this.nodeRenderData.push(this.makeNodeRenderData(node));
    });
  }

  /** 注入 payload 里「两端此刻都在场」的边（真实边优先于 spoke——去重按 pair，先到先得）。 */
  private addExpansionEdges(payload: ExpansionPayload): void {
    const existing = new Set<string>();
    for (const l of this.links) {
      const s = (l.source as SimNode).id;
      const t = (l.target as SimNode).id;
      existing.add(s < t ? `${s}${TRUNK_PAIR_SEP}${t}` : `${t}${TRUNK_PAIR_SEP}${s}`);
    }
    for (const e of payload.edges) {
      const s = this.nodeById.get(e.source);
      const t = this.nodeById.get(e.target);
      if (!s || !t) continue; // 对端不在场（后续批次补 / 收起簇以外的对象）
      const pair = e.source < e.target ? `${e.source}${TRUNK_PAIR_SEP}${e.target}` : `${e.target}${TRUNK_PAIR_SEP}${e.source}`;
      if (existing.has(pair)) continue;
      existing.add(pair);
      const link: SimLink = { source: s, target: t, trunkWeight: e.weight };
      this.links.push(link);
      this.linkRenderData.push(this.makeLinkRenderData(link));
    }
  }

  /** 按 predicate 撤边（this.links 与 linkRenderData 同步过滤；边绘制走 edgesGfx 整体重画）。 */
  private pruneEdgesBy(shouldPrune: (nodeId: string) => boolean): void {
    const keepLinks: SimLink[] = [];
    const keepRd: LinkRenderData[] = [];
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i]!;
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      if (shouldPrune(s.id) || shouldPrune(t.id)) continue;
      keepLinks.push(l);
      keepRd.push(this.linkRenderData[i]!);
    }
    this.links = keepLinks;
    this.linkRenderData = keepRd;
  }

  private removeSimNode(key: string): void {
    const idx = this.nodeRenderData.findIndex((rd) => rd.simulationData.id === key);
    if (idx >= 0) {
      const rd = this.nodeRenderData[idx]!;
      rd.gfx.destroy();
      rd.label.destroy();
      this.nodeRenderData.splice(idx, 1);
    }
    this.nodes = this.nodes.filter((n) => n.id !== key);
    this.nodeById.delete(key);
  }

  private addTrunkChip(clusterId: string, centroid: { x: number; y: number }): void {
    const cluster = this.trunkSceneRef?.clusters.find((c) => c.id === clusterId);
    const root = new Container({ interactive: true, eventMode: 'static' });
    root.hitArea = new Circle(0, 0, 18);
    root.cursor = 'pointer';
    const circle = new Graphics()
      .circle(0, 0, 13)
      .fill({ color: this.theme.bg, alpha: 0.95 })
      .stroke({ width: 2, color: trunkClusterColor(clusterId) });
    const label = new Text({
      interactive: false,
      eventMode: 'none',
      text: `✕ ${cluster?.label ?? clusterId}`,
      anchor: { x: 0.5, y: 0.5 },
      style: { fontSize: 12, fill: this.theme.label, fontFamily: LABEL_FONT },
      resolution: window.devicePixelRatio * 4,
    });
    root.addChild(circle, label);
    root.position.set(centroid.x + this.width / 2, centroid.y + this.height / 2);
    root.on('pointertap', () => {
      if (!this.dragging) this.callbacks.onTrunkCollapseClick?.(clusterId);
    });
    this.chipsLayer.addChild(root);
    this.trunkChips.set(clusterId, { root, centroid: { x: centroid.x, y: centroid.y } });
  }

  private removeTrunkChip(clusterId: string): void {
    const chip = this.trunkChips.get(clusterId);
    if (!chip) return;
    this.trunkChips.delete(clusterId);
    chip.root.destroy({ children: true });
  }

  /** 展开过渡（设计 §4.1）：成员从质心 350ms easeCubicOut 外扩 + 淡入，stagger 3ms/人封顶 150ms。 */
  private animateExpansionFrom(
    clusterId: string,
    batchKeys: string[],
    finalPos: ReadonlyMap<string, { x: number; y: number }>,
    centroid: { x: number; y: number },
  ): void {
    const tweenKey = `expand:${clusterId}`;
    this.tweens.get(tweenKey)?.stop();
    const byId = new Map(this.nodeRenderData.map((rd) => [rd.simulationData.id, rd] as const));
    const group = new Group();
    let maxEnd = 0;
    batchKeys.forEach((key, i) => {
      const node = this.nodeById.get(key);
      const rd = byId.get(key);
      const to = finalPos.get(key);
      if (!node || !rd || !to) return;
      const delay = Math.min(i * 3, 150);
      node.x = centroid.x; // 起点钉质心，tween 拉向落位
      node.y = centroid.y;
      rd.gfx.alpha = 0;
      const holder = { t: 0 };
      group.add(
        new Tween(holder)
          .to({ t: 1 }, 350)
          .delay(delay)
          .onUpdate(() => {
            const e = easeCubicOut(holder.t);
            node.x = centroid.x + (to.x - centroid.x) * e;
            node.y = centroid.y + (to.y - centroid.y) * e;
            rd.gfx.alpha = holder.t;
            this.geometryDirty = true;
          }),
      );
      maxEnd = Math.max(maxEnd, delay + 350);
    });
    group.getAll().forEach((tw) => tw.start());
    this.tweens.set(tweenKey, makeTweenNode(group));
    this.tweenUntil = Math.max(this.tweenUntil, performance.now() + maxEnd + 100);
  }

  /** 后续批次淡入（150ms，位置已在落位——只动 alpha，不占几何重画）。 */
  private animateBatchFadeIn(clusterId: string, batchKeys: string[]): void {
    const byId = new Map(this.nodeRenderData.map((rd) => [rd.simulationData.id, rd] as const));
    const group = new Group();
    for (const key of batchKeys) {
      const rd = byId.get(key);
      if (!rd) continue;
      rd.gfx.alpha = 0;
      const holder = { t: 0 };
      group.add(
        new Tween(holder)
          .to({ t: 1 }, 150)
          .onUpdate(() => {
            rd.gfx.alpha = holder.t;
          }),
      );
    }
    if (group.getAll().length === 0) return;
    group.getAll().forEach((tw) => tw.start());
    this.tweens.set(`expand:${clusterId}`, makeTweenNode(group)); // 覆写已完结的首批组
    this.tweenUntil = Math.max(this.tweenUntil, performance.now() + 250);
  }

  /** 收起的实际落地（动画完结后）：撤成员/重建聚合边/重挂他簇 spoke。 */
  private applyCollapse(clusterId: string, members: Set<string>): void {
    this.trunkCollapsing.delete(clusterId);
    for (const key of members) this.removeSimNode(key);
    this.pruneEdgesBy((id) => members.has(id));
    this.trunkExpandedMembers.delete(clusterId);
    this.trunkBlobPos.delete(clusterId);
    this.trunkExpanded.delete(clusterId);
    this.removeTrunkChip(clusterId);
    this.restoreBlobNode(clusterId); // 幂等：动画路径已提前恢复则跳过
    // 本簇聚合边重建（hub/其他 blob 在场的）；按 pair 去重——重入/他簇 spoke 重挂路径
    // 可能与 scene.links 撞对（终审 minor：双击 chip 曾双份重建）
    const seenPairs = new Set(this.links.map((l) => {
      const s = (l.source as SimNode).id;
      const t = (l.target as SimNode).id;
      return s < t ? `${s}${TRUNK_PAIR_SEP}${t}` : `${t}${TRUNK_PAIR_SEP}${s}`;
    }));
    for (const l of this.trunkSceneRef?.links ?? []) {
      if (l.source !== clusterId && l.target !== clusterId) continue;
      const other = l.source === clusterId ? l.target : l.source;
      if (!this.nodeById.has(other) || other === clusterId) continue;
      const pair = clusterId < other ? `${clusterId}${TRUNK_PAIR_SEP}${other}` : `${other}${TRUNK_PAIR_SEP}${clusterId}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      const link: SimLink = {
        source: this.nodeById.get(clusterId)!,
        target: this.nodeById.get(other)!,
        trunkWeight: l.weight,
      };
      this.links.push(link);
      this.linkRenderData.push(this.makeLinkRenderData(link));
    }
    // 其他已展开簇的 spoke 现在能落回本 blob（幂等去重，真实边优先）
    for (const [otherId, otherPayload] of this.trunkPayloads) {
      if (otherId === clusterId) continue;
      this.addExpansionEdges(otherPayload);
    }
    this.afterTrunkMutation();
  }

  /** blob 回 trunkBlobPos 缓存位（不跳位）。已存在（动画路径提前恢复）→ null。 */
  private restoreBlobNode(clusterId: string): NodeRenderData | null {
    if (this.nodeById.has(clusterId)) return null;
    const blobPos = this.trunkBlobPos.get(clusterId);
    const cluster = this.trunkSceneRef?.clusters.find((c) => c.id === clusterId);
    if (!blobPos || !cluster) return null;
    const blob: SimNode = {
      id: clusterId,
      text: cluster.label,
      path: '',
      linkCount: 0,
      trunkCluster: { size: cluster.size },
      radius: this.radiusOf({ linkCount: 0, trunkCluster: { size: cluster.size } }),
      rank: 0,
      x: blobPos.x,
      y: blobPos.y,
    };
    this.nodes.push(blob);
    this.nodeById.set(clusterId, blob);
    const rd = this.makeNodeRenderData(blob);
    this.nodeRenderData.push(rd);
    return rd;
  }

  /** 展开/收起/批次注入的公共收尾：选择残留守卫 + 邻域/度数重算 + 脏标记 + 全量重绘。 */
  private afterTrunkMutation(): void {
    if (this.selectedId !== null && !this.nodeById.has(this.selectedId)) {
      this.selectedId = null;
      this.selectionDirty = true;
    }
    if (this.hoveredNodeId !== null && !this.nodeById.has(this.hoveredNodeId)) this.hoveredNodeId = null;
    this.recomputeAdjacencyAndRank();
    this.lastLabelK = 0; // 新标签 scale=1：强制按当前 k 重同步全量标签
    this.geometryDirty = true;
    this.updateFocusAndRender();
  }

  /** 退回全量（setData 会隐式调用；显式调用用于宿主在 setData 前清理） */
  clearTrunk(): void {
    this.trunkMode = false;
  }

  getTrunkMode(): boolean {
    return this.trunkMode;
  }

  /** 高亮某簇（搜索命中簇名）：语义=选中该 trunk 对象（选中环+邻域高亮+其余压暗）。null 清除。 */
  highlightTrunkCluster(id: string | null): boolean {
    if (id === null) {
      this.selectedId = null;
      this.selectionDirty = true;
      this.updateFocusAndRender();
      return true;
    }
    return this.selectNode(id);
  }

  /** setData/setTrunkData 共用主体：SimNode/SimLink 构建 + rebuild + 首 fit（trunk 另做同步 settle）。 */
  private buildAndRender(nodes: EngineNode[], edges: EngineEdge[], trunk: TrunkScene | null, preserveViewport = false): void {
    // 上一批节点（此刻 this.nodeById 还是旧的）——用来给同名节点播种坐标。
    // 读的是「用户眼前这份布局」而非某个初始快照：布局被拖过、平移过，都该被继承。
    const prevNodes = this.inheritPositions ? this.nodeById : null;
    this.inheritPositions = true;

    const nodeById = new Map<string, SimNode>();
    const simNodes: SimNode[] = [];
    // H3 布局种子只在全量模式生效（trunk 是固定配方的另一套世界）
    const seed = trunk === null ? this.pendingSeed : null;
    for (const n of nodes) {
      const prev = prevNodes?.get(n.key);
      const seeded = seed?.get(n.key);
      simNodes.push({
        id: n.key,
        text: n.label,
        path: n.path,
        linkCount: n.linkCount,
        nodeType: n.nodeType ?? null,
        dead: n.dead,
        trunkCluster: n.trunkCluster,
        radius: this.radiusOf(n),
        rank: 0,
        // 老节点从原位继续仿真（刷新只微调，不重炸）；新节点优先吃布局种子
        // （daemon 预跑的近终态坐标——「出生定形」），无种子才交给 d3 默认散布。
        x: prev?.x ?? seeded?.x,
        y: prev?.y ?? seeded?.y,
        vx: prev?.vx ?? (seeded ? 0 : undefined),
        vy: prev?.vy ?? (seeded ? 0 : undefined),
      });
    }
    for (const n of simNodes) nodeById.set(n.id, n);
    this.nodes = simNodes;
    this.nodeById = nodeById;

    // 数据集更换后，指向已不存在 key 的选择/悬停必须清除——否则 focusId 永不命中，
    // updateFocus 会把全图压进焦点淡出档（trunk 选中簇 c1 → 切全量后全图压暗的串味，
    // 终审 Important-2；同一防线也覆盖「筛选滤掉已选节点」的既有残留路径）
    if (this.selectedId !== null && !nodeById.has(this.selectedId)) this.selectedId = null;
    if (this.hoveredNodeId !== null && !nodeById.has(this.hoveredNodeId)) this.hoveredNodeId = null;

    const weightByPair = new Map<string, number>();
    if (trunk) {
      for (const l of trunk.links) {
        weightByPair.set(l.source < l.target ? `${l.source}${TRUNK_PAIR_SEP}${l.target}` : `${l.target}${TRUNK_PAIR_SEP}${l.source}`, l.weight);
      }
    }
    const simLinks: SimLink[] = dedupeEdges(edges, (k) => nodeById.has(k)).map((e) => ({
      source: nodeById.get(e.source)!,
      target: nodeById.get(e.target)!,
      trunkWeight: trunk
        ? weightByPair.get(e.source < e.target ? `${e.source}${TRUNK_PAIR_SEP}${e.target}` : `${e.target}${TRUNK_PAIR_SEP}${e.source}`) ?? 1
        : undefined,
    }));
    this.links = simLinks;

    this.recomputeAdjacencyAndRank();

    this.rebuildRendering();

    if (trunk) {
      // trunk：几十对象同步 settle（毫秒级）+ 立即 fit——设计 §4.2「秒级收敛 + 单次取景」，
      // 不走全量的「首 fit + 1.5s refit」三段式（reframeAfterSettle 也不在此路径）。
      // preserveViewport（H2 刷新保态）：继承坐标微调后不 refit——视口永不因后台刷新重置
      const sim = this.sim;
      if (sim) {
        let ticks = 0;
        while (sim.alpha() > sim.alphaMin() && ticks++ < TRUNK_FORCE.settleTicks) sim.tick();
        sim.alpha(0);
        sim.stop();
      }
      if (!preserveViewport) this.fitView({ animate: false });
      this.hasFitFirstLayout = true;
      if (this.refitTimer) clearTimeout(this.refitTimer);
      return;
    }

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
    this.selectionDirty = true; // #415 deferred minor 归位：清选中也要重画选中环（否则残影留到下一脏帧）
    // 只在紧随其后的那次 setData 生效（setData 读取后立刻复位）。
    // 防御性：当前切库会连图谱页一起卸载（引擎本该新建、无缓存），这行是「resetPositions
    // 的语义 = 上下文已换、别继承」的自洽保证——将来若图谱页改成跨库常驻，它就是唯一防线。
    this.inheritPositions = false;
    this.updateFocusAndRender();
  }

  /**
   * 注册「仿真收敛后再取景」：数据上下文已换（如局部图 ⇄ 全量图），旧视口无意义，
   * 故先清掉交互标记；布局稳定后执行 reframe（通常是一次动画取景，此时范围才正确）。
   * 期间用户若自己平移/缩放，收敛时放弃这次自动取景（让位给用户）。
   * 注意：布局收敛前节点坐标仍在变，早取景会落在错误位置——所以必须等收敛。
   */
  reframeAfterSettle(reframe: () => void): void {
    this.hasUserInteracted = false;
    this.pendingReframe = reframe;
    if (this.refitTimer) {
      clearTimeout(this.refitTimer);
      this.refitTimer = null;
    }
  }

  /**
   * 同步跑完仿真并停表（小图 / 对照副格用）：布局一次到位，取景即可正确，省掉
   * 「先落位 → 收敛后再取景」的两段式过渡——副格随主格文档高频重锚定时后者很拖沓。
   * 顺带标记首屏已 fit 并清掉自动 refit 定时器，避免后续多余动画。
   */
  preSettle(maxTicks = 1000): void {
    const sim = this.sim;
    if (!sim) return;
    const min = sim.alphaMin();
    let ticks = 0;
    while (sim.alpha() > min && ticks++ < maxTicks) sim.tick();
    sim.alpha(0);
    sim.stop();
    this.hasFitFirstLayout = true;
    if (this.refitTimer) {
      clearTimeout(this.refitTimer);
      this.refitTimer = null;
    }
  }

  setForces(f: ForceParams): void {
    this.forces = { ...f };
    // trunk 仿真用固定配方（设计 §4.2 评审 #6）：用户力参先存着，退回全量后的
    // rebuild（setData → rebuildRendering 读 this.forces）自然生效
    if (this.trunkMode) return;
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
      // P0-1 失效协议：redrawAllNodes 只重写节点 Graphics 上下文与 l.color，不触发
      // 渲染——空闲帧会停在旧配色，必须自己标脏（选中环边框色也换了）
      this.edgesDirty = true; // 边色随边重画生效
      this.selectionDirty = true;
      this.transformDirty = true; // 强制下一帧 render
    }
    if (style.nodeScale !== undefined) this.nodeScale = style.nodeScale;
    if (style.edgeWidth !== undefined) {
      this.edgeWidth = style.edgeWidth;
      this.edgesDirty = true; // 边宽只在 redrawEdges 重画时生效
    }

    if (style.nodeScale !== undefined) {
      for (const n of this.nodeById.values()) {
        n.radius = this.radiusOf({ linkCount: n.linkCount, dead: n.dead, trunkCluster: n.trunkCluster });
      }
      this.sim?.force<ForceCollide<SimNode>>('collide')?.radius(collideRadius);
      this.geometryDirty = true; // 标签 y 偏移依赖 radius，几何要重写
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

  /** 选中节点：置选中态 + 高亮关联（不动相机）。与 fitView 搭配用于「框全子图 + 高亮圆心」。 */
  selectNode(key: string): boolean {
    if (this.destroyed) return false;
    if (!this.nodeById.has(key)) return false;
    this.selectedId = key;
    this.selectionDirty = true;
    this.updateFocusAndRender();
    return true;
  }

  /** 定位并选中节点（搜索用）：平滑居中缩放 */
  focusNode(key: string, opts?: { targetK?: number; durationMs?: number }): boolean {
    if (this.destroyed) return false;
    const node = this.nodeById.get(key);
    if (!node || node.x == null || node.y == null) return false;
    this.selectNode(key);
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

  /** e2e/探针观测口：当前可见标签数（统一 LOD 规则的防汤断言用） */
  getVisibleLabelCount(): number {
    let count = 0;
    for (const rd of this.nodeRenderData) {
      if (rd.label.visible) count++;
    }
    return count;
  }

  /** e2e 观测口：当前边总数（跨簇 spoke/真实边在场性的回归断言用，终审 #3） */
  getLinkCount(): number {
    return this.links.length;
  }

  /** Minimap / e2e 快照：节点位置 + 视口（simulation 坐标） */
  getSnapshot(): GraphSnapshot | null {
    if (this.nodes.length === 0) return null;
    const t = this.currentTransform;
    // P0-3：数组原地复用——长度一致就按索引改写既有元素（消费方 Minimap 同步读、不持引用，
    // 原地改写安全）；换图（setData）必然长度变化走重建。大库省掉每次 6500+ 对象分配。
    if (this.snapshotBuf.length !== this.nodes.length) {
      this.snapshotBuf = this.nodes.map((n) => ({ key: n.id, x: n.x ?? 0, y: n.y ?? 0 }));
    } else {
      for (let i = 0; i < this.nodes.length; i++) {
        const b = this.snapshotBuf[i]!;
        const n = this.nodes[i]!;
        b.key = n.id;
        b.x = n.x ?? 0;
        b.y = n.y ?? 0;
      }
    }
    return {
      nodes: this.snapshotBuf,
      view: {
        x: (0 - t.x) / t.k - this.width / 2,
        y: (0 - t.y) / t.k - this.height / 2,
        w: this.width / t.k,
        h: this.height / t.k,
      },
    };
  }

  /**
   * 把当前图谱渲染成一张位图（整图、已按主题铺底），交给调用方去排版。
   * 无可导出内容时返回 null。
   *
   * 引擎只产出「图」；标题卡、图例、署名由 exportCard.ts 合成 —— 那些是版式，
   * 不该跟 Pixi 生命周期纠缠，也才能在 node:test 里覆盖。
   *
   * 三个决定实现形状的事实：
   *  1. **导出的是整张图，不是用户当前取景框** —— 分享出去是给人看懂的，框外的
   *     东西对方补不回来。所以先 fitView 把整图收进视口，再据此取景。
   *  2. **`extract` 的 frame 是 world 空间的**（见 exportImage.ts 头注）：取景矩形
   *     按 world 单位算并夹在可见区域内，倍率按 frame 长边定，与当前缩放 k 无关。
   *  3. **不往 stage 里加任何东西** —— 不碰实时场景，就不会闪、无需清理；
   *     导出结束（含失败）视口一律还原成用户眼前那一帧。
   *
   * 背景必须显式传 clearColor：`extract` 的默认清屏色是**全透明**（不是 app 的
   * background）。透明底在多数看图器与发布平台上会被合成到白底上——深色主题的
   * 浅色标签会直接消失。
   */
  captureImage(): HTMLCanvasElement | null {
    if (this.destroyed || this.nodes.length === 0) return null;
    // 隐藏的 pane 尺寸为 0，取景会退化成空矩形
    if (!(this.width > 0) || !(this.height > 0)) return null;

    const prev = this.getViewport();
    let frame: Bounds | null = null;
    let resolution = 1;
    try {
      this.fitView({ animate: false });
      const viewport = viewportWorldRect(this.getViewport(), { w: this.width, h: this.height });
      const bounds = this.stage.getLocalBounds();
      frame = computeExportRect(
        { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
        viewport,
        EXPORT_MARGIN_SCREEN / this.currentTransform.k,
      );
      if (frame) {
        resolution = resolveExportScale(Math.max(frame.w, frame.h), { target: EXPORT_TARGET_LONG_EDGE });
      }
    } finally {
      this.setTransform(prev.tx, prev.ty, prev.k);
    }
    if (!frame) return null;

    // WebGL 画布默认 preserveDrawingBuffer:false，canvas.toDataURL 只会得到空白；
    // 必须走 Pixi 的 render-to-texture（extract）重渲染一遍。
    return this.app.renderer.extract.canvas({
      target: this.stage,
      frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
      resolution,
      antialias: true,
      clearColor: this.theme.bg,
    }) as unknown as HTMLCanvasElement;
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
    if (this.trunkClickDefer) clearTimeout(this.trunkClickDefer);
    for (const timer of this.trunkCollapseTimers) clearTimeout(timer);
    this.trunkCollapseTimers.clear();
    this.pendingReframe = null;
    this.viewportAnim = null;
    this.tweens.forEach((t) => t.stop());
    this.tweens.clear();
    this.renderListeners.clear();
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.rafId);
    this.sim?.stop();
    if (this.app) {
      // 步骤断开 + 各自吞错：销毁是终态操作，任何一步失败都只记日志——异常逃逸出 React
      // effect cleanup 会卸载整棵树（v0.3.56 线上全局白屏）。
      // 注意不要在用户侧销毁 Text 的托管纹理（{texture:true} 等）：v8 文本纹理由
      // CanvasTextPipe 引用计数管理，用户侧触碰会扰乱计数，令 app.destroy 内部的
      // GC 清扫在纹理池上抛 returnTexture TypeError（日志可见，纯上游缺陷）。
      // 这里只把标签从舞台摘除（Container 级），纹理交给管道自己的销毁清扫。
      try {
        this.labelsLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
        this.chipsLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
        this.nodeRenderData = [];
      } catch (err) {
        console.warn('[graph] engine destroy: label cleanup failed', err);
      }
      try {
        this.app.destroy(true, { children: true });
      } catch (err) {
        console.warn('[graph] engine destroy: app destroy failed', err);
      }
    }
  }

  // ── Internals: 布局 / 渲染 ──

  /** 邻域表 + 度数排名重算（buildAndRender 与展开/收起增量变更共用）。 */
  private recomputeAdjacencyAndRank(): void {
    const adjacency = new Map<string, Set<string>>();
    for (const n of this.nodes) adjacency.set(n.id, new Set());
    for (const l of this.links) {
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      adjacency.get(s.id)!.add(t.id);
      adjacency.get(t.id)!.add(s.id);
    }
    this.adjacency = adjacency;
    const byDegree = [...this.nodes].sort(
      (a, b) => (adjacency.get(b.id)?.size ?? 0) - (adjacency.get(a.id)?.size ?? 0),
    );
    byDegree.forEach((n, i) => {
      n.rank = i;
    });
  }

  /** 节点渲染对象工厂（rebuildRendering 与展开增量注入共用）：gfx + 指针事件 + 高分辨率标签。 */
  private makeNodeRenderData(n: SimNode): NodeRenderData {
    // trunk 簇团：簇色（id 哈希进调色板）+ theme 感知描边；死链节点用中性色区分
    const isCluster = !!n.trunkCluster;
    const color = isCluster
      ? trunkClusterColor(n.id)
      : n.dead
        ? this.theme.deadNode
        : nodeColorFor(n.nodeType, n.linkCount, this.theme);
    const gfx = new Graphics({
      interactive: true,
      eventMode: 'static',
      hitArea: new Circle(0, 0, n.radius + 6),
      // 簇团 = 可展开（zoom-in 光标提示），成员/hub = 可打开（pointer）——H2 验收 A1：
      // 区分度不够时容易误点成员跳走文档
      cursor: isCluster ? 'zoom-in' : 'pointer',
    })
      .circle(0, 0, n.radius)
      .fill({ color });
    if (isCluster) gfx.stroke({ width: 2.5, color: this.theme.edge });
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
      resolution: window.devicePixelRatio * 4,
    });
    this.labelsLayer.addChild(label);

    return {
      simulationData: n,
      gfx,
      label,
      labelW: label.width,
      labelH: label.height,
      alpha: 1,
      active: false,
    };
  }

  /** 边渲染数据工厂：trunk 聚合边/spoke 宽 ∝ log2(weight)，全量边恒 1×edgeWidth。 */
  private makeLinkRenderData(l: SimLink): LinkRenderData {
    return {
      simulationData: l,
      color: this.theme.edge,
      alpha: 1,
      active: false,
      widthMult: l.trunkWeight !== undefined ? trunkEdgeWidth(l.trunkWeight) : 1,
    };
  }

  /** Obsidian 视觉权重：半径 2 倍于 Quartz 式配方，fit 缩放(~0.3)下叶子≈4px、hub≈20px；
   *  trunk 簇团走 blob 公式（4+√size，设计 §4.2 半径 ∝ √成员数） */
  private radiusOf(n: { linkCount: number; dead?: boolean; trunkCluster?: { size: number } }): number {
    if (n.trunkCluster) return trunkBlobRadius(n.trunkCluster.size) * this.nodeScale;
    if (n.dead) return 3 * this.nodeScale;
    return (2 + Math.sqrt(n.linkCount)) * 2 * this.nodeScale;
  }


  private rebuildRendering(): void {
    this.sim?.stop();
    this.lastLabelK = 0; // 新标签 scale=1，需重新同步 1/k
    this.geometryDirty = true; // 重建即全量重画：显示对象全换新，消费过的脏标记不可信
    this.nodeRenderData = [];
    this.linkRenderData = [];
    this.tweens.forEach((t) => t.stop());
    this.tweens.clear();

    this.nodesLayer.removeChildren().forEach((c) => c.destroy());
    this.labelsLayer.removeChildren().forEach((c) => c.destroy());
    this.linkLayer.removeChildren().forEach((c) => c.destroy());
    this.chipsLayer.removeChildren().forEach((c) => c.destroy());
    this.selectionGfx = new Graphics();
    this.nodesLayer.addChild(this.selectionGfx);

    // trunk 用固定配方（TRUNK_FORCE），全量沿用用户 this.forces——两套语义互不污染
    const f = this.trunkMode ? TRUNK_FORCE : this.forces;
    const sim = forceSimulation<SimNode>(this.nodes)
      .force('charge', forceManyBody<SimNode>().strength(f.repelStrength).distanceMin(DISTANCE_MIN))
      .force('center', forceCenter<SimNode>(0, 0).strength(f.centerStrength))
      .force(
        'link',
        forceLink<SimNode, SimLink>(this.links)
          .id((d) => d.id)
          .distance(f.linkDistance)
          .strength(f.linkStrength > 0 ? f.linkStrength : defaultLinkStrength(this.adjacency)),
      )
      .force('x', forceX<SimNode>(0).strength(CONTAIN_STRENGTH))
      .force('y', forceY<SimNode>(0).strength(CONTAIN_STRENGTH))
      .force('collide', forceCollide<SimNode>().radius(collideRadius).iterations(COLLIDE_ITERATIONS));
    // H3 播种精修档：种子覆盖率 × 配方完好性决定起跑温度（seedPolicy 三档）。
    // 全量种子+默认配方+nodeScale=1 → α=0.1 低温（出生定形）；部分 → 0.3；
    // 改过力参/nodeScale≠1/无种子 → 现状 α=1。trunk 用 TRUNK_FORCE 固定配方，不吃种子。
    if (!this.trunkMode) {
      let seedCount = 0;
      if (this.pendingSeed) for (const n of this.nodes) if (this.pendingSeed.has(n.id)) seedCount++;
      const policy = planSeedRefine({
        seedCount,
        nodeCount: this.nodes.length,
        forces: this.forces,
        nodeScale: this.nodeScale,
      });
      sim.alpha(policy.alpha).alphaDecay(policy.alphaDecay);
    }
    // 仿真收敛后布局范围才稳定 —— 若用户未交互过，重新 fit 一次，
    // 避免「早期小范围 fit 的缩放」看「后期大范围布局」导致放大叠团的错觉。
    // 若宿主注册了 pendingReframe（scope 切换：局部图 ⇄ 全量图），优先执行它
    // （file-scope 要的是「圆心居中放大」而非 fit，目标不同）。
    sim.on('end', () => {
      if (this.destroyed) return;
      const pending = this.pendingReframe;
      this.pendingReframe = null;
      if (pending) {
        if (!this.hasUserInteracted) pending();
        return;
      }
      if (!this.hasUserInteracted) this.fitView({ animate: true });
    });
    this.sim = sim;
    // P0-1：任何 sim tick 都意味着几何在动（内部计时器与 preSettle 手动 tick 都会触发）
    sim.on('tick', () => {
      this.geometryDirty = true;
    });

    for (const n of this.nodes) {
      this.nodeRenderData.push(this.makeNodeRenderData(n));
    }

    // P0-2：边几何状态留在 linkRenderData，绘制统一收进单个 edgesGfx（redrawEdges）。
    // 旧版每边一个 Graphics：23k 边 = 23k 显示对象每帧各自 clear+重画，实测占帧预算 ~86%。
    // trunk 聚合边宽 ∝ log2(weight)（trunkEdgeWidth），全量边恒 1×edgeWidth。
    for (const l of this.links) {
      this.linkRenderData.push(this.makeLinkRenderData(l));
    }
    this.edgesGfx = new Graphics({ interactive: false, eventMode: 'none' });
    this.linkLayer.addChild(this.edgesGfx);
    this.redrawEdges();

    this.updateFocusAndRender();
  }

  private redrawAllNodes(): void {
    for (const n of this.nodeRenderData) {
      const d = n.simulationData;
      n.gfx.clear();
      n.gfx.circle(0, 0, d.radius).fill({
        color: d.trunkCluster
          ? trunkClusterColor(d.id)
          : d.dead
            ? this.theme.deadNode
            : nodeColorFor(d.nodeType, d.linkCount, this.theme),
      });
      if (d.trunkCluster) n.gfx.stroke({ width: 2.5, color: this.theme.edge });
    }
    for (const l of this.linkRenderData) {
      l.color = this.theme.edge;
    }
  }

  /** 全部边重画进单个 Graphics。两遍扫描替代 per-link zIndex：active 边最后画 = 置顶。 */
  private redrawEdges(): void {
    this.edgesGfx.clear();
    const cx = this.width / 2;
    const cy = this.height / 2;
    // 两遍循环（inactive 先、active 后），零 per-edge 分配：不许 [...linkRenderData].sort()（收敛期每帧调用）
    for (const pass of [false, true] as const) {
      for (const l of this.linkRenderData) {
        if (l.active !== pass) continue;
        const d = l.simulationData;
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
        this.edgesGfx
          .moveTo(s.x + cx, s.y + cy)
          .lineTo(t.x + cx, t.y + cy)
          .stroke({ alpha: l.alpha, width: l.widthMult * this.edgeWidth, color: l.color });
      }
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
    this.tweenUntil = performance.now() + 250; // 200ms tween + 余量：期间帧必须照常上屏
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
    this.tweenUntil = performance.now() + 250; // 200ms tween + 余量：期间帧必须照常上屏
    const group = new Group();
    const focusId = this.focusId;
    this.edgesDirty = true; // color 即时切换，下一帧边必须重画
    for (const l of this.linkRenderData) {
      const alpha = focusId === null ? 1 : l.active ? 1 : 0.2;
      l.color = l.active ? this.theme.edgeHover : this.theme.edge;
      // 高亮边置顶改由 redrawEdges 的绘制顺序保证（active 最后画）；alpha 仍 200ms tween
      group.add(
        new Tween<LinkRenderData>(l)
          .to({ alpha }, 200)
          .onUpdate(() => {
            this.edgesDirty = true; // alpha 逐帧变：tween 存活期内每帧重画边
          }),
      );
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
   * H2 统一 LOD 规则（labelLod.ts，设计 §4.3）：候选 = 屏内 ∩ 屏幕直径 ≥ 8px
   * （hovered 无条件、trunk blob 豁免），同屏上限 60、cap 内 1-hop 关联享优先——
   * 替代旧的「焦点邻域全显 + 度数预算池」双轨（hover 时邻居无条件显名正是大库
   * 「文字干扰」的根）。贪心碰撞检测照旧：焦点/blob 钉住必放，普通标签避让。
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

    const t = this.currentTransform;
    const view = {
      x: (0 - t.x) / t.k - this.width / 2,
      y: (0 - t.y) / t.k - this.height / 2,
      w: this.width / t.k,
      h: this.height / t.k,
    };
    const lodNodes: LabelLodNode[] = [];
    const rdByKey = new Map<string, NodeRenderData>();
    for (const rd of this.nodeRenderData) {
      const d = rd.simulationData;
      rd.label.visible = false; // 先灭后亮：候选经贪心碰撞检测再点亮
      if (d.x == null || d.y == null) continue;
      lodNodes.push({
        key: d.id,
        x: d.x,
        y: d.y,
        radius: d.radius,
        degree: this.adjacency.get(d.id)?.size ?? 0,
        forceShow: !!d.trunkCluster, // trunk 簇名常显（T2 承诺，直径豁免）
      });
      rdByKey.set(d.id, rd);
    }
    const orderedKeys = selectLabels({
      nodes: lodNodes,
      view,
      k,
      hoveredKey: this.hoveredNodeId,
      neighbourKeys: focusId ? this.focusedNeighbours : NO_NEIGHBOURS,
      minScreenDiameter: LABEL_MIN_SCREEN_DIAMETER,
      maxOnScreen: LABEL_MAX_ONSCREEN,
    });

    // 包围盒（stage-local）= 屏幕尺寸 / k；标签底边位于节点上方 LABEL_GAP_SCREEN 屏幕像素
    const boxes = orderedKeys.map((key) => {
      const rd = rdByKey.get(key)!;
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
    // 钉住必放：1-hop 焦点标签（hover/选中语境下的关键信息）+ trunk blob（簇名）
    const pinned = orderedKeys.map(
      (key) => this.focusedNeighbours.has(key) || !!rdByKey.get(key)!.simulationData.trunkCluster,
    );
    const visible = greedyLabelLayout(boxes, pinned);

    for (let i = 0; i < orderedKeys.length; i++) {
      const rd = rdByKey.get(orderedKeys[i]!)!;
      const focused = this.focusedNeighbours.has(orderedKeys[i]!);
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
    this.transformDirty = true; // zoom/pan/fit/视口动画共用入口：标签+minimap+选中环要跟
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
    this.geometryDirty = true; // 单击钉住/未过阈值拖拽：不加热 sim 也在动几何
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
    this.geometryDirty = true;
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
    } else {
      this.geometryDirty = true; // 松手恢复：标签 + minimap 同步要回来
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
              // trunk 簇团单击：延迟派发给双击留取消窗（双击簇团 no-op，T2 deferred minor）；
              // hub/成员立即打开文件（铁律零延迟）
              if (subj.trunkCluster) this.scheduleTrunkClusterClick(subj.id);
              else this.callbacks.onNodeClick?.(subj.id, toEngineNode(subj));
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
    this.selectionDirty = true;
    this.updateFocusAndRender();
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const node = this.hitTest(e);
    this.hasUserInteracted = true;
    if (node) {
      if (node.trunkCluster) {
        // 双击簇团 = no-op：取消第一次单击排定的展开回调（第二次 end 也会重排，此处统一清）
        if (this.trunkClickDefer) {
          clearTimeout(this.trunkClickDefer);
          this.trunkClickDefer = null;
        }
        return;
      }
      // 死链节点也触发双击（由 GraphPage 决定：新建空白页并打开）
      this.callbacks.onNodeDoubleClick?.(node.id, toEngineNode(node));
    } else if (this.hitTrunkChip(e)) {
      // 双击落在收起 chip 上：不触发空白 fit（chip 是收起出口，误触相机跳转很伤）
      return;
    } else {
      this.fitView({ animate: true });
    }
  };

  /** 双击命中检测（chip 版）：事件点到某 chip 屏幕位置 ≤ 20 CSS px。 */
  private hitTrunkChip(e: MouseEvent): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const ex = e.clientX - rect.left;
    const ey = e.clientY - rect.top;
    const t = this.currentTransform;
    for (const chip of this.trunkChips.values()) {
      const sx = chip.root.x * t.k + t.x;
      const sy = chip.root.y * t.k + t.y;
      if (Math.hypot(ex - sx, ey - sy) <= 20) return true;
    }
    return false;
  }

  /** 簇团单击延迟派发（TRUNK_CLUSTER_CLICK_DEFER_MS）：双击第二击的 dblclick 事件会取消。 */
  private scheduleTrunkClusterClick(clusterId: string): void {
    if (this.trunkClickDefer) clearTimeout(this.trunkClickDefer);
    this.trunkClickDefer = setTimeout(() => {
      this.trunkClickDefer = null;
      this.callbacks.onTrunkClusterClick?.(clusterId);
    }, TRUNK_CLUSTER_CLICK_DEFER_MS);
  }

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
    this.advanceViewport(); // 视口动画步进（内部走 applyTransform → transformDirty）
    const tweensActive = time < this.tweenUntil;
    for (const t of this.tweens.values()) t.update(time); // onUpdate 置 edgesDirty

    // P0-1：先读后清——本帧消费一次，未标记的工作全部跳过（空闲帧零绘制）
    const geometryDirty = this.geometryDirty;
    this.geometryDirty = false;
    const transformDirty = this.transformDirty;
    this.transformDirty = false;
    const selectionDirty = this.selectionDirty;
    this.selectionDirty = false;

    if (geometryDirty) {
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
      // chip 跟随团心（resize 后 cx/cy 变化也能钉在簇上——deferred minor 归位）
      for (const chip of this.trunkChips.values()) {
        chip.root.position.set(chip.centroid.x + cx, chip.centroid.y + cy);
      }
      this.redrawEdges();
      this.edgesDirty = false;
    } else if (this.edgesDirty) {
      this.redrawEdges();
      this.edgesDirty = false;
    }

    // 拖拽降质：位移场期跳过标签重排（标签已隐藏）与 minimap 重绘监听
    if (!this.motionMode && (geometryDirty || transformDirty)) {
      this.syncLabels();
      for (const listener of this.renderListeners) listener();
    }
    if (geometryDirty || transformDirty || selectionDirty) this.syncSelectionRing();

    // 无脏且 tween 已停 → 整帧跳过 renderer.render（空闲期 CPU 断崖的本体）
    if (geometryDirty || transformDirty || tweensActive || selectionDirty) {
      this.app.renderer.render(this.stage);
    }
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
  // 公式本体在 contracts.autoLinkStrength（H3 单一来源：daemon 预跑共用同一语义）
  return (l: SimLink) => {
    const s = l.source as SimNode;
    const t = l.target as SimNode;
    return autoLinkStrength(adjacency.get(s.id)?.size ?? 1, adjacency.get(t.id)?.size ?? 1);
  };
}

function collideRadius(d: SimNode): number {
  // 公式（×5+4 封顶 100）在 graphUtils.collideRadiusValue——mini-sim/布局 worker 共用同一来源。
  // 封顶动机：deg-683 巨型 hub 的 collide（radius*5+4 = 285）会让任何扰动在星形图里被放大成连锁爆炸。
  return collideRadiusValue(d.radius);
}

function toEngineNode(n: SimNode): EngineNode {
  return {
    key: n.id,
    label: n.text,
    path: n.path,
    linkCount: n.linkCount,
    nodeType: n.nodeType ?? null,
    dead: n.dead,
    trunkCluster: n.trunkCluster,
  };
}

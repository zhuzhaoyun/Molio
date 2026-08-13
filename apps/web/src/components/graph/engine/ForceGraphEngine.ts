/**
 * ForceGraphEngine —— 手写 SVG 力导向图谱引擎（框架无关）。
 *
 * 移植并适配自 Tencent WeKnora（MIT License）
 * `frontend/src/views/knowledge/wiki/WikiBrowser.vue`：
 *   - 渲染核心 L3695-4617（renderGraph / tick / setupDrag / setupPanZoom /
 *     applyHighlight / clearHighlight / setEdgePositions / updateLabelsVisibility）
 *   - fitGraphToView L1088-1133
 *
 * 与原版的主要差异：
 *   - 原版是 Vue SFC 内的模块级 let 状态（多实例会串状态、window 监听器从不解绑），
 *     这里收编为 class 实例字段，destroy() 统一清理；
 *   - 删除箭头 marker（Molio 边是无向的）、drawer 耦合（-240px 偏移）、
 *     route.query.slug 深链、TDesign CSS 变量（改用 Molio tokens）；
 *   - 新增过滤语义：hidden 节点 display:none 且完全退出力学；
 *   - 死链节点渲染为空心虚线圆；
 *   - 容器尺寸变化经 ResizeObserver 更新 viewBox。
 *
 * 物理常数由设置面板 4 个滑块映射（见 setForceParams），默认值复现 WeKnora 手感。
 */

import type {
  EngineData,
  EngineEdgeInput,
  EngineEvents,
  EngineForceParams,
  EngineNodeInput,
  EngineOptions,
  NodePalette,
  RenderOpts,
} from './types.ts';

/** 引擎内部节点（物理状态 + 输入快照） */
interface GNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  key: string;
  label: string;
  nodeType?: string;
  linkCount: number;
  dead: boolean;
  hiddenNeighbors: number;
  pinned: boolean;
  hidden: boolean;
  input: EngineNodeInput;
}

interface BloomBtnParts {
  g: SVGGElement;
  bg: SVGCircleElement;
  v: SVGLineElement;
  h: SVGLineElement;
}

interface NodeEl {
  g: SVGGElement;
  circle: SVGCircleElement;
  text: SVGTextElement;
  activeRing: SVGCircleElement;
  expansionRing: SVGCircleElement;
  bloomBtn: BloomBtnParts | null;
  node: GNode;
}

interface EdgeEl {
  line: SVGLineElement;
  source: string;
  target: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 斥力作用半径（px），超出直接剪枝（同 WeKnora MAX_REPULSION_DIST） */
const MAX_REPULSION_DIST = 300;
const MAX_REPULSION_DIST_SQ = MAX_REPULSION_DIST * MAX_REPULSION_DIST;
/** 近距斥力钳位下限，防止重合节点爆炸（同 WeKnora） */
const MIN_DIST_SQ = 100;
/** hover 离场防抖（ms），防相邻节点间滑动闪烁（同 WeKnora） */
const HOVER_LEAVE_DEBOUNCE = 60;
/** 单击去抖窗口（ms），让双击先到达（同 WeKnora） */
const SINGLE_CLICK_DEBOUNCE = 220;
/** 缩放范围（同 WeKnora） */
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
/** 标签截断长度（同 WeKnora） */
const LABEL_MAX_CHARS = 14;

const DEFAULT_PALETTE: NodePalette = {
  node: '#5C5C5C',
  isolated: '#999999',
  dead: '#B8B6B1',
  selected: '#2563eb',
};

export class ForceGraphEngine {
  private container: HTMLElement;
  private events: EngineEvents;

  // ── 场景状态（WeKnora 模块级状态 → 实例字段）──
  private nodes: GNode[] = [];
  private nodeMap = new Map<string, GNode>();
  private edgesInput: EngineEdgeInput[] = [];
  private adjacency = new Map<string, Set<string>>();
  private svg: SVGSVGElement | null = null;
  private rootG: SVGGElement | null = null;
  private nodeEls: NodeEl[] = [];
  private edgeEls: EdgeEl[] = [];
  private rafId = 0;
  private camAnimFrame = 0;
  private hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null;
  private clickTimers = new Set<ReturnType<typeof setTimeout>>();
  private activeDragCleanup: (() => void) | null = null;

  // ── 交互状态 ──
  private selectedKey: string | null = null;
  private hoverKey: string | null = null;
  private scale = 1;
  private translateX = 0;
  private translateY = 0;
  /** setData 后等模拟收敛自动适配一次视口（用户已交互则放弃） */
  private pendingFit = false;
  private panning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panDragStartX = 0;
  private panDragStartY = 0;
  private hasInteracted = false;
  private width = 800;
  private height = 600;
  private destroyed = false;

  // ── 外观 / 物理参数 ──
  private palette: NodePalette = { ...DEFAULT_PALETTE };
  private nodeColors: Record<string, string> = {};
  private nodeScale = 1;
  /** 基础线宽 = settings.edgeWidth(默认 0.8) × 1.5 = 1.2（对齐 WeKnora 观感） */
  private edgeWidthFactor = 0.8;
  private filterPred: ((n: EngineNodeInput) => boolean) | null = null;

  /** 物理常数（由设置滑块映射，默认值 = WeKnora 手感，见 setForceParams） */
  private repulsion = 12000; // WeKnora 200 × 60
  private springK = 0.005; // WeKnora 弹簧系数
  private restLength = 100; // Molio 既有默认 linkDistance
  private centerStrength = 0.004; // Molio 既有默认

  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement, options?: EngineOptions) {
    this.container = container;
    this.events = options?.events ?? {};

    // 窗口级 pan 监听只绑一次，destroy 统一解绑（修复 WeKnora 泄漏）
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.onResize(), 150);
    });
    this.resizeObserver.observe(container);
    this.onResize();
  }

  // ════════════════════════ 数据 ════════════════════════

  /**
   * 全量重绘（= WeKnora renderGraph）。默认重置布局与相机；
   * preserveLayout 用于 bloom 增量合并：复用旧节点 x/y/vx/vy，
   * 新节点出生在 anchorKey 附近，用户心智地图不跳动。
   */
  setData(data: EngineData, opts: RenderOpts = {}): void {
    if (this.destroyed) return;

    // 停掉上一轮动画与残留定时器
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
    for (const t of this.clickTimers) clearTimeout(t);
    this.clickTimers.clear();

    if (!data.nodes.length) {
      this.container.innerHTML = '';
      this.svg = null;
      this.rootG = null;
      this.nodes = [];
      this.nodeMap.clear();
      this.nodeEls = [];
      this.edgeEls = [];
      if (this.selectedKey) {
        this.selectedKey = null;
        this.events.onSelectChange?.(null);
      }
      return;
    }

    this.width = this.container.clientWidth || 800;
    this.height = this.container.clientHeight || 600;

    // preserveLayout：快照旧节点坐标（WeKnora priorCoords）
    const priorCoords = new Map<
      string,
      { x: number; y: number; vx: number; vy: number; pinned: boolean }
    >();
    if (opts.preserveLayout) {
      for (const n of this.nodes) {
        priorCoords.set(n.key, { x: n.x, y: n.y, vx: n.vx, vy: n.vy, pinned: n.pinned });
      }
    }

    // 重建 SVG 骨架：svg > g.graph-root > (edgeG + nodeG)
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    svg.style.width = '100%';
    svg.style.height = '100%';
    this.container.innerHTML = '';
    this.container.appendChild(svg);
    this.svg = svg;

    const rootG = document.createElementNS(SVG_NS, 'g');
    rootG.setAttribute('class', 'graph-root');
    svg.appendChild(rootG);
    this.rootG = rootG;

    const edgeG = document.createElementNS(SVG_NS, 'g');
    rootG.appendChild(edgeG);
    const nodeG = document.createElementNS(SVG_NS, 'g');
    rootG.appendChild(nodeG);

    // 邻接表（高亮用）
    this.adjacency = new Map<string, Set<string>>();
    for (const edge of data.edges) {
      if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, new Set());
      if (!this.adjacency.has(edge.target)) this.adjacency.set(edge.target, new Set());
      this.adjacency.get(edge.source)!.add(edge.target);
      this.adjacency.get(edge.target)!.add(edge.source);
    }

    // bloom 锚点：新节点出生位置（缺省画布中心）
    const anchorCoord = opts.anchorKey ? priorCoords.get(opts.anchorKey) : undefined;
    const anchorX = anchorCoord?.x ?? this.width / 2;
    const anchorY = anchorCoord?.y ?? this.height / 2;

    // 构建节点（初始位置：复用旧坐标 / 锚点 jitter / 圆形布局）
    this.nodeMap = new Map();
    this.nodes = data.nodes.map((input, i) => {
      const prior = opts.preserveLayout ? priorCoords.get(input.key) : undefined;
      let x: number, y: number, vx: number, vy: number, pinned: boolean;
      if (prior) {
        ({ x, y, vx, vy, pinned } = prior);
      } else if (opts.preserveLayout && opts.anchorKey) {
        // 新节点在锚点周围随机出生，由力模拟自然推开（WeKnora bloom 观感）
        const jitterR = 40;
        const angle = Math.random() * Math.PI * 2;
        x = anchorX + jitterR * Math.cos(angle);
        y = anchorY + jitterR * Math.sin(angle);
        vx = 0;
        vy = 0;
        pinned = false;
      } else {
        // 全新渲染：圆形布局起步（WeKnora 同款）
        const angle = (2 * Math.PI * i) / data.nodes.length;
        const r = Math.min(this.width, this.height) * 0.35;
        x = this.width / 2 + r * Math.cos(angle) + (Math.random() - 0.5) * 50;
        y = this.height / 2 + r * Math.sin(angle) + (Math.random() - 0.5) * 50;
        vx = 0;
        vy = 0;
        pinned = false;
      }
      const node: GNode = {
        x,
        y,
        vx,
        vy,
        key: input.key,
        label: input.label,
        nodeType: input.nodeType,
        linkCount: input.linkCount || 0,
        dead: input.dead ?? false,
        hiddenNeighbors: input.hiddenNeighbors ?? 0,
        pinned,
        hidden: false,
        input,
      };
      this.nodeMap.set(input.key, node);
      return node;
    });
    this.edgesInput = data.edges;

    // 边元素
    this.edgeEls = [];
    for (const edge of data.edges) {
      if (!this.nodeMap.has(edge.source) || !this.nodeMap.has(edge.target)) continue;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('stroke', 'var(--border-strong)');
      line.setAttribute('stroke-width', String(this.edgeBaseWidth()));
      line.setAttribute('stroke-opacity', '0.4');
      line.style.transition = 'stroke 0.2s, stroke-width 0.2s, stroke-opacity 0.2s';
      edgeG.appendChild(line);
      this.edgeEls.push({ line, source: edge.source, target: edge.target });
    }

    // 节点元素：expansionRing / activeRing / circle / text / ⊕ 按钮
    this.nodeEls = [];
    for (const n of this.nodes) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.style.cursor = 'pointer';

      const r = this.radius(n);

      // 扩展环：画布外还有隐藏邻居时的虚线提示（WeKnora expansionRing）
      const showExpansionRing = n.hiddenNeighbors > 0 && !n.dead;
      const expansionRing = document.createElementNS(SVG_NS, 'circle');
      expansionRing.setAttribute('r', String(r + 3));
      expansionRing.setAttribute('fill', 'none');
      expansionRing.setAttribute('stroke', this.fillOf(n));
      expansionRing.setAttribute('stroke-width', '1.5');
      expansionRing.setAttribute('stroke-dasharray', '3 3');
      expansionRing.setAttribute('pointer-events', 'none');
      expansionRing.style.opacity = showExpansionRing ? '0.55' : '0';
      expansionRing.style.transition = 'opacity 0.2s';
      g.appendChild(expansionRing);

      // 选中态 pulse 环
      const activeRing = document.createElementNS(SVG_NS, 'circle');
      activeRing.setAttribute('r', String(r + 5));
      activeRing.setAttribute('fill', 'none');
      activeRing.setAttribute('stroke', this.ringColorOf(n));
      activeRing.setAttribute('stroke-width', '2');
      activeRing.style.opacity = '0';
      activeRing.style.transition = 'opacity 0.2s';
      g.appendChild(activeRing);

      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('r', String(r));
      this.applyCirclePaint(circle, n); // 含 stroke-width（死链 1.5 / 普通 2）
      circle.style.transition = 'r 0.2s, stroke-width 0.2s, opacity 0.2s';
      g.appendChild(circle);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dy', String(r + 14));
      text.setAttribute('font-size', '11');
      text.setAttribute('fill', 'var(--text-muted)');
      text.setAttribute('pointer-events', 'none');
      text.style.transition = 'opacity 0.2s';
      text.style.textShadow =
        '0 1px 3px var(--bg), 0 -1px 3px var(--bg), 1px 0 3px var(--bg), -1px 0 3px var(--bg)';
      text.textContent =
        n.label.length > LABEL_MAX_CHARS ? n.label.substring(0, LABEL_MAX_CHARS) + '…' : n.label;
      g.appendChild(text);

      // ⊕ bloom 按钮：hover 时淡入，点击直接展开邻居（WeKnora bloomBtn）
      let bloomBtn: BloomBtnParts | null = null;
      if (n.hiddenNeighbors > 0 && !n.dead) {
        bloomBtn = this.buildBloomBtn(g, n);
      }

      this.wireNodeEvents(g, n);
      this.setupDrag(g, n);

      nodeG.appendChild(g);
      this.nodeEls.push({ g, circle, text, activeRing, expansionRing, bloomBtn, node: n });
    }

    this.setupPanZoom(svg);
    this.applyCurrentFilters();

    // 初始位置先落一帧，再启动力模拟
    for (const { g, node } of this.nodeEls) {
      g.setAttribute('transform', `translate(${node.x},${node.y})`);
    }
    for (const e of this.edgeEls) this.positionEdge(e);

    if (!opts.preserveLayout) {
      this.resetCamera();
      this.pendingFit = true;
    }

    // 选中态去留：focus 落点 > preserveLayout 时保留仍存在的旧选中 > 清空
    const prevSelected = this.selectedKey;
    this.hoverKey = null;
    if (opts.focusKey && this.nodeMap.has(opts.focusKey)) {
      this.selectedKey = null; // 强制触发变更事件
      this.setSelected(opts.focusKey);
      this.flyToNode(opts.focusKey);
    } else if (opts.preserveLayout && prevSelected && this.nodeMap.has(prevSelected)) {
      // bloom 增量渲染：选中不变，只把高亮重放到新 DOM 上
      this.selectedKey = prevSelected;
      this.applyHighlight(prevSelected);
    } else {
      this.selectedKey = null;
      if (prevSelected) this.events.onSelectChange?.(null);
    }

    this.alpha = 1.0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  getNodeCount(): number {
    return this.nodes.length;
  }

  // ════════════════════════ 物理模拟 ════════════════════════

  private alpha = 1.0;

  /**
   * 力模拟 tick（同 WeKnora L4209-4298）：
   * 斥力按 X 轴一维排序剪枝 O(n²)→O(n log n)，沿边弹簧，自适应向心，
   * 阻尼 0.6 + 限速 20，rAF 驱动，与渲染同帧 —— 布局动画肉眼可见。
   */
  private tick = (): void => {
    if (this.destroyed) return;
    this.alpha *= 0.985;
    if (this.alpha < 0.02) {
      this.rafId = 0;
      // 收敛后自动适配视口：初始斥力会让节点先散开再回收，
      // 任何"中途适配"都会框错范围，只在 settle 这一刻框一次。
      if (this.pendingFit) {
        this.pendingFit = false;
        if (!this.hasInteracted) this.fitToView(400);
      }
      return;
    }
    const alpha = this.alpha;

    const visible = this.nodes.filter((n) => !n.hidden);

    // 斥力：X 排序后 dx > 阈值即可 break（WeKnora 关键性能优化）
    const sorted = [...visible].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i++) {
      const n1 = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const n2 = sorted[j];
        const dx = n2.x - n1.x;
        if (dx > MAX_REPULSION_DIST) break;
        const dy = n2.y - n1.y;
        if (Math.abs(dy) > MAX_REPULSION_DIST) continue;
        const distSq = dx * dx + dy * dy;
        if (distSq > MAX_REPULSION_DIST_SQ) continue;
        const dist = Math.sqrt(distSq) || 1;
        const force = (this.repulsion * alpha) / Math.max(distSq, MIN_DIST_SQ);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!n1.pinned) {
          n1.vx -= fx;
          n1.vy -= fy;
        }
        if (!n2.pinned) {
          n2.vx += fx;
          n2.vy += fy;
        }
      }
    }

    // 沿边弹簧引力
    for (const edge of this.edgesInput) {
      const s = this.nodeMap.get(edge.source);
      const t = this.nodeMap.get(edge.target);
      if (!s || !t || s.hidden || t.hidden) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - this.restLength) * this.springK * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!s.pinned) {
        s.vx += fx;
        s.vy += fy;
      }
      if (!t.pinned) {
        t.vx -= fx;
        t.vy -= fy;
      }
    }

    // 向心重力：节点越多收得越紧（WeKnora 自适应，系数由设置滑块映射）
    const sizeFactor = 0.25 + 0.75 * Math.min(1, visible.length / 500);
    const gravityStrength = this.centerStrength * 2.5 * sizeFactor;
    for (const n of visible) {
      if (n.pinned) continue;
      n.vx += (this.width / 2 - n.x) * gravityStrength * alpha;
      n.vy += (this.height / 2 - n.y) * gravityStrength * alpha;
    }

    // 积分：阻尼 + 限速（防初始布局"炸屏"）
    for (const n of visible) {
      if (n.pinned) continue;
      n.vx *= 0.6;
      n.vy *= 0.6;
      const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (v > 20) {
        n.vx = (n.vx / v) * 20;
        n.vy = (n.vy / v) * 20;
      }
      n.x += n.vx;
      n.y += n.vy;
    }

    // 同帧写回 DOM —— 旧 Sigma 实现缺的正是这一步
    for (const { g, node } of this.nodeEls) {
      if (!node.hidden) g.setAttribute('transform', `translate(${node.x},${node.y})`);
    }
    for (const e of this.edgeEls) this.positionEdge(e);

    this.rafId = requestAnimationFrame(this.tick);
  };

  /** 唤醒/再加热模拟（设置变更、过滤变更后调用） */
  private reheat(alpha: number): void {
    if (this.destroyed) return;
    this.alpha = Math.max(this.alpha, alpha);
    if (!this.rafId) this.rafId = requestAnimationFrame(this.tick);
  }

  // ════════════════════════ 几何与外观 ════════════════════════

  /** 节点半径：对数缩放防超级节点过大（WeKnora 公式 × nodeScale） */
  private radius(n: GNode): number {
    return Math.max(8, Math.min(24, 8 + Math.log(n.linkCount + 1) * 4)) * this.nodeScale;
  }

  private edgeBaseWidth(): number {
    return this.edgeWidthFactor * 1.5;
  }

  /** 节点填充色：类型色 → 调色板兜底（死链空心，fill 用 transparent 保留命中区域） */
  private fillOf(n: GNode): string {
    if (n.dead) return 'transparent';
    if (n.nodeType && this.nodeColors[n.nodeType]) return this.nodeColors[n.nodeType];
    return n.linkCount === 0 ? this.palette.isolated : this.palette.node;
  }

  private ringColorOf(n: GNode): string {
    if (n.nodeType && this.nodeColors[n.nodeType]) return this.nodeColors[n.nodeType];
    return this.palette.selected;
  }

  private applyCirclePaint(circle: SVGCircleElement, n: GNode): void {
    if (n.dead) {
      circle.setAttribute('fill', 'transparent');
      circle.setAttribute('stroke', this.palette.dead);
      circle.setAttribute('stroke-dasharray', '4 3');
      circle.setAttribute('stroke-width', '1.5');
    } else {
      circle.setAttribute('fill', this.fillOf(n));
      circle.setAttribute('stroke', 'var(--bg-panel)');
      circle.setAttribute('stroke-width', '2');
      circle.removeAttribute('stroke-dasharray');
    }
  }

  /** 边两端按半径截断，画到圆边（WeKnora setEdgePositions，去掉箭头余量） */
  private positionEdge(e: EdgeEl): void {
    const s = this.nodeMap.get(e.source);
    const t = this.nodeMap.get(e.target);
    if (!s || !t) return;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const rS = this.radius(s) + 1;
    const rT = this.radius(t) + 1;
    e.line.setAttribute('x1', String(s.x + ux * rS));
    e.line.setAttribute('y1', String(s.y + uy * rS));
    e.line.setAttribute('x2', String(t.x - ux * rT));
    e.line.setAttribute('y2', String(t.y - uy * rT));
  }

  private buildBloomBtn(g: SVGGElement, n: GNode): BloomBtnParts {
    const btn = document.createElementNS(SVG_NS, 'g');
    btn.style.opacity = '0';
    btn.style.transition = 'opacity 0.15s';
    btn.style.pointerEvents = 'none'; // hover 时才点亮
    btn.style.cursor = 'pointer';

    const bg = document.createElementNS(SVG_NS, 'circle');
    bg.setAttribute('r', '8');
    bg.setAttribute('fill', 'var(--bg-panel)');
    bg.setAttribute('stroke', 'var(--accent)');
    bg.setAttribute('stroke-width', '1.5');
    btn.appendChild(bg);

    // ⊕ 用两条短线画，跨浏览器比文字符号稳（WeKnora 同款）
    const v = document.createElementNS(SVG_NS, 'line');
    v.setAttribute('stroke', 'var(--accent)');
    v.setAttribute('stroke-width', '1.8');
    v.setAttribute('stroke-linecap', 'round');
    btn.appendChild(v);
    const h = document.createElementNS(SVG_NS, 'line');
    h.setAttribute('stroke', 'var(--accent)');
    h.setAttribute('stroke-width', '1.8');
    h.setAttribute('stroke-linecap', 'round');
    btn.appendChild(h);

    this.placeBloomBtn({ g: btn, bg, v, h }, n);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.events.onBloomRequest?.(n.key);
    });
    // 防止 ⊕ 的 mousedown 触发节点拖拽
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    g.appendChild(btn);
    return { g: btn, bg, v, h };
  }

  private placeBloomBtn(parts: BloomBtnParts, n: GNode): void {
    const offset = this.radius(n) + 6;
    const bx = Math.SQRT1_2 * offset;
    const by = -Math.SQRT1_2 * offset;
    parts.bg.setAttribute('cx', String(bx));
    parts.bg.setAttribute('cy', String(by));
    parts.v.setAttribute('x1', String(bx));
    parts.v.setAttribute('x2', String(bx));
    parts.v.setAttribute('y1', String(by - 4));
    parts.v.setAttribute('y2', String(by + 4));
    parts.h.setAttribute('x1', String(bx - 4));
    parts.h.setAttribute('x2', String(bx + 4));
    parts.h.setAttribute('y1', String(by));
    parts.h.setAttribute('y2', String(by));
  }

  // ════════════════════════ 节点事件 ════════════════════════

  /**
   * hover 高亮 + 单击/双击/shift 分派（WeKnora L4095-4195）。
   * 单击 220ms 去抖让双击先到达；shift+click 直接 bloom 不走选中。
   */
  private wireNodeEvents(g: SVGGElement, n: GNode): void {
    const nodeEl = () => this.nodeEls.find((e) => e.node.key === n.key);

    g.addEventListener('mouseenter', () => {
      if (this.hoverLeaveTimer) {
        clearTimeout(this.hoverLeaveTimer);
        this.hoverLeaveTimer = null;
      }
      const el = nodeEl();
      if (el?.bloomBtn) {
        el.bloomBtn.g.style.opacity = '1';
        el.bloomBtn.g.style.pointerEvents = 'auto';
      }
      if (!this.selectedKey) {
        if (this.hoverKey === n.key) return;
        this.hoverKey = n.key;
        this.applyHighlight(n.key);
      } else if (this.selectedKey !== n.key) {
        if (this.hoverKey === n.key) return;
        this.hoverKey = n.key;
        this.applyHighlight(this.selectedKey, n.key);
      }
    });

    g.addEventListener('mouseleave', () => {
      if (this.hoverLeaveTimer) clearTimeout(this.hoverLeaveTimer);
      const el = nodeEl();
      if (el?.bloomBtn) {
        el.bloomBtn.g.style.opacity = '0';
        el.bloomBtn.g.style.pointerEvents = 'none';
      }
      // 60ms 防抖：在相邻节点间滑动不闪回无高亮态（WeKnora 同款）
      this.hoverLeaveTimer = setTimeout(() => {
        this.hoverLeaveTimer = null;
        this.hoverKey = null;
        if (!this.selectedKey) {
          this.clearHighlight();
        } else {
          this.applyHighlight(this.selectedKey);
        }
      }, HOVER_LEAVE_DEBOUNCE);
    });

    let pendingSingleClick: ReturnType<typeof setTimeout> | null = null;
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey) {
        if (pendingSingleClick) {
          clearTimeout(pendingSingleClick);
          this.clickTimers.delete(pendingSingleClick);
          pendingSingleClick = null;
        }
        this.events.onNodeShiftClick?.(n.key);
        return;
      }
      if (pendingSingleClick) {
        clearTimeout(pendingSingleClick);
        this.clickTimers.delete(pendingSingleClick);
      }
      pendingSingleClick = setTimeout(() => {
        this.clickTimers.delete(pendingSingleClick!);
        pendingSingleClick = null;
        if (this.destroyed || !this.nodeMap.has(n.key)) return;
        this.setSelected(n.key);
        this.flyToNode(n.key);
      }, SINGLE_CLICK_DEBOUNCE);
      this.clickTimers.add(pendingSingleClick);
    });

    g.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (pendingSingleClick) {
        clearTimeout(pendingSingleClick);
        this.clickTimers.delete(pendingSingleClick);
        pendingSingleClick = null;
      }
      this.events.onNodeDblClick?.(n.key);
    });
  }

  /** 拖拽（WeKnora setupDrag）：拖动即 pin，松手留在原地 */
  private setupDrag(g: SVGGElement, node: GNode): void {
    let dragging = false;
    let startX = 0;
    let startY = 0;

    const getPoint = (e: MouseEvent) => {
      const svg = this.svg;
      if (!svg) return { x: e.clientX, y: e.clientY };
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const rootG = this.rootG;
      const ctm = rootG?.getCTM()?.inverse();
      if (ctm) {
        const svgP = pt.matrixTransform(ctm);
        return { x: svgP.x, y: svgP.y };
      }
      return { x: e.clientX, y: e.clientY };
    };

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const p = getPoint(e);
      node.x = p.x - startX;
      node.y = p.y - startY;
      node.vx = 0;
      node.vy = 0;
      g.setAttribute('transform', `translate(${node.x},${node.y})`);
      for (const edge of this.edgeEls) {
        if (edge.source === node.key || edge.target === node.key) this.positionEdge(edge);
      }
    };

    const onEnd = () => {
      dragging = false;
      const el = this.nodeEls.find((e) => e.node.key === node.key);
      if (el) {
        if (node.dead) {
          el.circle.setAttribute('stroke', this.palette.dead);
          el.circle.setAttribute('stroke-width', '1.5');
        } else {
          el.circle.setAttribute('stroke', 'var(--bg-panel)');
          el.circle.setAttribute('stroke-width', '2');
        }
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      if (this.activeDragCleanup === cleanup) this.activeDragCleanup = null;
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
    };

    g.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.hasInteracted = true;
      dragging = true;
      node.pinned = true;
      const p = getPoint(e);
      startX = p.x - node.x;
      startY = p.y - node.y;
      const el = this.nodeEls.find((ne) => ne.node.key === node.key);
      if (el) {
        el.circle.setAttribute('stroke', this.ringColorOf(node));
        el.circle.setAttribute('stroke-width', '3');
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
      this.activeDragCleanup = cleanup;
    });
  }

  // ════════════════════════ Pan & Zoom ════════════════════════

  /** Pan/Zoom（WeKnora setupPanZoom）：窗口级监听器改为实例绑定，destroy 可解绑 */
  private setupPanZoom(svg: SVGSVGElement): void {
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.hasInteracted = true;
        const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * zoomFactor));
        // 朝光标缩放
        const rect = svg.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        this.translateX = cx - (cx - this.translateX) * (newScale / this.scale);
        this.translateY = cy - (cy - this.translateY) * (newScale / this.scale);
        this.scale = newScale;
        this.applyTransform();
      },
      { passive: false },
    );

    svg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // 仅背景触发 pan（点击节点由节点自己的 mousedown 处理）
      if ((e.target as Element).tagName === 'svg' || (e.target as Element).tagName === 'SVG') {
        this.hasInteracted = true;
        this.panning = true;
        this.panStartX = e.clientX - this.translateX;
        this.panStartY = e.clientY - this.translateY;
        this.panDragStartX = e.clientX;
        this.panDragStartY = e.clientY;
        svg.style.cursor = 'grabbing';
      }
    });
  }

  private onWindowMouseMove = (e: MouseEvent): void => {
    if (!this.panning) return;
    this.translateX = e.clientX - this.panStartX;
    this.translateY = e.clientY - this.panStartY;
    this.applyTransform();
  };

  private onWindowMouseUp = (e: MouseEvent): void => {
    if (!this.panning) return;
    this.panning = false;
    if (this.svg) this.svg.style.cursor = 'grab';
    // 位移 <5px 视为点击空白：清选中（WeKnora 同款）
    const dx = e.clientX - this.panDragStartX;
    const dy = e.clientY - this.panDragStartY;
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
      if ((e.target as Element).tagName === 'svg' || (e.target as Element).tagName === 'SVG') {
        if (this.selectedKey) this.setSelected(null);
        this.events.onBackgroundClick?.();
      }
    }
  };

  private applyTransform(): void {
    this.rootG?.setAttribute(
      'transform',
      `translate(${this.translateX},${this.translateY}) scale(${this.scale})`,
    );
    this.updateLabelsVisibility();
  }

  private resetCamera(): void {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  /**
   * 标签 LOD（WeKnora updateLabelsVisibility）：缩得太小隐藏标签，
   * 度数越高的节点越早显示；选中/hover 节点常显。
   */
  private updateLabelsVisibility(): void {
    for (const { text, node } of this.nodeEls) {
      if (node.key === this.selectedKey || node.key === this.hoverKey) {
        text.style.opacity = '1';
        continue;
      }
      let threshold = 0.5;
      if (node.linkCount > 10) threshold = 0.2;
      else if (node.linkCount > 5) threshold = 0.35;
      else if (node.linkCount > 2) threshold = 0.45;
      text.style.opacity = this.scale < threshold ? '0' : '1';
    }
  }

  // ════════════════════════ 相机动画 ════════════════════════

  /** 相机飞行（WeKnora flyTo）：cubic ease-out */
  flyTo(tx: number, ty: number, targetScale?: number, duration = 400): void {
    if (this.destroyed) return;
    if (this.camAnimFrame) cancelAnimationFrame(this.camAnimFrame);
    if (duration <= 0) {
      this.translateX = tx;
      this.translateY = ty;
      if (targetScale !== undefined) this.scale = targetScale;
      this.applyTransform();
      return;
    }
    const startX = this.translateX;
    const startY = this.translateY;
    const startScale = this.scale;
    const endScale = targetScale ?? this.scale;
    const startTime = performance.now();
    const animate = (time: number) => {
      if (this.destroyed) return;
      let t = (time - startTime) / duration;
      if (t > 1) t = 1;
      const ease = 1 - Math.pow(1 - t, 3);
      this.translateX = startX + (tx - startX) * ease;
      this.translateY = startY + (ty - startY) * ease;
      this.scale = startScale + (endScale - startScale) * ease;
      this.applyTransform();
      if (t < 1) this.camAnimFrame = requestAnimationFrame(animate);
      else this.camAnimFrame = 0;
    };
    this.camAnimFrame = requestAnimationFrame(animate);
  }

  /** 将某节点飞到视口中心（保持当前缩放） */
  flyToNode(key: string, opts?: { duration?: number; scale?: number }): void {
    const node = this.nodeMap.get(key);
    if (!node) return;
    const scale = opts?.scale ?? this.scale;
    this.flyTo(
      this.width / 2 - node.x * scale,
      this.height / 2 - node.y * scale,
      opts?.scale,
      opts?.duration ?? 400,
    );
  }

  /** 适应屏幕（WeKnora fitGraphToView，去掉 drawer 偏移） */
  fitToView(duration = 600): void {
    if (this.nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let visibleCount = 0;
    for (const node of this.nodes) {
      if (node.hidden) continue;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
      visibleCount++;
    }
    if (visibleCount === 0) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const padding = 60;
    const boxWidth = Math.max(maxX - minX, 100) + padding * 2;
    const boxHeight = Math.max(maxY - minY, 100) + padding * 2;
    const targetScale = Math.max(
      MIN_SCALE,
      Math.min(2, Math.min(this.width / boxWidth, this.height / boxHeight)),
    );
    this.flyTo(this.width / 2 - cx * targetScale, this.height / 2 - cy * targetScale, targetScale, duration);
  }

  // ════════════════════════ 高亮 ════════════════════════

  /** 邻接子图高亮（WeKnora applyHighlight，去箭头分支） */
  private applyHighlight(focusKey: string, hoverKey?: string): void {
    const neighbors = this.adjacency.get(focusKey) ?? new Set<string>();
    const hoverNeighbors = hoverKey ? this.adjacency.get(hoverKey) ?? new Set<string>() : new Set<string>();

    for (const { g, circle, activeRing, node } of this.nodeEls) {
      const r = this.radius(node);
      const isFocus = node.key === focusKey;
      const isHover = hoverKey !== undefined && node.key === hoverKey;
      if (isFocus || isHover) {
        circle.setAttribute('r', String(r + 3));
        circle.setAttribute('stroke-width', '3');
        g.style.opacity = '1';
      } else if (neighbors.has(node.key) || hoverNeighbors.has(node.key)) {
        circle.setAttribute('r', String(r));
        circle.setAttribute('stroke-width', '2');
        g.style.opacity = '1';
      } else {
        circle.setAttribute('r', String(r));
        circle.setAttribute('stroke-width', '2');
        g.style.opacity = '0.2';
      }
      activeRing.style.opacity = node.key === this.selectedKey ? '1' : '0';
    }

    const highlightColor = (k: string | undefined) => {
      const n = k ? this.nodeMap.get(k) : undefined;
      return n?.nodeType && this.nodeColors[n.nodeType] ? this.nodeColors[n.nodeType] : 'var(--accent)';
    };

    for (const e of this.edgeEls) {
      const touchesFocus = e.source === focusKey || e.target === focusKey;
      const touchesHover =
        hoverKey !== undefined && (e.source === hoverKey || e.target === hoverKey);
      if (touchesFocus || touchesHover) {
        e.line.setAttribute('stroke-opacity', '0.9');
        e.line.setAttribute('stroke-width', String(Math.max(this.edgeBaseWidth() * 1.6, 1.5)));
        const driver = touchesHover ? hoverKey : focusKey;
        e.line.setAttribute('stroke', highlightColor(driver));
      } else {
        e.line.setAttribute('stroke-opacity', '0.08');
        e.line.setAttribute('stroke-width', String(this.edgeBaseWidth() * 0.8));
        e.line.setAttribute('stroke', 'var(--border-strong)');
      }
    }
  }

  private clearHighlight(): void {
    if (this.selectedKey) {
      this.applyHighlight(this.selectedKey);
      return;
    }
    for (const { g, circle, activeRing, node } of this.nodeEls) {
      circle.setAttribute('r', String(this.radius(node)));
      circle.setAttribute('stroke-width', node.dead ? '1.5' : '2');
      g.style.opacity = '1';
      activeRing.style.opacity = '0';
    }
    for (const e of this.edgeEls) {
      e.line.setAttribute('stroke', 'var(--border-strong)');
      e.line.setAttribute('stroke-width', String(this.edgeBaseWidth()));
      e.line.setAttribute('stroke-opacity', '0.4');
    }
  }

  // ════════════════════════ 选中 ════════════════════════

  setSelected(key: string | null): void {
    if (this.destroyed) return;
    const changed = this.selectedKey !== key;
    this.selectedKey = key;
    if (key) {
      this.applyHighlight(key);
    } else {
      this.clearHighlight();
    }
    if (changed) this.events.onSelectChange?.(key);
  }

  getSelected(): string | null {
    return this.selectedKey;
  }

  // ════════════════════════ 设置 live 应用 ════════════════════════

  /** 可见性过滤：hidden 节点退出渲染与力学（Molio 新增语义） */
  applyFilters(pred: (n: EngineNodeInput) => boolean): void {
    if (this.destroyed) return;
    this.filterPred = pred;
    this.applyCurrentFilters();
    this.reheat(0.3);
  }

  private applyCurrentFilters(): void {
    const pred = this.filterPred;
    for (const { g, node } of this.nodeEls) {
      node.hidden = pred ? !pred(node.input) : false;
      g.style.display = node.hidden ? 'none' : '';
    }
    for (const e of this.edgeEls) {
      const s = this.nodeMap.get(e.source);
      const t = this.nodeMap.get(e.target);
      e.line.style.display = s?.hidden || t?.hidden ? 'none' : '';
    }
  }

  setNodeScale(scale: number): void {
    if (this.destroyed || scale === this.nodeScale) return;
    this.nodeScale = scale;
    for (const el of this.nodeEls) {
      const r = this.radius(el.node);
      el.circle.setAttribute('r', String(r));
      el.expansionRing.setAttribute('r', String(r + 3));
      el.activeRing.setAttribute('r', String(r + 5));
      el.text.setAttribute('dy', String(r + 14));
      if (el.bloomBtn) this.placeBloomBtn(el.bloomBtn, el.node);
    }
    for (const e of this.edgeEls) this.positionEdge(e);
  }

  setEdgeWidth(width: number): void {
    if (this.destroyed || width === this.edgeWidthFactor) return;
    this.edgeWidthFactor = width;
    for (const e of this.edgeEls) {
      e.line.setAttribute('stroke-width', String(this.edgeBaseWidth()));
    }
  }

  setNodePalette(p: NodePalette): void {
    if (this.destroyed) return;
    this.palette = { ...p };
    this.refreshNodePaint();
  }

  setNodeColors(map: Record<string, string>): void {
    if (this.destroyed) return;
    this.nodeColors = { ...map };
    this.refreshNodePaint();
  }

  private refreshNodePaint(): void {
    for (const el of this.nodeEls) {
      this.applyCirclePaint(el.circle, el.node);
      el.expansionRing.setAttribute('stroke', this.fillOf(el.node));
      el.activeRing.setAttribute('stroke', this.ringColorOf(el.node));
    }
  }

  /**
   * 力度参数映射（设置面板 4 滑块 → 物理常数，默认值复现 WeKnora 手感）：
   *   排斥力 repelStrength(-60)  → REPULSION = -v×200      = 12000（WeKnora 200×60）
   *   连线拉力 linkStrength(0.15) → SPRING_K  = v/30        = 0.005（WeKnora 弹簧系数）
   *   连线距离 linkDistance(100)  → restLength 直接使用
   *   向心力 centerStrength(0.004)→ gravity 基数（tick 内按节点数自适应缩放）
   */
  setForceParams(patch: Partial<EngineForceParams>): void {
    if (this.destroyed) return;
    if (patch.repelStrength !== undefined) this.repulsion = Math.max(0, -patch.repelStrength) * 200;
    if (patch.linkStrength !== undefined) this.springK = Math.max(0, patch.linkStrength) / 30;
    if (patch.linkDistance !== undefined) this.restLength = Math.max(20, patch.linkDistance);
    if (patch.centerStrength !== undefined) this.centerStrength = Math.max(0, patch.centerStrength);
    this.reheat(0.5);
  }

  // ════════════════════════ 生命周期 ════════════════════════

  updateEvents(events: EngineEvents): void {
    this.events = events;
  }

  private onResize(): void {
    if (this.destroyed) return;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.svg?.setAttribute('viewBox', `0 0 ${w} ${h}`);
    // 不在 resize 时抢相机：模拟未收敛时 fit 会框错范围，
    // 收敛时的 pendingFit 已负责首次适配；之后的适配交给用户的"适应屏幕"操作
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.camAnimFrame) cancelAnimationFrame(this.camAnimFrame);
    if (this.hoverLeaveTimer) clearTimeout(this.hoverLeaveTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    for (const t of this.clickTimers) clearTimeout(t);
    this.clickTimers.clear();
    this.activeDragCleanup?.();
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    this.resizeObserver?.disconnect();
    this.container.innerHTML = '';
    this.svg = null;
    this.rootG = null;
    this.nodes = [];
    this.nodeMap.clear();
    this.nodeEls = [];
    this.edgeEls = [];
    this.adjacency.clear();
  }
}

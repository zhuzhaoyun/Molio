/**
 * GraphPage — Obsidian-style force-directed knowledge graph.
 *
 * Visual reference: https://help.obsidian.md/Plugins/Graph+view
 * Colours match Obsidian's default dark theme CSS variables.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Graph from 'graphology';
import type { GraphData } from '@molio/contracts';
import { useSimulation } from './useSimulation';
import Sigma from 'sigma';
import { NodeCircleProgram } from 'sigma/rendering';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useActiveVaultId, vaultStore } from '../../stores/vaultStore';
import { useGraphSettings } from './useGraphSettings';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import { Minimap } from './Minimap';
import { getThemeColors } from './types';
import { setupCameraInertia } from './useCameraInertia';
import { NODE_TYPE_COLORS, nodeSize, nodeColor, interpolateColor, tileIsolatedNodes } from './graph-utils';

// ── Visual constants (Obsidian light theme, matching obsidian.png) ──
// 浅色背景 + 深色节点，像纸张上的墨点

const BG = '#FAFAFA';              // Obsidian 浅色背景
const NODE_DEFAULT = '#5C5C5C';  // 默认节点：深灰
const NODE_ISOLATED = '#999999';  // 孤立节点：更浅的灰
const NODE_HOVER = '#333333';    // hover：更深
const NODE_SELECTED = '#8B5CF6'; // 选中：Obsidian 紫色
const NODE_SELECTED_BORDER = '#7C3AED';
const EDGE_DEFAULT = '#D4D4D4';  // 连线：淡灰，清晰可见但不喧宾夺主
const EDGE_HOVER = '#C4B5FD';    // hover 连线：淡紫
const EDGE_SELECTED = '#8B5CF6'; // 选中连线：紫色
const LABEL_DEFAULT = '#6B6B6B'; // 标签：灰色

// ── 淡化参数（对齐 Obsidian：淡化但保持可读，非关联节点不缩成隐形点）──
const FOCUS_DIM_SIZE_RATIO = 0.4;    // 选中聚焦：非关联节点尺寸保留 60%
const HOVER_DIM_SIZE_RATIO = 0.25;   // hover：非关联节点尺寸保留 75%
const HOVER_DIM_COLOR_RATIO = 0.6;  // hover 颜色淡化深度（不全褪到 dimmed，hover 意图更轻）
const EDGE_DIM_COLOR_RATIO = 0.85;  // 非关联边向背景褪色深度（保留淡痕，不喧宾夺主）
const EDGE_DIM_SIZE_RATIO = 0.5;    // 非关联边尺寸收缩

// 拖拽局部流体（路线 B）半径，单位屏幕像素，用冻结映射换算成图坐标半径传入 beginDrag（拖拽期映射恒定）：
//   INNER = 「无回弹自由区」半径：其内拴绳强度=0，节点被推开后就地停/重组、绝不弹回旧锚点。
//           必须 ≥ 磁铁半径，否则被犁的节点落在拴绳>0 区 → 出现"回弹引力"。
//   OUTER = 完全钉死起始半径：INNER..OUTER 之间拴绳 0→强 插值（中距离节点呈滞后微动）。
//   MAGNET = 磁铁排斥场半径：场内未接触即被平滑推开（磁铁手感）；略大于 INNER，使 INNER..MAGNET
//           这圈节点受弱推+部分拴绳 → 滞后微动（"远节点少量流体移动"）。
const DRAG_FLOW_INNER_PX = 170;
const DRAG_FLOW_OUTER_PX = 320;
const DRAG_MAGNET_PX = 210;

// ── 模块级图谱数据缓存 ──
// 切出图谱页再回来时，先用上次缓存数据立即渲染（stale-while-revalidate），
// 后台静默拉新。vault 维度缓存，进程内有效。
interface GraphCacheEntry {
  data: GraphData;
  ts: number;
}
const graphDataCache = new Map<string, GraphCacheEntry>();

// ── 模块级节点位置缓存（跨导航复用 → 导航回来不闪、不重 bloom，只快速淡入）──
// 注意：刷新整页会清空（JS 内存），故刷新/首次走"冷加载 bloom"。
const graphPositionsCache = new Map<string, Map<string, { x: number; y: number; fx?: number; fy?: number }>>();

// ── 入场过渡参数（看不见画面，提成常量便于目测微调）──
const INTRO_BLOOM_MS = 800;        // 冷加载：节点 聚团→终态 绽放时长（easeOutCubic，先快后缓）
// 径向错峰：按终态到质心的归一化半径给每节点延迟，形成"由中心向外涟漪绽放"，比统一 ease 更"活"。
// 0=无错峰(统一)；越大波纹越明显。开销不变（仅每节点多算一个 localT）。
const INTRO_STAGGER = 0.6;
const INTRO_FADE_MS = 350;         // 画布 opacity 0→1（与 CSS .graph-intro* 的 transition 对齐）
const INTRO_PRESETTLE_TICKS = 300; // 冷加载小图：同步预结算 tick 数（拿终态，避免"中间态"）
const INTRO_SPIRAL_STEP = 7;       // 入场聚团黄金角螺旋点间距（图坐标，越小聚得越紧）
const INTRO_GUESS_R_FACTOR = 35;   // 冷加载大图 ML 完成前占位包围盒半径系数（sqrt(n)*k+120）

function easeOutCubic(t: number): number { const u = 1 - t; return 1 - u * u * u; }

/** 节点坐标（fx/fy 可选）；统一类型避免 Map 值类型不变性报错。 */
type Pos = { x: number; y: number; fx?: number; fy?: number };

/** 可见节点的包围盒（图坐标）；空图返回 null。
 *  回退"现状"的全量包围盒、不做离群点裁剪——裁剪会放大缩放、改变"现状"的间距观感
 *  （用户反馈"节点之间距离变大"）。若个别离群点撑大视图，应由布局本身解决（如孤立平铺），而非 fit 裁剪。 */
function computeBounds(graph: Graph): { x: [number, number]; y: [number, number] } | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  graph.forEachNode((_k, a) => {
    if (a.hidden) return;
    const x = (a.x as number) ?? 0, y = (a.y as number) ?? 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  });
  if (!isFinite(minX)) return null;
  if (maxX - minX < 1e-6) { minX -= 1; maxX += 1; }
  if (maxY - minY < 1e-6) { minY -= 1; maxY += 1; }
  return { x: [minX, maxX], y: [minY, maxY] };
}

/** 读当前图坐标为 Map（不含 fx/fy，供 bloom 终点）。 */
function toPosMap(graph: Graph): Map<string, Pos> {
  const m = new Map<string, Pos>();
  graph.forEachNode((k, a) => m.set(k, { x: (a.x as number) ?? 0, y: (a.y as number) ?? 0 }));
  return m;
}

// ── 位置缓存读写：模块缓存(跨导航) + sessionStorage(跨刷新) ──
// 刷新整页会清空 JS 内存 → 用 sessionStorage 恢复同一布局，避免"刷新后位置随机/重排"
// （对齐 Obsidian 按 vault 持久化图谱位置）。读取时只复用仍存在的节点（多余键忽略，缺失节点走初始布局）。
const POS_CACHE_KEY = (vaultId: string) => `molio.graphPositions.${vaultId}`;
function readPositionsCache(vaultId: string): Map<string, Pos> | null {
  const mem = graphPositionsCache.get(vaultId);
  if (mem && mem.size > 0) return mem;
  try {
    const raw = sessionStorage.getItem(POS_CACHE_KEY(vaultId));
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, Pos>;
    const m = new Map<string, Pos>();
    for (const k of Object.keys(obj)) m.set(k, obj[k]);
    if (m.size > 0) { graphPositionsCache.set(vaultId, m); return m; }
  } catch { /* 损坏 / 隐私模式：忽略，走冷加载 */ }
  return null;
}
function writePositionsCache(vaultId: string, positions: Map<string, Pos>) {
  if (positions.size === 0) return;
  graphPositionsCache.set(vaultId, positions);
  try {
    const obj: Record<string, Pos> = {};
    positions.forEach((v, k) => { obj[k] = v; });
    sessionStorage.setItem(POS_CACHE_KEY(vaultId), JSON.stringify(obj));
  } catch { /* 配额 / 隐私模式：忽略 */ }
}

// ── Main Page Component ──

export function GraphPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  // 跟随知识库的活跃 vault，知识库切换时图谱自动切换
  const activeVaultId = useActiveVaultId();
  const [graphData, setGraphData] = useState<GraphData | null>(() =>
    activeVaultId ? graphDataCache.get(activeVaultId)?.data ?? null : null,
  );
  const [loading, setLoading] = useState(() =>
    activeVaultId ? !graphDataCache.has(activeVaultId) : false,
  );
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [mlRunning, setMlRunning] = useState(false);
  const [mlProgress, setMlProgress] = useState(0);
  // 节点搜索（Ctrl/Cmd+F）
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  // sigma 在 effect 里创建、存于 ref（不触发重渲染）。Minimap 需要 sigma 作 prop，
  // 用 state 镜像让其在 sigma 就绪后挂载。
  const [sigmaInstance, setSigmaInstance] = useState<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 暴露 effect 内的 dim 动画函数给组件作用域（搜索选中时用）
  const startDimAnimRef = useRef<((target: number, durationMs: number) => void) | null>(null);

  const hoveredNodeRef = useRef<string | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  // 移动时降质标记：节点拖拽期间为 true，传给 Minimap 跳过重绘
  const interactingRef = useRef(false);
  // Multi-level layout progress callback (stable ref, updated each render)
  const mlOnProgressRef = useRef<((phase: string, progress: number) => void) | null>(null);
  mlOnProgressRef.current = (phase: string, progress: number) => {
    setMlRunning(true);
    setMlProgress(progress);
    if (progress >= 0.99) {
      setTimeout(() => setMlRunning(false), 500);
    }
  };
  // 入场过渡状态：clusterStart=冷加载入场聚团坐标(bloom 起点)；pendingCold=是否冷加载(待 bloom)；
  // introRaf=bloom 的 RAF id(卸载/重建时取消)。节点位置跨导航缓存见模块级 graphPositionsCache。
  const clusterStartRef = useRef<Map<string, Pos> | null>(null);
  const pendingColdRef = useRef(false);
  const introRafRef = useRef(0);

  // ── Transition animation states ──
  const focusDimRef = useRef(0);        // 0→1 animated for select focus
  const hoverDimRef = useRef(0);        // 0→1 animated for hover
  const hoverLingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const simulation = useSimulation();
  // 镜像 simulation 给独立 effect（ML 完成、筛选变化）用，便于在数据变化点显式清除质心锁
  const simulationRef = useRef(simulation);
  simulationRef.current = simulation;
  const { settings, updateSettings, updateForce } = useGraphSettings();
  const themeColors = getThemeColors(settings.theme);

  // Fetch graph data when active vault changes
  // stale-while-revalidate：有缓存立即显示，后台静默刷新
  useEffect(() => {
    if (!activeVaultId) return;

    let cancelled = false;

    // 立即用缓存数据（避免切回时 loading 闪烁）
    const cached = graphDataCache.get(activeVaultId);
    if (cached) {
      setGraphData(cached.data);
      setLoading(false);
      setError(null);
    } else {
      setLoading(true);
    }

    // 后台静默拉新
    api.getGraph(activeVaultId)
      .then((data) => {
        if (cancelled) return;
        graphDataCache.set(activeVaultId, { data, ts: Date.now() });
        setGraphData(data);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.message?.includes('404')) {
          // Vault no longer exists in DB — clear stale selection + cache.
          // App.tsx's setVaults() will auto-select a valid vault,
          // and this useEffect will re-fire with the new activeVaultId.
          vaultStore.setActiveVaultId(null);
          graphDataCache.delete(activeVaultId);
          setError(null);
          if (!cached) setGraphData(null);
        } else {
          // 有缓存就保留 stale 数据不报错；没缓存才报错
          if (cached) {
            setError(null);
          } else {
            setError(err.message ?? 'Failed to load graph');
            setGraphData(null);
          }
        }
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [activeVaultId]);

  // Initialize Sigma when graph data is available
  useEffect(() => {
    if (!graphData || graphData.nodes.length === 0 || !containerRef.current) return;
    if (!activeVaultId) return;

    // 入场完成标记复位（E2E 据此等待入场结束）
    (window as unknown as Record<string, unknown>).__graphIntroDone = false;

    // 暖=缓存命中(模块缓存/ sessionStorage，导航回来或刷新)→ 用缓存终态 + 快速淡入；
    // 冷=真正首次 → 入场聚团 + bloom。
    const savedPositions = readPositionsCache(activeVaultId);
    const warm = !!savedPositions;
    // 入场隐藏类：暖=轻模糊淡入；冷=重模糊(遮住"尚未排好"，兼作加载态)
    containerRef.current.classList.add(warm ? 'graph-intro-soft' : 'graph-intro');

    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }

    // ── Build graph ──
    const graph = new Graph({ allowSelfLoops: false, multi: false });
    graphRef.current = graph;

    const count = graphData.nodes.length;
    const guessR = Math.sqrt(count) * INTRO_GUESS_R_FACTOR + 120; // 冷大图 ML 完成前占位包围盒半径
    // 冷加载入场聚团（黄金角螺旋，围绕原点=力布局中心）= bloom 起点
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    // spiral 聚团：冷加载作 bloom 起点；暖加载作"缓存缺键节点"的兜底初始位（避免堆在原点 0,0）
    const clusterStart = new Map<string, Pos>();
    graphData.nodes.forEach((n, i) => {
      const r = INTRO_SPIRAL_STEP * Math.sqrt(i + 1);
      const a = i * GOLDEN;
      clusterStart.set(n.key, { x: Math.cos(a) * r, y: Math.sin(a) * r });
    });
    clusterStartRef.current = warm ? null : clusterStart;
    pendingColdRef.current = !warm;

    // 初始布局回退"现状"的圆形散布：螺旋初始会改变力布局/ML 的收敛结果（节点间距变大、回弹变味），
    // 故圆形仅用于"布局起点"；螺旋(clusterStart)只留给 bloom 当视觉起点，不影响布局/间距/回弹。
    for (let i = 0; i < count; i++) {
      const n = graphData.nodes[i];
      const saved = savedPositions?.get(n.key);
      const angle = (2 * Math.PI * i) / count;
      graph.addNode(n.key, {
        label: n.label,
        path: n.path,
        linkCount: n.linkCount,
        nodeType: n.nodeType ?? null,
        size: nodeSize(n.linkCount, settings.nodeScale),
        color: n.nodeType && NODE_TYPE_COLORS[n.nodeType]
          ? NODE_TYPE_COLORS[n.nodeType]
          : (n.linkCount === 0 ? themeColors.isolated : themeColors.node),
        type: 'circle',
        x: saved?.x ?? Math.cos(angle) * guessR,
        y: saved?.y ?? Math.sin(angle) * guessR,
        // 暖：恢复缓存的固定位置（孤立圆环/拖拽锁定）；冷：入场阶段不固定
        ...(warm && saved?.fx != null ? { fx: saved.fx, fy: saved.fy } : {}),
      });
    }

    for (const e of graphData.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      try {
        graph.addEdge(e.source, e.target, { color: themeColors.edge });
      } catch { /* Edge already exists */ }
    }

    // ── Dead link nodes ──
    if (graphData.deadLinks && graphData.deadLinks.length > 0) {
      const seen = new Set<string>();
      graphData.deadLinks.forEach((dl, i) => {
        if (seen.has(dl.targetName)) return;
        seen.add(dl.targetName);
        const deadKey = `__dead__${dl.targetName}`;
        const saved = savedPositions?.get(deadKey);
        const di = count + i;
        const sp = clusterStart.get(deadKey) ?? {
          x: Math.cos(di * GOLDEN) * INTRO_SPIRAL_STEP * Math.sqrt(di + 1),
          y: Math.sin(di * GOLDEN) * INTRO_SPIRAL_STEP * Math.sqrt(di + 1),
        };
        try {
          graph.addNode(deadKey, {
            label: `${dl.targetName} (?)`,
            path: '',
            linkCount: 0,
            nodeType: null,
            size: 4 * settings.nodeScale,
            color: themeColors.deadNode,
            type: 'circle',
            x: saved?.x ?? sp.x,
            y: saved?.y ?? sp.y,
            ...(warm && saved?.fx != null ? { fx: saved.fx, fy: saved.fy } : {}),
          });
        } catch { /* node already exists */ }
      });
    }

    // ── Apply filter settings ──
    graph.forEachNode((key, attrs) => {
      const isDead = key.startsWith('__dead__');
      const linkCount = (attrs.linkCount as number) ?? 0;

      // Dead link filter
      if (isDead && !settings.showDeadLinks) {
        graph.setNodeAttribute(key, 'hidden', true);
        return;
      }

      // Orphan filter (isolated nodes: no links, not dead links)
      if (!isDead && linkCount === 0 && !settings.showOrphans) {
        graph.setNodeAttribute(key, 'hidden', true);
        return;
      }

      // Type filter — only filter nodes that have an explicit type
      if (settings.visibleTypes.length > 0) {
        const rawType = attrs.nodeType as string | null;
        if (rawType && !settings.visibleTypes.includes(rawType)) {
          graph.setNodeAttribute(key, 'hidden', true);
          return;
        }
      }

      graph.setNodeAttribute(key, 'hidden', false);
    });

    // ── Node reducer for hover/select ──
    const nodeReducer = (node: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;
      const isSelected = node === selected;
      const isFocusMode = !!selected;
      const dimT = focusDimRef.current;
      const hoverT = hoverDimRef.current;
      const baseSize = (data.size as number) ?? 6;

      if (!focusNode) {
        return { ...data, color: (data.color as string) ?? themeColors.node, size: baseSize };
      }

      const origColor = data.color as string;
      const isConnected = graph.hasEdge(focusNode, node) || graph.hasEdge(node, focusNode);

      if (node === focusNode) {
        const targetScale = isSelected ? 1.4 : 1.2;
        const t = isFocusMode ? dimT : hoverT;
        const currentScale = 1 + (targetScale - 1) * t;
        return {
          ...data,
          size: baseSize * currentScale,
          color: isSelected
            ? interpolateColor(origColor, themeColors.selected, t)
            : interpolateColor(origColor, themeColors.hover, t),
          forceLabel: true,
        };
      }

      if (isConnected) {
        if (isFocusMode) {
          return { ...data, color: origColor, size: baseSize };
        }
        const connectedScale = 1 - hoverT * 0.15;
        return { ...data, color: origColor, size: baseSize * connectedScale };
      }

      if (isFocusMode) {
        const s = baseSize * (1 - dimT * FOCUS_DIM_SIZE_RATIO);
        return { ...data, color: interpolateColor(origColor, themeColors.dimmed, dimT), size: s };
      }
      const s = baseSize * (1 - hoverT * HOVER_DIM_SIZE_RATIO);
      return { ...data, color: interpolateColor(origColor, themeColors.dimmed, hoverT * HOVER_DIM_COLOR_RATIO), size: s };
    };

    // ── Edge reducer (animated with hoverT/dimT) ──
    const edgeReducer = (edge: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;
      const hoverT = hoverDimRef.current;
      const dimT = focusDimRef.current;

      if (!focusNode) {
        return { ...data, color: themeColors.edge, size: settings.edgeWidth };
      }

      const source = graph.source(edge);
      const target = graph.target(edge);
      const isConnected = source === focusNode || target === focusNode;
      const origColor = (data.color as string) || themeColors.edge;

      if (isConnected) {
        if (selected) {
          return {
            ...data,
            color: interpolateColor(origColor, themeColors.edgeSelected, dimT),
            size: settings.edgeWidth + (2 - settings.edgeWidth) * dimT,
            // 高亮边置顶，避免被后添加的淡化边遮挡
            zIndex: 1,
          };
        }
        return {
          ...data,
          color: interpolateColor(origColor, themeColors.edgeHover, hoverT),
          size: settings.edgeWidth + (1.5 - settings.edgeWidth) * hoverT,
          zIndex: 1,
        };
      }
      const t = selected ? dimT : hoverT;
      return {
        ...data,
        // 非关联边向背景色褪色，仅留淡痕（淡化但不融成完全不可见）
        color: interpolateColor(origColor, themeColors.bg, t * EDGE_DIM_COLOR_RATIO),
        size: settings.edgeWidth * (1 - t * EDGE_DIM_SIZE_RATIO),
        zIndex: 0,
      };
    };

    // ── Create Sigma ──
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: true,
      nodeProgramClasses: { circle: NodeCircleProgram },
      defaultEdgeColor: themeColors.edge,
      defaultEdgeType: 'line',
      edgeLabelSize: 10,
      labelColor: { color: themeColors.label },
      labelSize: 14,
      labelFont: 'Inter, PingFang SC, -apple-system, sans-serif',
      itemSizesReference: 'positions',
      zoomingRatio: 1.08, // 小步长缩放，避免一滚跳太远
      // 标签按缩放级别自动显隐 — 缩小时只显示大节点标签
      labelRenderedSizeThreshold: 16,
      labelDensity: 0.25,
      defaultNodeColor: themeColors.node,
      renderEdgeLabels: false,
      // 相机移动（平移/缩放）时标签自动隐藏、静止后恢复——sigma 原生支持。
      // 注意：sigma 3.0.3 默认 hideLabelsOnMove=false，此处为显式启用（必需，非冗余），
      // 避免移动中全量重测标签文字 + 纹理上传（低端设备渲染大头）。
      // 节点拖拽的标签降级在 handleMouseMove/handleMouseUp 中手动切换（拖拽锁相机，此开关不触发）。
      hideLabelsOnMove: true,
      autoRescale: true,
      autoCenter: true,
      minCameraRatio: 0.2,
      maxCameraRatio: 80,
      stagePadding: 80,
      // 开启 z-index 排序：高亮边（zIndex:1）绘制在淡化边（zIndex:0）之上，
      // 避免选中节点的关联边被不相关边遮挡
      zIndex: true,
      nodeReducer,
      edgeReducer,
    });

    sigmaRef.current = renderer;
    setSigmaInstance(renderer);
    // 暴露给 E2E：WebGL 无 DOM 可查，测试通过 window.__sigma/__graph 检查
    // 相机/节点渲染状态（如 graph-search.spec.ts 验证搜索后节点在视口内）。
    (window as unknown as Record<string, unknown>).__sigma = renderer;
    (window as unknown as Record<string, unknown>).__graph = graph;
    // Set up camera inertia (smooth zoom/pan with decay)
    const cleanupInertia = setupCameraInertia(renderer);

    renderer.refresh();
    // 初始不自动跑力模拟（避免入场抖动）；布局由各路径显式驱动：暖=缓存终态、冷小图=同步预结算、冷大图=ML。
    simulation.init(graph, renderer, () => renderer.refresh(), false);

    // Apply stored force params to the fresh simulation
    const { forces, edgeWidth } = settings;
    simulation.setForceParam('centerStrength', forces.centerStrength);
    simulation.setForceParam('repelStrength', forces.repelStrength);
    simulation.setForceParam('linkStrength', forces.linkStrength);
    simulation.setForceParam('linkDistance', forces.linkDistance);

    // Apply edge width
    if (edgeWidth !== 0.8) {
      graph.forEachEdge((key) => {
        graph.setEdgeAttribute(key, 'size', edgeWidth);
      });
    }

    // ── 入场编排 ──
    // 把相机 fit 到给定包围盒（customBBox 冻结 → 同时是拖拽稳定所需的冻结基准）。
    const fitToBounds = (bounds: { x: [number, number]; y: [number, number] }) => {
      renderer.setCustomBBox(bounds);
      renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
    };
    // 把一组坐标写进 graph（withFx：是否一并写 fx/fy，没有则清除）。
    const writePositions = (
      m: Map<string, Pos>,
      withFx: boolean,
    ) => {
      graph.forEachNode((k) => {
        const p = m.get(k);
        if (!p) return;
        graph.setNodeAttribute(k, 'x', p.x);
        graph.setNodeAttribute(k, 'y', p.y);
        if (withFx && p.fx != null && p.fy != null) {
          graph.setNodeAttribute(k, 'fx', p.fx);
          graph.setNodeAttribute(k, 'fy', p.fy);
        } else {
          graph.removeNodeAttribute(k, 'fx');
          graph.removeNodeAttribute(k, 'fy');
        }
      });
    };
    // 揭示动画。soft=暖加载快速淡入(无 bloom)；bloom=冷加载 聚团→终态 绽放+去模糊+淡入。
    // bloom 起点写入时画布仍重模糊，故"终态→聚团"的瞬间跳变不可见；随后去模糊与绽放同步进行。
    const reveal = (
      mode: 'bloom' | 'soft',
      from: Map<string, Pos> | null,
      to: Map<string, Pos>,
      bounds: { x: [number, number]; y: [number, number] },
    ) => {
      cancelAnimationFrame(introRafRef.current);
      introRafRef.current = 0;
      if (mode === 'soft') {
        writePositions(to, true);
        fitToBounds(bounds);
        renderer.refresh();
        simulation.syncToGraph(); // sim 内部同步到终态并停，防首次拖拽 1 帧抖动
        requestAnimationFrame(() => containerRef.current?.classList.remove('graph-intro-soft'));
        setTimeout(() => { (window as unknown as Record<string, unknown>).__graphIntroDone = true; }, INTRO_FADE_MS);
        return;
      }
      // 绽放期隐藏标签 + 跳过索引重建：标签文字测量 + 标签网格重建是逐帧开销大头，藏掉 +
      // skipIndexation 让绽放跑满帧率；绽放结束一次性恢复标签（一次出现，优于逐帧布局）。
      renderer.setSetting('renderLabels', false);
      writePositions(from!, false); // 跳回聚团（此刻画布透明+缩放，不可见）
      fitToBounds(bounds);          // 归一化冻结到终态 → 绽放"中心→铺开"才可见
      renderer.refresh({ skipIndexation: true });
      requestAnimationFrame(() => containerRef.current?.classList.remove('graph-intro'));
      // 径向错峰：按终态到质心的归一化半径给每节点延迟 → 由中心向外涟漪绽放（更"活"）。
      let bcx = 0, bcy = 0, bn = 0;
      to.forEach((p) => { bcx += p.x; bcy += p.y; bn++; });
      if (bn > 0) { bcx /= bn; bcy /= bn; }
      let maxD = 1;
      to.forEach((p) => { const d = Math.hypot(p.x - bcx, p.y - bcy); if (d > maxD) maxD = d; });
      const t0 = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - t0) / INTRO_BLOOM_MS);
        graph.forEachNode((k) => {
          const a = from!.get(k);
          const b = to.get(k);
          if (!a || !b) return;
          const rn = Math.hypot(b.x - bcx, b.y - bcy) / maxD; // 0=中心 1=最外
          const lt = Math.max(0, Math.min(1, t * (1 + INTRO_STAGGER) - rn * INTRO_STAGGER));
          const e = easeOutCubic(lt);
          graph.setNodeAttribute(k, 'x', a.x + (b.x - a.x) * e);
          graph.setNodeAttribute(k, 'y', a.y + (b.y - a.y) * e);
        });
        renderer.refresh({ skipIndexation: true });
        if (t < 1) {
          introRafRef.current = requestAnimationFrame(step);
        } else {
          writePositions(to, true);
          renderer.setSetting('renderLabels', true); // 绽放结束恢复标签
          renderer.refresh();
          simulation.syncToGraph(); // sim 内部=终态且停，供后续拖拽
          introRafRef.current = 0; // 标记 bloom 已结束，避免后续 mousedown 误触发取消逻辑
          (window as unknown as Record<string, unknown>).__graphIntroDone = true;
        }
      };
      introRafRef.current = requestAnimationFrame(step);
    };

    // ML 完成回调（放在 init effect 内以闭包访问 reveal/clusterStart 等）。
    // 冷加载首次：bloom 聚团→终态（worker 已把终态写入 graph，含孤立平铺）；
    // 重布局：节点已被 worker 渐进 morph 到终态，仅做一次平滑相机 fit（无节点 snap）。
    const onMlDone = () => {
      const g = graphRef.current;
      const r = sigmaRef.current;
      if (!g || !r) return;
      simulationRef.current.setCentroidLock(null);
      if (pendingColdRef.current) {
        const finals = toPosMap(g);
        const bounds = computeBounds(g);
        if (bounds) reveal('bloom', clusterStartRef.current, finals, bounds);
        pendingColdRef.current = false;
      } else {
        const bounds = computeBounds(g);
        if (bounds) {
          r.setCustomBBox(bounds);
          r.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: 500 });
        }
      }
    };
    window.addEventListener('graph-ml-done', onMlDone);

    if (warm) {
      const bounds = computeBounds(graph);
      if (bounds) reveal('soft', null, savedPositions!, bounds);
    } else if (graph.order < 50) {
      // 冷小图：同步预结算拿终态（消除"圆形中间态"），再 bloom
      simulation.preSettle(INTRO_PRESETTLE_TICKS);
      // 孤立节点平铺到外围圆环（确定性）：否则弱向心下它们被力布局甩成离群点 → 撑大包围盒 → 坏视角。
      tileIsolatedNodes(graph);
      const finals = toPosMap(graph);
      const bounds = computeBounds(graph);
      if (bounds) reveal('bloom', clusterStart, finals, bounds);
    } else {
      // 冷大图：占位包围盒 + 相机 fit，聚团在重模糊下显示；ML 完成后在 graph-ml-done 里 bloom
      fitToBounds({ x: [-guessR, guessR], y: [-guessR, guessR] });
      renderer.refresh();
      setTimeout(() => {
        simulation.multiLevel?.({ onProgress: mlOnProgressRef.current! });
      }, 50);
    }

    // ── Hover enter/leave with fade animation ──
    renderer.on('enterNode', (e: { node: string }) => {
      if (draggedNode) return;
      // 选中态下不触发 hover：避免 hover 高亮与点击聚焦并存/抢占
      if (selectedNodeRef.current) return;
      if (hoverLingerTimerRef.current) {
        clearTimeout(hoverLingerTimerRef.current);
        hoverLingerTimerRef.current = null;
      }
      hoveredNodeRef.current = e.node;
      startHoverAnimation(1, 180);
    });

    renderer.on('leaveNode', (e: { node: string }) => {
      if (draggedNode) return;
      if (selectedNodeRef.current) return;
      const leavingNode = e.node;
      if (hoverLingerTimerRef.current) clearTimeout(hoverLingerTimerRef.current);
      hoverLingerTimerRef.current = setTimeout(() => {
        // Start fade-out before clearing ref, so reducer still sees focusNode
        startHoverAnimation(0, 250);
        setTimeout(() => {
          if (hoveredNodeRef.current === leavingNode) {
            hoveredNodeRef.current = null;
            renderer.refresh();
          }
        }, 250);
      }, 150);
    });

    // ── Hover dim animation (RAF loop) ──
    let hoverAnimFrame = 0;

    function smoothstep(t: number) { return t * t * (3 - 2 * t); }

    function startHoverAnimation(target: number, durationMs: number) {
      cancelAnimationFrame(hoverAnimFrame);
      const startVal = hoverDimRef.current;
      const delta = target - startVal;
      const startTime = performance.now();
      if (Math.abs(delta) < 0.01) { hoverDimRef.current = target; return; }
      function tick() {
        const elapsed = performance.now() - startTime;
        const t = Math.min(1, elapsed / durationMs);
        hoverDimRef.current = startVal + delta * smoothstep(t);
        if (t < 1) hoverAnimFrame = requestAnimationFrame(tick);
        renderer.refresh();
      }
      requestAnimationFrame(tick);
    }

    // ── Focus dim animation (RAF loop) ──
    let dimAnimFrame = 0;

    function startDimAnimation(target: number, durationMs: number) {
      cancelAnimationFrame(dimAnimFrame);
      const startVal = focusDimRef.current;
      const delta = target - startVal;
      const startTime = performance.now();
      if (Math.abs(delta) < 0.01) { focusDimRef.current = target; return; }
      function tick() {
        const elapsed = performance.now() - startTime;
        const t = Math.min(1, elapsed / durationMs);
        focusDimRef.current = startVal + delta * smoothstep(t);
        if (t < 1) dimAnimFrame = requestAnimationFrame(tick);
        renderer.refresh();
      }
      requestAnimationFrame(tick);
    }

    // 暴露 dim 动画给组件作用域（搜索选中节点时调用）
    startDimAnimRef.current = startDimAnimation;

    // ── Click & Drag events ──
    // 使用原生鼠标事件处理节点交互；空白区域交给 Sigma 内置画布拖拽/缩放
    let draggedNode: string | null = null;
    let isDragging = false;
    let lastClickTime = 0;
    let lastClickNode: string | null = null;
    const DRAG_THRESHOLD = 4;
    let dragStartMouse = { x: 0, y: 0 };
    const container = containerRef.current;

    // 查找鼠标位置下的节点
    // 在 graph 坐标系中比较距离，hit radius 取节点实际 size 的 2 倍（方便点选小节点）
    const findNodeAtPosition = (mouseX: number, mouseY: number): string | null => {
      const mouseGraph = renderer.viewportToGraph({ x: mouseX, y: mouseY });
      let closestNode: string | null = null;
      let closestDist = Infinity;

      graph.forEachNode((node, attr) => {
        const nx = (attr.x as number) ?? 0;
        const ny = (attr.y as number) ?? 0;
        const size = (attr.size as number) ?? 6;
        const dist = Math.sqrt((nx - mouseGraph.x) ** 2 + (ny - mouseGraph.y) ** 2);
        // hit area = 节点实际半径 × 2，最小 3 graph units
        const hitRadius = Math.max(size * 2, 3);
        if (dist < hitRadius && dist < closestDist) {
          closestDist = dist;
          closestNode = node;
        }
      });

      return closestNode;
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const node = findNodeAtPosition(mouseX, mouseY);

      if (node) {
        // 命中节点：接管拖拽，阻止 Sigma 处理此事件
        draggedNode = node;
        isDragging = false;
        dragStartMouse = { x: mouseX, y: mouseY };
        // 若入场 bloom 仍在跑，立即取消并把当前坐标同步进 sim，避免 bloom 与拖拽争抢写坐标
        if (introRafRef.current) {
          cancelAnimationFrame(introRafRef.current);
          introRafRef.current = 0;
          containerRef.current?.classList.remove('graph-intro', 'graph-intro-soft');
          simulation.syncToGraph();
          (window as unknown as Record<string, unknown>).__graphIntroDone = true;
        }
        // 路线 B：解锁所有节点（含孤立）参与拖拽期流体。孤立不再硬钉——改由「中等牵引绳 + 磁铁场」
        // 约束：磁铁近时能被推开一点、绳子拽住防飞散（用户要求孤立节点也要有反应）。被拖节点随后重锁。
        graph.forEachNode((k) => {
          graph.removeNodeAttribute(k, 'fx');
          graph.removeNodeAttribute(k, 'fy');
          const h = simulation.getNode(k);
          if (h) { h.fx = null; h.fy = null; }
        });
        // Lock 被拖节点 position so collision doesn't push it away during drag
        const d3Node = simulation.getNode(node);
        if (d3Node) {
          const attrs = graph.getNodeAttributes(node);
          d3Node.fx = (attrs.x as number) ?? 0;
          d3Node.fy = (attrs.y as number) ?? 0;
        }
        // 拖拽全程锁死相机视角：用 setCustomBBox 把归一化包围盒冻结，使 sigma 每次 process()
        // 不再用实时包围盒重算 normalizationFunction + getGraphDimensions（否则相机状态没变、
        // 映射基准在变 → 逐帧漂移）。
        // 关键——按下瞬间绝不能「重捕获」基准：松手后 customBBox 持久保留，空闲时相机是按
        // 上一次冻结基准 E_prev 取景的，而实时包围盒已随沉降变成 E_idle（两者不等）。若此处
        // setCustomBBox(null)+setCustomBBox(getBBox()) 把基准从 E_prev 切成 E_idle，相机 x/y/
        // ratio 没动但映射变了 → 按下那一帧整张图「瞬间偏移」（第二次起每次拖拽都跳的根因）。
        // 故只冻结到「相机当前正在用的基准」：已有冻结则保持不动（它本就是当前视图基准，零
        // 跳变）；仅当尚无冻结（首次交互）才捕获当前实时包围盒（此时它==归一化基准，亦无跳变）。
        // 冻结保留到松手之后（对齐 Obsidian：拖拽/单击都不动相机），仅 ML 重布局、筛选变化、
        // 图谱重建等数据变化点清除。不再 toggle autoRescale——customBBox 设置时它被完全覆盖，
        // 且留着 true 能保持 stagePadding 恒定。
        if (!renderer.getCustomBBox()) {
          renderer.setCustomBBox(renderer.getBBox());
        }
        // 注意：拖拽流体（beginDrag：磁铁/拴绳/质心锁）**不在 mousedown 安装**——单击选中不应触发
        // 任何全局力（否则每次点击图都抖一下，§12.2 卡顿/抖动）。mousedown 只做：解锁全部 + 锁定
        // 被拖节点 + 冻结相机；真正装流体 + wake 延后到 handleMouseMove 超过 DRAG_THRESHOLD 处。
        // 因此单击（未过阈值）路径：mouseup 时 selectedNode 选中 + freezeAllNow 定格，全程无运动。
        e.preventDefault();
        e.stopPropagation();
      } else {
        // 空白区域：取消选中并解除 fx/fy 锁定
        draggedNode = null;
        if (selectedNodeRef.current) {
          const prev = selectedNodeRef.current;
          // 孤立节点保持固定：取消选中不解锁，否则外围圆环被破坏
          if (!(graph.hasNode(prev) && graph.degree(prev) === 0)) {
            graph.removeNodeAttribute(prev, 'fx');
            graph.removeNodeAttribute(prev, 'fy');
            // Also release d3 lock if any
            const d3Node = simulation.getNode(prev);
            if (d3Node) {
              d3Node.fx = null;
              d3Node.fy = null;
            }
          }
          // Start restore animation before clearing ref
          startDimAnimation(0, 200);
          setTimeout(() => {
            if (selectedNodeRef.current === prev) {
              selectedNodeRef.current = null;
              renderer.refresh();
            }
          }, 200);
        }
        // 不阻止默认行为 → Sigma 正常处理画布拖拽
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!draggedNode) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const moveDist = Math.sqrt(
        (mouseX - dragStartMouse.x) ** 2 + (mouseY - dragStartMouse.y) ** 2,
      );
      if (!isDragging && moveDist > DRAG_THRESHOLD) {
        isDragging = true;
        // 移动时降质（见 docs/superpowers/specs/2026-07-25-graph-motion-quality-design.md）：
        // 1) 隐藏标签——每帧渲染大头（文字测量 + 纹理上传）；
        // 2) collide 迭代 3→1——每 tick 最大 CPU 成本。
        // 松手立即恢复。超过阈值才降质，避免单击选中时标签闪烁。
        renderer.setSetting('renderLabels', false);
        simulation.setMotionMode(true);
        interactingRef.current = true;
        // 超过阈值才装拖拽流体（路线 B 局部流体：磁铁/拴绳/质心锁）+ 唤醒物理引擎。
        // 延后到此刻而非 mousedown：单击选中（未过阈值）不触发任何全局力 → 无点击抖动。
        // 半径按屏幕像素定义（符合视觉直觉），用冻结映射换算成图坐标（拖拽期映射恒定，
        // 一次换算全程有效）；平移轴由质心锁保证（beginDrag 内部装 forceCenter 按下瞬间均值）。
        const gA = renderer.viewportToGraph({ x: 0, y: 0 });
        const gB = renderer.viewportToGraph({ x: 100, y: 0 });
        const graphUnitsPer100Px = Math.hypot(gB.x - gA.x, gB.y - gA.y) || 1;
        const rInner = (DRAG_FLOW_INNER_PX * graphUnitsPer100Px) / 100;
        const rOuter = (DRAG_FLOW_OUTER_PX * graphUnitsPer100Px) / 100;
        const rMagnet = (DRAG_MAGNET_PX * graphUnitsPer100Px) / 100;
        simulation.beginDrag(draggedNode, rInner, rOuter, rMagnet);
        simulation.wake(0.3);
      }

      if (isDragging) {
        const graphPos = renderer.viewportToGraph({ x: mouseX, y: mouseY });
        const d3Node = simulation.getNode(draggedNode);
        if (d3Node) {
          // Update d3 node position + lock
          d3Node.x = graphPos.x;
          d3Node.y = graphPos.y;
          d3Node.fx = graphPos.x;
          d3Node.fy = graphPos.y;
          // Write to graphology so sigma renders it
          graph.setNodeAttribute(draggedNode, 'x', graphPos.x);
          graph.setNodeAttribute(draggedNode, 'y', graphPos.y);
        }
        // 活跃模拟：让关联节点被边力牵引跟随、其他节点流动填补拖拽产生的空白
        // （对齐 Obsidian「液体填补」）。alpha 0.3 衰减约百 tick，持续流动。
        simulation.wake(0.3);
        renderer.refresh();
      }
    };

    // 直接操纵模型：松手/点击后把所有可见节点「就地钉死」(fx/fy=当前坐标) 并停 tick → 零后续运动。
    // 不做沉降/回弹/重铺（那些都会造成"松手后还在动"的延迟动画，用户明确不要）。
    // 关键：这里必须用 halt()（非破坏性，仅停 tick）而非 stop()——stop() 会 terminate worker + 清空
    // 节点句柄 + 把 modeRef 置 null，导致「第一次松手后再拖，getNode 全返回 undefined → 被拖节点
    // 坐标写入被 if(d3Node) 跳过 → 拖不动」，beginDrag/wake 也因 sim/mode 为 null 而失效。
    const freezeAllNow = () => {
      graph.forEachNode((k, a) => {
        if (a.hidden) return;
        const x = (a.x as number) ?? 0;
        const y = (a.y as number) ?? 0;
        graph.setNodeAttribute(k, 'fx', x);
        graph.setNodeAttribute(k, 'fy', y);
        const h = simulation.getNode(k);
        if (h) { h.fx = x; h.fy = y; }
      });
      simulation.halt();
      // 单点不需要质心锁：清掉 mousedown beginDrag 装的锁，防残留的"幽灵力"在
      // 之后调力参数滑块 → wake 时把整簇拉到旧按下质心（§6.3 警告的污染路径）。
      simulation.setCentroidLock(null);
    };

    const handleMouseUp = (_e: MouseEvent) => {
      if (!draggedNode) {
        draggedNode = null;
        isDragging = false;
        return;
      }

      const node = draggedNode;
      const wasDragging = isDragging;

      if (wasDragging) {
        // 放开被拖节点：松手后靠被拉长的边做自然回弹（=用户要的"回弹效果"）。
        // 先前"钉死在落点"会让被拖节点弹不回 → 回弹消失；邻居的拴绳也在 endDrag 撤掉，一起回弹。
        const dn = simulation.getNode(node);
        if (dn) { dn.fx = null; dn.fy = null; }
        graph.removeNodeAttribute(node, 'fx');
        graph.removeNodeAttribute(node, 'fy');
        // 重铺孤立节点到外围圆环，并同步钉进 sim（fx/fy）→ 回弹期不飞散、圆环不丢。
        tileIsolatedNodes(graph);
        graph.forEachNode((k, a) => {
          if (a.hidden || graph.degree(k) !== 0) return;
          const h = simulation.getNode(k);
          if (!h) return;
          const fx = (a.fx as number) ?? (a.x as number) ?? 0;
          const fy = (a.fy as number) ?? (a.y as number) ?? 0;
          h.x = fx; h.y = fy; h.fx = fx; h.fy = fy;
        });
        // endDrag 撤磁铁 + 保留拴绳(回弹弹簧) + 回弹慢放档；向心保持开启，与拴绳一起稳住整簇/孤立。
        // 沉降接近静止时 onTick 自动撤拴绳（alpha≈0 不产生位移）→ 布局随后稳定、无延迟动画。
        simulation.endDrag();
        simulation.wake(0.3);
        // 恢复降质 + 重绘；interactingRef 先置 false 让 afterRender 能重绘 minimap（回弹过程可见）
        renderer.setSetting('renderLabels', true);
        simulation.setMotionMode(false);
        interactingRef.current = false;
        renderer.refresh();
        // 相机冻结保留（customBBox 不清除），仅 ML/筛选/重建才清除。
      } else {
        // 单击未拖拽：mousedown 解锁了全部 + 装了磁铁/拴绳，此处撤掉并就地钉死 + 停模拟，
        // 使点击后也无任何残留运动。相机冻结不清除（防点击跳变）。
        simulation.endDrag();
        freezeAllNow();
        // 单击锁定聚焦（探索连接）；350ms 内再次单击同一节点 → 双击导航
        const now = Date.now();
        const isDblClick = node === lastClickNode && now - lastClickTime < 350;

        if (isDblClick) {
          lastClickTime = 0;
          lastClickNode = null;
          const path = graph.getNodeAttribute(node, 'path') as string | undefined;
          if (path) {
            navigate('/knowledge', { state: { openFile: path, vaultId: activeVaultId } });
          }
        } else {
          selectedNodeRef.current = node;
          lastClickTime = now;
          lastClickNode = node;
          focusDimRef.current = 0;
          startDimAnimation(1, 200);
        }
      }

      draggedNode = null;
      isDragging = false;
    };

    container.addEventListener('mousedown', handleMouseDown, { capture: true });
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      // Save positions before teardown so they persist across rebuilds (theme change, etc.)
      const positions = new Map<string, { x: number; y: number; fx?: number; fy?: number }>();
      if (graphRef.current) {
        graphRef.current.forEachNode((key, attrs) => {
          const entry: { x: number; y: number; fx?: number; fy?: number } = {
            x: (attrs.x as number) ?? 0,
            y: (attrs.y as number) ?? 0,
          };
          const fx = attrs.fx as number | undefined;
          const fy = attrs.fy as number | undefined;
          if (fx != null) entry.fx = fx;
          if (fy != null) entry.fy = fy;
          positions.set(key, entry);
        });
      }
      // 写入模块级位置缓存：导航回来/同挂载重建即"暖加载"（快速淡入、不重 bloom）。
      // 仅当本次入场已完成(__graphIntroDone)才缓存——否则(如 React StrictMode 被中止的首挂载，
      // graph 还停在入场聚团)会把"聚团"误存为终态，导致下次"暖加载"显示未展开的聚团(节点被放大成巨球)。
      if (activeVaultId && (window as unknown as Record<string, unknown>).__graphIntroDone) {
        writePositionsCache(activeVaultId, positions); // 模块缓存 + sessionStorage（刷新可恢复）
      }

      cancelAnimationFrame(introRafRef.current);
      containerRef.current?.classList.remove('graph-intro', 'graph-intro-soft');
      window.removeEventListener('graph-ml-done', onMlDone);
      simulation.stop();
      cleanupInertia();
      startDimAnimRef.current = null;
      cancelAnimationFrame(hoverAnimFrame);
      if (hoverLingerTimerRef.current) {
        clearTimeout(hoverLingerTimerRef.current);
        hoverLingerTimerRef.current = null;
      }
      container.removeEventListener('mousedown', handleMouseDown, { capture: true });
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      // 防拖拽越阈值后、mouseup 前 effect 重建（graphData refetch/切主题等）导致
      // interactingRef 残留 true、新 Minimap 的 scheduleDraw 被永久跳过
      interactingRef.current = false;

      if (sigmaRef.current) {
        sigmaRef.current.kill();
        sigmaRef.current = null;
      }
      setSigmaInstance(null);
      graphRef.current = null;
      hoveredNodeRef.current = null;
      selectedNodeRef.current = null;
    };
  }, [graphData, navigate, settings.theme, settings.nodeScale]);

  // ── Live filter updates (no rebuild needed) ──
  useEffect(() => {
    const graph = graphRef.current;
    const renderer = sigmaRef.current;
    if (!graph || !renderer) return;

    graph.forEachNode((key, attrs) => {
      const isDead = key.startsWith('__dead__');
      const linkCount = (attrs.linkCount as number) ?? 0;

      // Dead link filter
      if (isDead && !settings.showDeadLinks) {
        graph.setNodeAttribute(key, 'hidden', true);
        return;
      }

      // Orphan filter (isolated nodes: no links, not dead links)
      if (!isDead && linkCount === 0 && !settings.showOrphans) {
        graph.setNodeAttribute(key, 'hidden', true);
        return;
      }

      // Type filter — only filter nodes that have an explicit type
      if (settings.visibleTypes.length > 0) {
        const rawType = attrs.nodeType as string | null;
        if (rawType && !settings.visibleTypes.includes(rawType)) {
          graph.setNodeAttribute(key, 'hidden', true);
          return;
        }
      }

      graph.setNodeAttribute(key, 'hidden', false);
    });

    // 筛选改变了可见节点集合 → 清除拖拽遗留的冻结包围盒，让相机重新 fit 到可见内容
    // （否则拖拽后 customBBox 仍冻结、筛选不 refit，图谱缩在旧框里）。同时清除可能残留的
    // 质心锁（数据变化点不应保留拖拽期的质心约束）。
    renderer.setCustomBBox(null);
    simulationRef.current.setCentroidLock(null);
    renderer.refresh();
  }, [settings.showOrphans, settings.showDeadLinks, settings.visibleTypes]);

  // ── Live edge width update (no rebuild needed) ──
  useEffect(() => {
    const graph = graphRef.current;
    const renderer = sigmaRef.current;
    if (!graph || !renderer) return;

    graph.forEachEdge((key) => {
      graph.setEdgeAttribute(key, 'size', settings.edgeWidth);
    });
    renderer.refresh();
  }, [settings.edgeWidth]);

  // ── Node search (Ctrl/Cmd+F) ──
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || !graphData) return [];
    return graphData.nodes
      .filter((n) => n.label.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      .slice(0, 20);
  }, [searchQuery, graphData]);

  // 重置高亮索引当 matches 变化
  useEffect(() => {
    setSearchActiveIndex(0);
  }, [searchMatches]);

  const zoomToNode = useCallback((nodeKey: string) => {
    const sigma = sigmaRef.current;
    const graph = graphRef.current;
    if (!sigma || !graph || !graph.hasNode(nodeKey)) return;
    const attrs = graph.getNodeAttributes(nodeKey);
    const x = (attrs.x as number) ?? 0;
    const y = (attrs.y as number) ?? 0;
    const camera = sigma.getCamera();

    // 节点当前视口位置（基于当前相机，未动）
    const vp = sigma.graphToViewport({ x, y });
    const w = sigma.getContainer().clientWidth;
    const h = sigma.getContainer().clientHeight;
    // 视口内缩一圈作为「舒适可视区」：节点已在其中 → 只高亮不飞相机，避免晃动视角；
    // 在视口外或贴边 → 才飞相机把它拉到中心。
    const marginX = w * 0.08;
    const marginY = h * 0.08;
    const inView = vp.x >= marginX && vp.x <= w - marginX && vp.y >= marginY && vp.y <= h - marginY;

    if (!inView) {
      // 飞到节点：pan 到节点位置 + 缩放到能看清节点和邻居的级别
      const targetRatio = Math.max(2.5, Math.min(camera.ratio, 4));
      // Sigma 相机工作在归一化（framed）坐标空间：节点位置经 normalizationFunction
      // 归一化到以 0.5 为中心、跨度约 1 的区间，相机的 x/y 也在这个空间里。
      // attrs.x/y 是原始图坐标，不能直接喂给 camera.animate——否则相机会把原始值
      // 当成归一化值，飞到 extent×ratio 远处，整张图渲染空白、交互失效。
      // viewportToFramedGraph(graphToViewport(p)) 等价于 normalizationFunction(p)（公开 API）。
      const framed = sigma.viewportToFramedGraph(vp);
      camera.animate({ x: framed.x, y: framed.y, ratio: targetRatio }, { duration: 600 });
    }

    // 选中高亮（带淡入动画）——无论是否飞相机都做
    selectedNodeRef.current = nodeKey;
    focusDimRef.current = 0;
    startDimAnimRef.current?.(1, 200);
    sigma.refresh();
  }, []);

  const commitSearchResult = useCallback((nodeKey: string) => {
    setSearchOpen(false);
    setSearchQuery('');
    zoomToNode(nodeKey);
  }, [zoomToNode]);

  // Ctrl/Cmd+F 打开搜索；Esc 关闭
  useEffect(() => {
    if (!graphData) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [graphData, searchOpen]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchMatches.length > 0) {
      e.preventDefault();
      const match = searchMatches[Math.min(searchActiveIndex, searchMatches.length - 1)];
      commitSearchResult(match.key);
    } else if (e.key === 'ArrowDown' && searchMatches.length > 0) {
      e.preventDefault();
      setSearchActiveIndex((i) => (i + 1) % searchMatches.length);
    } else if (e.key === 'ArrowUp' && searchMatches.length > 0) {
      e.preventDefault();
      setSearchActiveIndex((i) => (i - 1 + searchMatches.length) % searchMatches.length);
    } else if (e.key === 'Escape') {
      setSearchOpen(false);
    }
  };

  // 注：graph-ml-done 的处理已搬进初始化 effect 闭包（需要 reveal/clusterStart 等闭包变量），
  // 冷加载首次走 bloom、重布局走平滑相机 fit。见初始化 effect 内的 onMlDone。

  const nodeCount = graphData?.nodes.length ?? 0;
  const edgeCount = graphData?.edges.length ?? 0;

  if (!activeVaultId) {
    return (
      <div className="graph-page">
        <div className="graph-empty">
          <div className="graph-empty__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2" />
              <circle cx="18" cy="6" r="2" />
              <circle cx="12" cy="18" r="2" />
              <line x1="7.5" y1="7.5" x2="10.5" y2="16.5" />
              <line x1="16.5" y1="7.5" x2="13.5" y2="16.5" />
              <line x1="6" y1="8" x2="18" y2="8" />
            </svg>
          </div>
          <p>{t('graph.noVault')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-page">
      <div className="graph-topbar">
        <div className="graph-topbar__left">
          <h2 className="graph-topbar__title">{t('graph.title')}</h2>
        </div>
        <div className="graph-topbar__right">
          {graphData && !loading && (
            <span className="graph-stat">{t('graph.nodes', { count: nodeCount })}</span>
          )}
          {graphData && !loading && (
            <span className="graph-stat graph-stat--edges">{t('graph.edges', { count: edgeCount })}</span>
          )}
          {graphData && graphData.deadLinks && graphData.deadLinks.length > 0 && (
            <span className="graph-stat graph-stat--deadlink" title={`${graphData.deadLinks.length} dead link(s)`}>
              死链接 {graphData.deadLinks.length}
            </span>
          )}
          <button
            className={`graph-settings-btn ${showSettings ? 'is-active' : ''}`}
            onClick={() => setShowSettings(!showSettings)}
            title="图谱设置"
          >
            ⚙
          </button>
        </div>
      </div>

      <div className="graph-canvas">
        {loading && (
          <div className="graph-loading">
            <div className="graph-loading__spinner" />
            <p>{t('graph.loading')}</p>
          </div>
        )}

        {error && (
          <div className="graph-error">
            <p>{error}</p>
          </div>
        )}

        {!loading && !error && graphData && graphData.nodes.length === 0 && (
          <div className="graph-empty">
            <p>{t('graph.empty')}</p>
          </div>
        )}

        <div ref={containerRef} className="graph-sigma" />

        {sigmaInstance && <Minimap sigma={sigmaInstance} isInteracting={() => interactingRef.current} />}

        {/* 节点搜索浮层（Ctrl/Cmd+F 唤起） */}
        {searchOpen && (
          <div className="graph-search">
            <div className="graph-search__box">
              <svg className="graph-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="16.5" y1="16.5" x2="21" y2="21" />
              </svg>
              <input
                ref={searchInputRef}
                className="graph-search__input"
                placeholder="搜索节点…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                data-testid="graph-search-input"
              />
              <button
                className="graph-search__close"
                onClick={() => setSearchOpen(false)}
                title="关闭 (Esc)"
              >
                ✕
              </button>
            </div>
            {searchQuery.trim() && (
              <div className="graph-search__results" data-testid="graph-search-results">
                {searchMatches.length === 0 ? (
                  <div className="graph-search__empty">无匹配节点</div>
                ) : (
                  searchMatches.map((n, i) => (
                    <button
                      key={n.key}
                      className={`graph-search__result ${i === searchActiveIndex ? 'is-active' : ''}`}
                      onMouseEnter={() => setSearchActiveIndex(i)}
                      onClick={() => commitSearchResult(n.key)}
                      data-testid="graph-search-result"
                    >
                      <span className="graph-search__result-label">{n.label}</span>
                      {n.path && <span className="graph-search__result-path">{n.path}</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* 图谱设置面板 */}
        {graphData && showSettings && (
          <GraphSettingsPanel
            settings={settings}
            onUpdateSettings={updateSettings}
            onUpdateForce={(patch) => {
              updateForce(patch);
              // Apply force changes to live simulation
              for (const [name, value] of Object.entries(patch)) {
                simulation.setForceParam(name, value);
              }
            }}
            onClose={() => setShowSettings(false)}
            availableTypes={graphData.nodes
              .map(n => n.nodeType)
              .filter((t): t is string => !!t)}
            mlRunning={mlRunning}
            mlProgress={mlProgress}
            onReLayout={() => simulation.multiLevel?.({ onProgress: mlOnProgressRef.current! })}
          />
        )}
      </div>
    </div>
  );
}

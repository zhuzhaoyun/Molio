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
import { NODE_TYPE_COLORS, nodeSize, nodeColor, interpolateColor } from './graph-utils';

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
  // Persist node positions across graph rebuilds (theme change, nodeScale change).
  // fx/fy 一并保存：孤立节点的外围圆环固定、用户拖拽锁定，重建后需恢复，
  // 否则重建后这些节点会失去固定、被向心力拉回中心。
  const savedPositionsRef = useRef<
    Map<string, { x: number; y: number; fx?: number; fy?: number }>
  >(new Map());

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

    // Use saved positions from previous build (theme change, nodeScale change)
    const savedPositions = savedPositionsRef.current;

    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }

    // ── Build graph ──
    const graph = new Graph({ allowSelfLoops: false, multi: false });
    graphRef.current = graph;

    const count = graphData.nodes.length;
    // 均匀正圆形初始布局 — 替代随机散布，让图谱从干净整洁的圆形开始
    const radius = Math.sqrt(count) * 35 + 120;

    for (let i = 0; i < count; i++) {
      const n = graphData.nodes[i];
      const angle = (2 * Math.PI * i) / count;
      const saved = savedPositions.get(n.key);
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
        x: saved?.x ?? Math.cos(angle) * radius,
        y: saved?.y ?? Math.sin(angle) * radius,
        // 恢复固定位置（孤立节点圆环 / 拖拽锁定）；undefined 时不设属性
        ...(saved?.fx != null ? { fx: saved.fx, fy: saved.fy } : {}),
      });
    }

    for (const e of graphData.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      try {
        graph.addEdge(e.source, e.target, { color: themeColors.edge });
      } catch { /* Edge already exists */ }
    }

    // ── Dead link nodes ──
    // Render unresolved wikilinks as small semi-transparent nodes
    if (graphData.deadLinks && graphData.deadLinks.length > 0) {
      const seen = new Set<string>();
      for (const dl of graphData.deadLinks) {
        if (seen.has(dl.targetName)) continue;
        seen.add(dl.targetName);
        const deadKey = `__dead__${dl.targetName}`;
        const saved = savedPositions.get(deadKey);
        try {
          graph.addNode(deadKey, {
            label: `${dl.targetName} (?)`,
            path: '',
            linkCount: 0,
            nodeType: null,
            size: 4 * settings.nodeScale,
            color: themeColors.deadNode,
            type: 'circle',
            x: saved?.x ?? (Math.random() - 0.5) * radius,
            y: saved?.y ?? (Math.random() - 0.5) * radius,
            ...(saved?.fx != null ? { fx: saved.fx, fy: saved.fy } : {}),
          });
        } catch { /* node already exists */ }
      }
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
    // Start d3-force physics engine (positions sync on tick, rendering via interaction handlers)
    // onTick=refresh：让 d3 tick 中其他节点的位置变化实时重绘（拖拽流体联动）
    simulation.init(graph, renderer, () => renderer.refresh());

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

    // Auto-trigger multi-level layout if no saved positions exist (first load only)
    const hasSavedPositions = savedPositionsRef.current.size > 0;
    if (!hasSavedPositions && graph.order >= 50) {
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
        // 路线 B 局部流体：把「近/远」反应区按屏幕像素定义（符合视觉直觉），用冻结映射换算成图坐标
        // 半径（拖拽期映射恒定，一次换算全程有效），交 beginDrag 装按距离门控的拴绳 + 关闭向心。
        // 平移轴改由「远节点被拴绳钉死」保证（不再依赖拖拽期 forceCenter）；缩放/包围盒轴仍由上面
        // 的 customBBox 管。两轴各负其责 → 整簇不旋转/不平移，近处流体、邻居受牵引。
        const gA = renderer.viewportToGraph({ x: 0, y: 0 });
        const gB = renderer.viewportToGraph({ x: 100, y: 0 });
        const graphUnitsPer100Px = Math.hypot(gB.x - gA.x, gB.y - gA.y) || 1;
        const rInner = (DRAG_FLOW_INNER_PX * graphUnitsPer100Px) / 100;
        const rOuter = (DRAG_FLOW_OUTER_PX * graphUnitsPer100Px) / 100;
        const rMagnet = (DRAG_MAGNET_PX * graphUnitsPer100Px) / 100;
        simulation.beginDrag(node, rInner, rOuter, rMagnet);
        // 唤醒物理引擎——这次唤醒会持续 tick，拖拽过程中不需要重复唤醒
        simulation.wake(0.3);
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

    // 直接操纵模型：松手/点击后把所有可见节点「就地钉死」(fx/fy=当前坐标) 并停模拟 → 零后续运动。
    // 不做沉降/回弹/重铺（那些都会造成"松手后还在动"的延迟动画，用户明确不要）。
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
      simulation.stop();
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
        // 直接操纵模型：撤磁铁/拴绳 → 全部就地钉死 + 停模拟 → 松手瞬间定格，零后续运动。
        // 不重铺孤立节点（那会让孤立弹回圆环 = 延迟动画）；外围圆环随多次拖拽缓慢变化可接受，
        // 需规整可点重布局。
        simulation.endDrag();
        freezeAllNow();
        // 恢复降质 + 重绘；interactingRef 先置 false 让 afterRender 能重绘 minimap
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
          // 固定位置一并保存，重建后恢复（见 savedPositionsRef 注释）
          const fx = attrs.fx as number | undefined;
          const fy = attrs.fy as number | undefined;
          if (fx != null) entry.fx = fx;
          if (fy != null) entry.fy = fy;
          positions.set(key, entry);
        });
      }
      savedPositionsRef.current = positions;

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

  // ── Camera pulse after ML completes ──
  useEffect(() => {
    const handler = () => {
      const sigma = sigmaRef.current;
      if (!sigma) return;
      // ML 重布局大幅改变节点位置 → 清除拖拽遗留的冻结包围盒 + 质心锁，让相机 fit 到新布局
      sigma.setCustomBBox(null);
      simulationRef.current.setCentroidLock(null);
      const camera = sigma.getCamera();
      camera.animate({ ratio: camera.ratio * 1.05 }, { duration: 300 });
    };
    window.addEventListener('graph-ml-done', handler);
    return () => window.removeEventListener('graph-ml-done', handler);
  }, []);

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

/**
 * GraphPage — Obsidian-style force-directed knowledge graph.
 *
 * Visual reference: https://help.obsidian.md/Plugins/Graph+view
 * Colours match Obsidian's default dark theme CSS variables.
 */

import { useEffect, useRef, useState } from 'react';
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
import { getThemeColors } from './types';

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

// 节点颜色 — 精简为 3 阶灰度 + 2 个强调色，降低视觉杂乱
const NODE_TYPE_COLORS: Record<string, string> = {
  // 中性色（文档类）
  document:   '#8899AA',
  source:     '#8899AA',
  wiki:       '#7A8A99',
  // 知识核心（紫色强调）
  concept:    '#8B5CF6',
  entity:     '#8B5CF6',
  // 观点/对比（琥珀强调）
  comparison: '#D97706',
  question:   '#D97706',
  // Legacy types
  tag:        '#8B5CF6',
  agent:      '#8B5CF6',
  project:    '#8899AA',
  workflow:   '#D97706',
  aiModel:    '#D97706',
};

// 节点大小按连接数动态变化
// Obsidian 风格：小节点 3px，大节点 9px，中心节点突出
function nodeSize(linkCount: number, scale: number = 1.0): number {
  const base = 2;
  const maxSize = 8;
  const calculated = (base + Math.sqrt(linkCount) * 1.2) * scale;
  return Math.min(maxSize * scale, calculated);
}

function nodeColor(linkCount: number, nodeType?: string): string {
  if (nodeType && NODE_TYPE_COLORS[nodeType]) {
    return NODE_TYPE_COLORS[nodeType]!;
  }
  if (linkCount === 0) return NODE_ISOLATED;
  return NODE_DEFAULT;
}

// ── Main Page Component ──

export function GraphPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  // 跟随知识库的活跃 vault，知识库切换时图谱自动切换
  const activeVaultId = useActiveVaultId();
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const hoveredNodeRef = useRef<string | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  // Persist node positions across graph rebuilds (theme change, nodeScale change)
  const savedPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  const simulation = useSimulation();
  const { settings, updateSettings, updateForce } = useGraphSettings();
  const themeColors = getThemeColors(settings.theme);

  // Fetch graph data when active vault changes
  useEffect(() => {
    if (!activeVaultId) return;

    setLoading(true);
    setError(null);
    api.getGraph(activeVaultId)
      .then((data) => {
        setGraphData(data);
      })
      .catch((err) => {
        if (err.message?.includes('404')) {
          // Vault no longer exists in DB — clear stale selection.
          // App.tsx's setVaults() will auto-select a valid vault,
          // and this useEffect will re-fire with the new activeVaultId.
          vaultStore.setActiveVaultId(null);
          setError(null);
        } else {
          setError(err.message ?? 'Failed to load graph');
        }
        setGraphData(null);
      })
      .finally(() => setLoading(false));
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
    // 局部图模式：选中节点后聚焦邻居，非关联节点大幅淡出
    const nodeReducer = (node: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;
      const isSelected = node === selected;
      const isFocusMode = !!selected; // true when a node is locked by click

      // 无 focus：默认显示所有节点
      if (!focusNode) {
        return {
          ...data,
          color: (data.color as string) ?? themeColors.node,
          size: (data.size as number) ?? 6,
        };
      }

      // 当前 focus 节点：高亮
      if (node === focusNode) {
        const scale = isSelected ? 1.4 : 1.2;
        return {
          ...data,
          size: ((data.size as number) ?? 6) * scale,
          color: isSelected ? themeColors.selected : themeColors.hover,
        };
      }

      // 关联节点（邻居）
      const isConnected = graph.hasEdge(focusNode, node) || graph.hasEdge(node, focusNode);
      if (isConnected) {
        return {
          ...data,
          color: (data.color as string) ?? themeColors.node,
          // 选中模式下邻居保持原始大小
          size: isFocusMode ? (data.size as number) ?? 6 : undefined,
        };
      }

      // 非关联节点：
      if (isFocusMode) {
        // 选中模式：大幅淡出（保留位置布局，但视觉上几乎消失）
        return {
          ...data,
          color: themeColors.dimmed,
          size: ((data.size as number) ?? 6) * 0.15,
        };
      }
      // 悬停模式：轻微变淡
      return { ...data, color: themeColors.edge };
    };

    // ── Edge reducer ──
    // Obsidian 风格：默认淡灰，hover 时关联线变紫
    const edgeReducer = (edge: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;

      // 无 focus：默认淡灰细线
      if (!focusNode) {
        return { ...data, color: themeColors.edge, size: settings.edgeWidth };
      }

      // Get source/target using graphology API
      const source = graph.source(edge);
      const target = graph.target(edge);
      const isConnected = source === focusNode || target === focusNode;

      if (isConnected) {
        // 选中状态：粗紫线
        if (selected) {
          return { ...data, color: themeColors.edgeSelected, size: 2 };
        }
        // hover：淡紫线
        return { ...data, color: themeColors.edgeHover, size: 1.5 };
      }
      // 非关联线：更淡
      return { ...data, color: themeColors.dimmed, size: 0.5 };
    };

    // ── Create Sigma ──
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: true,
      nodeProgramClasses: { circle: NodeCircleProgram },
      defaultEdgeColor: themeColors.edge,
      defaultEdgeType: 'line',
      edgeLabelSize: 10,
      labelColor: { color: themeColors.label },
      labelSize: 12,
      labelFont: 'Inter, PingFang SC, -apple-system, sans-serif',
      // 标签按缩放级别自动显隐 — 缩小时只显示大节点标签
      labelRenderedSizeThreshold: 5,
      labelDensity: 0.25,
      defaultNodeColor: themeColors.node,
      renderEdgeLabels: false,
      autoRescale: true,
      autoCenter: true,
      minCameraRatio: 0.2,
      maxCameraRatio: 8,
      stagePadding: 80,
      nodeReducer,
      edgeReducer,
    });

    sigmaRef.current = renderer;
    renderer.refresh();
    // Start d3-force physics engine (positions sync on tick, rendering via interaction handlers)
    simulation.init(graph, renderer, () => {});

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

    renderer.on('leaveNode', () => {
      if (draggedNode) return;
      hoveredNodeRef.current = null;
      renderer.refresh();
    });

    // ── Click & Drag events ──
    // 使用原生鼠标事件处理节点交互；空白区域交给 Sigma 内置画布拖拽/缩放
    let draggedNode: string | null = null;
    let isDragging = false;
    let lastClickTime = 0;
    let lastClickNode: string | null = null;
    const DRAG_THRESHOLD = 4;
    const DBLCLICK_INTERVAL = 350;
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
        // Lock d3 node position so collision doesn't push it away during drag
        const d3Node = simulation.getNode(node);
        if (d3Node) {
          const attrs = graph.getNodeAttributes(node);
          d3Node.fx = (attrs.x as number) ?? 0;
          d3Node.fy = (attrs.y as number) ?? 0;
        }
        // 唤醒物理引擎——这次唤醒会持续 tick，拖拽过程中不需要重复唤醒
        simulation.wake();
        e.preventDefault();
        e.stopPropagation();
      } else {
        // 空白区域：取消选中并解除 fx/fy 锁定
        draggedNode = null;
        if (selectedNodeRef.current) {
          const prev = selectedNodeRef.current;
          graph.removeNodeAttribute(prev, 'fx');
          graph.removeNodeAttribute(prev, 'fy');
          // Also release d3 lock if any
          const d3Node = simulation.getNode(prev);
          if (d3Node) {
            d3Node.fx = null;
            d3Node.fy = null;
          }
          selectedNodeRef.current = null;
          renderer.refresh();
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
        // 轻柔保持引擎活跃——mousedown 的唤醒在 ~1s 后衰减殆尽
        // 低 alpha 让邻居持续被弹簧拉动，不会闪烁（tick 已不再调用 refresh）
        simulation.wake(0.06);
        renderer.refresh();
      }
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
        // Release d3 fx/fy lock → node settles naturally with damping
        const d3Node = simulation.getNode(node);
        if (d3Node) {
          d3Node.fx = null;
          d3Node.fy = null;
          graph.removeNodeAttribute(node, 'fx');
          graph.removeNodeAttribute(node, 'fy');
        }
        // Small nudge for gradual convergence
        simulation.wake(0.1);
      } else {
        // 点击（非拖拽）：检测双击
        const now = Date.now();
        const isDoubleClick =
          node === lastClickNode && now - lastClickTime < DBLCLICK_INTERVAL;

        if (isDoubleClick) {
          const path = graph.getNodeAttribute(node, 'path') as string | undefined;
          if (path) {
            navigate('/knowledge', { state: { openFile: path } });
          }
          lastClickTime = 0;
          lastClickNode = null;
        } else {
          selectedNodeRef.current = node;
          lastClickTime = now;
          lastClickNode = node;
          renderer.refresh();
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
      const positions = new Map<string, { x: number; y: number }>();
      if (graphRef.current) {
        graphRef.current.forEachNode((key, attrs) => {
          positions.set(key, { x: (attrs.x as number) ?? 0, y: (attrs.y as number) ?? 0 });
        });
      }
      savedPositionsRef.current = positions;

      simulation.stop();
      container.removeEventListener('mousedown', handleMouseDown, { capture: true });
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      if (sigmaRef.current) {
        sigmaRef.current.kill();
        sigmaRef.current = null;
      }
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
          />
        )}
      </div>
    </div>
  );
}

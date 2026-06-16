/**
 * GraphPage — Obsidian-style force-directed knowledge graph.
 *
 * Visual reference: https://help.obsidian.md/Plugins/Graph+view
 * Colours match Obsidian's default dark theme CSS variables.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Graph from 'graphology';
import { useSimulation } from './useSimulation';
import Sigma from 'sigma';
import { NodeCircleProgram } from 'sigma/rendering';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { Minimap } from './Minimap';
import { useActiveVaultId, vaultStore } from '../../stores/vaultStore';
import type { GraphData } from '@molio/contracts';

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

// Node type colours — matched to wiki directory structure
const NODE_TYPE_COLORS: Record<string, string> = {
  document:   '#94A3B8',  // 灰蓝 — 普通文档
  source:     '#3B82F6',  // 蓝色 — 源文件
  entity:     '#22C55E',  // 绿色 — 实体
  concept:    '#8B5CF6',  // 紫色 — 概念
  comparison: '#F59E0B',  // 橙色 — 对比
  question:   '#EF4444',  // 红色 — 问答
  wiki:       '#6B7280',  // 灰色 — 其他 wiki 页面
  // Legacy types (for backwards compatibility)
  tag:        '#22C55E',
  agent:      '#8B5CF6',
  project:    '#3B82F6',
  workflow:   '#F59E0B',
  aiModel:    '#EF4444',
};

// 节点大小按连接数动态变化
// Obsidian 风格：小节点 4px，大节点 12px，中心节点突出
function nodeSize(linkCount: number): number {
  const base = 4;
  const maxSize = 12;
  const calculated = base + Math.sqrt(linkCount) * 1.5;
  return Math.min(maxSize, calculated);
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

  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const hoveredNodeRef = useRef<string | null>(null);
  const selectedNodeRef = useRef<string | null>(null);

  const simulation = useSimulation();

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
      graph.addNode(n.key, {
        label: n.label,
        path: n.path,
        linkCount: n.linkCount,
        nodeType: n.nodeType ?? null,
        size: nodeSize(n.linkCount),
        color: nodeColor(n.linkCount, n.nodeType),
        type: 'circle',
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }

    for (const e of graphData.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      try {
        graph.addEdge(e.source, e.target, { color: EDGE_DEFAULT });
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
        try {
          graph.addNode(deadKey, {
            label: `${dl.targetName} (?)`,
            path: '',
            linkCount: 0,
            nodeType: null,
            size: 4,
            color: '#D4D4D4',
            type: 'circle',
            x: (Math.random() - 0.5) * radius,
            y: (Math.random() - 0.5) * radius,
          });
        } catch { /* node already exists */ }
      }
    }

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
          color: (data.color as string) ?? NODE_DEFAULT,
          size: (data.size as number) ?? 6,
        };
      }

      // 当前 focus 节点：高亮
      if (node === focusNode) {
        const scale = isSelected ? 1.4 : 1.2;
        return {
          ...data,
          size: ((data.size as number) ?? 6) * scale,
          color: isSelected ? NODE_SELECTED : NODE_HOVER,
        };
      }

      // 关联节点（邻居）
      const isConnected = graph.hasEdge(focusNode, node) || graph.hasEdge(node, focusNode);
      if (isConnected) {
        return {
          ...data,
          color: (data.color as string) ?? NODE_DEFAULT,
          // 选中模式下邻居保持原始大小
          size: isFocusMode ? (data.size as number) ?? 6 : undefined,
        };
      }

      // 非关联节点：
      if (isFocusMode) {
        // 选中模式：大幅淡出（保留位置布局，但视觉上几乎消失）
        return {
          ...data,
          color: '#F0F0F0',
          size: ((data.size as number) ?? 6) * 0.15,
        };
      }
      // 悬停模式：轻微变淡
      return { ...data, color: '#D4D4D4' };
    };

    // ── Edge reducer ──
    // Obsidian 风格：默认淡灰，hover 时关联线变紫
    const edgeReducer = (edge: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;

      // 无 focus：默认淡灰细线
      if (!focusNode) {
        return { ...data, color: EDGE_DEFAULT, size: 0.8 };
      }

      // Get source/target using graphology API
      const source = graph.source(edge);
      const target = graph.target(edge);
      const isConnected = source === focusNode || target === focusNode;

      if (isConnected) {
        // 选中状态：粗紫线
        if (selected) {
          return { ...data, color: EDGE_SELECTED, size: 2 };
        }
        // hover：淡紫线
        return { ...data, color: EDGE_HOVER, size: 1.5 };
      }
      // 非关联线：更淡
      return { ...data, color: '#F0F0F0', size: 0.5 };
    };

    // ── Create Sigma ──
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: true,
      nodeProgramClasses: { circle: NodeCircleProgram },
      defaultEdgeColor: EDGE_DEFAULT,
      defaultEdgeType: 'line',
      edgeLabelSize: 10,
      labelColor: { color: '#333333' },
      labelSize: 12,
      labelFont: 'Inter, PingFang SC, -apple-system, sans-serif',
      // 标签按缩放级别自动显隐 — 缩小时只显示大节点标签
      labelRenderedSizeThreshold: 5,
      labelDensity: 0.25,
      defaultNodeColor: NODE_DEFAULT,
      renderEdgeLabels: false,
      autoRescale: true,
      autoCenter: false,
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

    // 聚焦到主集群——忽略孤立节点，让图谱主体填满画布
    let cx = 0, cy = 0, clusterCount = 0;
    graph.forEachNode((key, attrs) => {
      if ((attrs.linkCount as number) > 0) {
        cx += (attrs.x as number) ?? 0;
        cy += (attrs.y as number) ?? 0;
        clusterCount++;
      }
    });
    if (clusterCount > 0) {
      const camera = renderer.getCamera();
      camera.x = cx / clusterCount;
      camera.y = cy / clusterCount;
      camera.ratio = 0.3;
    }

    // ── Hover events ──
    // 拖拽时跳过 hover，避免 enterNode/leaveNode 频繁触发导致邻居节点大小闪烁
    renderer.on('enterNode', ({ node }) => {
      if (draggedNode) return;
      hoveredNodeRef.current = node;
      renderer.refresh();
    });

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
        // 不唤醒引擎——mousedown 时已唤醒，引擎持续 tick 带动邻居
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
  }, [graphData, navigate]);

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
        <Minimap sigma={sigmaRef.current} />

        {graphData && (
          <div className="graph-legend">
            <div className="graph-legend__item">
              <span className="graph-legend__dot" style={{ background: '#3B82F6' }} />
              <span className="graph-legend__label">源文件</span>
            </div>
            <div className="graph-legend__item">
              <span className="graph-legend__dot" style={{ background: '#8B5CF6' }} />
              <span className="graph-legend__label">概念</span>
            </div>
            <div className="graph-legend__item">
              <span className="graph-legend__dot" style={{ background: '#22C55E' }} />
              <span className="graph-legend__label">实体</span>
            </div>
            <div className="graph-legend__item">
              <span className="graph-legend__dot" style={{ background: '#F59E0B' }} />
              <span className="graph-legend__label">对比</span>
            </div>
            <div className="graph-legend__item">
              <span className="graph-legend__dot" style={{ background: '#EF4444' }} />
              <span className="graph-legend__label">问答</span>
            </div>
            <div className="graph-legend__item">
              <span className="graph-legend__dot" style={{ background: '#94A3B8' }} />
              <span className="graph-legend__label">文档</span>
            </div>
            {graphData.deadLinks && graphData.deadLinks.length > 0 && (
              <div className="graph-legend__item">
                <span className="graph-legend__dot graph-legend__dot--dead" />
                <span className="graph-legend__label">死链接</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="graph-hints">
        <span className="graph-hint">拖拽节点 · 邻居联动</span>
        <span className="graph-hint-sep">|</span>
        <span className="graph-hint">单击选中 · 高亮关联</span>
        <span className="graph-hint-sep">|</span>
        <span className="graph-hint">双击节点 · 打开文章</span>
      </div>
    </div>
  );
}

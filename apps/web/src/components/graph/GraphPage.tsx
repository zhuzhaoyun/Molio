/**
 * GraphPage — Obsidian-style force-directed knowledge graph.
 *
 * Visual reference: https://help.obsidian.md/Plugins/Graph+view
 * Colours match Obsidian's default dark theme CSS variables.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Graph from 'graphology';
import forceLayout from 'graphology-layout-force';
import Sigma from 'sigma';
import { NodeCircleProgram } from 'sigma/rendering';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { Minimap } from './Minimap';
import type { Vault } from '@molio/contracts';

// ── Types ──

interface GraphNode {
  key: string;
  label: string;
  path: string;
  linkCount: number;
  nodeType?: string; // future: document | tag | agent | project | workflow | aiModel
}

interface GraphEdge {
  source: string;
  target: string;
}

// ── Visual constants (Obsidian light theme, matching obsidian.png) ──
// 浅色背景 + 深色节点，像纸张上的墨点

const BG = '#FAFAFA';              // Obsidian 浅色背景
const NODE_DEFAULT = '#5C5C5C';  // 默认节点：深灰
const NODE_ISOLATED = '#999999';  // 孤立节点：更浅的灰
const NODE_HOVER = '#333333';    // hover：更深
const NODE_SELECTED = '#8B5CF6'; // 选中：Obsidian 紫色
const NODE_SELECTED_BORDER = '#7C3AED';
const EDGE_DEFAULT = '#F5F5F5';  // 连线：极淡灰，几乎看不见
const EDGE_HOVER = '#C4B5FD';    // hover 连线：淡紫
const EDGE_SELECTED = '#8B5CF6'; // 选中连线：紫色
const LABEL_DEFAULT = '#6B6B6B'; // 标签：灰色

// Node type colours (future: daemon will provide nodeType)
const NODE_TYPE_COLORS: Record<string, string> = {
  document: '#94A3B8',
  tag: '#22C55E',
  agent: '#8B5CF6',
  project: '#3B82F6',
  workflow: '#F59E0B',
  aiModel: '#EF4444',
};

// 节点大小按连接数动态变化
// Obsidian 风格：小节点 2px，大节点 10px，差异明显
function nodeSize(linkCount: number): number {
  const base = 2;
  const maxSize = 10;
  const calculated = base + Math.sqrt(linkCount) * 1.8;
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

  const [vaults, setVaults] = useState<Vault[]>([]);
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const hoveredNodeRef = useRef<string | null>(null);
  const selectedNodeRef = useRef<string | null>(null);

  // Load vault list
  useEffect(() => {
    api.listVaults()
      .then((list) => {
        setVaults(list);
        if (list.length > 0 && !selectedVaultId) {
          setSelectedVaultId(list[0].id);
        }
      })
      .catch(() => { /* silently ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch graph data when vault changes
  useEffect(() => {
    if (!selectedVaultId) return;

    setLoading(true);
    setError(null);
    api.getGraph(selectedVaultId)
      .then((data) => {
        setGraphData(data);
      })
      .catch((err) => {
        setError(err.message ?? 'Failed to load graph');
        setGraphData(null);
      })
      .finally(() => setLoading(false));
  }, [selectedVaultId]);

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
    const initialRadius = Math.sqrt(count) * 40 + 200;
    const angleStep = (2 * Math.PI) / (count || 1);

    for (let i = 0; i < count; i++) {
      const n = graphData.nodes[i];
      const angle = angleStep * i + (Math.random() - 0.5) * 0.5;
      const radius = initialRadius * (0.5 + Math.random() * 0.5);
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

    // Force-directed layout: Obsidian 风格
    // 节点均匀散开，形成自然的知识网络
    forceLayout.assign(graph, {
      maxIterations: 1200,
      settings: {
        attraction: 0.0008,  // 很松，节点间距大
        repulsion: 3.0,      // 强排斥，均匀分布
        gravity: 0.01,       // 轻微向心力
        inertia: 0.4,        // 低惯性
        maxMove: 100,        // 较小移动范围，更稳定
      },
    });

    // ── Node reducer for hover/select ──
    // Obsidian 风格：默认全部显示，hover 时非关联节点变淡
    const nodeReducer = (node: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;
      const isSelected = node === selected;

      // 无 focus：默认显示所有节点
      if (!focusNode) {
        return {
          ...data,
          color: (data.color as string) ?? NODE_DEFAULT,
          size: (data.size as number) ?? 6,
        };
      }

      // 当前 hover/选中节点：紫色高亮
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
        return { ...data, color: (data.color as string) ?? NODE_DEFAULT };
      }

      // 非关联节点：变淡但可见（Obsidian 风格，不是完全消失）
      return { ...data, color: '#D4D4D4' };
    };

    // ── Edge reducer ──
    // Obsidian 风格：默认淡灰，hover 时关联线变紫
    const edgeReducer = (edge: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;

      // 无 focus：默认淡灰线
      if (!focusNode) {
        return { ...data, color: EDGE_DEFAULT, size: 1 };
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
      labelColor: { color: LABEL_DEFAULT },
      labelSize: 11,
      labelFont: 'Inter, PingFang SC, -apple-system, sans-serif',
      // Labels only show when zoomed in (≈ zoom > 1.2 in Obsidian terms)
      labelRenderedSizeThreshold: 12,
      labelDensity: 0.25,
      defaultNodeColor: NODE_DEFAULT,
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

    // ── Hover events ──
    renderer.on('enterNode', ({ node }) => {
      hoveredNodeRef.current = node;
      renderer.refresh();
    });

    renderer.on('leaveNode', () => {
      hoveredNodeRef.current = null;
      renderer.refresh();
    });

    // ── Click events ──
    renderer.on('clickNode', ({ node }) => {
      const path = graph.getNodeAttribute(node, 'path') as string | undefined;
      if (path) {
        if (selectedNodeRef.current === node) {
          // Double-click: open the document
          navigate('/knowledge', { state: { openFile: path } });
        } else {
          selectedNodeRef.current = node;
          // Smooth camera animation to center on selected node
          const nx = graph.getNodeAttribute(node, 'x') as number | undefined;
          const ny = graph.getNodeAttribute(node, 'y') as number | undefined;
          if (nx != null && ny != null) {
            renderer.getCamera().animate(
              { x: nx, y: ny, ratio: renderer.getCamera().ratio },
              { duration: 800 },
            );
          }
          renderer.refresh();
        }
      }
    });

    renderer.on('doubleClickNode', ({ node }) => {
      const path = graph.getNodeAttribute(node, 'path') as string | undefined;
      if (path) {
        navigate('/knowledge', { state: { openFile: path } });
      }
    });

    renderer.on('clickStage', () => {
      if (selectedNodeRef.current) {
        // Release fixed position on deselect
        const prev = selectedNodeRef.current;
        graph.removeNodeAttribute(prev, 'fx');
        graph.removeNodeAttribute(prev, 'fy');
        selectedNodeRef.current = null;
        renderer.refresh();
      }
    });

    // ── Drag implementation ──
    let draggedNode: string | null = null;
    let isDragging = false;
    const DRAG_THRESHOLD = 4;
    let dragStartMouse = { x: 0, y: 0 };
    const container = containerRef.current;

    const handleMouseDown = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const mouseGraph = renderer.viewportToGraph({ x: mouseX, y: mouseY });

      let closestNode: string | null = null;
      let closestDist = Infinity;

      graph.forEachNode((node, attr) => {
        const nx = (attr.x as number) ?? 0;
        const ny = (attr.y as number) ?? 0;
        const size = (attr.size as number) ?? 6;
        const dist = Math.sqrt((nx - mouseGraph.x) ** 2 + (ny - mouseGraph.y) ** 2);
        if (dist < size * 1.5 + 4 && dist < closestDist) {
          closestDist = dist;
          closestNode = node;
        }
      });

      if (closestNode) {
        draggedNode = closestNode;
        isDragging = false;
        dragStartMouse = { x: mouseX, y: mouseY };
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!draggedNode) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const moveDist = Math.sqrt((mouseX - dragStartMouse.x) ** 2 + (mouseY - dragStartMouse.y) ** 2);
      if (!isDragging && moveDist > DRAG_THRESHOLD) {
        isDragging = true;
      }

      if (isDragging) {
        const graphPos = renderer.viewportToGraph({ x: mouseX, y: mouseY });
        graph.setNodeAttribute(draggedNode, 'x', graphPos.x);
        graph.setNodeAttribute(draggedNode, 'y', graphPos.y);
        renderer.refresh();
      }
    };

    const handleMouseUp = () => {
      if (isDragging && draggedNode) {
        // Fix position after drag (per Obsidian spec)
        const x = graph.getNodeAttribute(draggedNode, 'x') as number | undefined;
        const y = graph.getNodeAttribute(draggedNode, 'y') as number | undefined;
        if (x != null) graph.setNodeAttribute(draggedNode, 'fx', x);
        if (y != null) graph.setNodeAttribute(draggedNode, 'fy', y);
      }
      draggedNode = null;
      isDragging = false;
    };

    container.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
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

  if (vaults.length === 0) {
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
          <select
            className="graph-vault-select"
            value={selectedVaultId ?? ''}
            onChange={(e) => setSelectedVaultId(e.target.value || null)}
          >
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>

          {graphData && !loading && (
            <span className="graph-stat">{t('graph.nodes', { count: nodeCount })}</span>
          )}
          {graphData && !loading && (
            <span className="graph-stat graph-stat--edges">{t('graph.edges', { count: edgeCount })}</span>
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
      </div>
    </div>
  );
}

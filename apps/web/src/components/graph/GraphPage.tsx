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

// ── Visual constants (Galaxy Knowledge Graph style) ──
// "知识星系" 视觉：连线极淡，节点有层次，hover 聚焦

const BG = '#0B1020'; // 深邃夜空背景，不是纯黑
const NODE_DEFAULT = '#C5CBD6'; // 节点微亮，在深色背景上像星光
const NODE_ISOLATED = '#6B7280'; // 孤立节点稍暗
const NODE_HOVER = '#FFFFFF'; // hover 节点纯白
const NODE_SELECTED = '#FFFFFF'; // 选中节点纯白
const NODE_HOVER_GLOW = 'rgba(96,165,250,0.8)';
const EDGE_DEFAULT = 'rgba(60,65,80,0.03)'; // 连线几乎完全隐形
const EDGE_HOVER = 'rgba(96,165,250,0.8)'; // hover 时亮起
const EDGE_SELECTED = '#60A5FA';
const LABEL_DEFAULT = '#D1D5DB';

// Node type colours (future: daemon will provide nodeType)
const NODE_TYPE_COLORS: Record<string, string> = {
  document: '#94A3B8',
  tag: '#22C55E',
  agent: '#8B5CF6',
  project: '#3B82F6',
  workflow: '#F59E0B',
  aiModel: '#EF4444',
};

// 节点大小按连接数动态变化：知识越多的节点越大
// 范围：5 ~ 30，中心节点明显更大，小节点也不消失
function nodeSize(linkCount: number): number {
  const base = 5;
  const maxSize = 30;
  const calculated = base + Math.sqrt(linkCount) * 3;
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

    // Force-directed layout: 星系感
    // 目标：节点自然散开，形成中心辐射结构
    forceLayout.assign(graph, {
      maxIterations: 1200,
      settings: {
        attraction: 0.0015,  // 稍松，节点间距更大
        repulsion: 2.5,      // 更强排斥，避免拥挤
        gravity: 0.015,      // 向心力，形成中心
        inertia: 0.5,        // 低惯性，更稳定
        maxMove: 150,        // 适度移动范围
      },
    });

    // ── Node reducer for hover/select ──
    // 核心视觉：默认状态下节点微亮，hover 时聚焦，其余淡出
    const nodeReducer = (node: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;
      const isSelected = node === selected;

      // 无 focus：默认显示
      if (!focusNode) {
        return {
          ...data,
          color: (data.color as string) ?? NODE_DEFAULT,
          size: (data.size as number) ?? 6,
        };
      }

      // 当前 hover/选中节点
      if (node === focusNode) {
        const scale = isSelected ? 1.5 : 1.2;
        return {
          ...data,
          size: ((data.size as number) ?? 6) * scale,
          color: NODE_HOVER,
          // 发光效果：通过 zIndex 或额外渲染实现
        };
      }

      // 关联节点（邻居）
      const isConnected = graph.hasEdge(focusNode, node) || graph.hasEdge(node, focusNode);
      if (isConnected) {
        return { ...data, color: (data.color as string) ?? NODE_DEFAULT };
      }

      // 非关联节点：几乎消失
      return { ...data, color: 'rgba(156,163,175,0.08)' };
    };

    // ── Edge reducer ──
    // 默认：线条几乎消失 (rgba 0.05)
    // hover/选中：关联线亮起 (0.8 高亮)
    const edgeReducer = (edge: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;

      // 无 focus：默认极淡
      if (!focusNode) {
        return { ...data, color: EDGE_DEFAULT, size: 0.5 };
      }

      // Get source/target using graphology API
      const source = graph.source(edge);
      const target = graph.target(edge);
      const isConnected = source === focusNode || target === focusNode;

      if (isConnected) {
        // 选中状态：粗蓝线
        if (selected) {
          return { ...data, color: EDGE_SELECTED, size: 3 };
        }
        // hover：亮蓝线
        return { ...data, color: EDGE_HOVER, size: 2 };
      }
      // 非关联线：几乎消失
      return { ...data, color: 'rgba(255,255,255,0.02)', size: 0.3 };
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

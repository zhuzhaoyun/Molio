/**
 * GraphPage — Obsidian-style force-directed knowledge graph.
 *
 * Uses Sigma.js with a custom Canvas edge renderer to match Obsidian's
 * visual quality: visible grey edges, black nodes, and smooth drag.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Graph from 'graphology';
import forceLayout from 'graphology-layout-force';
import Sigma from 'sigma';
import { NodeCircleProgram } from 'sigma/rendering';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type { Vault } from '@molio/contracts';

// ── Types ──

interface GraphNode {
  key: string;
  label: string;
  path: string;
  linkCount: number;
}

interface GraphEdge {
  source: string;
  target: string;
}

// ── Visual constants (Obsidian-style) ──

/** Node colour — #8c8c8c is Obsidian's --graph-node default */
const NODE_COLOR = '#8c8c8c';
const NODE_HOVER_COLOR = '#4a90d9';
const NODE_SELECTED_COLOR = '#fb4934';
/** Edge colour — visible grey, matching Obsidian's --graph-line (#363636 in dark) */
const EDGE_COLOR = 'rgba(54,54,54,0.5)';
const EDGE_HIGHLIGHT_COLOR = 'rgba(54,54,54,0.8)';
/** Obsidian dark background */
const BG_COLOR = '#1a1a2e';

/** Compute node size from link count */
function nodeSize(linkCount: number): number {
  return Math.max(4, Math.min(18, 4 + Math.sqrt(linkCount + 1) * 2.5));
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
  const isDraggingRef = useRef(false);

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
        size: nodeSize(n.linkCount),
        color: NODE_COLOR,
        type: 'circle',
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }

    for (const e of graphData.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      try {
        graph.addEdge(e.source, e.target, { color: EDGE_COLOR });
      } catch { /* Edge already exists */ }
    }

    // Force-directed layout
    forceLayout.assign(graph, {
      maxIterations: 800,
      settings: {
        attraction: 0.002,
        repulsion: 8,
        gravity: 0.02,
        inertia: 0.6,
        maxMove: 200,
      },
    });

    // ── Node reducer for hover/select highlighting ──
    const nodeReducer = (node: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;

      if (!focusNode) {
        return { ...data, color: (data.color as string) ?? NODE_COLOR };
      }

      if (node === focusNode) {
        return {
          ...data,
          size: ((data.size as number) ?? 6) * 1.3,
          color: selected ? NODE_SELECTED_COLOR : NODE_HOVER_COLOR,
        };
      }

      const isConnected = graph.hasEdge(focusNode, node) || graph.hasEdge(node, focusNode);
      if (isConnected) {
        return { ...data, color: (data.color as string) ?? NODE_COLOR };
      }

      return { ...data, color: 'rgba(140,140,140,0.15)' };
    };

    // ── Edge reducer ──
    const edgeReducer = (edge: string, data: Record<string, unknown>) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;

      if (!focusNode) {
        return { ...data, color: (data.color as string) ?? EDGE_COLOR };
      }

      const edgeData = graph.getEdgeAttributes(edge) as Record<string, unknown>;
      const source = (edgeData.source as string) ?? '';
      const target = (edgeData.target as string) ?? '';
      const isConnected = source === focusNode || target === focusNode;

      if (isConnected) {
        return { ...data, color: EDGE_HIGHLIGHT_COLOR };
      }
      return { ...data, color: 'rgba(54,54,54,0.08)' };
    };

    // Read theme text color for labels
    const computedStyle = getComputedStyle(document.documentElement);
    const textColor = computedStyle.getPropertyValue('--text').trim() || '#1a1917';

    // ── Create Sigma with custom edge rendering ──
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: true,
      nodeProgramClasses: { circle: NodeCircleProgram },
      defaultEdgeColor: EDGE_COLOR,
      defaultEdgeType: 'line',
      edgeLabelSize: 10,
      labelColor: { color: textColor },
      labelSize: 12,
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.25,
      defaultNodeColor: NODE_COLOR,
      renderEdgeLabels: false,
      autoRescale: true,
      autoCenter: true,
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
          navigate('/knowledge', { state: { openFile: path } });
        } else {
          selectedNodeRef.current = node;
          renderer.refresh();
        }
      }
    });

    renderer.on('clickStage', () => {
      if (selectedNodeRef.current) {
        selectedNodeRef.current = null;
        renderer.refresh();
      }
    });

    // ── Drag implementation (native DOM on canvas container) ──
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

      // Find closest node
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
      draggedNode = null;
      isDragging = false;
    };

    // Use capture phase so we get events before Sigma's handlers
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
      </div>
    </div>
  );
}

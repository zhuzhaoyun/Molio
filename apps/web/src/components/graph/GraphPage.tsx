/**
 * GraphPage — Obsidian-style force-directed knowledge graph.
 *
 * Renders a Sigma.js WebGL graph with an Obsidian-inspired visual style:
 * uniform grey nodes, subtle dotted grid, hover/select highlighting,
 * and smooth force-directed layout with drag support.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Graph from 'graphology';
import forceLayout from 'graphology-layout-force';
import Sigma from 'sigma';
import { NodeCircleProgram, EdgeLineProgram } from 'sigma/rendering';
import type { Attributes } from 'graphology-types';
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

// ── Obsidian-inspired visual constants ──

/**
 * Node colour — matches Obsidian's default --graph-node which resolves
 * to --text-muted: #999 in light mode, ~#777 in dark mode.
 */
const NODE_COLOR_LIGHT = '#999999';
const NODE_COLOR_DARK = '#777777';
/** Node colour on hover — accent blue for feedback */
const NODE_HOVER_COLOR = '#4a90d9';
/** Node colour when selected/focused — warm red for emphasis */
const NODE_SELECTED_COLOR = '#fb4934';
/** Edge colour (very subtle, adapts to theme via opacity) */
const EDGE_COLOR = 'rgba(128,128,128,0.15)';
/** Edge colour on highlight */
const EDGE_HIGHLIGHT_COLOR = 'rgba(128,128,128,0.4)';

/** Compute node size from link count */
function nodeSize(linkCount: number): number {
  return Math.max(3, Math.min(20, 3 + Math.sqrt(linkCount + 1) * 3.5));
}

/** Get current theme node color */
function getNodeColor(): string {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return isDark ? NODE_COLOR_DARK : NODE_COLOR_LIGHT;
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

  // Refs for Sigma instance and container
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  // Track hovered and selected nodes for highlighting
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

  // ── Drag helpers ──

  const screenToGraph = useCallback((renderer: Sigma, x: number, y: number): { x: number; y: number } => {
    const graphCoords = renderer.viewportToGraph({ x, y });
    return graphCoords;
  }, []);

  // ── Initialize Sigma when graph data is available ──
  useEffect(() => {
    if (!graphData || graphData.nodes.length === 0 || !containerRef.current) return;

    // Cleanup previous instance
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }

    // ── Build graphology graph ──
    const graph = new Graph({ allowSelfLoops: false, multi: false });
    graphRef.current = graph;

    // Get current theme color
    const currentNodeColor = getNodeColor();

    // Give nodes an initial circular spread so the force layout starts from a
    // decent distribution instead of piling everything at (0,0).
    const count = graphData.nodes.length;
    const initialRadius = Math.sqrt(count) * 40 + 200;
    const angleStep = (2 * Math.PI) / (count || 1);

    for (let i = 0; i < count; i++) {
      const n = graphData.nodes[i];
      // Place nodes in a circle with some random jitter
      const angle = angleStep * i + (Math.random() - 0.5) * 0.5;
      const radius = initialRadius * (0.5 + Math.random() * 0.5);
      graph.addNode(n.key, {
        label: n.label,
        path: n.path,
        linkCount: n.linkCount,
        size: nodeSize(n.linkCount),
        color: currentNodeColor,
        type: 'circle',
        // Initial position so the force layout doesn't start from (0,0)
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }

    for (const e of graphData.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      try {
        graph.addEdge(e.source, e.target, { color: EDGE_COLOR });
      } catch {
        // Edge already exists
      }
    }

    // Apply force-directed layout
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

    // ── Edge reducer: dim non-connected edges ──
    const edgeReducer = (edge: string, data: Attributes) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;

      if (!focusNode) {
        return data;
      }

      // Check if this edge is connected to the focused node
      const edgeAttributes = graph.getEdgeAttributes(edge) as Record<string, unknown>;
      const ext = edgeAttributes as { source: string; target: string };
      const isConnected = ext.source === focusNode || ext.target === focusNode;

      if (!isConnected) {
        return { ...data, color: 'rgba(160,158,154,0.03)' };
      }
      return { ...data, color: EDGE_HIGHLIGHT_COLOR };
    };

    // ── Node reducer: highlight hovered/selected and their neighbors ──
    const nodeReducer = (node: string, data: Attributes) => {
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;
      const focusNode = hovered ?? selected;
      const currentColor = getNodeColor();

      if (!focusNode) {
        // No focus: default state, all nodes visible
        return {
          ...data,
          type: (data.type as string) ?? 'circle',
          size: (data.size as number) ?? 6,
          color: (data.color as string) ?? currentColor,
        };
      }

      // This node is the focused node itself
      if (node === focusNode) {
        return {
          ...data,
          type: (data.type as string) ?? 'circle',
          size: ((data.size as number) ?? 6) * 1.3,
          color: selected ? NODE_SELECTED_COLOR : NODE_HOVER_COLOR,
        };
      }

      // Check if this node is connected to the focused node
      const isConnected = graph.hasEdge(focusNode, node) || graph.hasEdge(node, focusNode);

      if (isConnected) {
        return {
          ...data,
          type: (data.type as string) ?? 'circle',
          size: (data.size as number) ?? 6,
          color: (data.color as string) ?? currentColor,
        };
      }

      // Dim non-connected nodes
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
        || (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
      return {
        ...data,
        type: (data.type as string) ?? 'circle',
        size: (data.size as number) ?? 6,
        color: isDark ? 'rgba(119,119,119,0.2)' : 'rgba(153,153,153,0.2)',
      };
    };

    // Read current theme text color for labels (adapts to light/dark mode)
    const computedStyle = getComputedStyle(document.documentElement);
    const textColor = computedStyle.getPropertyValue('--text').trim() || '#1a1917';

    // Create Sigma instance
    const renderer = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: true,
      nodeProgramClasses: { circle: NodeCircleProgram },
      edgeProgramClasses: { line: EdgeLineProgram },
      defaultEdgeColor: EDGE_COLOR,
      defaultEdgeType: 'line',
      edgeLabelSize: 10,
      labelColor: { color: textColor },
      labelSize: 11,
      labelRenderedSizeThreshold: 6,
      labelDensity: 0.3,
      defaultNodeColor: currentNodeColor,
      renderEdgeLabels: false,
      autoRescale: true,
      autoCenter: true,
      nodeReducer,
      edgeReducer,
    });

    sigmaRef.current = renderer;
    renderer.refresh();

    // ── Hover: enterNode / leaveNode ──
    renderer.on('enterNode', ({ node }) => {
      hoveredNodeRef.current = node;
      renderer.refresh();
    });

    renderer.on('leaveNode', () => {
      hoveredNodeRef.current = null;
      renderer.refresh();
    });

    // ── Click to select / navigate ──
    renderer.on('clickNode', ({ node }) => {
      const path = graph.getNodeAttribute(node, 'path') as string | undefined;
      if (path) {
        // If clicking the same node, navigate; otherwise select it
        if (selectedNodeRef.current === node) {
          navigate('/knowledge', { state: { openFile: path } });
        } else {
          selectedNodeRef.current = node;
          renderer.refresh();
        }
      }
    });

    // ── Click on empty space to deselect ──
    renderer.on('clickStage', () => {
      if (selectedNodeRef.current) {
        selectedNodeRef.current = null;
        renderer.refresh();
      }
    });

    // ── Drag implementation ──
    let draggedNode: string | null = null;
    let isMouseDown = false;
    let dragStartPos: { x: number; y: number } | null = null;

    const container = containerRef.current;

    const handleMouseDown = (e: MouseEvent) => {
      const sigma = sigmaRef.current;
      if (!sigma) return;

      const mousePos = sigma.viewportToGraph({ x: e.offsetX, y: e.offsetY });
      const mouseGraphX = mousePos.x;
      const mouseGraphY = mousePos.y;

      // Find node under mouse
      let closestNode: string | null = null;
      let closestDist = Infinity;

      graph.forEachNode((node, attr) => {
        const nodeX = (attr.x as number) ?? 0;
        const nodeY = (attr.y as number) ?? 0;
        const size = (attr.size as number) ?? 6;
        const dist = Math.sqrt((nodeX - mouseGraphX) ** 2 + (nodeY - mouseGraphY) ** 2);
        if (dist < size + 5 && dist < closestDist) {
          closestDist = dist;
          closestNode = node;
        }
      });

      if (closestNode) {
        draggedNode = closestNode;
        isMouseDown = true;
        dragStartPos = { x: e.clientX, y: e.clientY };
        isDraggingRef.current = false;
        e.preventDefault();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isMouseDown || !draggedNode) return;

      const sigma = sigmaRef.current;
      if (!sigma) return;

      // If moved enough, consider it a drag
      if (dragStartPos) {
        const moveDist = Math.sqrt(
          (e.clientX - dragStartPos.x) ** 2 + (e.clientY - dragStartPos.y) ** 2
        );
        if (moveDist > 3) {
          isDraggingRef.current = true;
        }
      }

      if (isDraggingRef.current) {
        // Convert screen position to graph position
        const graphPos = sigma.viewportToGraph({ x: e.offsetX, y: e.offsetY });
        graph.setNodeAttribute(draggedNode, 'x', graphPos.x);
        graph.setNodeAttribute(draggedNode, 'y', graphPos.y);
        sigma.refresh();
      }
    };

    const handleMouseUp = () => {
      draggedNode = null;
      isMouseDown = false;
      isDraggingRef.current = false;
      dragStartPos = null;
    };

    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Cleanup on unmount or data change
    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
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

  // ── Empty states ──

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
      {/* Top bar */}
      <div className="graph-topbar">
        <div className="graph-topbar__left">
          <h2 className="graph-topbar__title">{t('graph.title')}</h2>
        </div>
        <div className="graph-topbar__right">
          {/* Vault selector */}
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

          {/* Stats */}
          {graphData && !loading && (
            <span className="graph-stat">{t('graph.nodes', { count: nodeCount })}</span>
          )}
          {graphData && !loading && (
            <span className="graph-stat graph-stat--edges">{t('graph.edges', { count: edgeCount })}</span>
          )}
        </div>
      </div>

      {/* Graph canvas */}
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

        {/* Sigma container div - ref attached for direct Sigma initialization */}
        <div ref={containerRef} className="graph-sigma" />
      </div>
    </div>
  );
}

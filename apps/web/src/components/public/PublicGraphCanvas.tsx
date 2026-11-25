import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PublicGraph } from '@molio/contracts';
import { Minimap } from '../graph/Minimap';
import { PixiGraphEngine, type EngineEdge, type EngineNode } from '../graph/engine/pixiGraphEngine';
import { DEFAULT_FORCE_PARAMS, getThemeColors } from '../graph/types';
import { useGraphSettings } from '../graph/useGraphSettings';

export function PublicGraphCanvas({ graph, t }: {
  graph: PublicGraph;
  t: (key: string) => string;
}) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PixiGraphEngine | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [engine, setEngine] = useState<PixiGraphEngine | null>(null);
  const [error, setError] = useState('');
  const { settings } = useGraphSettings();

  const nodes = useMemo<EngineNode[]>(() => {
    const degrees = new Map<string, number>();
    for (const edge of graph.edges) {
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    }
    return graph.nodes.map((node) => ({
      key: node.id,
      label: node.title,
      path: '',
      linkCount: degrees.get(node.id) ?? 0,
      nodeType: 'document',
    }));
  }, [graph]);
  const edges = useMemo<EngineEdge[]>(() => graph.edges.map((edge) => ({ ...edge })), [graph]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !nodes.length) return;
    let cancelled = false;
    void PixiGraphEngine.create(container, {
      theme: getThemeColors(settings.theme),
      forces: settings.forces ?? DEFAULT_FORCE_PARAMS,
      nodeScale: settings.nodeScale,
      edgeWidth: settings.edgeWidth,
    }).then((created) => {
      if (cancelled) {
        created.destroy();
        return;
      }
      created.setCallbacks({
        onNodeClick: (id) => navigateRef.current(`/public/wiki/${encodeURIComponent(id)}`),
        onNodeDoubleClick: (id) => navigateRef.current(`/public/wiki/${encodeURIComponent(id)}`),
        onZoom: (scale) => { container.dataset.zoomScale = String(scale); },
      });
      const canvas = container.querySelector('canvas');
      canvas?.setAttribute('aria-label', t('publicWiki.graphTitle'));
      canvas?.setAttribute('role', 'img');
      engineRef.current = created;
      setEngine(created);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : t('publicWiki.graphUnavailable'));
    });
    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
      setEngine(null);
    };
  // The graph page mounts this canvas only after its public snapshot has loaded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!engine) return;
    engine.setData(nodes, edges);
  }, [engine, nodes, edges]);

  useEffect(() => {
    engine?.setStyle({ theme: getThemeColors(settings.theme) });
    engine?.setStyle({ nodeScale: settings.nodeScale, edgeWidth: settings.edgeWidth });
    engine?.setForces(settings.forces);
  }, [engine, settings]);

  return <>
    {error && <p role="alert">{error}</p>}
    {!error && !nodes.length && <p className="public-graph__empty">{t('publicWiki.graphEmpty')}</p>}
    <div
      ref={containerRef}
      className="public-graph__viewport"
      data-testid="public-graph-canvas"
      data-node-count={nodes.length}
      data-edge-count={edges.length}
      data-zoom-scale=""
      aria-label={t('publicWiki.graphTitle')}
    >
      {engine && <div className="public-graph__controls" role="group" aria-label={t('publicWiki.graphControls')}>
        <button type="button" data-testid="public-graph-zoom-in" aria-label={t('publicWiki.zoomIn')} title={t('publicWiki.zoomIn')} onClick={() => engine.zoomBy(1.2)}>+</button>
        <button type="button" data-testid="public-graph-zoom-out" aria-label={t('publicWiki.zoomOut')} title={t('publicWiki.zoomOut')} onClick={() => engine.zoomBy(1 / 1.2)}>−</button>
        <button type="button" data-testid="public-graph-fit" aria-label={t('publicWiki.fitGraph')} title={t('publicWiki.fitGraph')} onClick={() => engine.fitView({ animate: true })}>⤢</button>
      </div>}
      {engine && <Minimap engine={engine} dark={getThemeColors(settings.theme).bg === '#0F1117'} />}
    </div>
  </>;
}

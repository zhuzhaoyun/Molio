import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from '3d-force-graph';
import type { EngineNode, EngineEdge } from './engine/pixiGraphEngine';
import { getThemeColors, NODE_TYPE_COLORS, type GraphSettings } from './types';
import { useI18n } from '../../i18n';

type SpatialNode = NodeObject & EngineNode;
type SpatialLink = LinkObject<SpatialNode>;
export interface ThreeGraphHandle { focusNode(key: string): void; reset(): void }
interface Props {
  nodes: EngineNode[];
  edges: EngineEdge[];
  knownKeys: string[];
  settings: GraphSettings;
  active: boolean;
  selectedKey: string | null;
  onSelect(node: EngineNode): void;
}
const escapeLabel = (label: string) => label.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const endpoint = (node: string | number | SpatialNode | undefined) => typeof node === 'object' ? node.key : String(node);

/** Owns mutable simulation copies and the entire WebGL lifecycle. API data never enters Three. */
export const ThreeGraphView = forwardRef<ThreeGraphHandle, Props>(function ThreeGraphView(props, ref) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph3DInstance<SpatialNode, SpatialLink> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [themeRevision, setThemeRevision] = useState(0);
  useEffect(() => {
    const update = () => setThemeRevision(value => value + 1);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    return () => { observer.disconnect(); media.removeEventListener('change', update); };
  }, []);
  const cache = useRef(new Map<string, SpatialNode>());
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settled = useRef(false);
  const failed = useRef(false);
  const cameraBusyUntil = useRef(0);
  const needsInitialFit = useRef(true);
  const paused = useRef(false);
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = () => latest.current.active && !document.hidden;
  const resume = () => {
    clearTimeout(idle.current);
    if (visible() && !failed.current) { graph.current?.resumeAnimation(); paused.current = false; }
  };
  const sleepWhenSettled = () => {
    clearTimeout(idle.current);
    idle.current = setTimeout(() => {
      if (settled.current) { graph.current?.pauseAnimation(); paused.current = true; }
    }, Math.max(350, cameraBusyUntil.current - performance.now() + 50));
  };
  const focusNode = (key: string) => {
    const node = cache.current.get(key);
    const g = graph.current;
    if (!node || !g) return;
    needsInitialFit.current = false;
    resume();
    const target = { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 };
    const camera = g.camera();
    const dx = camera.position.x - target.x, dy = camera.position.y - target.y, dz = camera.position.z - target.z;
    const distance = Math.hypot(dx, dy, dz) || 1;
    const duration = reducedMotion() ? 0 : 600;
    cameraBusyUntil.current = performance.now() + duration;
    g.cameraPosition({ x: target.x + dx / distance * 150, y: target.y + dy / distance * 150, z: target.z + dz / distance * 150 }, target, duration);
    sleepWhenSettled();
  };
  const reset = () => {
    needsInitialFit.current = false;
    resume();
    cameraBusyUntil.current = performance.now() + (reducedMotion() ? 0 : 600);
    graph.current?.cameraPosition({ x: 0, y: 0, z: 500 }, { x: 0, y: 0, z: 0 }, 0)
      .zoomToFit(reducedMotion() ? 0 : 600, 60);
    sleepWhenSettled();
  };
  useImperativeHandle(ref, () => ({ focusNode, reset }));

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setError(false);
    failed.current = false;
    needsInitialFit.current = true;
    setReady(false);
    let g: ForceGraph3DInstance<SpatialNode, SpatialLink> | null = null;
    let observer: ResizeObserver | undefined;
    const lostContext = (event: Event) => {
      event.preventDefault();
      clearTimeout(idle.current);
      g?.pauseAnimation();
      paused.current = true;
      failed.current = true;
      setReady(false);
      setError(true);
    };
    const wake = () => resume();
    const interact = () => { needsInitialFit.current = false; resume(); };
    const rest = () => sleepWhenSettled();
    const visibility = () => {
      if (!visible()) { g?.pauseAnimation(); paused.current = true; }
      else { resume(); sleepWhenSettled(); }
    };
    try {
      // Trackball controls: left drag rotates, right drag pans, wheel zooms.
      g = new ForceGraph3D(element, { controlType: 'trackball' }) as unknown as ForceGraph3DInstance<SpatialNode, SpatialLink>;
      graph.current = g;
      g.numDimensions(3).nodeId('key').nodeLabel(n => escapeLabel(n.label))
        .showNavInfo(false).backgroundColor(getThemeColors(latest.current.settings.theme).bg)
        .nodeRelSize(3).nodeVal(n => 1 + Math.sqrt(n.linkCount))
        .linkOpacity(0.22).cooldownTicks(reducedMotion() ? 60 : 160)
        .onNodeClick(n => { latest.current.onSelect(n); focusNode(n.key); })
        .onEngineStop(() => {
          if (needsInitialFit.current) {
            needsInitialFit.current = false;
            cameraBusyUntil.current = performance.now() + (reducedMotion() ? 0 : 600);
            g?.zoomToFit(reducedMotion() ? 0 : 600, 60);
          }
          settled.current = true;
          sleepWhenSettled();
        });
      g.renderer().domElement.addEventListener('webglcontextlost', lostContext);
      const controls = g.controls() as unknown as { staticMoving: boolean };
      controls.staticMoving = true;
      g.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const resize = () => {
        const { width, height } = element.getBoundingClientRect();
        if (width > 0 && height > 0) { g?.width(width).height(height); resume(); sleepWhenSettled(); }
      };
      observer = new ResizeObserver(resize);
      observer.observe(element);
      resize();
      element.addEventListener('pointerdown', interact);
      element.addEventListener('pointerup', rest);
      element.addEventListener('pointermove', wake);
      element.addEventListener('pointermove', rest);
      element.addEventListener('wheel', interact, { passive: true });
      element.addEventListener('wheel', rest, { passive: true });
      document.addEventListener('visibilitychange', visibility);
      // Same dev-only observability as Pixi: inspect actual data, camera and lifecycle in E2E.
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__threeGraph = {
        instance: g, isPaused: () => paused.current,
      };
      setReady(true);
    } catch {
      g?._destructor();
      graph.current = null;
      element.replaceChildren();
      failed.current = true;
      setError(true);
    }
    return () => {
      clearTimeout(idle.current);
      observer?.disconnect();
      element.removeEventListener('pointerdown', interact);
      element.removeEventListener('pointerup', rest);
      element.removeEventListener('pointermove', wake);
      element.removeEventListener('pointermove', rest);
      element.removeEventListener('wheel', interact);
      element.removeEventListener('wheel', rest);
      document.removeEventListener('visibilitychange', visibility);
      g?.renderer().domElement.removeEventListener('webglcontextlost', lostContext);
      g?._destructor();
      graph.current = null;
      cache.current.clear();
      element.replaceChildren();
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__threeGraph;
    };
  }, [attempt]);

  useEffect(() => {
    const g = graph.current;
    if (!g || !ready) return;
    const known = new Set(props.knownKeys);
    for (const key of cache.current.keys()) if (!known.has(key)) cache.current.delete(key);
    const nodes = props.nodes.map((node, index) => {
      const existing = cache.current.get(node.key);
      if (existing) { Object.assign(existing, node); return existing; }
      const angle = index * 2.399963229728653;
      const radius = 25 + Math.sqrt(index + 1) * 12;
      const fresh = { ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: ((index % 7) - 3) * 17 };
      cache.current.set(node.key, fresh);
      return fresh;
    });
    // Retain hidden nodes' coordinates for filter round-trips, but remove deleted documents.
    settled.current = false;
    g.graphData({ nodes, links: props.edges.map(edge => ({ source: edge.source, target: edge.target })) });
    resume();
    if (!visible()) { g.pauseAnimation(); paused.current = true; }
  }, [props.nodes, props.edges, props.knownKeys, ready]);

  useEffect(() => {
    const g = graph.current;
    if (!g || !ready) return;
    const colors = getThemeColors(props.settings.theme);
    const neighbors = new Set<string>();
    if (props.selectedKey) {
      neighbors.add(props.selectedKey);
      for (const e of props.edges) {
        if (e.source === props.selectedKey) neighbors.add(e.target);
        if (e.target === props.selectedKey) neighbors.add(e.source);
      }
    }
    g.backgroundColor(colors.bg)
      .nodeColor(n => n.key === props.selectedKey ? colors.selected : neighbors.size && !neighbors.has(n.key) ? colors.dimmed : n.dead ? colors.deadNode : NODE_TYPE_COLORS[n.nodeType ?? ''] ?? colors.node)
      .nodeVal(n => (1 + Math.sqrt(n.linkCount)) * props.settings.nodeScale ** 3)
      .linkColor(l => neighbors.size && (endpoint(l.source) === props.selectedKey || endpoint(l.target) === props.selectedKey) ? colors.edgeSelected : colors.edge)
      .linkWidth(props.settings.edgeWidth);
    resume();
    sleepWhenSettled();
  }, [props.settings, props.selectedKey, props.edges, ready, themeRevision]);

  useEffect(() => {
    if (!ready) return;
    if (!props.active) { graph.current?.pauseAnimation(); paused.current = true; clearTimeout(idle.current); }
    else { resume(); sleepWhenSettled(); }
  }, [props.active, ready]);

  return <>
    <div ref={host} className="graph-three" data-testid="graph-3d" aria-label={t('graph.threeLabel')} />
    {error && <div className="graph-three-error" role="alert" data-testid="graph-3d-error">
      <p>{t('graph.threeError')}</p>
      <button type="button" data-testid="graph-3d-retry" onClick={() => setAttempt(v => v + 1)}>{t('graph.threeRetry')}</button>
    </div>}
  </>;
});

/**
 * GraphPage — 知识库关系图谱。
 *
 * 渲染引擎：手写 SVG 力导向（engine/ForceGraphEngine.ts，移植自 Tencent WeKnora MIT）。
 * 数据流：daemon 一次全图（GET /api/graph/:vaultId）→ 前端本地归一化与切片。
 * 状态机：overview（全图/截断 top-N）↔ ego（聚焦子图）+ bloom 增量合并（代际 LRU）。
 * 交互：单击选中（浮动卡片）、双击打开文档、Shift+单击/⊕ 展开邻居、
 *       聚焦 chip ✕ 返回全图、搜索定位（画布外自动 pivot）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GraphData } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useActiveVaultId, vaultStore } from '../../stores/vaultStore';
import { useGraphSettings } from './useGraphSettings';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import { NODE_TYPE_COLORS, NODE_TYPE_LABELS, nodePaletteFor } from './types';
import { ForceGraphEngine } from './engine/ForceGraphEngine';
import type { EngineData, EngineNodeInput } from './engine/types';
import {
  computeHiddenNeighbors,
  egoSlice,
  evictBloomOverflow,
  mergeGraphData,
  normalizeGraphData,
  overviewTopN,
  type CanvasData,
  type NormalizedGraph,
} from './engine/slicing';

type GraphMode = 'overview' | 'ego';

export function GraphPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  // 跟随知识库的活跃 vault，知识库切换时图谱自动切换
  const activeVaultId = useActiveVaultId();
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<GraphMode>('overview');
  const [egoCenter, setEgoCenter] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  // 当前画布的节点/边计数（过滤/截断后，顶栏统计用）
  const [canvasCounts, setCanvasCounts] = useState<{ nodes: number; edges: number } | null>(null);

  // 搜索
  const [searchValue, setSearchValue] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ForceGraphEngine | null>(null);
  const fullGraphRef = useRef<NormalizedGraph | null>(null);
  // bloom 宿主：当前画布数据 + 代际记录
  const canvasRef = useRef<CanvasData | null>(null);
  const generationsRef = useRef<Map<string, number>>(new Map());
  const genCounterRef = useRef(0);
  const modeRef = useRef<GraphMode>('overview');
  const egoCenterRef = useRef<string | null>(null);
  const activeVaultIdRef = useRef(activeVaultId);
  useEffect(() => {
    activeVaultIdRef.current = activeVaultId;
  }, [activeVaultId]);

  const { settings, updateSettings, updateForce } = useGraphSettings();

  // system 主题跟随 OS：matchMedia 变化时重渲染（resolveTheme 自身不订阅）
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const resolvedTheme =
    settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;

  // ── 可见性谓词：死链 / 孤立节点 / 类型过滤（与旧版语义一致）──
  const visiblePred = useCallback(
    (n: { deadLink?: boolean; linkCount: number; nodeType?: string }) => {
      if (n.deadLink && !settings.showDeadLinks) return false;
      if (!n.deadLink && n.linkCount === 0 && !settings.showOrphans) return false;
      if (settings.visibleTypes.length > 0 && n.nodeType && !settings.visibleTypes.includes(n.nodeType)) {
        return false;
      }
      return true;
    },
    [settings.showDeadLinks, settings.showOrphans, settings.visibleTypes],
  );

  // ── 引擎事件（ref 转发，构造一次不随渲染变化）──
  const eventsRef = useRef({
    onNodeDblClick: (_key: string) => {},
    onNodeShiftClick: (_key: string) => {},
    onBloomRequest: (_key: string) => {},
    onSelectChange: (_key: string | null) => {},
  });
  eventsRef.current.onNodeDblClick = (key: string) => {
    // 双击契约：打开知识库文档（原 GraphPage 行为）
    const node = fullGraphRef.current?.nodeMap.get(key);
    if (node?.path) {
      navigate('/knowledge', { state: { openFile: node.path, vaultId: activeVaultIdRef.current } });
    }
  };
  eventsRef.current.onNodeShiftClick = (key: string) => bloom(key);
  eventsRef.current.onBloomRequest = (key: string) => bloom(key);
  eventsRef.current.onSelectChange = (key: string | null) => setSelectedKey(key);

  const engineEvents = useMemo(
    () => ({
      onNodeDblClick: (key: string) => eventsRef.current.onNodeDblClick(key),
      onNodeShiftClick: (key: string) => eventsRef.current.onNodeShiftClick(key),
      onBloomRequest: (key: string) => eventsRef.current.onBloomRequest(key),
      onSelectChange: (key: string | null) => eventsRef.current.onSelectChange(key),
    }),
    [],
  );

  // ── 引擎生命周期：callback ref 创建一次，路由离开才销毁 ──
  const containerCallbackRef = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      if (el && !engineRef.current) {
        const engine = new ForceGraphEngine(el, { events: engineEvents });
        engine.setNodeColors(NODE_TYPE_COLORS);
        engineRef.current = engine;
      }
      if (!el && engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }
    },
    [engineEvents],
  );

  // ── 取数：vault 切换时拉全图并重置状态机 ──
  useEffect(() => {
    if (!activeVaultId) return;

    setLoading(true);
    setError(null);
    api
      .getGraph(activeVaultId)
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

  /** 画布数据 → 引擎输入（hiddenNeighbors 由全图邻接表现算） */
  const pushCanvas = useCallback(
    (canvas: CanvasData, opts: { preserveLayout?: boolean; anchorKey?: string; focusKey?: string } = {}) => {
      const engine = engineRef.current;
      const full = fullGraphRef.current;
      if (!engine || !full) return;
      canvasRef.current = canvas;
      const hidden = computeHiddenNeighbors(canvas, full);
      engine.setData(toEngineData(canvas, hidden), opts);
      setCanvasCounts({ nodes: canvas.nodes.length, edges: canvas.edges.length });
    },
    [],
  );

  // ── 状态机转换 ──

  /** overview：过滤后超 cap 取 top-N（截断提示） */
  const renderOverview = useCallback(() => {
    const full = fullGraphRef.current;
    if (!full) return;
    const { data, truncated: isTruncated } = overviewTopN(full, visiblePred);
    setMode('overview');
    modeRef.current = 'overview';
    setEgoCenter(null);
    egoCenterRef.current = null;
    setTruncated(isTruncated);
    generationsRef.current = new Map();
    genCounterRef.current = 0;
    pushCanvas(data);
  }, [pushCanvas, visiblePred]);

  /** pivot：以 key 为中心的 ego 子图（本地 BFS） */
  const pivot = useCallback(
    (key: string) => {
      const full = fullGraphRef.current;
      if (!full || !full.nodeMap.has(key)) return;
      const slice = egoSlice(full, key, 1);
      setMode('ego');
      modeRef.current = 'ego';
      setEgoCenter(key);
      egoCenterRef.current = key;
      setTruncated(false);
      generationsRef.current = new Map(slice.nodes.map((n) => [n.key, 0]));
      genCounterRef.current = 0;
      pushCanvas(slice, { focusKey: key });
    },
    [pushCanvas],
  );

  /** bloom：合并 key 的 ego 邻域进画布；不带新节点时回落 pivot（同 WeKnora overview 回落） */
  function bloom(key: string) {
    const full = fullGraphRef.current;
    const canvas = canvasRef.current;
    if (!full || !canvas || !full.nodeMap.has(key)) return;
    const incoming = egoSlice(full, key, 1);
    const before = canvas.nodes.length;
    const gens = generationsRef.current;
    genCounterRef.current += 1;
    let merged = mergeGraphData(canvas, incoming, genCounterRef.current, gens);
    merged = evictBloomOverflow(merged, new Set([
      egoCenterRef.current ?? '',
      key,
      selectedKey ?? '',
    ].filter(Boolean)), gens);
    if (merged.nodes.length <= before && modeRef.current === 'overview') {
      // 全图已在画布，bloom 无新信息 → 改为聚焦视图
      pivot(key);
      return;
    }
    pushCanvas(merged, { preserveLayout: true, anchorKey: key });
  }

  /** 返回全图 */
  const exitEgo = useCallback(() => {
    renderOverview();
  }, [renderOverview]);

  // 数据到达 / 过滤变化 → 重建 overview（ego 模式下的过滤变化只走引擎层隐藏）
  useEffect(() => {
    if (!graphData) {
      fullGraphRef.current = null;
      canvasRef.current = null;
      setCanvasCounts(null);
      return;
    }
    fullGraphRef.current = normalizeGraphData(graphData);
    renderOverview();
  }, [graphData, renderOverview]);

  // 过滤变化在 ego 模式下同步隐藏（引擎层），overview 已被上面重建覆盖
  useEffect(() => {
    if (modeRef.current === 'ego') {
      engineRef.current?.applyFilters(visiblePred);
    }
  }, [visiblePred]);

  // ── 设置 live 应用（不全量重建）──
  useEffect(() => {
    engineRef.current?.setNodeScale(settings.nodeScale);
  }, [settings.nodeScale]);

  useEffect(() => {
    engineRef.current?.setEdgeWidth(settings.edgeWidth);
  }, [settings.edgeWidth]);

  useEffect(() => {
    engineRef.current?.setForceParams(settings.forces);
  }, [settings.forces]);

  useEffect(() => {
    engineRef.current?.setNodePalette(nodePaletteFor(resolvedTheme));
  }, [resolvedTheme]);

  // ── 搜索：本地过滤全图节点 ──
  const searchResults = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    const full = fullGraphRef.current;
    if (!q || !full) return [];
    const inEgo = modeRef.current === 'ego';
    return Array.from(full.nodeMap.values())
      .filter((n) => (inEgo ? !n.deadLink : true) && n.label.toLowerCase().includes(q))
      .sort((a, b) => b.linkCount - a.linkCount)
      .slice(0, 20);
  }, [searchValue, graphData]);

  const handleSearchSelect = useCallback(
    (key: string) => {
      setSearchValue('');
      setSearchOpen(false);
      const canvas = canvasRef.current;
      const onCanvas = canvas?.nodes.some((n) => n.key === key);
      if (onCanvas) {
        engineRef.current?.setSelected(key);
        engineRef.current?.flyToNode(key);
      } else {
        pivot(key);
      }
    },
    [pivot],
  );

  // ── 派生显示数据 ──
  const selectedNode = selectedKey ? fullGraphRef.current?.nodeMap.get(selectedKey) ?? null : null;
  const egoCenterNode = egoCenter ? fullGraphRef.current?.nodeMap.get(egoCenter) ?? null : null;

  const nodeCount = canvasCounts?.nodes ?? 0;
  const edgeCount = canvasCounts?.edges ?? 0;

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
    <div className="graph-page" data-theme={resolvedTheme}>
      <div className="graph-topbar">
        <div className="graph-topbar__left">
          <h2 className="graph-topbar__title">{t('graph.title')}</h2>
          {mode === 'ego' && egoCenterNode && (
            <span className="graph-ego-chip" data-testid="graph-ego-chip">
              {t('graph.ego.focus', { label: egoCenterNode.label })}
              <button
                className="graph-ego-chip__exit"
                data-testid="graph-ego-exit"
                onClick={exitEgo}
                title={t('graph.ego.exit')}
              >
                ✕
              </button>
            </span>
          )}
        </div>
        <div className="graph-topbar__right">
          {graphData && !loading && (
            <div className="graph-search">
              <input
                className="graph-search__input"
                data-testid="graph-search-input"
                placeholder={t('graph.search.placeholder')}
                value={searchValue}
                onChange={(e) => {
                  setSearchValue(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchResults.length > 0) {
                    handleSearchSelect(searchResults[0].key);
                  } else if (e.key === 'Escape') {
                    setSearchOpen(false);
                  }
                }}
              />
              {searchOpen && searchValue.trim() && (
                <ul className="graph-search__list" data-testid="graph-search-list">
                  {searchResults.length === 0 && (
                    <li className="graph-search__empty">{t('graph.search.empty')}</li>
                  )}
                  {searchResults.map((n) => (
                    <li key={n.key}>
                      <button
                        className="graph-search__item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleSearchSelect(n.key)}
                      >
                        <span className="graph-search__label">{n.label}</span>
                        <span className="graph-search__count">{n.linkCount}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {graphData && !loading && (
            <span className="graph-stat" title={t('graph.nodes.title')}>
              {t('graph.nodes', { count: nodeCount })}
            </span>
          )}
          {graphData && !loading && (
            <span className="graph-stat graph-stat--edges">{t('graph.edges', { count: edgeCount })}</span>
          )}
          {truncated && (
            <span className="graph-stat graph-stat--truncated" title={t('graph.truncated')}>
              TOP {nodeCount}
            </span>
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

        <div ref={containerCallbackRef} className="graph-svg-host" />

        {/* 选中节点浮动卡片（替代 WeKnora drawer 的轻量版） */}
        {selectedNode && !loading && !error && (
          <div className="graph-node-card" data-testid="graph-node-card">
            <button
              className="graph-node-card__close"
              data-testid="graph-card-close"
              onClick={() => engineRef.current?.setSelected(null)}
            >
              ✕
            </button>
            <div className="graph-node-card__title">{selectedNode.label}</div>
            <div className="graph-node-card__meta">
              {selectedNode.nodeType && (
                <span
                  className="graph-node-card__type"
                  style={{ background: NODE_TYPE_COLORS[selectedNode.nodeType] ?? '#8899AA' }}
                >
                  {NODE_TYPE_LABELS[selectedNode.nodeType] ?? selectedNode.nodeType}
                </span>
              )}
              <span>{t('graph.card.links', { count: selectedNode.linkCount })}</span>
            </div>
            {selectedNode.path && <div className="graph-node-card__path">{selectedNode.path}</div>}
            {selectedNode.deadLink && (
              <div className="graph-node-card__dead">{t('graph.card.dead')}</div>
            )}
            <div className="graph-node-card__actions">
              {selectedNode.path && (
                <button
                  data-testid="graph-card-open"
                  onClick={() =>
                    navigate('/knowledge', {
                      state: { openFile: selectedNode.path, vaultId: activeVaultId },
                    })
                  }
                >
                  {t('graph.card.open')}
                </button>
              )}
              <button data-testid="graph-card-focus" onClick={() => pivot(selectedNode.key)}>
                {t('graph.card.focus')}
              </button>
              {!selectedNode.deadLink && (
                <button data-testid="graph-card-bloom" onClick={() => bloom(selectedNode.key)}>
                  ⊕ {t('graph.card.bloom')}
                </button>
              )}
            </div>
          </div>
        )}

        {/* 图谱设置面板 */}
        {graphData && showSettings && (
          <GraphSettingsPanel
            settings={settings}
            onUpdateSettings={updateSettings}
            onUpdateForce={(patch) => {
              updateForce(patch);
              engineRef.current?.setForceParams(patch);
            }}
            onClose={() => setShowSettings(false)}
            availableTypes={graphData.nodes
              .map((n) => n.nodeType)
              .filter((tp): tp is string => !!tp)}
          />
        )}
      </div>
    </div>
  );
}

/** contracts 画布数据 → 引擎输入（hiddenNeighbors 由 GraphPage 用全图邻接表算好传入） */
function toEngineData(
  canvas: CanvasData,
  hidden: Map<string, number>,
): EngineData {
  const nodes: EngineNodeInput[] = canvas.nodes.map((n) => ({
    key: n.key,
    label: n.label,
    linkCount: n.linkCount,
    nodeType: n.nodeType,
    dead: n.deadLink ?? false,
    hiddenNeighbors: hidden.get(n.key) ?? 0,
  }));
  return { nodes, edges: canvas.edges };
}

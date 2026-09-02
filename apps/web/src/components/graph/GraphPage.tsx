/**
 * GraphPage — Obsidian-style force-directed knowledge graph.
 *
 * 渲染层：PixiGraphEngine（PixiJS WebGL + d3-force，移植自 Quartz v4，MIT）。
 * 本组件只负责：数据获取、筛选计算、设置面板、引擎生命周期与回调路由。
 * 坐标计算和渲染帧循环在引擎内部闭环，零 React re-render。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GraphData, GraphNode } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useActiveVaultId, vaultStore } from '../../stores/vaultStore';
import { useGraphSettings } from './useGraphSettings';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import { GraphSearchBox } from './GraphSearchBox';
import { Minimap } from './Minimap';
import { getThemeColors, resolveTheme } from './types';
import {
  PixiGraphEngine,
  type EngineNode,
  type EngineEdge,
} from './engine/pixiGraphEngine';

export function GraphPage({ active = true }: { active?: boolean } = {}) {
  const { t } = useI18n();
  const navigate = useNavigate();

  // 跟随知识库的活跃 vault，知识库切换时图谱自动切换
  const activeVaultId = useActiveVaultId();
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // 搜索折叠态：常驻一个 🔍 图标，点开/按 / 展开输入框；统计收敛进 ℹ（点开显示）。
  const [searchOpen, setSearchOpen] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PixiGraphEngine | null>(null);
  const [engine, setEngine] = useState<PixiGraphEngine | null>(null);

  const { settings, updateSettings, updateForce } = useGraphSettings();
  const themeColors = getThemeColors(settings.theme);

  // 供引擎回调读取的最新值（避免重建引擎）
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const vaultIdRef = useRef(activeVaultId);
  vaultIdRef.current = activeVaultId;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const themeRef = useRef(themeColors);
  themeRef.current = themeColors;

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

  // ── 筛选后的图数据（引擎只接收可见节点）──
  const engineData = useMemo((): { nodes: EngineNode[]; edges: EngineEdge[] } | null => {
    if (!graphData) return null;

    const nodes: EngineNode[] = [];
    const keys = new Set<string>();
    for (const n of graphData.nodes) {
      // 死链节点过滤（daemon 已把死链目标作为节点并入图）
      if (n.deadLink && !settings.showDeadLinks) continue;
      // 孤立节点过滤（无连线的真实节点）
      if (n.linkCount === 0 && !settings.showOrphans) continue;
      // 类型过滤（仅对显式标注类型的节点生效）
      if (n.nodeType && settings.visibleTypes.length > 0 && !settings.visibleTypes.includes(n.nodeType)) continue;
      nodes.push(toEngineNode(n));
      keys.add(n.key);
    }

    const edges: EngineEdge[] = graphData.edges.filter(
      (e) => keys.has(e.source) && keys.has(e.target),
    );
    return { nodes, edges };
  }, [graphData, settings.showOrphans, settings.showDeadLinks, settings.visibleTypes]);

  const hasData = !!engineData && engineData.nodes.length > 0;

  // `/` 快捷键：在非输入态下展开图谱搜索。与全局搜索 Ctrl/Cmd+F 区分，不冲突。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!hasData || !engine) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasData, engine]);

  // 搜索开合：外部点击 / Esc 收起（点在搜索框内则保留）。
  useEffect(() => {
    if (!searchOpen && !showStats) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (searchRef.current?.contains(t)) return;
      if ((t as HTMLElement)?.closest?.('.graph-stats-ctrl')) return;
      setSearchOpen(false);
      setShowStats(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSearchOpen(false); setShowStats(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [searchOpen, showStats]);

  // ── 引擎生命周期：首次有数据时异步创建 ──
  useEffect(() => {
    if (!hasData || !containerRef.current || engineRef.current) return;

    let cancelled = false;
    const container = containerRef.current;
    PixiGraphEngine.create(container, {
      theme: themeRef.current,
      forces: settingsRef.current.forces,
      nodeScale: settingsRef.current.nodeScale,
      edgeWidth: settingsRef.current.edgeWidth,
    }).then((eng) => {
      if (cancelled) {
        eng.destroy();
        return;
      }
      // hover 高亮由引擎内部处理；单击/双击节点都跳转文档
      const openNode = (_key: string, node: EngineNode) => {
          const vaultId = vaultIdRef.current;
          if (!vaultId) return;
          if (node.path) {
            navigateRef.current('/knowledge', {
              state: { openFile: node.path, vaultId },
            });
          } else if (node.dead) {
            // 死链节点 → 新建空白页并打开（Obsidian 行为：点未解析链接即建笔记）
            const fileName = /\.md$/i.test(node.label) ? node.label : `${node.label}.md`;
            api
              .writeFile(vaultId, fileName, '')
              .then(() => {
                navigateRef.current('/knowledge', {
                  state: { openFile: fileName, vaultId },
                });
              })
              .catch((err) => {
                console.error('[graph] 创建死链目标文件失败:', err);
              });
          }
        };
      eng.setCallbacks({ onNodeClick: openNode, onNodeDoubleClick: openNode });
      engineRef.current = eng;
      // 开发环境调试句柄：像素提取（renderer.extract）与布局检查
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__graphEngine = eng;
      }
      setEngine(eng);
    }).catch((err) => {
      // WebGL 初始化失败（如 GPU 不可用）——降级为错误提示
      console.error('[graph] PixiJS init failed:', err);
      setError('图谱渲染初始化失败（WebGL 不可用）');
    });

    return () => {
      cancelled = true;
    };
  }, [hasData]);

  // Keep-alive: when the graph tab is tabbed away (active=false) but stays
  // mounted, pause the engine so a hidden canvas doesn't burn rAF/CPU; resume
  // on return. Node positions and viewport are preserved across the pause.
  useEffect(() => {
    engine?.setPaused(!active);
  }, [engine, active]);

  // 组件卸载时销毁引擎
  useEffect(() => {
    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  // ── 数据推送：vault 切换时先清位置缓存，再 setData ──
  const lastVaultRef = useRef<string | null>(null);
  useEffect(() => {
    if (!engine || !engineData) return;
    if (lastVaultRef.current !== activeVaultId) {
      lastVaultRef.current = activeVaultId;
      engine.resetPositions();
    }
    engine.setData(engineData.nodes, engineData.edges);
  }, [engine, engineData, activeVaultId]);

  // ── 外观/力度参数实时下发（不重建仿真布局）──
  useEffect(() => {
    engine?.setStyle({ theme: themeColors });
  }, [engine, themeColors]);

  useEffect(() => {
    engine?.setStyle({ nodeScale: settings.nodeScale, edgeWidth: settings.edgeWidth });
  }, [engine, settings.nodeScale, settings.edgeWidth]);

  useEffect(() => {
    engine?.setForces(settings.forces);
  }, [engine, settings.forces]);

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
          <p className="graph-empty__hint">{t('graph.noVaultHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-page">
      <div className="graph-topbar">
        {/* 左端：预留前进/后退（#247 设计，等 #244 store 合入后落地） */}
        <div className="graph-topbar__left" />
        <div className="graph-topbar__right">
          {/* 搜索：默认 🔍 图标，点开/按 / 展开输入框（从图标向左滑入）；与全局 Ctrl/Cmd+F 区分 */}
          {hasData && engine && engineData && (
            <div className="graph-search-ctrl" ref={searchRef}>
              {searchOpen && (
                <div className="graph-search-expand">
                  <GraphSearchBox
                    autoFocus
                    nodes={engineData.nodes}
                    onSelect={(key) => {
                      engineRef.current?.focusNode(key);
                    }}
                  />
                </div>
              )}
              <button
                type="button"
                className={`graph-icon-btn${searchOpen ? ' is-active' : ''}`}
                onClick={() => setSearchOpen((v) => !v)}
                title={`${t('graph.searchNodes')} (/)`}
                aria-label={t('graph.searchNodes')}
                data-testid="graph-search-open"
              >
                {/* 定位（crosshair）：在图谱里定位节点，与全局全文搜索的放大镜区分 */}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <circle cx="12" cy="12" r="6" />
                  <line x1="12" y1="2" x2="12" y2="6" />
                  <line x1="12" y1="18" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="6" y2="12" />
                  <line x1="18" y1="12" x2="22" y2="12" />
                </svg>
              </button>
            </div>
          )}
          {/* 统计：收敛进 ℹ，点击展示 */}
          {graphData && !loading && (
            <div className="graph-stats-ctrl">
              {showStats && (
                <div className="graph-stats-pop">
                  <span>{t('graph.nodes', { count: nodeCount })}</span>
                  <span>{t('graph.edges', { count: edgeCount })}</span>
                  {graphData.deadLinks && graphData.deadLinks.length > 0 && (
                    <span className="graph-stat--deadlink">{t('graph.deadLinks', { count: graphData.deadLinks.length })}</span>
                  )}
                </div>
              )}
              <button
                type="button"
                className={`graph-icon-btn${showStats ? ' is-active' : ''}`}
                onClick={() => setShowStats((v) => !v)}
                title={t('graph.stats')}
                aria-label={t('graph.stats')}
              >
                {/* 柱状图：实心填充，一眼即"数据统计" */}
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <rect x="4" y="12" width="3.6" height="8" rx="1" />
                  <rect x="10.2" y="7" width="3.6" height="13" rx="1" />
                  <rect x="16.4" y="3" width="3.6" height="17" rx="1" />
                </svg>
              </button>
            </div>
          )}
          <button
            className={`graph-settings-btn ${showSettings ? 'is-active' : ''}`}
            onClick={() => setShowSettings(!showSettings)}
            title={t('graph.settings')}
          >
            {/* 调节滑杆：设置面板（筛选/力度滑杆）一眼即"调整" */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
              <line x1="4" y1="8" x2="20" y2="8" />
              <circle cx="9" cy="8" r="2.6" />
              <line x1="4" y1="16" x2="20" y2="16" />
              <circle cx="15" cy="16" r="2.6" />
            </svg>
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
            <p className="graph-empty__hint">{t('graph.emptyHint')}</p>
          </div>
        )}

        <div ref={containerRef} className="graph-pixi" data-testid="graph-canvas" />

        {/* 引擎就绪后才挂载 Minimap，避免空画布占据右下角拦截指针事件 */}
        {engine && <Minimap engine={engine} dark={resolveTheme(settings.theme) === 'dark'} />}

        {/* 图谱设置面板 */}
        {graphData && showSettings && (
          <GraphSettingsPanel
            settings={settings}
            onUpdateSettings={updateSettings}
            onUpdateForce={(patch) => {
              updateForce(patch);
              // 力度参数经 settings → effect 下发到引擎（单一数据源）
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

function toEngineNode(n: GraphNode): EngineNode {
  return {
    key: n.key,
    label: n.label,
    path: n.path,
    linkCount: n.linkCount,
    nodeType: n.nodeType ?? null,
    dead: n.deadLink ?? false,
  };
}

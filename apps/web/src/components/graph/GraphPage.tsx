/**
 * GraphPage — Obsidian-style force-directed knowledge graph.
 *
 * 渲染层：PixiGraphEngine（PixiJS WebGL + d3-force，移植自 Quartz v4，MIT）。
 * 本组件只负责：数据获取、筛选计算、设置面板、引擎生命周期与回调路由。
 * 坐标计算和渲染帧循环在引擎内部闭环，零 React re-render。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GraphData, GraphNode, GraphScope } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useActiveVaultId, vaultStore } from '../../stores/vaultStore';
import { navigationHistoryStore, useNavigationHistory } from '../../stores/navigationHistoryStore';
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

/** 图谱剔除的 .md 基名（小写）——镜像 daemon `routes/graph.ts` 的 GRAPH_EXCLUDED_BASENAMES，
 *  仅用于挑空态文案，不参与数据过滤（过滤在 daemon）。 */
const GRAPH_EXCLUDED_BASENAMES = new Set(['index', 'log']);

export function GraphPage({
  active = true,
  onCloseCompanion,
  // 局部图作用域（null = 全量图，严格 no-op）：file=单文档 1 跳邻域 / dir=文件夹子图。
  // 由宿主传入：对照副视图传 file-scope，主格图谱 tab 传 graphTabScope（file/dir）。
  graphScope = null,
  onNodeOpen,
  onScopeReset,
}: {
  active?: boolean;
  onCloseCompanion?: () => void;
  graphScope?: GraphScope | null;
  onNodeOpen?: () => void;
  onScopeReset?: () => void;
} = {}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  // 与文件标签标题栏同一份视图历史（#244 store）——图谱也是一个「被看过的视图」
  const { canGoBack, canGoForward } = useNavigationHistory();

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
  // 局部图分支同样经 ref 读取最新值：fetch/push effect 的 deps 只放 scopeKey 字符串，
  // 绝不 dep scope 对象（父组件每次渲染都新建对象字面量会把 effect 打成每次渲染重跑）
  const scopeRef = useRef<GraphScope | null>(graphScope);
  scopeRef.current = graphScope;
  const activeRef = useRef(active);
  activeRef.current = active;
  // 引擎回调 / topbar 按钮都只创建一次，必须走 ref 才能拿到最新的回调实现
  const onNodeOpenRef = useRef(onNodeOpen);
  onNodeOpenRef.current = onNodeOpen;
  const onScopeResetRef = useRef(onScopeReset);
  onScopeResetRef.current = onScopeReset;
  // scope 的稳定标识：换 file / 换 dir 才重新拉数据
  const scopeKey = graphScope ? `${graphScope.type}:${graphScope.path}` : null;

  // Fetch graph data when active vault / scope changes
  useEffect(() => {
    if (!activeVaultId) return;

    // 局部分支：按 scopeRef.current 分派局部图 / 全量图（deps 用 scopeKey，不含 scope 对象）
    const scope = scopeRef.current;

    // cancelled：快速切换 scope/file 时丢弃陈旧响应（慢的旧请求晚到不能覆盖新数据）
    let cancelled = false;
    setLoading(true);
    setError(null);
    const req = scope
      ? api.getLocalGraph(activeVaultId, scope)
      : api.getGraph(activeVaultId);
    req
      .then((data) => {
        if (cancelled) return;
        setGraphData(data);
      })
      .catch((err) => {
        if (cancelled) return;
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
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeVaultId, scopeKey]);

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

  // 空态文案按 scope 细分——全量图空态只说「库里没有 md」，对局部图是误导
  // （库里有 md，只是这个文件/目录没有可显示的关系）。
  const emptyCopy = useMemo(() => {
    const scope = graphScope;
    if (!scope) return { title: t('graph.empty'), hint: t('graph.emptyHint') };
    if (scope.type === 'dir') return { title: t('graph.emptyDir'), hint: t('graph.emptyDirHint') };
    // file-scope：图谱只收录除 index / log 之外的 .md（与 daemon 的 isGraphExcludedFile 同规则，
    // 仅用于选文案；规则若变更这里只需同步措辞，不影响功能）。
    const base = scope.path.split('/').pop() ?? scope.path;
    const isMd = /\.md$/i.test(base);
    const excluded = isMd && GRAPH_EXCLUDED_BASENAMES.has(base.replace(/\.md$/i, '').toLowerCase());
    return isMd && !excluded
      ? { title: t('graph.emptyFile'), hint: t('graph.emptyFileHint') }
      : { title: t('graph.emptyOutOfGraph'), hint: t('graph.emptyOutOfGraphHint') };
  }, [graphScope, t]);

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
      // hover 高亮由引擎内部处理；单击/双击节点都跳转文档（见下方 setCallbacks）
      const openNode = (_key: string, node: EngineNode) => {
          const vaultId = vaultIdRef.current;
          if (!vaultId) return;
          if (node.path) {
            navigateRef.current('/knowledge', {
              state: { openFile: node.path, vaultId },
            });
            // 可选宿主通知：在本组件已 navigate 到节点文件后触发一次（走 ref——setCallbacks 只在引擎创建时调用一次）。
            // 当前无宿主传 onNodeOpen，此调用为 no-op；如未来 graph-as-tab 宿主接管跳转可在此接收。
            onNodeOpenRef.current?.();
          } else if (node.dead) {
            // 死链节点 → 新建空白页并打开（Obsidian 行为：点未解析链接即建笔记）
            const fileName = /\.md$/i.test(node.label) ? node.label : `${node.label}.md`;
            api
              .writeFile(vaultId, fileName, '')
              .then(() => {
                navigateRef.current('/knowledge', {
                  state: { openFile: fileName, vaultId },
                });
                onNodeOpenRef.current?.();
              })
              .catch((err) => {
                console.error('[graph] 创建死链目标文件失败:', err);
              });
          }
        };
      // 单击 / 双击节点都打开文章 —— 三处图谱（全量图 / 局部知识图谱 / 对照）行为完全一致。
      // 「高亮关联」由悬停承担（引擎 hover 两档：非邻居淡化 + 关联边置顶），与 Obsidian 原生图谱同款
      // （悬停高亮、单击打开）；「单击选中」不提供——它与悬停重复，而「看邻域」已由局部知识图谱专门承担。
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
  // 上一次的 scope 标识：用于识别「局部图 → 全量图」的返回（需要重新取景）
  const prevScopeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!engine) return;
    const scope = scopeRef.current;
    const prevScopeKey = prevScopeKeyRef.current;
    prevScopeKeyRef.current = scope ? `${scope.type}:${scope.path}` : null;

    // 空数据必须清引擎：hasData 翻转后 .graph-empty 只是视觉遮罩（不透明背景 + z-index），
    // 不清掉的话旧子图仍在遮罩背后继续仿真耗 CPU；但引擎本身不销毁（tab 切回还要用）。
    if (!engineData) {
      engine.setData([], []);
      return;
    }
    if (lastVaultRef.current !== activeVaultId) {
      lastVaultRef.current = activeVaultId;
      engine.resetPositions();
    }
    engine.setData(engineData.nodes, engineData.edges);

    if (!scope) {
      // 全量图：从局部图返回时旧视口（局部子图的缩放/平移）已无意义 —— 立即框住整图，
      // 并清掉交互标记，让仿真收敛后再平滑 fit 一次（与首次打开全量图同样的观感）。
      if (prevScopeKey) {
        engine.fitView({ animate: false });
        engine.reframeOnSettle();
      }
      return;
    }
    // 局部图：setData 后按 scope 类型居中。必须走动画路径：animateToViewport 会置
    // hasUserInteracted=true，从而抑制 sim end 的自动 refit；非动画 setTransform 不置位，
    // 居中结果会被 refit 覆盖。active 不进 deps（读 activeRef）——companion 开合若触发
    // effect 会全量重跑 setData。
    if (scope.type === 'file') {
      // file：圆心节点居中放大；圆心被筛选条件滤掉（不在可见节点里）时退化为整图 fit
      const focusKey = graphData?.focusNodes?.[0];
      if (focusKey && engineData.nodes.some((n) => n.key === focusKey)) {
        engine.focusNode(focusKey, { durationMs: activeRef.current ? 600 : 0 });
      } else {
        engine.fitView({ animate: false });
      }
    } else {
      // dir：子图整体 fit（可见时平滑动画，隐藏的 companion 副格直接落位）
      engine.fitView({ animate: activeRef.current });
    }
  }, [engine, engineData, activeVaultId, graphData]);

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
        {/* 左端：前进/后退（与文件标签标题栏最左同一份历史；常驻、disabled 置灰，
            与 #244 的 .kb-nav-btn 同款裸 chevron 样式）。
            主格专属：图谱做副视图（分屏对照，onCloseCompanion 存在）时不渲染，
            避免「在右格点后退、左格却变了」的误导。 */}
        {!onCloseCompanion && (
          <div className="kb-nav-group graph-topbar__left" data-testid="graph-nav-navigation">
            <button
              type="button"
              className="kb-nav-btn"
              data-testid="graph-nav-back"
              disabled={!canGoBack}
              onClick={() => navigationHistoryStore.back()}
              aria-label={t('nav.back')}
            >
              ‹
            </button>
            <button
              type="button"
              className="kb-nav-btn"
              data-testid="graph-nav-forward"
              disabled={!canGoForward}
              onClick={() => navigationHistoryStore.forward()}
              aria-label={t('nav.forward')}
            >
              ›
            </button>
          </div>
        )}
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
                data-tooltip={`${t('graph.searchNodes')} (/)`}
                aria-label={t('graph.searchNodes')}
                data-testid="graph-search-open"
              >
                {/* 定位（瞄准镜/定位点）：在图谱里定位节点，与全局搜索放大镜区分 */}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <circle cx="12" cy="12" r="6.5" />
                  <line x1="12" y1="1.5" x2="12" y2="5.5" />
                  <line x1="12" y1="18.5" x2="12" y2="22.5" />
                  <line x1="1.5" y1="12" x2="5.5" y2="12" />
                  <line x1="18.5" y1="12" x2="22.5" y2="12" />
                  <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
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
                data-tooltip={t('graph.stats')}
                aria-label={t('graph.stats')}
              >
                {/* 柱状图：一眼即"数据统计" */}
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <rect x="4" y="13" width="3.8" height="7" rx="1.9" />
                  <rect x="10.1" y="9" width="3.8" height="11" rx="1.9" />
                  <rect x="16.2" y="5" width="3.8" height="15" rx="1.9" />
                </svg>
              </button>
            </div>
          )}
          <button
            className={`graph-settings-btn ${showSettings ? 'is-active' : ''}`}
            onClick={() => setShowSettings(!showSettings)}
            data-tooltip={t('graph.settings')}
          >
            {/* 调节滑杆：设置面板（筛选/力度滑杆）一眼即"调整" */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
              <line x1="4" y1="8" x2="20" y2="8" />
              <circle cx="9" cy="8" r="2.7" />
              <line x1="4" y1="16" x2="20" y2="16" />
              <circle cx="15" cy="16" r="2.7" />
            </svg>
          </button>
          {/* 局部图作用域的「回到全量图」：任意非空 scope 都显示（file/dir 均由宿主是否传 onScopeReset 决定）
              —— 与搜索/统计/设置同款磨砂 icon-btn；onClick 走 ref，避免闭包过期 */}
          {graphScope && onScopeReset && (
            <button
              type="button"
              className="graph-icon-btn"
              onClick={() => onScopeResetRef.current?.()}
              data-tooltip={t('graph.scopeBack')}
              aria-label={t('graph.scopeBack')}
              data-testid="graph-scope-back"
            >
              {/* 左指箭头：返回全量图 */}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <path d="M19 12H5" />
                <path d="M11 6l-6 6 6 6" />
              </svg>
            </button>
          )}
          {/* 副视图（分屏）关闭 × —— 与搜索/统计/设置同款磨砂 chip，放进图谱自己的 topbar */}
          {onCloseCompanion && (
            <button
              type="button"
              className="graph-icon-btn"
              onClick={onCloseCompanion}
              data-tooltip={t('kb.close')}
              aria-label={t('kb.close')}
              data-testid="companion-close"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
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
            <p>{emptyCopy.title}</p>
            <p className="graph-empty__hint">{emptyCopy.hint}</p>
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

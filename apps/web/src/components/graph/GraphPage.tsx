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

export function GraphPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  // 跟随知识库的活跃 vault，知识库切换时图谱自动切换
  const activeVaultId = useActiveVaultId();
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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
        </div>
      </div>
    );
  }

  return (
    <div className="graph-page">
      <div className="graph-topbar">
        <div className="graph-topbar__left">
          <h2 className="graph-topbar__title">{t('graph.title')}</h2>
          {/* 搜索只覆盖当前可见节点（engineData 已过滤 → 天然尊重筛选） */}
          {hasData && engine && engineData && (
            <GraphSearchBox
              nodes={engineData.nodes}
              onSelect={(key) => {
                engineRef.current?.focusNode(key);
              }}
            />
          )}
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

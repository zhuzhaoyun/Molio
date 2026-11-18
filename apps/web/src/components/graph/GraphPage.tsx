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
import { useActiveVault, useActiveVaultId, vaultStore } from '../../stores/vaultStore';
import { navigationHistoryStore, useNavigationHistory } from '../../stores/navigationHistoryStore';
import { useGraphSettings } from './useGraphSettings';
import { graphFingerprint, refreshDebounceMs } from './refreshPolicy';
import { buildTrunkScene, resolveTrunkView, trunkExportMeta, type TrunkScene } from './trunkScene';
import {
  buildExpansion,
  computeMiniSim,
  centroidOf,
  translatePositions,
  radialFillPositions,
  splitBatches,
  matchExpansionsOnRefresh,
} from './trunkExpand';
import { getLayoutService } from './layoutService';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import { GraphSearchBox } from './GraphSearchBox';
import { Minimap } from './Minimap';
import { getThemeColors, resolveTheme, NODE_TYPE_COLORS, NODE_TYPE_LABELS } from './types';
import {
  PixiGraphEngine,
  type EngineNode,
  type EngineEdge,
} from './engine/pixiGraphEngine';
import { exportFileName } from './engine/exportImage';
import {
  cardInkFor,
  collectLegend,
  computeCardLayout,
  drawCard,
  pickCoreTopics,
  type CardAspect,
} from './engine/exportCard';

/** 出图署名：免费、无开关。去水印是「负面购买」——向最愿意分享的人收费，
 *  正好掐掉获客本身；付费点应该是「换成你自己的署名」，不是把名字抹掉。 */
const EXPORT_WATERMARK = 'Molio';

/** 图谱剔除的 .md 基名（小写）——镜像 daemon `routes/graph.ts` 的 GRAPH_EXCLUDED_BASENAMES，
 *  仅用于挑空态文案，不参与数据过滤（过滤在 daemon）。 */
const GRAPH_EXCLUDED_BASENAMES = new Set(['index', 'log']);

/** 出图版式选项。`natural` 跟图的原始比例；其余是发布平台的常用比例。 */
const EXPORT_ASPECTS: Array<{ key: CardAspect; label: string }> = [
  { key: 'natural', label: 'graph.exportAspectNatural' },
  { key: 'square', label: 'graph.exportAspectSquare' },
  { key: 'portrait', label: 'graph.exportAspectPortrait' },
  { key: 'wide', label: 'graph.exportAspectWide' },
];

/**
 * 「库 + scope」合成键：指纹去重与在途反馈都以它为界。
 *
 * 只比内容指纹是不够的——两个不同 scope 的空子图载荷逐字节相同（nodes/edges/
 * deadLinks/focusNodes 全空），会被误判成「数据没变」而丢弃，界面就停在上一个
 * scope 上不动。同一库同一 scope 内才谈得上「内容没变」。
 */
function graphDataKey(vaultId: string | null | undefined, scopeKey: string | null): string {
  return `${vaultId ?? ''}|${scopeKey ?? ''}`;
}

export function GraphPage({
  active = true,
  onCloseCompanion,
  // 局部图作用域（null = 全量图，严格 no-op）：file=单文档 1 跳邻域 / dir=文件夹子图。
  // 由宿主传入：对照副视图传 file-scope，主格图谱 tab 传 graphTabScope（file/dir）。
  graphScope = null,
  onNodeOpen,
  onScopeReset,
  // 副视图（对照）模式：小参照面板 + 随主格文档高频重锚定。取景与时机都不同——
  // 取景用「整张子图 fit」而非「圆心居中放大」（小画布下后者会裁掉邻居），
  // 且布局同步跑完、瞬时取景，不做过渡动画（见下方数据推送 effect）。
  companion = false,
  // 「库变了」信号计数（useKnowledge.treeRevision）：图谱自动跟上文件树。
  // 宿主传值；图谱不可见时先记账、等可见了再刷（见下方防抖消费 effect）。
  revision = 0,
}: {
  active?: boolean;
  onCloseCompanion?: () => void;
  graphScope?: GraphScope | null;
  onNodeOpen?: () => void;
  onScopeReset?: () => void;
  companion?: boolean;
  revision?: number;
} = {}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  // 与文件标签标题栏同一份视图历史（#244 store）——图谱也是一个「被看过的视图」
  const { canGoBack, canGoForward } = useNavigationHistory();

  // 跟随知识库的活跃 vault，知识库切换时图谱自动切换
  const activeVaultId = useActiveVaultId();
  // 出图卡片的标题 —— 库名；拿不到就不出标题行（不拿 vaultId 凑数）
  const activeVault = useActiveVault();
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // 搜索折叠态：常驻一个 🔍 图标，点开/按 / 展开输入框；统计收敛进 ℹ（点开显示）。
  const [searchOpen, setSearchOpen] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  // 一键出图：气泡里二选一（下载 / 复制），气泡关掉后在原位飘一句结果
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  /** 出图版式：默认跟图的原始比例，固定比例是给发布平台用的（不裁切、只留白）。 */
  const [exportAspect, setExportAspect] = useState<CardAspect>('natural');
  /** 是否附带标题/统计/核心主题/图例。默认带（这是卡片的价值所在），
   *  但有人只想要一张干净的图 —— 给开关，不替他决定。署名始终保留。 */
  const [exportIncludeInfo, setExportIncludeInfo] = useState(true);
  const exportRef = useRef<HTMLDivElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PixiGraphEngine | null>(null);
  const [engine, setEngine] = useState<PixiGraphEngine | null>(null);

  const { settings, updateSettings, updateForce, resetSettings } = useGraphSettings();
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
  // trunk（T2）：引擎回调只建一次，经 ref 读最新值
  const updateSettingsRef = useRef(updateSettings);
  updateSettingsRef.current = updateSettings;

  // ── trunk 展开编排（H2，设计 §4.1 + 代拍 F/G + 评审 #3）──
  /** 展开缓存：clusterId → 位置（sim 坐标）+ 全量成员序 + 活性（收起翻假——刷新只匹配
   *  live 条目，代拍 G 的位置缓存保留但不得被后台刷新复活，终审 #2） */
  const expandedRef = useRef<
    Map<string, { positions: Map<string, { x: number; y: number }>; members: string[]; live: boolean }>
  >(new Map());
  /** 上一份 trunk 场景（后台刷新的身份重匹配用，代拍 O） */
  const prevTrunkSceneRef = useRef<TrunkScene | null>(null);
  // scope 的稳定标识：换 file / 换 dir 才重新拉数据
  const scopeKey = graphScope ? `${graphScope.type}:${graphScope.path}` : null;

  // 供防抖与去重读取的最新值（不进 deps，避免把它们变成 effect 触发器）
  const graphDataRef = useRef<GraphData | null>(null);
  graphDataRef.current = graphData;
  // 上一次「已采纳」数据的指纹（连同它所属的库+scope 键）：两者都相同才跳过 setGraphData
  // （对象不换 → 下游重排不跑）
  const fingerprintRef = useRef<{ key: string; fingerprint: string } | null>(null);
  // 展示中数据所属的库+scope 键：用来区分「换 scope」（必须有在途反馈）与后台自动刷新（不该闪）
  const shownKeyRef = useRef<string | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);

  // ── 库变了 → 防抖后刷新 ──
  // 复用文件树那条 `tree-changed` 信号（useKnowledge 的 treeRevision），不另开 SSE。
  // 两道闸门：① 图谱不可见不刷（keep-alive 的隐藏标签页没必要为看不见的重排买单），
  // 但记账不丢——下一次 active 翻转时补上；② 按图规模尾随防抖，把 AI 连续写入打出的
  // 多波信号合并成一次（大图一次重排数秒 CPU，多等一会儿更划算）。
  const [refreshTick, setRefreshTick] = useState(0);
  const consumedRevisionRef = useRef(revision);
  useEffect(() => {
    if (!active) return;
    if (consumedRevisionRef.current === revision) return;
    const timer = setTimeout(() => {
      consumedRevisionRef.current = revision;
      setRefreshTick((v) => v + 1);
    }, refreshDebounceMs(graphDataRef.current?.nodes.length ?? 0));
    return () => clearTimeout(timer);
  }, [revision, active]);

  // Fetch graph data when active vault / scope changes, or the vault content changes
  useEffect(() => {
    // 库被清空时在途请求会被 cleanup 取消，其 finally 不再执行——必须在这里收掉在途反馈，
    // 否则那枚芯片会永远盖在旧图上（库删除发生在换 scope 请求飞行途中时命中）。
    if (!activeVaultId) {
      setScopeLoading(false);
      return;
    }

    // 局部分支：按 scopeRef.current 分派局部图 / 全量图（deps 用 scopeKey，不含 scope 对象）
    const scope = scopeRef.current;

    // cancelled：快速切换 scope/file 时丢弃陈旧响应（慢的旧请求晚到不能覆盖新数据）
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 换 scope（全量图 ⇄ 局部图、局部图之间）而屏幕上已有旧图时，置在途反馈。
    // 后台自动刷新（refreshTick 触发）键没变，不置——那里数据没变就该保持原样、不闪加载态。
    const dedupKey = graphDataKey(activeVaultId, scopeKey);
    if (shownKeyRef.current !== dedupKey) setScopeLoading(true);
    const req = scope
      ? api.getLocalGraph(activeVaultId, scope)
      : api.getGraph(activeVaultId);
    req
      .then((data) => {
        if (cancelled) return;
        // 指纹去重：库变了 ≠ 图谱变了。往 raw/ 拷个 PDF、改个错别字同样会推 tree-changed，
        // 而重建一次要重跑整轮力导向仿真；数据没变就保持原对象，下游 setData/重排全不跑。
        // 但去重只在**同一库 + 同一 scope** 内成立：换 scope 时哪怕内容逐字节相同
        // （两个不同的空子图正是如此）也必须采纳，否则界面停在上一个 scope 上不动。
        const fingerprint = graphFingerprint(data);
        const prev = fingerprintRef.current;
        if (prev && prev.key === dedupKey && prev.fingerprint === fingerprint) return;
        fingerprintRef.current = { key: dedupKey, fingerprint };
        shownKeyRef.current = dedupKey;
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
          fingerprintRef.current = null;
          setGraphData(null);
        } else {
          // 刷新失败保留旧图，只报错（图还在，用户不必重新等一次布局）。
          // 首次加载失败时本来就没有旧图，落到的仍然是错误空态。
          setError(err.message ?? 'Failed to load graph');
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setScopeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeVaultId, scopeKey, refreshTick]);

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

  // ── trunk 场景派生与生效判定（T2，纯逻辑在 trunkScene.ts，见该文件注释）──
  // companion 副视图与局部 scope 永不 trunk（设计 §4.2：它们本就只渲染邻域）。
  // deps 用 scopeKey 字符串而非 scope 对象（本文件既定防御约定，见 fetch effect 注释）
  const trunkScene = useMemo<TrunkScene | null>(
    () => (graphData && !companion && scopeKey === null ? buildTrunkScene(graphData) : null),
    [graphData, companion, scopeKey],
  );
  const trunkView = useMemo(
    () =>
      resolveTrunkView({
        scope: graphScope,
        scene: trunkScene,
        globalView: settings.globalView,
        showOrphans: settings.showOrphans,
        showDeadLinks: settings.showDeadLinks,
        visibleTypes: settings.visibleTypes,
        companion,
      }),
    [scopeKey, trunkScene, settings.globalView, settings.showOrphans, settings.showDeadLinks, settings.visibleTypes, companion],
  );
  // 引擎回调（创建时一次性注册）经 ref 读最新 trunk 场景
  const trunkSceneRef = useRef<TrunkScene | null>(null);
  trunkSceneRef.current = trunkScene;
  const trunkViewRef = useRef(trunkView);
  trunkViewRef.current = trunkView;

  const expandCluster = (clusterId: string, opts?: { focus?: string; trigger?: 'click' | 'search' | 'zoom' }) => {
    // trigger 是 H2+ 缩放分区展开的接口预留（同一入口三源）；本段实现 click/search，zoom 占位不派发
    void opts?.trigger;
    const engine = engineRef.current;
    const scene = trunkSceneRef.current;
    const graph = graphDataRef.current;
    if (!engine || !scene || !graph || !trunkViewRef.current.active) return;

    // 已在展开态：只定位（终审 #1：重复搜索/点击已展开簇不得走展开路径——那会拿不到 blob、
    // 以原点为锚 mini-sim 覆写位置缓存，收起再展开时整簇跳到原点）
    if (engine.getTrunkExpandedClusters().includes(clusterId)) {
      if (opts?.focus) engine.focusNode(opts.focus);
      return;
    }

    // 代拍 G：曾展开过又收起 → 缓存位置瞬时重展开（不重算）
    const cached = expandedRef.current.get(clusterId);
    if (cached) {
      const again = buildExpansion(scene, graph, clusterId, new Set(engine.getTrunkExpandedClusters()));
      if (again) {
        cached.live = true;
        engine.expandTrunkCluster(clusterId, again, cached.positions, [...cached.positions.keys()], { animate: false });
        if (opts?.focus) engine.focusNode(opts.focus);
        return;
      }
    }

    // expandedIds 一律取引擎真相（终审 #3a：页面缓存含已收起条目，拿它裁边会让跨簇边凭空消失）
    const payload = buildExpansion(scene, graph, clusterId, new Set(engine.getTrunkExpandedClusters()));
    if (!payload || payload.memberNodes.length === 0) return;
    const batches = splitBatches(payload.memberOrder);
    const first = batches[0];
    if (!first) return;
    const snap = engine.getSnapshot();
    const blobPos = snap?.nodes.find((n) => n.key === clusterId);
    const centroid = blobPos ? { x: blobPos.x, y: blobPos.y } : centroidOf(new Map());

    // 位置来源（评审 #3）：worker 全量布局就绪且覆盖该簇 → 质心对齐平移，全批即刻落位；
    // 否则首批 mini-sim + 余批流式（本簇走到底，worker 就绪不迁移）
    const layout = getLayoutService();
    const workerPos = layout.isReady() ? layout.getPositions() : null;
    if (workerPos && payload.memberOrder.every((k) => workerPos.has(k))) {
      const clusterPos = new Map<string, { x: number; y: number }>();
      for (const k of payload.memberOrder) clusterPos.set(k, workerPos.get(k)!);
      const translated = translatePositions(clusterPos, centroidOf(clusterPos), centroid);
      expandedRef.current.set(clusterId, { positions: translated, members: payload.memberOrder, live: true });
      engine.expandTrunkCluster(clusterId, payload, translated, first);
      for (const b of batches.slice(1)) engine.appendTrunkMembers(clusterId, payload, translated, b);
      if (opts?.focus) engine.focusNode(opts.focus);
      return;
    }

    const placed = computeMiniSim(first, payload.edges, centroid);
    expandedRef.current.set(clusterId, { positions: placed, members: payload.memberOrder, live: true });
    engine.expandTrunkCluster(clusterId, payload, placed, first);
    if (opts?.focus) engine.focusNode(opts.focus);
    let bi = 1;
    const step = () => {
      const cache = expandedRef.current.get(clusterId);
      if (!cache) return; // 场景已换
      if (!engine.getTrunkExpandedClusters().includes(clusterId)) return; // 已收起，停流
      const batch = batches[bi++];
      if (!batch) return;
      // 余批 radial 续接铺位（O(n)）：巨簇 3997 的 ≤2s 流式预算兑现——mini-sim 只跑首批
      // 出结构骨干（度数降序 = 高连接成员），余批围绕已落位外缘 golden 螺旋续铺；
      // worker 就绪路径（展开前已算完）不受影响，给的是真布局
      let maxR = 0;
      for (const p of cache.positions.values()) {
        maxR = Math.max(maxR, Math.hypot(p.x - centroid.x, p.y - centroid.y));
      }
      const filled = radialFillPositions(batch, centroid, maxR, cache.positions.size);
      const merged = new Map(cache.positions);
      for (const k of batch) merged.set(k, filled.get(k)!);
      cache.positions = merged;
      engine.appendTrunkMembers(clusterId, payload, merged, batch);
      setTimeout(step, 0); // 块间让出主线程
    };
    setTimeout(step, 0);
  };
  const expandClusterRef = useRef(expandCluster);
  expandClusterRef.current = expandCluster;

  const collapseCluster = (clusterId: string) => {
    // 位置缓存保留（代拍 G：再展开瞬时）但活性翻假——后台刷新只匹配 live 条目，
    // 用户收起的簇不得被文件变更复活（终审 #2）
    const cache = expandedRef.current.get(clusterId);
    if (cache) cache.live = false;
    engineRef.current?.collapseTrunkCluster(clusterId);
  };
  const collapseClusterRef = useRef(collapseCluster);
  collapseClusterRef.current = collapseCluster;

  // ── 出图卡片内容 ──
  // 一律取**筛选后的** engineData：卡片上的统计和核心主题必须跟图面严格对得上，
  // 否则会出现「图里 300 个点、标题写 1284 篇」——比不写更糟。
  const coreTopics = useMemo(
    () => pickCoreTopics(engineData?.nodes ?? [], engineData?.edges ?? []),
    [engineData],
  );
  const exportLegend = useMemo(
    () => collectLegend(engineData?.nodes ?? [], NODE_TYPE_COLORS, NODE_TYPE_LABELS),
    [engineData],
  );

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
    if (!searchOpen && !showStats && !showExport) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (searchRef.current?.contains(t)) return;
      if ((t as HTMLElement)?.closest?.('.graph-stats-ctrl')) return;
      // 出图气泡同理：吃掉 caret 内的 mousedown，否则点「下载 PNG」时元素先被卸载，
      // 后续 click 根本不会派发（mousedown → 卸载 → 无 click），点了没反应。
      if (exportRef.current?.contains(t)) return;
      setSearchOpen(false);
      setShowStats(false);
      setShowExport(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSearchOpen(false); setShowStats(false); setShowExport(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [searchOpen, showStats, showExport]);

  // 出图结果提示 2.4s 自动消失（成功/失败同一条：看见就行，不必手动点掉）
  useEffect(() => {
    if (!exportNote) return;
    const timer = setTimeout(() => setExportNote(null), 2400);
    return () => clearTimeout(timer);
  }, [exportNote]);

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
      eng.setCallbacks({
        onNodeClick: openNode,
        onNodeDoubleClick: openNode,
        // H2：点击簇团 = 真展开（替换 H1 拍板 A 的「切全量+框邻域」，开关不再翻转）
        onTrunkClusterClick: (clusterId) => {
          expandClusterRef.current(clusterId, { trigger: 'click' });
        },
        onTrunkCollapseClick: (clusterId) => {
          collapseClusterRef.current(clusterId);
        },
      });
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
  // 上一次是否处于 trunk（识别 trunk→full 跳变：全量数据规模剧变，需立即重取景）
  const prevTrunkActiveRef = useRef(false);
  useEffect(() => {
    if (!engine) return;
    const scope = scopeRef.current;
    const currentScopeKey = scope ? `${scope.type}:${scope.path}` : null;
    const prevScopeKey = prevScopeKeyRef.current;
    prevScopeKeyRef.current = currentScopeKey;

    // 空数据必须清引擎：hasData 翻转后 .graph-empty 只是视觉遮罩（不透明背景 + z-index），
    // 不清掉的话旧子图仍在遮罩背后继续仿真耗 CPU；但引擎本身不销毁（tab 切回还要用）。
    if (!engineData) {
      engine.setData([], []);
      return;
    }
    const vaultChanged = lastVaultRef.current !== activeVaultId;
    if (vaultChanged) {
      lastVaultRef.current = activeVaultId;
      engine.resetPositions();
    }

    // ── trunk 分支（T2 + H2 刷新保态）：setTrunkData 内部同步 settle + 立即 fit ──
    const wasTrunk = prevTrunkActiveRef.current;
    prevTrunkActiveRef.current = trunkView.active;
    if (trunkView.active && trunkScene) {
      // H2 刷新保态（代拍 O）：同库同 scope 的后台刷新 = 视口不动 + 展开态按最小成员 key
      // 重匹配（≥80% 成员重合才保，新增成员 mini-sim 补位）；首次/换库/换 scope = 全新场景
      const refresh = wasTrunk && !vaultChanged && prevScopeKey === currentScopeKey && !!prevTrunkSceneRef.current;
      if (refresh) {
        // 只匹配 live 条目（终审 #2：已收起的簇有位置缓存但不得被刷新复活）
        const liveIds = [...expandedRef.current.entries()]
          .filter(([, v]) => v.live)
          .map(([k]) => k);
        const match = matchExpansionsOnRefresh(prevTrunkSceneRef.current!, trunkScene, liveIds);
        for (const d of match.drop) expandedRef.current.delete(d);
        const keepCaches = new Map<
          string,
          { positions: Map<string, { x: number; y: number }>; members: string[]; live: boolean }
        >();
        for (const { oldId, newId } of match.keep) {
          const cache = expandedRef.current.get(oldId);
          if (!cache) continue;
          expandedRef.current.delete(oldId);
          keepCaches.set(newId, cache);
        }
        engine.setTrunkData(trunkScene, { preserveViewport: true });
        for (const [newId, cache] of keepCaches) expandedRef.current.set(newId, cache);
        for (const [newId, cache] of keepCaches) {
          const payload = buildExpansion(trunkScene, graphData!, newId, new Set(keepCaches.keys()));
          if (!payload) continue;
          engine.expandTrunkCluster(newId, payload, cache.positions, [...cache.positions.keys()], { animate: false });
          const newMembers = trunkScene.clusters.find((c) => c.id === newId)?.memberIds ?? [];
          const added = newMembers.filter(
            (m) => !cache.positions.has(m) && payload.memberNodes.some((n) => n.key === m),
          );
          if (added.length > 0) {
            const sim = computeMiniSim(
              [...new Set([...cache.positions.keys(), ...added])],
              payload.edges,
              centroidOf(cache.positions),
              cache.positions,
            );
            const merged = new Map(cache.positions);
            for (const k of added) merged.set(k, sim.get(k)!);
            engine.appendTrunkMembers(newId, payload, merged, added);
            expandedRef.current.set(newId, { positions: merged, members: newMembers, live: true });
          } else {
            expandedRef.current.set(newId, { positions: cache.positions, members: newMembers, live: true });
          }
        }
        prevTrunkSceneRef.current = trunkScene;
        return;
      }
      prevTrunkSceneRef.current = trunkScene;
      expandedRef.current.clear();
      engine.setTrunkData(trunkScene);
      return;
    }
    // 离开 trunk（开关/筛选/scope/换库）：展开态清（代拍 I：会话瞬态不持久化）
    if (wasTrunk || expandedRef.current.size > 0) expandedRef.current.clear();
    prevTrunkSceneRef.current = null;
    engine.setData(engineData.nodes, engineData.edges);
    if (wasTrunk) engine.fitView({ animate: false }); // trunk→full：旧视口对着几十个对象的布局，无意义

    // ── 取景：对照副格 → 整张子图 fit；file → 圆心居中放大；dir → 子图 fit；全量图 → 整图 fit ──
    // 布局在收敛前一直在动，早取景会落在错误位置（这是「切换后视角不对」的根因），所以：
    //   scope 切换（含局部图 ⇄ 全量图）→ 立即落位（不动画，先给个合理视角）
    //                                    + 注册收敛后的动画取景，平滑过渡到正确视角
    //   同 scope 内筛选变化 → 照旧直接动画取景（数据规模没变，位置基本稳定）
    // 注意非动画 setTransform 不置 hasUserInteracted，动画路径会置——故立即落位必须非动画，
    // 否则会抑制收敛后的 reframe。active 读 activeRef（不进 deps）：companion 开合若触发
    // effect 会全量重跑 setData。
    const applyView = (animated: boolean) => {
      if (companion) {
        // 对照副格：始终瞬时 fit 整张子图（高频重锚定 + 小画布，动画只会拖沓且裁掉邻居）
        engine.fitView({ animate: false });
        return;
      }
      if (scope?.type === 'file') {
        const focusKey = graphData?.focusNodes?.[0];
        // 圆心被筛选条件滤掉（不在可见节点里）时退化为整图 fit
        if (focusKey && engineData.nodes.some((n) => n.key === focusKey)) {
          // 框全整张 1 跳邻域（大 hub 下 focusNode 的 k=1.5 会裁掉外圈），并选中圆心做视觉锚点
          engine.fitView({ animate: animated });
          engine.selectNode(focusKey);
          return;
        }
      }
      engine.fitView({ animate: animated });
    };
    if (companion) {
      // 布局同步跑完 → 取景一次到位：无过渡动画、无延迟，每次重锚定都是完整视角
      engine.preSettle();
      applyView(false);
      return;
    }
    if (prevScopeKey !== currentScopeKey) {
      if (currentScopeKey || prevScopeKey) {
        applyView(false);
        engine.reframeAfterSettle(() => applyView(activeRef.current));
      }
    } else if (scope) {
      applyView(activeRef.current);
    }
  }, [engine, engineData, activeVaultId, graphData, companion, trunkView, trunkScene]);

  // ── 后台全量布局（H2 §4.2 + 代拍 E/P）：trunk 可交互后 idle 启动（不抢首开预算），
  // 换库/换 scope 时 ensure 换键自动重启；用户改 forces 不触碰；展开中不迁移（评审 #3）──
  useEffect(() => {
    if (!trunkView.active || !trunkScene || companion || !activeVaultId || !graphData) return;
    const nodeKeys = graphData.nodes.filter((n) => !n.deadLink).map((n) => n.key);
    // 边必须裁到节点集内：死链占位端点不在 nodeKeys 里，原样喂给 worker 的 forceLink
    // 会抛 "node not found"（layout 永不就绪 + 控制台报错——合成 10k 库探针实测抓到）
    const keySet = new Set(nodeKeys);
    const links = graphData.edges
      .filter((e) => keySet.has(e.source) && keySet.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));
    const key = `${activeVaultId}|global`;
    const idle: (cb: () => void) => number =
      typeof window.requestIdleCallback === 'function'
        ? (cb) => window.requestIdleCallback(cb)
        : (cb) => window.setTimeout(cb, 0) as unknown as number;
    const handle = idle(() => getLayoutService().ensure(key, nodeKeys, links));
    return () => {
      if (typeof window.cancelIdleCallback === 'function' && typeof handle === 'number') {
        window.cancelIdleCallback(handle);
      }
    };
  }, [trunkView.active, trunkScene, companion, activeVaultId, graphData]);

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

  /**
   * 出图并按出口投递。
   *
   * 图分两步来：引擎产出位图（captureImage），这里把它排进卡片（标题 / 统计 /
   * 核心主题 / 图例 / 署名）再编码成 PNG。卡片内容全部取筛选后的数据，与图面一致。
   *
   * 复制那条路把 **promise 直接塞进 ClipboardItem** —— `write()` 仍在用户手势的同步段
   * 内被调用（Safari 只在手势内放行 clipboard.write，先 await 再 write 会被拒）。
   */
  const runExport = async (outlet: 'download' | 'copy') => {
    const eng = engineRef.current;
    if (!eng || exporting) return;
    setShowExport(false);
    // 非安全上下文（如 NAS 上 http 访问）没有 navigator.clipboard：如实说不可用，
    // 别静默吞掉变成「复制成功」。能力检查放在出图之前 —— 先 capture 再早退会
    // 留下一个没人接的 promise。
    if (outlet === 'copy' && (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write)) {
      setExportNote(t('graph.exportCopyUnsupported'));
      return;
    }
    setExportNote(null);
    setExporting(true);

    // 统计行与图面严格对得上（出图红线）：trunk 态截的是 trunk 画布（几个团），
    // 统计/核心主题/图例必须换成 trunk 口径或省略——写全库计数就是卡片撒谎
    //（终审 Important-3；代拍只豁免「导出所见」的位图行为，不豁免文案失配）
    const trunkActive = trunkView.active && !!trunkScene;
    const metaLine = trunkActive
      ? trunkExportMeta(
          trunkScene!,
          t('graph.trunkClustersLabel'),
          t('graph.trunkHubsLabel'),
          expandedRef.current.size,
          t('graph.trunkExpandedLabel'),
        )
      : `${t('graph.nodes', { count: engineData?.nodes.length ?? 0 })} · ${t(
          'graph.edges',
          { count: engineData?.edges.length ?? 0 },
        )}`;
    const topicsLine =
      !trunkActive && coreTopics.length
        ? `${t('graph.exportCoreTopics')}${coreTopics.join(' · ')}`
        : '';
    const title = activeVault?.name ?? '';
    const aspect = exportAspect;
    const includeInfo = exportIncludeInfo;

    /** 位图 → 卡片 → PNG。数据在点击那一刻快照，之后用户再改筛选也不影响这次导出。 */
    const compose = (raw: HTMLCanvasElement): Promise<Blob | null> => {
      const layout = computeCardLayout({
        graphW: raw.width,
        graphH: raw.height,
        aspect,
        hasTopics: topicsLine.length > 0,
        includeInfo,
      });
      if (!layout) return Promise.resolve(null);
      const out = document.createElement('canvas');
      out.width = layout.width;
      out.height = layout.height;
      const ctx = out.getContext('2d');
      if (!ctx) return Promise.resolve(null);
      drawCard(ctx, raw, layout, {
        title,
        meta: metaLine,
        topics: topicsLine,
        legend: trunkActive ? [] : exportLegend,
        watermark: EXPORT_WATERMARK,
        ink: cardInkFor(themeColors.bg),
        bg: themeColors.bg,
        includeInfo,
      });
      return new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    };

    const capture = (async () => {
      const raw = eng.captureImage();
      return raw ? compose(raw) : null;
    })();

    try {
      if (outlet === 'copy') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'image/png': capture.then((blob) => {
              if (!blob) throw new Error('nothing to export');
              return blob;
            }),
          }),
        ]);
        setExportNote(t('graph.exportCopied'));
      } else {
        const blob = await capture;
        if (!blob) throw new Error('nothing to export');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = exportFileName(new Date(), title);
        a.click();
        // 立刻 revoke 有些浏览器会来不及取用；留足时间再释放这个临时 URL
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setExportNote(t('graph.exportDownloaded'));
      }
    } catch (err) {
      console.error('[graph] 导出图片失败:', err);
      setExportNote(t('graph.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

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
                    clusters={trunkView.active ? trunkScene?.clusters : undefined}
                    onSelectCluster={(id) => {
                      // trunk 态命中簇名：就地高亮该簇（聚合边置顶），不切视图
                      engineRef.current?.highlightTrunkCluster(id);
                    }}
                    onSelect={(key) => {
                      // trunk 态命中节点（H2 替换拍板 A）：命中簇成员 → 展开该簇 + 定位（留在
                      // trunk 态，开关不翻转）；hub/不在簇里的节点 → 直接定位
                      if (trunkView.active) {
                        const cluster = trunkScene?.clusters.find((c) => c.memberIds.includes(key));
                        if (cluster) {
                          expandClusterRef.current(cluster.id, { focus: key, trigger: 'search' });
                          return;
                        }
                      }
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
          {/* 统计：收敛进 ℹ，点击展示（刷新期间也留着——不然每次自动刷新控件都会闪一下） */}
          {graphData && (
            <div className="graph-stats-ctrl">
              {showStats && (
                <div className="graph-stats-pop">
                  {trunkView.active && trunkScene ? (
                    /* trunk 口径（T2 deferred minor 归位）：ℹ 显示画面上的 trunk 对象，不写全库计数 */
                    <>
                      <span>{t('graph.trunkClustersLabel')} {trunkScene.clusters.length}</span>
                      <span>{t('graph.trunkHubsLabel')} {trunkScene.hubs.length}</span>
                      {trunkScene.crumbCount > 0 && (
                        <span>{t('graph.trunkCrumbs', { count: trunkScene.crumbCount })}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span>{t('graph.nodes', { count: nodeCount })}</span>
                      <span>{t('graph.edges', { count: edgeCount })}</span>
                      {graphData.deadLinks && graphData.deadLinks.length > 0 && (
                        <span className="graph-stat--deadlink">{t('graph.deadLinks', { count: graphData.deadLinks.length })}</span>
                      )}
                    </>
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
          {/* 一键出图（对外分享/获客）：下载 PNG / 复制到剪贴板。
              副视图（分屏对照的小参照面板）不渲染——那里是「看」，出图只属于主格。 */}
          {hasData && !companion && (
            <div className="graph-export-ctrl" ref={exportRef}>
              {(showExport || exportNote) && (
                <div className="graph-export-pop">
                  {exportNote ? (
                    <span className="graph-export-note">{exportNote}</span>
                  ) : (
                    <>
                      {/* 版式：默认跟图走；固定比例是给发布平台用的（contain 留白，不裁图） */}
                      <div
                        className="graph-export-aspects"
                        role="group"
                        aria-label={t('graph.exportAspect')}
                      >
                        {EXPORT_ASPECTS.map(({ key, label }) => (
                          <button
                            key={key}
                            type="button"
                            className={`graph-export-aspect${exportAspect === key ? ' is-active' : ''}`}
                            data-testid={`graph-export-aspect-${key}`}
                            aria-pressed={exportAspect === key}
                            onClick={() => setExportAspect(key)}
                          >
                            {t(label)}
                          </button>
                        ))}
                      </div>
                      {/* 附带信息：默认开（标题/统计/核心主题/图例是卡片的价值），
                          但只想要一张干净图的人应当能关掉——署名不跟着关。 */}
                      <label className="graph-export-toggle">
                        <input
                          type="checkbox"
                          data-testid="graph-export-info"
                          checked={exportIncludeInfo}
                          onChange={(e) => setExportIncludeInfo(e.target.checked)}
                        />
                        <span>{t('graph.exportIncludeInfo')}</span>
                      </label>
                      <button
                        type="button"
                        className="graph-export-item"
                        data-testid="graph-export-download"
                        onClick={() => runExport('download')}
                      >
                        {t('graph.exportDownload')}
                      </button>
                      <button
                        type="button"
                        className="graph-export-item"
                        data-testid="graph-export-copy"
                        onClick={() => runExport('copy')}
                      >
                        {t('graph.exportCopy')}
                      </button>
                    </>
                  )}
                </div>
              )}
              <button
                type="button"
                className={`graph-icon-btn${showExport ? ' is-active' : ''}`}
                onClick={() => setShowExport((v) => !v)}
                disabled={exporting}
                data-tooltip={exporting ? t('graph.exporting') : t('graph.export')}
                aria-label={t('graph.export')}
                data-testid="graph-export"
              >
                {/* 画框 + 山形/日头：一眼即「这一屏能出成图片」 */}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
                  <circle cx="8.6" cy="10" r="1.5" />
                  <path d="M4 17.4l4.7-4.7a1.5 1.5 0 0 1 2.1 0l3.4 3.4 1.6-1.6a1.5 1.5 0 0 1 2.1 0L21 17.6" />
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
          {/* 全局视图开关（trunk T2，设计 §4.2 拍板 #5）：大库默认枝干。
              no-communities（小库/局部 scope/副视图）不渲染；筛选偏离默认态置灰（reason==='filters'）。
              开关状态 = globalView 持久化设置；点击簇团/搜索命中成员的过渡切换也翻转它（拍板 A）。 */}
          {trunkView.reason !== 'no-communities' && (
            <button
              type="button"
              className={`graph-icon-btn${trunkView.active ? ' is-active' : ''}`}
              onClick={() => updateSettings({ globalView: trunkView.active ? 'full' : 'trunk' })}
              disabled={trunkView.reason === 'filters'}
              data-tooltip={trunkView.reason === 'filters' ? t('graph.trunkFiltersBlocked') : t('graph.viewModeToggle')}
              aria-label={t('graph.viewModeToggle')}
              aria-pressed={trunkView.active}
              data-testid="graph-view-mode-toggle"
            >
              {/* 枝干：主干 + 两叉 */}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <circle cx="12" cy="5" r="2.4" />
                <circle cx="5" cy="19" r="2.4" />
                <circle cx="19" cy="19" r="2.4" />
                <path d="M12 7.4v4.2M12 11.6 6.2 16.8M12 11.6l5.8 5.2" />
              </svg>
            </button>
          )}
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
        {/* 刷新时不清屏：有旧图就留着（自动刷新不该闪一下加载态），只有首屏/换库才盖 */}
        {loading && !graphData && (
          <div className="graph-loading">
            <div className="graph-loading__spinner" />
            <p>{t('graph.loading')}</p>
          </div>
        )}

        {/* 换 scope 的在途反馈（旧图仍在屏上，故不能盖全屏）：daemon 每次都要整库重建，
            慢机器 / 移动盘上可达数十秒，此前这段时间毫无反馈，表现为「旧图纹丝不动」。
            后台自动刷新不置 scopeLoading，所以不会无谓闪烁。 */}
        {scopeLoading && graphData && (
          <div className="graph-scope-loading" data-testid="graph-scope-loading" role="status">
            <span className="graph-scope-loading__spinner" />
            <span>{t('graph.loading')}</span>
          </div>
        )}

        {/* trunk 模式指示（T2）：确认用户看到的是枝干 + 碎屑不在屏的事实（计数告知）；
            degenerate 如实提示（仍渲染，不自动退全量——设计 §4.1 退化保护） */}
        {trunkView.active && (
          <div className="graph-trunk-indicator" data-testid="graph-trunk-indicator">
            <span>{t('graph.trunkIndicator')}</span>
            {trunkScene && trunkScene.crumbCount > 0 && (
              <span className="graph-trunk-crumbs">
                {t('graph.trunkCrumbs', { count: trunkScene.crumbCount })}
              </span>
            )}
          </div>
        )}
        {trunkView.active && trunkScene?.quality === 'degenerate' && (
          <div className="graph-trunk-banner" data-testid="graph-trunk-banner">
            {t('graph.trunkDegenerate')}
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
            onReset={resetSettings}
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

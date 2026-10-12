import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAgents } from './hooks/useAgents';
import { HomePage } from './components/HomePage';

import { NavRail } from './components/NavRail';
import { FloatingChatButton } from './components/kb/FloatingChatButton';
import { KbChatSessionsPanel, type KbChatSessionsPanelHandle } from './components/kb/KbChatSessionsPanel';
import { KbChatSessionsProvider } from './components/kb/KbChatSessionsProvider';
import { UpdateNotification } from './components/UpdateNotification';
import { PreloadToast } from './components/PreloadToast';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { LanguageProvider } from './i18n/LanguageProvider';
import type { Locale } from './i18n';
import { api } from './api/client';
import { useActiveVault, vaultStore } from './stores/vaultStore';
import { chatRuntimeStore, useChatAgentId } from './stores/chatRuntimeStore';
import { OPEN_RUNTIME_SETTINGS_EVENT } from './components/RuntimeModelPill';
import { authStore } from './stores/authStore';
import { configStore, useAppConfig } from './stores/configStore';
import { currentContextStore, type CurrentContext } from './stores/currentContextStore';
import { messageSelectionStore } from './stores/messageSelectionStore';
import { kbChatSessionsStore } from './stores/kbChatSessionsStore';
import { usePendingPrefill, skillPrefillStore } from './stores/skillPrefillStore';
import { SkillEditor, type SkillFormValues } from './components/settings/SkillEditor';
import { DEFAULT_ROUTE, CHAT_ROUTE, RESTORABLE_ROUTES } from './routes';
import './styles/rail.css';
import './styles/home.css';
import './styles/knowledge.css';
import './styles/runtimes.css';
import './styles/settings.css';
import './styles/channels.css';
import './styles/history.css';
import './styles/graph.css';
import './styles/account.css';
import './styles/resources.css';
import './App.css';

// Route-level code splitting: everything except HomePage (first screen) and
// KbChatSessionsPanel (must stay mounted for background wiki/qa tasks) loads
// on navigation. Biggest wins: KnowledgeBasePage drags in pixi.js + d3 +
// doocs-md/marked/highlight.js via GraphPage & KbMainContent.
const KnowledgeBasePage = lazy(() =>
  import('./components/kb/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })));
const SettingsPage = lazy(() =>
  import('./components/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AccountPage = lazy(() =>
  import('./components/account/AccountPage').then((m) => ({ default: m.AccountPage })));
const HistoryPage = lazy(() =>
  import('./components/history/HistoryPage').then((m) => ({ default: m.HistoryPage })));
const ResourcesPage = lazy(() =>
  import('./components/resources/ResourcesPage').then((m) => ({ default: m.ResourcesPage })));
const ResourceDetailPage = lazy(() =>
  import('./components/resources/ResourceDetailPage').then((m) => ({ default: m.ResourceDetailPage })));

const STORAGE_KEY_LAST_ROUTE = 'molio.lastRoute';

/**
 * `/` 的渲染：redirect 到「上次访问的路由」，没有则落到默认落点。
 *
 * 两条防线：
 * - 老版本里 `/` 就是首页，会被写进 `molio.lastRoute`。把它当合法目标会自我重定向成死循环，
 *   所以 `/` 天然不在 RESTORABLE_ROUTES 里。
 * - 值必须命中白名单（允许带子路径，如 `/resources/xxx`），脏数据一律回落默认落点。
 *
 * query 原样带过去：`?vault=` / `?file=` 是跨路由的深链参数
 * （`vaultStore` 与 `KnowledgeBasePage` 都从 URL 读），在入口丢掉等于把
 * 「打开某库的某个文件」降级成「打开某库」。
 */
function EntryRedirect() {
  const { search } = useLocation();
  const target = useMemo(() => {
    try {
      const last = localStorage.getItem(STORAGE_KEY_LAST_ROUTE);
      if (last && RESTORABLE_ROUTES.some((r) => last === r || last.startsWith(`${r}/`))) {
        return last;
      }
    } catch { /* ignore */ }
    return DEFAULT_ROUTE;
  }, []);
  return <Navigate to={{ pathname: target, search }} replace />;
}

export default function App() {
  const { agents, loading: agentsLoading, error: agentsError, refresh: refreshAgents } = useAgents();
  // 从 agents 列表判定「无可用运行时」，而非依赖 selection：selection 在首帧
  // 绘制后才生效（会闪空状态卡片），且所选 agent 被移除时 selection 会变 stale。
  //
  // 必须排除「请求失败」：失败时 agents 一定是空数组，若照上面的式子判定，
  // 就会把「后端连不上」报成「一个运行时都没装」，把用户推去安装他装好的东西。
  // 失败是独立的一态（见 agentsUnavailable），两者不能共用一张卡片。
  const hasNoUsableAgent = !agentsError && (agents.length === 0 || !agents.some((a) => a.available));
  const agentsUnavailable = !agentsLoading && Boolean(agentsError);
  const navigate = useNavigate();
  const location = useLocation();
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  // 当前 runtime 选择迁移到 chatRuntimeStore（composer 的 runtime/model pill 与
  // App 共享同一事实源）；此处只订阅 agentId，往下喂给 KbChatSessionsProvider（各会话控制器
  // 与知识库页共用）——App 级 useChat 已于 L2a 退役。
  const selectedAgent = useChatAgentId();
  const activeVault = useActiveVault();
  // 共享 config 快照（configStore，in-flight 去重）。首帧不再等 daemon：
  // locale 先用 localStorage 兜底立即渲染，config 到达后由 LanguageProvider
  // 同步（用户手动改过语言则锁定，不回跳）。旧的 `configLoaded` 白屏 gate
  // 已移除——daemon 慢/挂时用户立刻看到 UI 而非白屏。
  const config = useAppConfig();
  const storedLocale = useMemo<Locale>(() => {
    try {
      const v = localStorage.getItem('molio.locale');
      if (v === 'en' || v === 'zh') return v;
    } catch { /* ignore */ }
    return 'zh';
  }, []);
  const cfgLocale = config?.['locale'];
  const locale: Locale = cfgLocale === 'en' || cfgLocale === 'zh' ? cfgLocale : storedLocale;
  // 全局悬浮对话面板句柄（App 层常驻挂载，ref 下发给 KB 页触发 runWikiOp/openQa）
  const kbChatPanelRef = useRef<KbChatSessionsPanelHandle | null>(null);

  // "Save as skill" — assistant-message buttons push a prefill into the store;
  // the fullscreen editor is hosted here (above the chat) to avoid prop-drilling.
  const pendingPrefill = usePendingPrefill();
  const [skillPrefillBusy, setSkillPrefillBusy] = useState(false);
  const [skillPrefillError, setSkillPrefillError] = useState<string | null>(null);
  const closePrefill = useCallback(() => {
    skillPrefillStore.setPendingPrefill(null);
    setSkillPrefillError(null);
  }, []);
  const savePrefillSkill = useCallback(async (values: SkillFormValues) => {
    setSkillPrefillBusy(true);
    setSkillPrefillError(null);
    try {
      await api.createSkill(values);
      skillPrefillStore.setPendingPrefill(null);
    } catch (err) {
      // Keep the editor open with the values so the user can retry; surface the
      // failure inline instead of swallowing it as an unhandled rejection.
      setSkillPrefillError((err as Error).message);
    } finally {
      setSkillPrefillBusy(false);
    }
  }, []);

  // Persist current route on change. `/` 是入口地址而非页面，写进去会让下次冷启动
  // 恢复到一个自我重定向的目标——不记。
  useEffect(() => {
    if (location.pathname === '/') return;
    try {
      localStorage.setItem(STORAGE_KEY_LAST_ROUTE, location.pathname);
    } catch { /* ignore */ }
  }, [location.pathname]);

  // 路由切换 → 悬浮对话读取当前页面
  useEffect(() => {
    // 原「首页」路由是 `/`，replace 后得到空串，会被判成 'other' —— 'home' 这个取值因此永远不可达。
    // 显式特判，让 'home' 真正生效（悬浮面板据此跳过主页：见 KbChatSessionsPanel 的 dock effect）。
    const path = location.pathname;
    const page: CurrentContext['page'] = path === CHAT_ROUTE
      ? 'home'
      // 入口地址转瞬即走（EntryRedirect 是声明式重定向），归 'other' 以免被当成主页。
      : path === '/'
        ? 'other'
        : path.replace('/', '') as CurrentContext['page'];
    const known: CurrentContext['page'][] = ['knowledge', 'home', 'history', 'graph', 'settings'];
    currentContextStore.set({
      page: known.includes(page) ? page : 'other',
    });
  }, [location.pathname]);

  // 模型 pill 的未安装 runtime 行 → SPA 内跳「设置 → 运行时」。
  // 走 router 而非 location.href：产物静态服务无 SPA history fallback，硬导航可能 404。
  useEffect(() => {
    const handler = () => navigate('/settings?tab=runtimes');
    window.addEventListener(OPEN_RUNTIME_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(OPEN_RUNTIME_SETTINGS_EVENT, handler);
  }, [navigate]);

  // 面板在除整页对话外的任意页面常驻可用（方案 D）：跨页保持开启，后台任务继续且可见。
  // 唯独到达 `/chat` 时收起——它自身就是一个聊天页（占满整屏的 HomePage），
  // 再叠一个悬浮对话会在同屏出现两个聊天框。
  // 第 3 步 `/chat` 也不再是聊天页后，本 effect 与下方渲染处的例外一并删除。
  useEffect(() => {
    if (location.pathname === CHAT_ROUTE) {
      kbChatSessionsStore.setPanelOpen(false);
    }
  }, [location.pathname]);

  // In-page navigation from molio:// protocol (desktop main → renderer IPC).
  // When a clip lands and molio://open/... fires while the app is already open,
  // the main process sends `molio:navigate` instead of reloading the window,
  // so we route to the file via React Router with no flash/state loss.
  useEffect(() => {
    const electron = window.__electron__;
    if (!electron?.onNavigate) return; // absent in plain browser dev
    const unsub = electron.onNavigate(({ vaultId, filePath }) => {
      navigate('/knowledge', { state: { openFile: filePath, vaultId: vaultId ?? undefined } });
    });
    // Signal readiness so main flushes any molio://open that arrived during
    // cold start (before this listener was registered) instead of dropping it.
    electron.notifyReady?.();
    return unsub;
  }, [navigate]);

  // Load config once into the shared store (mount). refresh() never throws —
  // a down daemon just leaves the snapshot null and the UI keeps its fallbacks.
  useEffect(() => {
    void configStore.refresh();
  }, []);

  // Resolve the active agent once both agents and config are loaded.
  useEffect(() => {
    if (selectedAgent) return;
    if (agents.length === 0) return;

    if (defaultAgentId) {
      if (agents.some((a) => a.id === defaultAgentId && a.available)) {
        chatRuntimeStore.setAgentId(defaultAgentId);
      }
      return;
    }

    const firstAvailable = agents.find((a) => a.available);
    if (firstAvailable) {
      chatRuntimeStore.setAgentId(firstAvailable.id);
      setDefaultAgentId(firstAvailable.id);
      api.updateConfig({ defaultAgentId: firstAvailable.id }).catch(() => {});
    }
  }, [agents, defaultAgentId, selectedAgent]);

  // Re-read config on navigation (e.g. back from Settings where the user may
  // have changed the default agent). Goes through the shared store — the
  // in-flight dedup collapses this with any concurrent refresh.
  useEffect(() => {
    void configStore.refresh();
  }, [location.pathname]);

  // Sync defaultAgentId/selectedAgent whenever the stored config's default
  // changes (replaces the old pathname-keyed getConfig().then(...) handler).
  const cfgDefaultAgentId = config?.['defaultAgentId'];
  useEffect(() => {
    const id = typeof cfgDefaultAgentId === 'string' ? cfgDefaultAgentId : null;
    if (!id || id === defaultAgentId) return;
    setDefaultAgentId(id);
    if (agents.some((a) => a.id === id && a.available)) {
      chatRuntimeStore.setAgentId(id);
    }
  }, [cfgDefaultAgentId, defaultAgentId, agents]);

  // Load vaults into the shared store on mount
  useEffect(() => {
    api.listVaults()
      .then((list) => vaultStore.setVaults(list))
      .catch(() => {});
  }, []);

  // Auth status snapshot — restore on mount, then keep fresh with a light
  // 30s poll + focus refresh. refresh() never throws: a down daemon keeps
  // the last snapshot (local-first — auth UI degrades, never blocks).
  // In-flight guard: a slow daemon + focus spam (or overlapping polls) must
  // not pile up concurrent status requests.
  useEffect(() => {
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      void authStore.refresh().finally(() => { inFlight = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    const onFocus = refresh;
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Keep daemon-side defaultCwd aligned with the active knowledge vault.
  // Reads via the shared store (dedup) and mirrors the write locally with
  // applyPatch so the snapshot never goes stale between refreshes.
  useEffect(() => {
    const cwd = activeVault?.path;
    if (!cwd) return;
    void configStore.refresh()
      .then((cfg) => {
        if (!cfg) return;
        if ((cfg as { defaultCwd?: string }).defaultCwd === cwd) return;
        return api.updateConfig({ ...cfg, defaultCwd: cwd }).then(() => {
          configStore.applyPatch({ defaultCwd: cwd });
        });
      })
      .catch(() => {});
  }, [activeVault?.path]);

  // 页头「+」：新建一个会话标签（不再重置 App 级会话 —— 会话状态已由面板/Provider 按标签持有）。
  const handleNewChat = () => {
    kbChatSessionsStore.openSession({
      mode: 'qa', title: '新会话', conversationId: null, filePath: null,
    });
  };

  // 视图切换（路由变化）→ 退出消息勾选态。`messageSelectionStore` 是模块级全局单例，
  // 面板态与全屏态共用；若不清理，切到另一视图会凭空冒出删除确认条（选中的消息 id 在
  // 新视图里恰好也存在时 pruneStale 拦不住）。
  useEffect(() => {
    messageSelectionStore.exit();
  }, [location.pathname]);

  // 任一历史入口删除会话后统一收敛：删除的会话若正是某个会话标签当前加载的，清空该标签，
  // 避免切回主页/面板仍显示已删除的内容。历史页勾选删除 / 主页输入框历史下拉 / KB 会话面板
  // 历史下拉 共用。收敛实现在面板（它持有各标签的 imperative API，见 resetConversations）。
  const handleConversationsDeleted = useCallback((ids: string[]) => {
    kbChatPanelRef.current?.resetConversations(ids);
  }, []);

  return (
    <LanguageProvider initialLocale={locale}>
      <AppErrorBoundary>
      {/* 会话状态宿主（方案 D 第 3 步）：每个会话标签一个无 DOM 的 controller 常驻于此，
          面板与 `/chat` 都只是它的消费者 —— 面板是否渲染不再决定会话是否存活。
          必须包住路由与面板（context 只沿树向下传，同级兄弟取不到）。 */}
      <KbChatSessionsProvider agentId={selectedAgent}>
      <div className="entry-shell">
        <NavRail />
        <div className="entry-main">
          {/* fallback=null：懒路由 chunk 本地加载是毫秒级，闪 skeleton 反而抖动。 */}
          <Suspense fallback={null}>
          <Routes>
            {/* 入口：不渲染页面，只决定去哪（默认知识库 / 恢复上次路由）。
                必须是独立路由而非「挂载时重定向」effect —— 后者会让 `/` 这个地址
                在恢复完成后失效，深链与硬导航都会落到 NotFound。 */}
            <Route path="/" element={<EntryRedirect />} />
            <Route
              path={CHAT_ROUTE}
              element={
                // `/chat` = 悬浮对话面板的全屏态：HomePage 自己从 KbChatSessionsProvider
                // 读活动标签的状态（与面板同一份会话），不再是 App 级独立会话。
                <HomePage
                  selectedAgentName={agents.find((a) => a.id === selectedAgent)?.name ?? null}
                  agentsReady={!agentsLoading}
                  hasNoUsableAgent={hasNoUsableAgent}
                  agentsUnavailable={agentsUnavailable}
                  onRetryAgents={refreshAgents}
                  onOpenRuntimes={() => navigate('/settings?tab=runtimes')}
                  onNewChat={handleNewChat}
                  onOpenConversation={(conversationId) => {
                    // 就地切换活动会话并触发加载（复用面板已有的切换语义：运行中 → 新开标签）。
                    kbChatPanelRef.current?.openConversation(conversationId);
                  }}
                  onDeleteConversations={handleConversationsDeleted}
                />
              }
            />
            <Route
              path="/history"
              element={
                <HistoryPage
                  onOpenConversation={(conversationId) => {
                    // 保持旧行为：加载到「整页对话」→ 跳转过去呈现（撤销方案 D 的「就地打开面板」）。
                    // 现在整页对话展示的是活动会话，所以先把它切到目标会话，再跳 /chat。
                    kbChatPanelRef.current?.openConversation(conversationId);
                    navigate(CHAT_ROUTE);
                  }}
                  onDeleteConversations={handleConversationsDeleted}
                />
              }
            />
            <Route path="/knowledge" element={
            <KnowledgeBasePage agentId={selectedAgent} chatPanelRef={kbChatPanelRef} />
          } />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/me" element={<AccountPage />} />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="/resources/:id" element={<ResourceDetailPage />} />
          </Routes>
          </Suspense>
        </div>
        {/* 全局悬浮对话面板（方案 D）：面板常驻挂载 + CSS --closed 隐藏，保 ref 恒有效。
            悬浮按钮在除整页对话外的任意页面显示——那里自己就是聊天页，按钮等于第二个聊天框；
            面板展开时按钮自动让位（FloatingChatButton 在 panelOpen 时返回 null）。
            `/`（入口）也排除：它转瞬即走，挂上会闪一帧。 */}
        {location.pathname !== CHAT_ROUTE && location.pathname !== '/' && <FloatingChatButton />}
        <KbChatSessionsPanel
          ref={kbChatPanelRef}
        />
        <UpdateNotification />
        <PreloadToast />
        <SkillEditor
          show={pendingPrefill !== null}
          mode="prefill"
          prefillData={pendingPrefill}
          busy={skillPrefillBusy}
          externalError={skillPrefillError}
          onClose={closePrefill}
          onSave={savePrefillSkill}
        />
      </div>
      </KbChatSessionsProvider>
      </AppErrorBoundary>
    </LanguageProvider>
  );
}

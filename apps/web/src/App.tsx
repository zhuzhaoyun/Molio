import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAgents } from './hooks/useAgents';
import { useChat } from './hooks/useChat';
import { HomePage } from './components/HomePage';

import { NavRail } from './components/NavRail';
import { FloatingChatButton } from './components/kb/FloatingChatButton';
import { KbChatSessionsPanel, type KbChatSessionsPanelHandle } from './components/kb/KbChatSessionsPanel';
import { UpdateNotification } from './components/UpdateNotification';
import { PreloadToast } from './components/PreloadToast';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { LanguageProvider } from './i18n/LanguageProvider';
import { useI18n } from './i18n';
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

/** 切 vault 后会话重置的 transient 提示条（必须渲染在 LanguageProvider 内取 useI18n）。 */
function VaultSwitchNotice({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  if (!visible) return null;
  return (
    <div className="vault-switch-notice" role="status" data-testid="vault-switch-notice">
      {t('app.vaultSwitchReset')}
    </div>
  );
}

export default function App() {
  const { agents, loading: agentsLoading } = useAgents();
  // 从 agents 列表判定「无可用运行时」，而非依赖 selection：selection 在首帧
  // 绘制后才生效（会闪空状态卡片），且所选 agent 被移除时 selection 会变 stale。
  const hasNoUsableAgent = agents.length === 0 || !agents.some((a) => a.available);
  const navigate = useNavigate();
  const location = useLocation();
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  // 当前 runtime 选择迁移到 chatRuntimeStore（composer 的 runtime/model pill 与
  // App 共享同一事实源）；此处只订阅 agentId 供 useChat / KB 面板消费。
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
  const chat = useChat({ agentId: selectedAgent, cwd: activeVault?.path });
  // 跨 vault 残留防线：home 会话绑定 activeVault 的 cwd，切 vault 后旧会话在新 vault
  // 上下文里产出读不到文件。检测到 activeVault 变化且有会话 → 重置 + transient 提示。
  const [vaultSwitchNotice, setVaultSwitchNotice] = useState(false);
  const vaultNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevVaultIdRef = useRef<string | null>(null);
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

  const handleNewChat = () => {
    chat.reset();
    chatRuntimeStore.setAgentId(defaultAgentId ?? null);
  };

  // 切 vault → 重置绑定旧 vault 的会话。首载/无 vault/未变化跳过；无会话无需重置。
  // 保守同步实现（不依赖 daemon 会话归属查询）：只要 activeVault 变化即视为上下文切换。
  useEffect(() => {
    const vaultId = activeVault?.id ?? null;
    const prev = prevVaultIdRef.current;
    prevVaultIdRef.current = vaultId;
    if (prev === null || vaultId === null || vaultId === prev) return;
    if (!chat.conversationId) return;
    chat.reset();
    setVaultSwitchNotice(true);
    if (vaultNoticeTimer.current) clearTimeout(vaultNoticeTimer.current);
    vaultNoticeTimer.current = setTimeout(() => setVaultSwitchNotice(false), 3000);
  }, [activeVault?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 任一历史入口删除会话后统一收敛：删除的会话恰是主页当前加载的 → 清空主页聊天，
  // 避免切回主页仍显示已删除的内容。历史页勾选删除 / 主页输入框历史下拉 / KB 会话面板
  // 历史下拉 共用。
  const handleConversationsDeleted = (ids: string[]) => {
    if (chat.conversationId && ids.includes(chat.conversationId)) {
      chat.reset();
    }
  };

  return (
    <LanguageProvider initialLocale={locale}>
      <AppErrorBoundary>
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
                <HomePage
                  selectedAgentName={agents.find((a) => a.id === selectedAgent)?.name ?? null}
                  agentsReady={!agentsLoading}
                  hasNoUsableAgent={hasNoUsableAgent}
                  onOpenRuntimes={() => navigate('/settings?tab=runtimes')}
                  messages={chat.messages}
                  isRunning={chat.isRunning}
                  activity={chat.activity}
                  onSend={(message) => chat.send(message, { queueIfRunning: true })}
                  onSubmitForm={(text) => chat.send(text)}
                  onCancel={chat.cancel}
                  onNewChat={handleNewChat}
                  onSubmitToolResult={chat.submitToolResult}
                  onOpenConversation={(conversationId) => {
                    void chat.loadConversationById(conversationId);
                  }}
                  onDeleteConversations={handleConversationsDeleted}
                  onRegenerate={chat.regenerateLast}
                  onEdit={chat.editAndResend}
                  onContinue={() => chat.send('继续')}
                  onRequestDelete={(id) => messageSelectionStore.enterSelection(id, chat.messages)}
                  onDeleteMessages={chat.deleteMessages}
                />
              }
            />
            <Route
              path="/history"
              element={
                <HistoryPage
                  onOpenConversation={(conversationId) => {
                    // 恢复旧行为：加载到整页对话 → 跳转过去呈现（撤销方案 D 的「就地打开面板」）。
                    void chat.loadConversationById(conversationId).then(() => {
                      navigate(CHAT_ROUTE);
                    });
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
          agentId={selectedAgent}
          onDeleteConversations={handleConversationsDeleted}
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
        <VaultSwitchNotice visible={vaultSwitchNotice} />
      </div>
      </AppErrorBoundary>
    </LanguageProvider>
  );
}

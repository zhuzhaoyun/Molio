import { useState, useEffect, useRef, useCallback } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useAgents } from './hooks/useAgents';
import { useChat } from './hooks/useChat';
import { HomePage } from './components/HomePage';

import { NavRail } from './components/NavRail';
import { KnowledgeBasePage } from './components/kb/KnowledgeBasePage';
import { KbChatSessionsPanel, type KbChatSessionsPanelHandle } from './components/kb/KbChatSessionsPanel';
import { SettingsPage } from './components/settings/SettingsPage';
import { HistoryPage } from './components/history/HistoryPage';
import { GraphPage } from './components/graph/GraphPage';
import { ResourcesPage } from './components/resources/ResourcesPage';
import { ResourceDetailPage } from './components/resources/ResourceDetailPage';
import { UpdateNotification } from './components/UpdateNotification';
import { PreloadToast } from './components/PreloadToast';
import { LanguageProvider } from './i18n/LanguageProvider';
import { useI18n } from './i18n';
import type { Locale } from './i18n';
import { api } from './api/client';
import { useActiveVault, vaultStore } from './stores/vaultStore';
import { authStore } from './stores/authStore';
import { currentContextStore, type CurrentContext } from './stores/currentContextStore';
import { messageSelectionStore } from './stores/messageSelectionStore';
import { kbChatSessionsStore } from './stores/kbChatSessionsStore';
import { usePendingPrefill, skillPrefillStore } from './stores/skillPrefillStore';
import { SkillEditor, type SkillFormValues } from './components/settings/SkillEditor';
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

const STORAGE_KEY_LAST_ROUTE = 'molio.lastRoute';

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
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const activeVault = useActiveVault();
  const [locale, setLocale] = useState<Locale>('zh');
  const [configLoaded, setConfigLoaded] = useState(false);
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

  // Persist current route on change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_LAST_ROUTE, location.pathname);
    } catch { /* ignore */ }
  }, [location.pathname]);

  // 路由切换 → 悬浮对话读取当前页面
  useEffect(() => {
    const page = location.pathname.replace('/', '') as CurrentContext['page'];
    const known: CurrentContext['page'][] = ['knowledge', 'home', 'history', 'graph', 'settings'];
    currentContextStore.set({
      page: known.includes(page) ? page : 'other',
    });
  }, [location.pathname]);

  // 入口收敛（暂时屏蔽右下角悬浮按钮）：面板只在 KB 页经 💬问答 等入口唤起。
  // 离开 /knowledge 时若面板开着则自动收起——后台任务继续但不可见，回 KB 可重新唤起。
  useEffect(() => {
    if (location.pathname !== '/knowledge') {
      kbChatSessionsStore.setPanelOpen(false);
    }
  }, [location.pathname]);

  // On mount, restore last route (only if at root "/")
  useEffect(() => {
    if (location.pathname === '/') {
      try {
        const lastRoute = localStorage.getItem(STORAGE_KEY_LAST_ROUTE);
        if (lastRoute && lastRoute !== '/') {
          navigate(lastRoute, { replace: true });
        }
      } catch { /* ignore */ }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Load config to get defaultAgentId and locale
  useEffect(() => {
    api.getConfig()
      .then((cfg) => {
        const id = (cfg as { defaultAgentId?: string }).defaultAgentId;
        if (id) setDefaultAgentId(id);
        const loc = (cfg as { locale?: string }).locale;
        if (loc === 'en' || loc === 'zh') setLocale(loc);
        setConfigLoaded(true);
      })
      .catch(() => { setConfigLoaded(true); });
  }, []);

  // Resolve the active agent once both agents and config are loaded.
  useEffect(() => {
    if (selectedAgent) return;
    if (agents.length === 0) return;

    if (defaultAgentId) {
      if (agents.some((a) => a.id === defaultAgentId && a.available)) {
        setSelectedAgent(defaultAgentId);
      }
      return;
    }

    const firstAvailable = agents.find((a) => a.available);
    if (firstAvailable) {
      setSelectedAgent(firstAvailable.id);
      setDefaultAgentId(firstAvailable.id);
      api.updateConfig({ defaultAgentId: firstAvailable.id }).catch(() => {});
    }
  }, [agents, defaultAgentId, selectedAgent]);

  // Sync selectedAgent with config when navigating back from Settings page.
  useEffect(() => {
    api.getConfig()
      .then((cfg) => {
        const id = (cfg as { defaultAgentId?: string }).defaultAgentId;
        if (id && id !== defaultAgentId) {
          setDefaultAgentId(id);
          if (agents.some((a) => a.id === id && a.available)) {
            setSelectedAgent(id);
          }
        }
      })
      .catch(() => {});
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Keep daemon-side defaultCwd aligned with the active knowledge vault
  useEffect(() => {
    const cwd = activeVault?.path;
    if (!cwd) return;
    api.getConfig()
      .then((cfg) => {
        if ((cfg as { defaultCwd?: string }).defaultCwd === cwd) return;
        return api.updateConfig({ ...cfg, defaultCwd: cwd });
      })
      .catch(() => {});
  }, [activeVault?.path]);

  const handleNewChat = () => {
    chat.reset();
    setSelectedAgent(defaultAgentId ?? null);
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

  if (!configLoaded) return null;

  return (
    <LanguageProvider initialLocale={locale}>
      <div className="entry-shell">
        <NavRail />
        <div className="entry-main">
          <Routes>
            <Route
              path="/"
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
                    // 恢复旧行为：加载到首页聊天 → 跳转首页呈现（撤销方案 D 的「就地打开面板」）。
                    void chat.loadConversationById(conversationId).then(() => {
                      navigate('/');
                    });
                  }}
                />
              }
            />
            <Route path="/knowledge" element={
            <KnowledgeBasePage agentId={selectedAgent} chatPanelRef={kbChatPanelRef} />
          } />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/graph" element={<GraphPage />} />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="/resources/:id" element={<ResourceDetailPage />} />
          </Routes>
        </div>
        {/* 全局悬浮对话面板（方案 D）：面板常驻挂载 + CSS --closed 隐藏，保 ref 恒有效。
            右下角悬浮按钮已暂时屏蔽（Task 6）——面板只在 KB 页经 💬问答 等入口唤起，
            离开 /knowledge 自动收起（见上方 effect）。FloatingChatButton 组件保留待回退。 */}
        <KbChatSessionsPanel
          ref={kbChatPanelRef}
          agentId={selectedAgent}
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
    </LanguageProvider>
  );
}

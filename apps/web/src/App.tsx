import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useAgents } from './hooks/useAgents';
import { useChat } from './hooks/useChat';
import { HomePage } from './components/HomePage';
import { kbChatSessionsStore } from './stores/kbChatSessionsStore';

import { NavRail } from './components/NavRail';
import { KnowledgeBasePage } from './components/kb/KnowledgeBasePage';
import { SettingsPage } from './components/settings/SettingsPage';
import { HistoryPage } from './components/history/HistoryPage';
import { GraphPage } from './components/graph/GraphPage';
import { ResourcesPage } from './components/resources/ResourcesPage';
import { ResourceDetailPage } from './components/resources/ResourceDetailPage';
import { UpdateNotification } from './components/UpdateNotification';
import { PreloadToast } from './components/PreloadToast';
import { LanguageProvider } from './i18n/LanguageProvider';
import type { Locale } from './i18n';
import { api } from './api/client';
import { useActiveVault, vaultStore } from './stores/vaultStore';
import { authStore } from './stores/authStore';
import { messageSelectionStore } from './stores/messageSelectionStore';
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

export default function App() {
  const { agents } = useAgents();
  const navigate = useNavigate();
  const location = useLocation();
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const activeVault = useActiveVault();
  const [locale, setLocale] = useState<Locale>('zh');
  const [configLoaded, setConfigLoaded] = useState(false);
  const chat = useChat({ agentId: selectedAgent, cwd: activeVault?.path });

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
                    kbChatSessionsStore.openConversation(conversationId);
                    navigate('/knowledge');
                  }}
                />
              }
            />
            <Route path="/knowledge" element={
            <KnowledgeBasePage agentId={selectedAgent} />
          } />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/graph" element={<GraphPage />} />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="/resources/:id" element={<ResourceDetailPage />} />
          </Routes>
        </div>
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
    </LanguageProvider>
  );
}

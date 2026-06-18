import { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useAgents } from './hooks/useAgents';
import { useChat } from './hooks/useChat';
import { HomePage } from './components/HomePage';
import { NavRail } from './components/NavRail';
import { KnowledgeBasePage } from './components/kb/KnowledgeBasePage';
import { SettingsPage } from './components/settings/SettingsPage';
import { HistoryPage } from './components/history/HistoryPage';
import { GraphPage } from './components/graph/GraphPage';
import { UpdateNotification } from './components/UpdateNotification';
import { LanguageProvider } from './i18n/LanguageProvider';
import type { Locale } from './i18n';
import { api } from './api/client';
import { useActiveVault, vaultStore } from './stores/vaultStore';
import './styles/rail.css';
import './styles/home.css';
import './styles/knowledge.css';
import './styles/runtimes.css';
import './styles/settings.css';
import './styles/channels.css';
import './styles/history.css';
import './styles/graph.css';
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
                  onSend={chat.send}
                  onCancel={chat.cancel}
                  onNewChat={handleNewChat}
                  onSubmitToolResult={chat.submitToolResult}
                />
              }
            />
            <Route
              path="/history"
              element={
                <HistoryPage
                  onOpenConversation={(conversationId) => {
                    void chat.loadConversationById(conversationId).then(() => {
                      navigate('/');
                    });
                  }}
                />
              }
            />
            <Route path="/knowledge" element={<KnowledgeBasePage agentId={selectedAgent} />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/graph" element={<GraphPage />} />
          </Routes>
        </div>
        <UpdateNotification />
      </div>
    </LanguageProvider>
  );
}

import { useState, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useAgents } from './hooks/useAgents';
import { useChat } from './hooks/useChat';
import { HomePage } from './components/HomePage';
import { NavRail } from './components/NavRail';
import { KnowledgeBasePage } from './components/kb/KnowledgeBasePage';
import { RuntimePage } from './components/runtimes/RuntimePage';
import { api } from './api/client';
import type { Vault } from '@molio/contracts';
import './styles/rail.css';
import './styles/home.css';
import './styles/knowledge.css';
import './styles/runtimes.css';
import './App.css';

export default function App() {
  const { agents } = useAgents();
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [activeVault, setActiveVault] = useState<Vault | null>(null);
  const chat = useChat({ agentId: selectedAgent, cwd: activeVault?.path });

  // Load config to get defaultAgentId
  useEffect(() => {
    api.getConfig()
      .then((cfg) => {
        const id = (cfg as { defaultAgentId?: string }).defaultAgentId;
        if (id) setDefaultAgentId(id);
      })
      .catch(() => {});
  }, []);

  // Resolve the active agent once both agents and config are loaded.
  //
  // Rules:
  //  - If the user has configured a defaultAgentId (via Runtimes page) and it
  //    is still available, honour it.
  //  - If no defaultAgentId is configured yet, auto-pick the first available
  //    agent and persist it as the new default — so the next page load reads
  //    the same default from config, and a double-click on the Runtimes page
  //    can later override it.
  //  - Never silently pick a different agent when a configured default exists.
  useEffect(() => {
    if (selectedAgent) return;
    if (agents.length === 0) return;

    if (defaultAgentId) {
      if (agents.some((a) => a.id === defaultAgentId && a.available)) {
        setSelectedAgent(defaultAgentId);
      }
      // If configured default is unavailable, leave selectedAgent null so the
      // composer shows the "no agent" guidance instead of silently switching.
      return;
    }

    // No configured default — auto-pick first available and persist it.
    const firstAvailable = agents.find((a) => a.available);
    if (firstAvailable) {
      setSelectedAgent(firstAvailable.id);
      setDefaultAgentId(firstAvailable.id);
      api.updateConfig({ defaultAgentId: firstAvailable.id }).catch(() => {});
    }
  }, [agents, defaultAgentId, selectedAgent]);

  // Load first vault as default cwd for agent runs
  useEffect(() => {
    api.listVaults().then((vaults) => {
      if (vaults.length > 0) setActiveVault(vaults[0]!);
    }).catch(() => {});
  }, []);

  const handleNewChat = () => {
    chat.reset();
    // Reset to default agent instead of null
    setSelectedAgent(defaultAgentId ?? null);
  };

  return (
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
          <Route path="/knowledge" element={<KnowledgeBasePage agentId={selectedAgent} />} />
          <Route path="/runtimes" element={<RuntimePage />} />
        </Routes>
      </div>
    </div>
  );
}

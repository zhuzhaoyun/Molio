import { useState, useEffect } from 'react';
import { useAgents } from './hooks/useAgents';
import { useChat } from './hooks/useChat';
import { HomePage } from './components/HomePage';
import { NavRail } from './components/NavRail';
import { KnowledgeBasePage } from './components/kb/KnowledgeBasePage';
import { RuntimePage } from './components/runtimes/RuntimePage';
import { api } from './api/client';
import type { Vault } from '@kge/contracts';
import './styles/rail.css';
import './styles/home.css';
import './styles/knowledge.css';
import './styles/runtimes.css';
import './App.css';

type View = 'home' | 'knowledge' | 'runtimes';

export default function App() {
  const { agents } = useAgents();
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [activeVault, setActiveVault] = useState<Vault | null>(null);
  const chat = useChat({ agentId: selectedAgent, cwd: activeVault?.path });
  const [activeView, setActiveView] = useState<View>('home');

  // Load config to get defaultAgentId
  useEffect(() => {
    api.getConfig()
      .then((cfg) => {
        const id = (cfg as { defaultAgentId?: string }).defaultAgentId;
        if (id) setDefaultAgentId(id);
      })
      .catch(() => {});
  }, []);

  // Auto-select default agent when agents load and no agent is selected
  useEffect(() => {
    if (!selectedAgent && defaultAgentId && agents.some((a) => a.id === defaultAgentId && a.available)) {
      setSelectedAgent(defaultAgentId);
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
      <NavRail activeView={activeView} onViewChange={setActiveView} />
      <div className="entry-main">
        {activeView === 'home' ? (
          <HomePage
            selectedAgentName={agents.find((a) => a.id === selectedAgent)?.name ?? null}
            messages={chat.messages}
            isRunning={chat.isRunning}
            onSend={chat.send}
            onCancel={chat.cancel}
            onNewChat={handleNewChat}
            onSubmitToolResult={chat.submitToolResult}
          />
        ) : activeView === 'knowledge' ? (
          <KnowledgeBasePage />
        ) : (
          <RuntimePage />
        )}
      </div>
    </div>
  );
}

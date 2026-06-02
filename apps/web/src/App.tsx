import { useState } from 'react';
import { useAgents } from './hooks/useAgents';
import { useChat } from './hooks/useChat';
import { HomePage } from './components/HomePage';
import { NavRail } from './components/NavRail';
import './styles/rail.css';
import './styles/home.css';
import './App.css';

type View = 'home' | 'knowledge' | 'runtimes';

export default function App() {
  const { agents } = useAgents();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const chat = useChat(selectedAgent);
  const [activeView, setActiveView] = useState<View>('home');

  const handleNewChat = () => {
    chat.reset();
    setSelectedAgent(null);
  };

  return (
    <div className="entry-shell">
      <NavRail activeView={activeView} onViewChange={setActiveView} />
      <div className="entry-main">
        {activeView === 'home' ? (
          <HomePage
            agents={agents}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedAgent}
            messages={chat.messages}
            isRunning={chat.isRunning}
            onSend={chat.send}
            onCancel={chat.cancel}
            onNewChat={handleNewChat}
            onSubmitToolResult={chat.submitToolResult}
          />
        ) : activeView === 'knowledge' ? (
          <div className="placeholder-view">
            <div className="placeholder-icon">📚</div>
            <div className="placeholder-title">Knowledge Base</div>
            <div className="placeholder-hint">Coming soon — manage your local knowledge base.</div>
          </div>
        ) : (
          <div className="placeholder-view">
            <div className="placeholder-icon">⚙️</div>
            <div className="placeholder-title">Runtimes</div>
            <div className="placeholder-hint">Coming soon — manage local runtime connections.</div>
          </div>
        )}
      </div>
    </div>
  );
}

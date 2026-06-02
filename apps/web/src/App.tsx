import { useState } from 'react';
import { useAgents } from './hooks/useAgents';
import { useRun } from './hooks/useRun';
import { AgentSelector } from './components/AgentSelector';
import { StatusBadge } from './components/StatusBadge';
import { RunPanel } from './components/RunPanel';
import { EventStream } from './components/EventStream';
import { ToolResultInput } from './components/ToolResultInput';
import './App.css';

export default function App() {
  const { agents, loading: agentsLoading, error: agentsError, refresh: refreshAgents } = useAgents();
  const run = useRun();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const handleSend = async (message: string) => {
    if (!selectedAgent) return;
    run.reset();
    await run.startRun(selectedAgent, message);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">KGE</h1>
        <div className="header-controls">
          {agentsLoading && <span className="loading">Detecting agents...</span>}
          {agentsError && <span className="error">{agentsError}</span>}
          {!agentsLoading && (
            <AgentSelector
              agents={agents}
              selected={selectedAgent}
              onSelect={setSelectedAgent}
            />
          )}
          <StatusBadge status={run.status} />
        </div>
      </header>

      <main className="app-main">
        <RunPanel
          isRunning={run.status === 'running'}
          onSubmit={handleSend}
          onCancel={run.cancelRun}
          onReset={run.reset}
          hasRun={run.runId !== null}
        />

        <EventStream events={run.events} textContent={run.textContent} />

        {run.pendingToolUse && (
          <ToolResultInput
            toolUseId={run.pendingToolUse.id}
            toolName={run.pendingToolUse.name}
            input={run.pendingToolUse.input}
            onSubmit={run.submitToolResult}
          />
        )}
      </main>
    </div>
  );
}

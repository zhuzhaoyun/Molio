import { useState, type CSSProperties } from 'react';
import type { AgentInfo, RunInfo } from '@kge/contracts';
import { useRuntimes } from '../../hooks/useRuntimes';

type Tab = 'agents' | 'runs';

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; ok: boolean; elapsed: number; error?: string };

type RescanState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; count: number }
  | { status: 'error'; message: string };

const AGENT_ICONS: Record<string, string> = {
  claude: '🟣',
  codex: '🟢',
  gemini: '🔵',
  qwen: '🟠',
};

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'rt-status--pending' },
  running: { label: 'Running', className: 'rt-status--running' },
  succeeded: { label: 'Succeeded', className: 'rt-status--succeeded' },
  failed: { label: 'Failed', className: 'rt-status--failed' },
  canceled: { label: 'Canceled', className: 'rt-status--canceled' },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - ts;

  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ─── Test Result Feedback ─── */
function TestResult({ test }: { test: TestState }) {
  if (test.status === 'idle') return null;

  if (test.status === 'running') {
    return (
      <div className="rt-test-result rt-test-result--running">
        <span className="rt-test-result__spinner" />
        <span>Testing…</span>
      </div>
    );
  }

  if (test.ok) {
    return (
      <div className="rt-test-result rt-test-result--ok">
        <span className="rt-test-result__icon">✓</span>
        <span>OK ({test.elapsed}ms)</span>
      </div>
    );
  }

  return (
    <div className="rt-test-result rt-test-result--error">
      <span className="rt-test-result__icon">✗</span>
      <span className="rt-test-result__msg">{test.error ?? 'Test failed'}</span>
    </div>
  );
}

/* ─── Agent Card ─── */
function AgentCard({
  agent,
  isDefault,
  testState,
  onTest,
  onSetDefault,
}: {
  agent: AgentInfo;
  isDefault: boolean;
  testState: TestState;
  onTest: () => void;
  onSetDefault: () => void;
}) {
  const icon = AGENT_ICONS[agent.id] ?? '⚙️';
  const sourceLabel = agent.source === 'not-found' ? 'Not found' : agent.source ?? 'unknown';

  const handleDoubleClick = () => {
    if (agent.available) onSetDefault();
  };

  return (
    <div
      className={`rt-agent-card${agent.available ? '' : ' rt-agent-card--unavailable'}${isDefault ? ' rt-agent-card--default' : ''}`}
      onDoubleClick={handleDoubleClick}
    >
      <div className="rt-agent-card__icon">{icon}</div>
      <div className="rt-agent-card__body">
        <div className="rt-agent-card__header">
          <span className="rt-agent-card__name">{agent.name}</span>
          {isDefault && <span className="rt-badge rt-badge--default">Default</span>}
          {agent.available ? (
            <span className="rt-badge rt-badge--ok">Available</span>
          ) : (
            <span className="rt-badge rt-badge--off">Unavailable</span>
          )}
        </div>
        <div className="rt-agent-card__meta">
          {agent.version ? (
            <span className="rt-agent-card__version">v{agent.version}</span>
          ) : null}
          {agent.binary ? (
            <span className="rt-agent-card__binary" title={agent.binary}>{agent.binary}</span>
          ) : null}
          <span className="rt-agent-card__source">{sourceLabel}</span>
        </div>
        {agent.models.length > 0 && (
          <div className="rt-agent-card__models">
            {agent.models.map((m) => (
              <span key={m.id} className="rt-chip">{m.label}</span>
            ))}
          </div>
        )}
        {/* Test result feedback */}
        <TestResult test={testState} />
      </div>
      <div className="rt-agent-card__actions">
        {agent.available && (
          <button
            className="rt-btn rt-btn--sm rt-btn--ghost"
            onClick={onTest}
            disabled={testState.status === 'running'}
          >
            Test
          </button>
        )}
        {!agent.available && agent.installUrl && (
          <a className="rt-agent-card__install" href={agent.installUrl} target="_blank" rel="noopener noreferrer">
            Install →
          </a>
        )}
      </div>
    </div>
  );
}

/* ─── Run Row ─── */
function RunRow({ run, onCancel }: { run: RunInfo; onCancel: (id: string) => void }) {
  const status = STATUS_LABELS[run.status] ?? { label: run.status, className: '' };

  return (
    <div className="rt-run-row">
      <div className="rt-run-row__agent">
        <span className="rt-run-row__agent-icon">{AGENT_ICONS[run.agentId] ?? '⚙️'}</span>
        <span className="rt-run-row__agent-name">{run.agentId}</span>
      </div>
      <div className="rt-run-row__status">
        <span className={`rt-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="rt-run-row__time">{formatTime(run.createdAt)}</div>
      <div className="rt-run-row__reason">
        {run.lastStopReason ? <span className="rt-run-row__reason-text">{run.lastStopReason}</span> : null}
      </div>
      <div className="rt-run-row__actions">
        {run.status === 'running' && (
          <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={() => onCancel(run.id)}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Rescan Button ─── */
function RescanButton({ state, onRescan }: { state: RescanState; onRescan: () => void }) {
  const isRunning = state.status === 'running';

  return (
    <div className="rt-rescan-wrap">
      <button className="rt-btn rt-btn--ghost" onClick={onRescan} disabled={isRunning}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          width="16"
          height="16"
          className={isRunning ? 'rt-rescan-icon--spinning' : ''}
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        {isRunning ? 'Scanning…' : 'Rescan'}
      </button>
      {state.status === 'done' && (
        <span className="rt-rescan-notice rt-rescan-notice--ok">
          {state.count} available
        </span>
      )}
      {state.status === 'error' && (
        <span className="rt-rescan-notice rt-rescan-notice--err">
          Scan failed
        </span>
      )}
    </div>
  );
}

/* ─── Main Page ─── */
export function RuntimePage() {
  const {
    agents, runs, loading, error,
    defaultAgentId, testStates, rescanState,
    refresh, testAgent, rescan, setDefaultAgent, cancelRun,
  } = useRuntimes();
  const [activeTab, setActiveTab] = useState<Tab>('agents');

  const availableCount = agents.filter((a) => a.available).length;
  const activeRuns = runs.filter((r) => r.status === 'running').length;

  return (
    <div className="rt-shell">
      {/* Header */}
      <div className="rt-header">
        <div className="rt-header__left">
          <h1 className="rt-header__title">Runtimes</h1>
          <span className="rt-header__subtitle">
            {availableCount} agent{availableCount !== 1 ? 's' : ''} available
            {activeRuns > 0 && ` · ${activeRuns} running`}
          </span>
        </div>
        <RescanButton state={rescanState} onRescan={rescan} />
      </div>

      {/* Tab switcher */}
      <div className="rt-tabs" role="tablist" style={{ '--tab-cols': 2 } as CSSProperties}>
        <button
          role="tab"
          className={`rt-tab${activeTab === 'agents' ? ' active' : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          <span className="rt-tab__title">Agents</span>
          <span className="rt-tab__count">{agents.length}</span>
        </button>
        <button
          role="tab"
          className={`rt-tab${activeTab === 'runs' ? ' active' : ''}`}
          onClick={() => setActiveTab('runs')}
        >
          <span className="rt-tab__title">Runs</span>
          <span className="rt-tab__count">{runs.length}</span>
        </button>
      </div>

      {/* Content */}
      <div className="rt-content">
        {error && (
          <div className="rt-error">
            <span>{error}</span>
            <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={refresh}>Retry</button>
          </div>
        )}

        {loading ? (
          <div className="rt-loading">Loading…</div>
        ) : activeTab === 'agents' ? (
          <AgentsView
            agents={agents}
            defaultAgentId={defaultAgentId}
            testStates={testStates}
            onTest={testAgent}
            onSetDefault={setDefaultAgent}
          />
        ) : (
          <RunsView runs={runs} onCancel={cancelRun} />
        )}
      </div>
    </div>
  );
}

/* ─── Agents View ─── */
function AgentsView({
  agents,
  defaultAgentId,
  testStates,
  onTest,
  onSetDefault,
}: {
  agents: AgentInfo[];
  defaultAgentId: string | null;
  testStates: Record<string, TestState>;
  onTest: (id: string) => void;
  onSetDefault: (id: string) => void;
}) {
  const available = agents.filter((a) => a.available);
  const unavailable = agents.filter((a) => !a.available);

  if (agents.length === 0) {
    return (
      <div className="rt-empty">
        <div className="rt-empty__icon">🔍</div>
        <div className="rt-empty__text">No agents detected</div>
        <div className="rt-empty__hint">Install a supported AI CLI to get started.</div>
      </div>
    );
  }

  return (
    <div className="rt-agents">
      {available.length > 0 && (
        <div className="rt-agents__section">
          <h2 className="rt-section-title">Installed</h2>
          <div className="rt-agents__grid">
            {available.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                isDefault={a.id === defaultAgentId}
                testState={testStates[a.id] ?? { status: 'idle' }}
                onTest={() => onTest(a.id)}
                onSetDefault={() => onSetDefault(a.id)}
              />
            ))}
          </div>
        </div>
      )}
      {unavailable.length > 0 && (
        <div className="rt-agents__section">
          <h2 className="rt-section-title">Not Installed</h2>
          <div className="rt-agents__grid">
            {unavailable.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                isDefault={false}
                testState={testStates[a.id] ?? { status: 'idle' }}
                onTest={() => onTest(a.id)}
                onSetDefault={() => {}}
              />
            ))}
          </div>
        </div>
      )}
      <p className="rt-agents__hint">
        Double-click an agent to set it as the default runtime for chat.
      </p>
    </div>
  );
}

/* ─── Runs View ─── */
function RunsView({ runs, onCancel }: { runs: RunInfo[]; onCancel: (id: string) => void }) {
  if (runs.length === 0) {
    return (
      <div className="rt-empty">
        <div className="rt-empty__icon">📭</div>
        <div className="rt-empty__text">No runs yet</div>
        <div className="rt-empty__hint">Start a conversation to create a run.</div>
      </div>
    );
  }

  const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'pending');
  const completedRuns = runs.filter((r) => r.status !== 'running' && r.status !== 'pending');

  return (
    <div className="rt-runs">
      {activeRuns.length > 0 && (
        <div className="rt-runs__section">
          <h2 className="rt-section-title">Active</h2>
          <div className="rt-runs__list">
            {activeRuns.map((r) => <RunRow key={r.id} run={r} onCancel={onCancel} />)}
          </div>
        </div>
      )}
      {completedRuns.length > 0 && (
        <div className="rt-runs__section">
          <h2 className="rt-section-title">Completed</h2>
          <div className="rt-runs__list">
            {completedRuns.map((r) => <RunRow key={r.id} run={r} onCancel={onCancel} />)}
          </div>
        </div>
      )}
    </div>
  );
}

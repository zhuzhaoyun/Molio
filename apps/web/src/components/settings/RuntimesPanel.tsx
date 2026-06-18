import { useState } from 'react';
import type { AgentInfo, RunInfo } from '@molio/contracts';
import { useRuntimes } from '../../hooks/useRuntimes';
import { useI18n, type Locale } from '../../i18n';

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

function getStatusLabels(locale: Locale): Record<string, { label: string; className: string }> {
  const t = (key: string) => {
    const labels: Record<string, Record<string, string>> = {
      zh: { pending: '等待中', running: '运行中', succeeded: '成功', failed: '失败', canceled: '已取消' },
      en: { pending: 'Pending', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', canceled: 'Canceled' },
    };
    return labels[locale]?.[key] ?? key;
  };
  return {
    pending: { label: t('pending'), className: 'rt-status--pending' },
    running: { label: t('running'), className: 'rt-status--running' },
    succeeded: { label: t('succeeded'), className: 'rt-status--succeeded' },
    failed: { label: t('failed'), className: 'rt-status--failed' },
    canceled: { label: t('canceled'), className: 'rt-status--canceled' },
  };
}

function formatTime(ts: number, locale: Locale, t: (key: string, params?: Record<string, string | number>) => string): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;

  if (diff < 60_000) return t('runtimes.justNow');
  if (diff < 3_600_000) return t('runtimes.mAgo', { n: String(Math.floor(diff / 60_000)) });
  if (diff < 86_400_000) return t('runtimes.hAgo', { n: String(Math.floor(diff / 3_600_000)) });

  return d.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ─── Test Result Feedback ─── */
function TestResult({ test }: { test: TestState }) {
  const { t } = useI18n();

  if (test.status === 'idle') return null;

  if (test.status === 'running') {
    return (
      <div className="rt-test-result rt-test-result--running">
        <span className="rt-test-result__spinner" />
        <span>{t('runtimes.testing')}</span>
      </div>
    );
  }

  if (test.ok) {
    return (
      <div className="rt-test-result rt-test-result--ok">
        <span className="rt-test-result__icon">✓</span>
        <span>{t('runtimes.testOk', { elapsed: String(test.elapsed) })}</span>
      </div>
    );
  }

  return (
    <div className="rt-test-result rt-test-result--error">
      <span className="rt-test-result__icon">✗</span>
      <span className="rt-test-result__msg">{test.error ?? t('runtimes.testFailed')}</span>
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
  const { t } = useI18n();
  const icon = AGENT_ICONS[agent.id] ?? '⚙️';
  const sourceLabel = agent.source === 'not-found' ? t('runtimes.notFound') : agent.source ?? 'unknown';

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
          {isDefault && <span className="rt-badge rt-badge--default">{t('runtimes.default')}</span>}
          {agent.available ? (
            <span className="rt-badge rt-badge--ok">{t('runtimes.available')}</span>
          ) : (
            <span className="rt-badge rt-badge--off">{t('runtimes.unavailable')}</span>
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
            {agent.models.map((m: { id: string; label: string }) => (
              <span key={m.id} className="rt-chip">{m.label}</span>
            ))}
          </div>
        )}
        <TestResult test={testState} />
      </div>
      <div className="rt-agent-card__actions">
        {agent.available && (
          <button
            className="rt-btn rt-btn--sm rt-btn--ghost"
            onClick={onTest}
            disabled={testState.status === 'running'}
          >
            {t('runtimes.test')}
          </button>
        )}
        {!agent.available && agent.installUrl && (
          <a className="rt-agent-card__install" href={agent.installUrl} target="_blank" rel="noopener noreferrer">
            {t('runtimes.install')}
          </a>
        )}
      </div>
    </div>
  );
}

/* ─── Run Row ─── */
function RunRow({ run, onCancel }: { run: RunInfo; onCancel: (id: string) => void }) {
  const { t, locale } = useI18n();
  const statusLabels = getStatusLabels(locale);
  const status = statusLabels[run.status] ?? { label: run.status, className: '' };

  return (
    <div className="rt-run-row">
      <div className="rt-run-row__agent">
        <span className="rt-run-row__agent-icon">{AGENT_ICONS[run.agentId] ?? '⚙️'}</span>
        <span className="rt-run-row__agent-name">{run.agentId}</span>
      </div>
      <div className="rt-run-row__status">
        <span className={`rt-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="rt-run-row__time">{formatTime(run.createdAt, locale, t)}</div>
      <div className="rt-run-row__reason">
        {run.lastStopReason ? <span className="rt-run-row__reason-text">{run.lastStopReason}</span> : null}
      </div>
      <div className="rt-run-row__actions">
        {run.status === 'running' && (
          <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={() => onCancel(run.id)}>
            {t('runtimes.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Rescan Button ─── */
function RescanButton({ state, onRescan }: { state: RescanState; onRescan: () => void }) {
  const { t } = useI18n();
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
        {isRunning ? t('runtimes.scanning') : t('runtimes.rescan')}
      </button>
      {state.status === 'done' && (
        <span className="rt-rescan-notice rt-rescan-notice--ok">
          {state.count} {t('runtimes.availableSuffix')}
        </span>
      )}
      {state.status === 'error' && (
        <span className="rt-rescan-notice rt-rescan-notice--err">
          {t('runtimes.scanFailed')}
        </span>
      )}
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
  const { t } = useI18n();
  const available = agents.filter((a) => a.available);
  const unavailable = agents.filter((a) => !a.available);

  if (agents.length === 0) {
    return (
      <div className="rt-empty">
        <div className="rt-empty__icon">🔍</div>
        <div className="rt-empty__text">{t('runtimes.noAgents')}</div>
        <div className="rt-empty__hint">{t('runtimes.installHint')}</div>
      </div>
    );
  }

  return (
    <div className="rt-agents">
      {available.length > 0 && (
        <div className="rt-agents__section">
          <h2 className="rt-section-title">{t('runtimes.installed')}</h2>
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
          <h2 className="rt-section-title">{t('runtimes.notInstalled')}</h2>
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
        {t('runtimes.agentHint')}
      </p>
    </div>
  );
}

/* ─── Runs View ─── */
function RunsView({ runs, onCancel }: { runs: RunInfo[]; onCancel: (id: string) => void }) {
  const { t } = useI18n();

  if (runs.length === 0) {
    return (
      <div className="rt-empty">
        <div className="rt-empty__icon">📭</div>
        <div className="rt-empty__text">{t('runtimes.noRuns')}</div>
        <div className="rt-empty__hint">{t('runtimes.startHint')}</div>
      </div>
    );
  }

  const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'pending');
  const completedRuns = runs.filter((r) => r.status !== 'running' && r.status !== 'pending');

  return (
    <div className="rt-runs">
      {activeRuns.length > 0 && (
        <div className="rt-runs__section">
          <h2 className="rt-section-title">{t('runtimes.active')}</h2>
          <div className="rt-runs__list">
            {activeRuns.map((r) => <RunRow key={r.id} run={r} onCancel={onCancel} />)}
          </div>
        </div>
      )}
      {completedRuns.length > 0 && (
        <div className="rt-runs__section">
          <h2 className="rt-section-title">{t('runtimes.completed')}</h2>
          <div className="rt-runs__list">
            {completedRuns.map((r) => <RunRow key={r.id} run={r} onCancel={onCancel} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Runtimes Panel (used inside Settings) ─── */
export function RuntimesPanel() {
  const { t } = useI18n();
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
          <h1 className="rt-header__title">{t('runtimes.title')}</h1>
          <span className="rt-header__subtitle">
            {t('runtimes.agentsAvailable', { count: String(availableCount) })}
            {activeRuns > 0 && ` · ${t('runtimes.running', { count: String(activeRuns) })}`}
          </span>
        </div>
        <RescanButton state={rescanState} onRescan={rescan} />
      </div>

      {/* Tab switcher */}
      <div className="rt-tabs" role="tablist">
        <button
          role="tab"
          className={`rt-tab${activeTab === 'agents' ? ' active' : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          <span className="rt-tab__title">{t('runtimes.agentsTab')}</span>
          <span className="rt-tab__count">{agents.length}</span>
        </button>
        <button
          role="tab"
          className={`rt-tab${activeTab === 'runs' ? ' active' : ''}`}
          onClick={() => setActiveTab('runs')}
        >
          <span className="rt-tab__title">{t('runtimes.runsTab')}</span>
          <span className="rt-tab__count">{runs.length}</span>
        </button>
      </div>

      {/* Content */}
      <div className="rt-content">
        {error && (
          <div className="rt-error">
            <span>{error}</span>
            <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={refresh}>{t('runtimes.retry')}</button>
          </div>
        )}

        {loading ? (
          <div className="rt-loading">{t('runtimes.loading')}</div>
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

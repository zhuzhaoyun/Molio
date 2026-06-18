import { useState, useRef, useEffect, useCallback } from 'react';
import type { InstallEvent, InstallPhase, ErrorCategory } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

type InstallState =
  | { status: 'idle' }
  | { status: 'installing'; phase: InstallPhase | null; percent: number; logs: string[] }
  | { status: 'done'; message: string; version?: string }
  | { status: 'error'; message: string; category: ErrorCategory; retryable: boolean; hint?: string };

interface InstallButtonProps {
  agentId: string;
  installUrl?: string;
  onInstalled: () => void;
}

export function InstallButton({ agentId, installUrl, onInstalled }: InstallButtonProps) {
  const { t } = useI18n();
  const [state, setState] = useState<InstallState>({ status: 'idle' });
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll log panel to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [state]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const handleInstall = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ status: 'installing', phase: null, percent: 0, logs: [] });

    const handleEvent = (event: InstallEvent) => {
      if (ac.signal.aborted) return;

      if (event.type === 'phase') {
        setState((prev) => {
          if (prev.status !== 'installing') return prev;
          return { ...prev, phase: event.phase, logs: [...prev.logs, event.message] };
        });
      } else if (event.type === 'progress') {
        setState((prev) => {
          if (prev.status !== 'installing') return prev;
          return { ...prev, percent: event.percent };
        });
      } else if (event.type === 'log') {
        setState((prev) => {
          if (prev.status !== 'installing') return prev;
          return { ...prev, logs: [...prev.logs, event.message] };
        });
      } else if (event.type === 'done') {
        setState({ status: 'done', message: event.message, version: event.version });
        setTimeout(onInstalled, 1500);
      } else if (event.type === 'error') {
        setState({
          status: 'error',
          message: event.message,
          category: event.category,
          retryable: event.retryable,
          hint: event.hint,
        });
      }
    };

    try {
      await api.installAgent(agentId, handleEvent, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        setState({
          status: 'error',
          message: (err as Error).message,
          category: 'network',
          retryable: true,
        });
      }
    } finally {
      abortRef.current = null;
    }
  }, [agentId, onInstalled]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setState({ status: 'idle' });
  }, []);

  // ── Render: Done ──
  if (state.status === 'done') {
    return (
      <div className="rt-install-result rt-install-result--ok">
        <span className="rt-install-result__icon">✓</span>
        <span>{state.version ? `${state.message} (${state.version})` : state.message}</span>
      </div>
    );
  }

  // ── Render: Error ──
  if (state.status === 'error') {
    const categoryLabel = t(`runtimes.installError${capitalize(state.category)}` as any) || state.category;
    return (
      <div className="rt-install-wrap">
        <div className="rt-install-result rt-install-result--error">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className="rt-install-result__icon">✗</span>
            <span className="rt-install-error__category">{categoryLabel}</span>
          </div>
          <pre className="rt-install-result__msg">{state.message}</pre>
          {state.hint && (
            <div className="rt-install-error__hint">{state.hint}</div>
          )}
        </div>
        <div className="rt-install-actions">
          {state.retryable && (
            <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={handleInstall}>
              {t('runtimes.retry')}
            </button>
          )}
          {!state.retryable && installUrl && (
            <a href={installUrl} target="_blank" rel="noopener noreferrer" className="rt-btn rt-btn--sm rt-btn--ghost">
              {t('runtimes.install')}
            </a>
          )}
        </div>
      </div>
    );
  }

  // ── Render: Installing ──
  if (state.status === 'installing') {
    const phaseLabel = state.phase ? t(`runtimes.installPhase${capitalize(state.phase)}` as any) : '';
    const isDownloading = state.phase === 'download';

    return (
      <div className="rt-install-wrap">
        <div className="rt-install-status">
          <span className="rt-test-result__spinner" />
          <span>{isDownloading ? `${t('runtimes.installing')} ${state.percent}%` : t('runtimes.installing')}</span>
          <button className="rt-btn rt-btn--xs rt-btn--ghost rt-install-cancel" onClick={handleCancel}>
            {t('runtimes.installCancel')}
          </button>
        </div>
        {isDownloading && (
          <div className="rt-install-progress">
            <div className="rt-install-progress__bar" style={{ width: `${state.percent}%` }} />
          </div>
        )}
        {phaseLabel && !isDownloading && (
          <div className="rt-install-phase">{phaseLabel}</div>
        )}
        <div className="rt-install-log" ref={logRef}>
          {state.logs.map((line, i) => (
            <div key={i} className="rt-install-log__line">{line}</div>
          ))}
        </div>
      </div>
    );
  }

  // ── Render: Idle ──
  return (
    <button
      className="rt-btn rt-btn--sm rt-install-btn"
      onClick={handleInstall}
    >
      {t('runtimes.installBtn')}
    </button>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

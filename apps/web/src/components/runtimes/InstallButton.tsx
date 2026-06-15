import { useState, useRef, useEffect, useCallback } from 'react';
import type { InstallEvent } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

type InstallState =
  | { status: 'idle' }
  | { status: 'installing'; logs: string[] }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string };

interface InstallButtonProps {
  agentId: string;
  onInstalled: () => void;
}

export function InstallButton({ agentId, onInstalled }: InstallButtonProps) {
  const { t } = useI18n();
  const [state, setState] = useState<InstallState>({ status: 'idle' });
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  // Auto-scroll log panel to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [state]);

  const handleInstall = useCallback(async () => {
    abortRef.current = false;
    setState({ status: 'installing', logs: [] });

    const handleEvent = (event: InstallEvent) => {
      if (abortRef.current) return;

      if (event.type === 'log' || event.type === 'node-check') {
        setState((prev) => {
          if (prev.status !== 'installing') return prev;
          return { ...prev, logs: [...prev.logs, event.message] };
        });
      } else if (event.type === 'done') {
        setState({ status: 'done', message: event.message });
        // Trigger rescan after a short delay
        setTimeout(onInstalled, 1500);
      } else if (event.type === 'error') {
        setState({ status: 'error', message: event.message });
      }
    };

    try {
      await api.installAgent(agentId, handleEvent);
    } catch (err) {
      if (!abortRef.current) {
        setState({ status: 'error', message: (err as Error).message });
      }
    }
  }, [agentId, onInstalled]);

  if (state.status === 'done') {
    return (
      <div className="rt-install-result rt-install-result--ok">
        <span className="rt-install-result__icon">✓</span>
        <span>{t('runtimes.installDone')}</span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="rt-install-wrap">
        <div className="rt-install-result rt-install-result--error">
          <span className="rt-install-result__icon">✗</span>
          <span className="rt-install-result__msg">{state.message}</span>
        </div>
        <button
          className="rt-btn rt-btn--sm rt-btn--ghost"
          onClick={() => setState({ status: 'idle' })}
        >
          {t('runtimes.retry')}
        </button>
      </div>
    );
  }

  if (state.status === 'installing') {
    return (
      <div className="rt-install-wrap">
        <div className="rt-install-status">
          <span className="rt-test-result__spinner" />
          <span>{t('runtimes.installing')}</span>
        </div>
        <div className="rt-install-log" ref={logRef}>
          {state.logs.map((line, i) => (
            <div key={i} className="rt-install-log__line">{line}</div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <button
      className="rt-btn rt-btn--sm rt-install-btn"
      onClick={handleInstall}
    >
      {t('runtimes.installBtn')}
    </button>
  );
}

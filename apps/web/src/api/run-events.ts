import type { AgentEvent, RunInfo } from '@molio/contracts';
import type { AccessController } from '../access/session-controller.ts';
import type { ManagedEventsOptions, ManagedEventSubscription, ManagedTransportState } from './managed-events.ts';
interface SSEEnvelope { seq: number; runId: string; event: AgentEvent }
export function createRunSubscriber(deps: {
  open: (options: ManagedEventsOptions) => ManagedEventSubscription;
  getContext: AccessController['getContext']; getRun: (id: string) => Promise<RunInfo>;
  replay: (id: string, after: number, onMessage: (message: MessageEvent<string>) => void, signal: AbortSignal) => Promise<void>;
  suppressMessages?: () => boolean;
}) {
  return function subscribeToRun(runId: string, onEvent: (event: AgentEvent, seq?: number) => void, onError?: (error: Event) => void, onDone?: () => void, afterSeq?: number, onKeepalive?: () => void, onTransportState?: (state: ManagedTransportState) => void): ManagedEventSubscription {
    const scope = deps.getContext()?.resources;
    const replayAbort = new AbortController();
    let lastSeq = afterSeq ?? 0; let closed = false; let reconciling = false;
    const options: ManagedEventsOptions = {
      url: () => `/api/runs/${runId}/events${lastSeq > 0 ? `?after=${lastSeq}` : ''}`,
      onState: onTransportState,
      onMessage(msg) {
        if (closed || !deps.getContext() || (scope && deps.getContext()?.resources !== scope) || deps.suppressMessages?.()) return;
        if (msg.data === 'ping') { onKeepalive?.(); return; }
        try { const envelope: SSEEnvelope = JSON.parse(msg.data); if (envelope.seq <= lastSeq) return; lastSeq = envelope.seq; onEvent(envelope.event, envelope.seq); } catch { /* non-JSON keepalive */ }
      },
      onLocalClosed: onDone,
      onError(event) {
        onError?.(event); const context = deps.getContext();
        if (!context || context.mode !== 'server' || reconciling || closed) return;
        reconciling = true;
        void deps.getRun(runId).then(async run => {
          if (closed || deps.getContext()?.resources !== context.resources) return;
          if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
            await deps.replay(runId, lastSeq, options.onMessage, replayAbort.signal);
            if (closed || deps.getContext()?.resources !== context.resources) return;
            closed = true; subscription.close(); onDone?.();
          }
        }).catch(() => {}).finally(() => { reconciling = false; });
      },
    };
    const subscription = deps.open(options);
    return { close() { closed = true; replayAbort.abort(); subscription.close(); }, reconnect() { if (!closed) subscription.reconnect(); } };
  };
}

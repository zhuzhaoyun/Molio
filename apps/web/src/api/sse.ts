import { openManagedEvents } from './managed-events';
import { accessController } from '../access/runtime';
import { api } from './client';
import { daemonFetch, getDaemonResponseSignal } from './http';
import { createRunSubscriber } from './run-events';
import { consumeSseData } from './read-stream';

export const subscribeToRun = createRunSubscriber({
  open: openManagedEvents, getContext: accessController.getContext, getRun: id => api.getRun(id),
  suppressMessages: () => typeof window !== 'undefined' && (window as any).__MOLIO_DEBUG_SSE_OPEN_SILENT__ === true,
  async replay(id, after, onMessage, signal) {
    // Terminal runs produce a finite replay. Only a complete, authenticated
    // response can settle an observation; GET status alone cannot recover text.
    const response = await daemonFetch(`/api/runs/${id}/events?after=${after}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Replay unavailable');
    await consumeSseData(response.body, getDaemonResponseSignal(response), data => onMessage({ data } as MessageEvent<string>));
  },
});

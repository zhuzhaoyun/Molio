import { useState, useCallback, useRef } from 'react';
import type { AgentEvent, RunStatus } from '@kge/contracts';
import { api } from '../api/client';
import { subscribeToRun } from '../api/sse';

export interface RunState {
  runId: string | null;
  status: RunStatus;
  events: AgentEvent[];
  pendingToolUse: { id: string; name: string; input: unknown } | null;
  textContent: string;
}

export function useRun() {
  const [state, setState] = useState<RunState>({
    runId: null,
    status: 'pending',
    events: [],
    pendingToolUse: null,
    textContent: '',
  });
  const esRef = useRef<EventSource | null>(null);

  const startRun = useCallback(async (agentId: string, message: string, model?: string) => {
    // Close any existing SSE connection
    esRef.current?.close();

    setState({
      runId: null,
      status: 'running',
      events: [],
      pendingToolUse: null,
      textContent: '',
    });

    const runId = await api.createRun({ agentId, message, model });

    setState((prev) => ({ ...prev, runId }));

    const es = subscribeToRun(
      runId,
      (event) => {
        setState((prev) => {
          const newEvents = [...prev.events, event];
          let newStatus = prev.status;
          let newPending = prev.pendingToolUse;
          let newText = prev.textContent;

          // Accumulate text content
          if (event.type === 'text_delta') {
            newText += event.delta;
          }

          // Detect AskUserQuestion tool_use
          if (event.type === 'tool_use' && event.name === 'AskUserQuestion') {
            newPending = { id: event.id, name: event.name, input: event.input };
          }

          // Clear pending tool use when we get a result
          if (event.type === 'tool_result' && prev.pendingToolUse?.id === event.toolUseId) {
            newPending = null;
          }

          // Detect terminal events
          if (event.type === 'usage' || event.type === 'error') {
            // Don't set status here — wait for the status event from close handler
          }
          if (event.type === 'status' && (event.label === 'completed' || event.label === 'failed')) {
            newStatus = event.label === 'completed' ? 'succeeded' : 'failed';
          }

          return {
            ...prev,
            events: newEvents,
            status: newStatus,
            pendingToolUse: newPending,
            textContent: newText,
          };
        });
      },
      () => {
        // SSE error — could be transient, EventSource will retry
      },
    );

    esRef.current = es;
  }, []);

  const submitToolResult = useCallback(async (toolUseId: string, content: string) => {
    if (!state.runId) return;
    await api.submitToolResult(state.runId, { toolUseId, content });
    setState((prev) => ({ ...prev, pendingToolUse: null }));
  }, [state.runId]);

  const cancelRun = useCallback(async () => {
    if (!state.runId) return;
    await api.cancelRun(state.runId);
    esRef.current?.close();
    setState((prev) => ({ ...prev, status: 'canceled' }));
  }, [state.runId]);

  const reset = useCallback(() => {
    esRef.current?.close();
    setState({
      runId: null,
      status: 'pending',
      events: [],
      pendingToolUse: null,
      textContent: '',
    });
  }, []);

  return { ...state, startRun, submitToolResult, cancelRun, reset };
}

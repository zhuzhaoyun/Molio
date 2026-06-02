/**
 * KGE Runtime Client — renderer-side API for communicating with the daemon.
 *
 * This file declares the types exposed by the preload script via
 * contextBridge, and provides a thin convenience layer.
 */

interface AgentModelOption {
  id: string;
  label: string;
}

interface AgentInfo {
  id: string;
  name: string;
  available: boolean;
  version: string | null;
  models: AgentModelOption[];
  installUrl?: string;
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface RunEventData {
  runId: string;
  event: AgentEvent;
}

interface KgeApi {
  listAgents: () => Promise<AgentInfo[]>;
  createRun: (opts: {
    agentId: string;
    message: string;
    model?: string;
    cwd?: string;
  }) => Promise<{ runId: string }>;
  submitToolResult: (runId: string, toolUseId: string, content: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  onRunEvent: (callback: (data: RunEventData) => void) => void;
  offRunEvent: () => void;
}

declare global {
  interface Window {
    kge: KgeApi;
  }
}

export type { AgentInfo, AgentEvent, RunEventData, KgeApi };

/**
 * Convenience wrapper for running a single conversation turn.
 * Handles event subscription and unsubscription.
 */
export async function runConversation(opts: {
  agentId: string;
  message: string;
  model?: string;
  cwd?: string;
  onText?: (delta: string) => void;
  onToolUse?: (id: string, name: string, input: unknown) => void;
  onToolResult?: (toolUseId: string, content: string) => void;
  onStatus?: (label: string) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}): Promise<string> {
  const { runId } = await window.kge.createRun({
    agentId: opts.agentId,
    message: opts.message,
    model: opts.model,
    cwd: opts.cwd,
  });

  window.kge.onRunEvent(({ runId: evRunId, event }) => {
    if (evRunId !== runId) return;

    switch (event.type) {
      case 'text_delta':
        opts.onText?.(event['delta'] as string);
        break;
      case 'tool_use':
        opts.onToolUse?.(
          event['id'] as string,
          event['name'] as string,
          event['input'],
        );
        break;
      case 'tool_result':
        opts.onToolResult?.(
          event['toolUseId'] as string,
          event['content'] as string,
        );
        break;
      case 'status':
        opts.onStatus?.(event['label'] as string);
        break;
      case 'error':
        opts.onError?.(event['message'] as string);
        break;
      case 'usage':
        opts.onDone?.();
        window.kge.offRunEvent();
        break;
    }
  });

  return runId;
}

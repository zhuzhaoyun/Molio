import { useState, useEffect } from 'react';
import type { AgentInfo } from '@molio/contracts';
import { api } from '../api/client';

/** Custom event dispatched when agents are installed/uninstalled. */
export const AGENTS_CHANGED_EVENT = 'molio:agents-changed';

/**
 * Custom event dispatched when an ACP agent (e.g. Hermes) reports its dynamic
 * model list via session/new. detail: { agentId, models, currentModelId }.
 * useAgents listens and merges into the corresponding AgentInfo so the UI
 * shows real models instead of the static fallbackModels placeholder.
 */
export const ACP_MODELS_UPDATED_EVENT = 'molio:acp-models-updated';
export type AcpModelsUpdatedDetail = {
  agentId: string;
  models: { id: string; label: string }[];
  currentModelId?: string;
};

export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = () => {
    setLoading(true);
    api.listAgents()
      .then(setAgents)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  // Refresh when agents are installed/uninstalled from the Runtimes page.
  useEffect(() => {
    const handler = () => fetchAgents();
    window.addEventListener(AGENTS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, handler);
  }, []);

  // Merge dynamic model lists reported by ACP agents (Hermes) into the agent info.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AcpModelsUpdatedDetail>).detail;
      if (!detail?.agentId) return;
      setAgents((prev) => prev.map((a) => {
        if (a.id !== detail.agentId) return a;
        return {
          ...a,
          models: detail.models.length > 0 ? detail.models : a.models,
        };
      }));
    };
    window.addEventListener(ACP_MODELS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACP_MODELS_UPDATED_EVENT, handler);
  }, []);

  return { agents, loading, error, refresh: fetchAgents };
}

import { useState, useEffect } from 'react';
import type { AgentInfo } from '@molio/contracts';
import { api } from '../api/client';

/** Custom event dispatched when agents are installed/uninstalled. */
export const AGENTS_CHANGED_EVENT = 'molio:agents-changed';

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
  // The Runtimes page uses its own useRuntimes hook which rescans independently;
  // this listener bridges the two so the home page auto-selects newly installed agents.
  useEffect(() => {
    const handler = () => fetchAgents();
    window.addEventListener(AGENTS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, handler);
  }, []);

  return { agents, loading, error, refresh: fetchAgents };
}

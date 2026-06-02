import { useState, useEffect } from 'react';
import type { AgentInfo } from '@kge/contracts';
import { api } from '../api/client';

export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAgents()
      .then(setAgents)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return { agents, loading, error, refresh: () => {
    setLoading(true);
    api.listAgents().then(setAgents).catch((err) => setError((err as Error).message)).finally(() => setLoading(false));
  }};
}

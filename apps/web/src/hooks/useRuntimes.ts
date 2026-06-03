import { useState, useEffect, useCallback } from 'react';
import type { AgentInfo, RunInfo } from '@kge/contracts';
import { api } from '../api/client';

export function useRuntimes() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentsData, runsData, configData] = await Promise.all([
        api.listAgents(),
        api.listRuns(),
        api.getConfig(),
      ]);
      setAgents(agentsData);
      setRuns(runsData);
      setConfig(configData);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refreshAgents = useCallback(async () => {
    try {
      const data = await api.listAgents();
      setAgents(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const data = await api.listRuns();
      setRuns(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const cancelRun = useCallback(async (runId: string) => {
    await api.cancelRun(runId);
    await refreshRuns();
  }, [refreshRuns]);

  return {
    agents, runs, config,
    loading, error,
    refresh: load,
    refreshAgents,
    refreshRuns,
    cancelRun,
  };
}

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AgentInfo, RunInfo } from '@molio/contracts';
import { api } from '../api/client';

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; ok: boolean; elapsed: number; error?: string };

type RescanState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; count: number }
  | { status: 'error'; message: string };

export function useRuntimes() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-agent test state
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const testAbortRef = useRef<Record<string, AbortController>>({});

  // Rescan state
  const [rescanState, setRescanState] = useState<RescanState>({ status: 'idle' });
  const rescanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Default agent
  const defaultAgentId = (config as { defaultAgentId?: string }).defaultAgentId ?? null;

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

  // Auto-clear rescan notice after 6s
  useEffect(() => {
    if (rescanState.status === 'done' || rescanState.status === 'error') {
      rescanTimerRef.current = setTimeout(() => {
        setRescanState({ status: 'idle' });
      }, 6000);
    }
    return () => {
      if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current);
    };
  }, [rescanState.status]);

  const testAgent = useCallback(async (agentId: string) => {
    // Cancel any existing test for this agent
    testAbortRef.current[agentId]?.abort();
    const ctrl = new AbortController();
    testAbortRef.current[agentId] = ctrl;

    setTestStates((s) => ({ ...s, [agentId]: { status: 'running' } }));
    try {
      const result = await api.testAgent(agentId);
      if (ctrl.signal.aborted) return;
      setTestStates((s) => ({
        ...s,
        [agentId]: {
          status: 'done',
          ok: result.ok,
          elapsed: result.elapsed,
          error: result.error,
        },
      }));
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setTestStates((s) => ({
        ...s,
        [agentId]: {
          status: 'done',
          ok: false,
          elapsed: 0,
          error: (err as Error).message,
        },
      }));
    }
  }, []);

  const rescan = useCallback(async () => {
    if (rescanState.status === 'running') return;
    setRescanState({ status: 'running' });
    try {
      const agentsData = await api.listAgents();
      setAgents(agentsData);
      const count = agentsData.filter((a) => a.available).length;
      setRescanState({ status: 'done', count });
    } catch (err) {
      setRescanState({ status: 'error', message: (err as Error).message });
    }
  }, [rescanState.status]);

  const setDefaultAgent = useCallback(async (agentId: string) => {
    try {
      const nextConfig = { ...config, defaultAgentId: agentId };
      await api.updateConfig(nextConfig);
      setConfig(nextConfig);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [config]);

  const cancelRun = useCallback(async (runId: string) => {
    await api.cancelRun(runId);
    // Refresh runs list
    try {
      const data = await api.listRuns();
      setRuns(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  return {
    agents, runs, config,
    loading, error,
    defaultAgentId,
    testStates,
    rescanState,
    refresh: load,
    testAgent,
    rescan,
    setDefaultAgent,
    cancelRun,
  };
}

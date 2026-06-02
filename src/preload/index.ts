import { contextBridge, ipcRenderer } from 'electron';

const kgeApi = {
  // ── Agents ──
  detectAgents: (): Promise<Array<{
    id: string;
    name: string;
    available: boolean;
    binary: string | null;
    source: string;
    version: string | null;
    models: Array<{ id: string; label: string }>;
    installUrl?: string;
  }>> => ipcRenderer.invoke('agents:detect'),

  listAgents: (): Promise<Array<{
    id: string;
    name: string;
    available: boolean;
    version: string | null;
    models: Array<{ id: string; label: string }>;
    installUrl?: string;
  }>> => ipcRenderer.invoke('agents:list'),

  // ── Runs ──
  createRun: (opts: {
    agentId: string;
    message: string;
    model?: string;
    cwd?: string;
  }): Promise<{ runId: string }> => ipcRenderer.invoke('runs:create', opts),

  submitToolResult: (runId: string, toolUseId: string, content: string): Promise<void> =>
    ipcRenderer.invoke('runs:tool-result', { runId, toolUseId, content }),

  cancelRun: (runId: string): Promise<void> =>
    ipcRenderer.invoke('runs:cancel', runId),

  // ── Event stream ──
  onRunEvent: (callback: (data: { runId: string; event: unknown }) => void): void => {
    ipcRenderer.on('runs:event', (_event, data) => callback(data));
  },

  offRunEvent: (): void => {
    ipcRenderer.removeAllListeners('runs:event');
  },

  // ── Config ──
  getConfig: (): Promise<{
    agents: Record<string, { binaryPath?: string; env?: Record<string, string> }>;
    defaultCwd?: string;
  }> => ipcRenderer.invoke('config:get'),

  setConfig: (config: {
    agents: Record<string, { binaryPath?: string; env?: Record<string, string> }>;
    defaultCwd?: string;
  }): Promise<{ ok: boolean }> => ipcRenderer.invoke('config:set', config),

  setAgentConfig: (data: {
    agentId: string;
    binaryPath?: string;
    env?: Record<string, string>;
  }): Promise<{ ok: boolean }> => ipcRenderer.invoke('config:setAgent', data),
};

contextBridge.exposeInMainWorld('kge', kgeApi);

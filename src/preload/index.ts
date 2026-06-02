import { contextBridge, ipcRenderer } from 'electron';

const kgeApi = {
  // ── Agents ──
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
};

contextBridge.exposeInMainWorld('kge', kgeApi);

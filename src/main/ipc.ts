import { ipcMain, BrowserWindow } from 'electron';
import type { RunManager } from '../daemon/server.js';
import type { AgentEvent } from '../daemon/types.js';
import { loadConfig, saveConfig, setAgentConfig } from '../daemon/config.js';

export function registerIpcHandlers(runManager: RunManager): void {
  // ── List / detect available agents ──
  ipcMain.handle('agents:detect', () => {
    const agents = runManager.detectAgents();
    console.log('[IPC] agents:detect →', JSON.stringify(agents.map(a => ({
      id: a.id,
      available: a.available,
      binary: a.binary,
      source: a.source,
      version: a.version,
    })), null, 2));
    return agents;
  });

  ipcMain.handle('agents:list', () => {
    return runManager.listAgents();
  });

  // ── Create a new run ──
  ipcMain.handle('runs:create', async (event, opts: {
    agentId: string;
    message: string;
    model?: string;
    cwd?: string;
  }) => {
    const runId = await runManager.createRun(opts);

    // Subscribe to events and broadcast to all windows
    const win = BrowserWindow.fromWebContents(event.sender);
    runManager.onEvent(runId, (ev: AgentEvent) => {
      // Send to the requesting window
      if (win && !win.isDestroyed()) {
        win.webContents.send('runs:event', { runId, event: ev });
      }
      // Also broadcast to all other windows
      for (const w of BrowserWindow.getAllWindows()) {
        if (w !== win && !w.isDestroyed()) {
          w.webContents.send('runs:event', { runId, event: ev });
        }
      }
    });

    return { runId };
  });

  // ── Submit tool result (AskUserQuestion answer) ──
  ipcMain.handle('runs:tool-result', (_event, data: {
    runId: string;
    toolUseId: string;
    content: string;
  }) => {
    runManager.submitToolResult(data.runId, data.toolUseId, data.content);
  });

  // ── Cancel a run ──
  ipcMain.handle('runs:cancel', (_event, runId: string) => {
    runManager.cancelRun(runId);
  });

  // ── Config: get full config ──
  ipcMain.handle('config:get', () => {
    return loadConfig();
  });

  // ── Config: set full config ──
  ipcMain.handle('config:set', (_event, config) => {
    saveConfig(config);
    return { ok: true };
  });

  // ── Config: set agent-specific config (binary path, env) ──
  ipcMain.handle('config:setAgent', (_event, data: {
    agentId: string;
    binaryPath?: string;
    env?: Record<string, string>;
  }) => {
    setAgentConfig(data.agentId, {
      binaryPath: data.binaryPath,
      env: data.env,
    });
    return { ok: true };
  });
}

import { ipcMain, BrowserWindow } from 'electron';
import type { RunManager } from '../daemon/server.js';
import type { AgentEvent } from '../daemon/types.js';

export function registerIpcHandlers(runManager: RunManager): void {
  // ── List available agents ──
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
}

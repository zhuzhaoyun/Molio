import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentsRoutes } from '../../src/routes/agents.js';
import type { RunManager } from '../../src/core/RunManager.js';
import { saveConfig } from '../../src/core/config.js';

it('reuses runtime scans while explicit refresh and config changes rescan immediately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-agents-cache-'));
  const previous = process.env.MOLIO_DATA_DIR;
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  process.env.MOLIO_DATA_DIR = dir;
  let calls = 0;
  const manager = { detectAgents() { calls++; return []; } } as unknown as RunManager;
  try {
    saveConfig({ agents: {} });
    const app = agentsRoutes(manager);
    assert.equal((await app.request('/')).status, 200);
    assert.equal((await app.request('/')).status, 200);
    assert.equal(calls, 1);
    await app.request('/?refresh=1');
    assert.equal(calls, 2);
    saveConfig({ agents: { codex: { binaryPath: 'new-binary' } } });
    await app.request('/');
    assert.equal(calls, 3);
    now += 30_001;
    await app.request('/');
    assert.equal(calls, 4);
  } finally {
    Date.now = clock;
    if (previous === undefined) delete process.env.MOLIO_DATA_DIR;
    else process.env.MOLIO_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

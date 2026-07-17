import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../../src/core/db.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { FeishuService } from '../../src/core/feishu/service.js';
import { feishuRoutes } from '../../src/routes/feishu.js';
import type { RunManager } from '../../src/core/RunManager.js';

function createMockRunManager(): RunManager {
  return {
    createRun: async () => 'mock-run-id',
    onEvent: () => () => {},
    cancelAll: () => {},
    canAcceptMessage: () => true,
  } as unknown as RunManager;
}

describe('Feishu routes', () => {
  let db: Database.Database;
  let tempDir: string;
  let service: FeishuService;
  let app: Hono;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-feishu-routes-'));
    db = openDatabase(tempDir);
    const conversations = new ConversationService(db);
    service = new FeishuService(createMockRunManager(), conversations, db);
    app = new Hono();
    app.route('/api/feishu', feishuRoutes(service));
    originalUserprofile = process.env.USERPROFILE;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    service.stop();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('GET /status returns the current service status', async () => {
    const res = await app.request('/api/feishu/status');
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.connectionState, 'idle');
    assert.equal(body.connected, false);
    assert.equal(body.hasAppConfig, false);
  });

  it('POST /stop returns 200 and idle status', async () => {
    const res = await app.request('/api/feishu/stop', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.connectionState, 'idle');
    assert.equal(body.loginStatus, 'idle');
  });

  it('POST /disconnect returns 200 and disabled status', async () => {
    const res = await app.request('/api/feishu/disconnect', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.enabled, false);
  });

  it('PUT /config persists and returns the updated status', async () => {
    const res = await app.request('/api/feishu/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'cli_x', appSecret: 'sec_y', enabled: false }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.hasAppConfig, true);
    // enabled=false so start() should not have been called.
    assert.equal(body.enabled, false);
  });
});

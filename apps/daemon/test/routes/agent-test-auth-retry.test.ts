import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { agentsRoutes } from '../../src/routes/agents.js';

/**
 * Error-driven integration test (user report, 2026-09-30):
 * Clicking "测试" for Claude Code with an expired GLM token returned
 * "Test timed out after 30s" instead of the real cause.
 *
 * Root cause (reproduced live against open.bigmodel.cn with an expired
 * token): Claude Code retries the 401 with exponential backoff — 10
 * attempts spanning ~3 minutes — emitting system/api_retry events and NO
 * result event within the test endpoint's 30s budget.
 *
 * Fix: claude-stream.ts fails fast with an `error` event on the first
 * 401/403 api_retry (auth never recovers on retry), so the test endpoint
 * reports the authentication failure in ~1s instead of timing out.
 */
describe('Agent test endpoint — expired-token auth retry fast-fail', () => {
  let db: Database.Database;
  let tempDir: string;
  let runManager: RunManager;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-agent-test-retry-'));
    db = openDatabase(tempDir);
    runManager = new RunManager();

    app = new Hono();
    app.route('/api/agents', agentsRoutes(runManager));

    process.env['CLAUDE_BIN'] = join(
      process.cwd(),
      'test/fixtures/fake-agents',
      process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.mjs',
    );
    // Fake provider that 401s every attempt, like an expired GLM token.
    process.env['FAKE_CLAUDE_API_RETRY'] = '401';
  });

  afterEach(() => {
    runManager.cancelAll();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env['CLAUDE_BIN'];
    delete process.env['FAKE_CLAUDE_API_RETRY'];
  });

  it('reports the auth failure fast instead of "Test timed out after 30s"', async () => {
    const startedAt = Date.now();
    const res = await app.request('/api/agents/claude/test', { method: 'POST' });
    const elapsed = Date.now() - startedAt;

    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; error?: string };
    assert.equal(body.ok, false, 'test run must fail with an expired token');
    assert.ok(body.error, 'error message must be present');
    // The real cause — NOT the old bare timeout message.
    assert.match(body.error!, /authentication failed/i);
    assert.match(body.error!, /401/);
    assert.ok(!body.error!.includes('Test timed out'), 'must not fall through to timeout');
    // Fast-fail: well under the 30s test budget (poll interval is 300ms).
    assert.ok(elapsed < 15_000, `expected fast-fail, took ${elapsed}ms`);
  });
});

/**
 * GET/PUT /api/agents/:agentId/provider route tests — hermes dispatch.
 *
 * The provider endpoints never touch RunManager, so a stub is enough.
 * HERMES_HOME + MOLIO_DATA_DIR are redirected to temp dirs: hermes-config
 * resolves the home lazily per call and config.ts resolves its dir lazily,
 * so no real ~/.hermes or ~/.molio is touched.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Hono } from 'hono';
import type { RunManager } from '../../src/core/RunManager.js';
import { agentsRoutes } from '../../src/routes/agents.js';

let tmp: string;
let savedHermesHome: string | undefined;
let savedDataDir: string | undefined;

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/agents', agentsRoutes({} as unknown as RunManager));
  return app;
}

async function put(app: Hono, agentId: string, body: unknown): Promise<Response> {
  return app.request(`/api/agents/${agentId}/provider`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-provider-test-'));
  savedHermesHome = process.env['HERMES_HOME'];
  savedDataDir = process.env['MOLIO_DATA_DIR'];
  process.env['HERMES_HOME'] = path.join(tmp, 'hermes-home');
  process.env['MOLIO_DATA_DIR'] = path.join(tmp, 'molio-data');
  fs.mkdirSync(process.env['HERMES_HOME']!, { recursive: true });
  fs.mkdirSync(process.env['MOLIO_DATA_DIR']!, { recursive: true });
});

afterEach(() => {
  if (savedHermesHome === undefined) delete process.env['HERMES_HOME'];
  else process.env['HERMES_HOME'] = savedHermesHome;
  if (savedDataDir === undefined) delete process.env['MOLIO_DATA_DIR'];
  else process.env['MOLIO_DATA_DIR'] = savedDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/agents/:agentId/provider — dispatch', () => {
  it('rejects agents without provider support (400, names supported agents)', async () => {
    const res = await makeApp().request('/api/agents/claude/provider');
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /codex/);
    assert.match(body.error, /hermes/);
  });

  it('hermes: empty state when nothing is configured', async () => {
    const res = await makeApp().request('/api/agents/hermes/provider');
    assert.equal(res.status, 200);
    const state = await res.json() as Record<string, unknown>;
    assert.equal(state['provider'], null);
    assert.equal(state['hasKey'], false);
  });

  it('hermes: reads live config.yaml + .env, never returns the key itself', async () => {
    fs.writeFileSync(
      path.join(process.env['HERMES_HOME']!, 'config.yaml'),
      'model:\n  provider: zai\n  default: glm-4.6\n',
    );
    fs.writeFileSync(
      path.join(process.env['HERMES_HOME']!, '.env'),
      'GLM_API_KEY=sk-secret-value\n',
    );
    const res = await makeApp().request('/api/agents/hermes/provider');
    const state = await res.json() as Record<string, unknown>;
    assert.equal(state['presetHint'], 'zai');
    assert.equal(state['model'], 'glm-4.6');
    assert.equal(state['hasKey'], true);
    assert.ok(!JSON.stringify(state).includes('sk-secret-value'));
  });

  it('hermes: falls back to the saved presetId when live files have no provider', async () => {
    // Simulate a previous PUT: selection meta persisted in Molio config…
    fs.writeFileSync(
      path.join(process.env['MOLIO_DATA_DIR']!, 'config.json'),
      JSON.stringify({ agents: { hermes: { provider: { presetId: 'kimi-coding' } } } }),
    );
    // …but hermes home has no provider configured (files lost / fresh install).
    const res = await makeApp().request('/api/agents/hermes/provider');
    const state = await res.json() as Record<string, unknown>;
    assert.equal(state['presetHint'], 'kimi-coding');
    assert.equal(state['provider'], null);
  });

  it('hermes: live provider wins over saved meta', async () => {
    fs.writeFileSync(
      path.join(process.env['MOLIO_DATA_DIR']!, 'config.json'),
      JSON.stringify({ agents: { hermes: { provider: { presetId: 'kimi-coding' } } } }),
    );
    fs.writeFileSync(
      path.join(process.env['HERMES_HOME']!, 'config.yaml'),
      'model:\n  provider: anthropic\n',
    );
    const res = await makeApp().request('/api/agents/hermes/provider');
    const state = await res.json() as Record<string, unknown>;
    assert.equal(state['presetHint'], 'anthropic');
  });
});

describe('PUT /api/agents/:agentId/provider — hermes', () => {
  it('applies a preset: writes native files, persists meta, returns ok', async () => {
    const app = makeApp();
    const res = await put(app, 'hermes', { presetId: 'zai', apiKey: 'sk-glm', model: 'glm-4.6' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    // Native files written
    const cfg = fs.readFileSync(path.join(process.env['HERMES_HOME']!, 'config.yaml'), 'utf8');
    assert.match(cfg, /provider: zai/);
    assert.match(cfg, /default: glm-4\.6/);
    const env = fs.readFileSync(path.join(process.env['HERMES_HOME']!, '.env'), 'utf8');
    assert.match(env, /^GLM_API_KEY=sk-glm$/m);

    // Selection meta persisted — WITHOUT the secret
    const config = JSON.parse(
      fs.readFileSync(path.join(process.env['MOLIO_DATA_DIR']!, 'config.json'), 'utf8'),
    );
    assert.equal(config.agents.hermes.provider.presetId, 'zai');
    assert.equal(config.agents.hermes.provider.model, 'glm-4.6');
    assert.ok(!JSON.stringify(config).includes('sk-glm'), 'API key must never be persisted in Molio config');
  });

  it('GET after PUT reflects the new selection', async () => {
    const app = makeApp();
    await put(app, 'hermes', { presetId: 'anthropic', apiKey: 'sk-ant' });
    const res = await app.request('/api/agents/hermes/provider');
    const state = await res.json() as Record<string, unknown>;
    assert.equal(state['presetHint'], 'anthropic');
    assert.equal(state['hasKey'], true);
  });

  it('unknown preset → 400 with the validation message', async () => {
    const res = await put(makeApp(), 'hermes', { presetId: 'does-not-exist' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /does-not-exist/);
  });

  it('custom without baseUrl → 400', async () => {
    const res = await put(makeApp(), 'hermes', { presetId: 'custom', apiKey: 'k' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /baseUrl/);
  });

  it('malformed JSON body → 400', async () => {
    const res = await put(makeApp(), 'hermes', '{broken json');
    assert.equal(res.status, 400);
  });

  it('persists meta across agents independently (codex entry untouched)', async () => {
    fs.writeFileSync(
      path.join(process.env['MOLIO_DATA_DIR']!, 'config.json'),
      JSON.stringify({ agents: { codex: { provider: { presetId: 'deepseek' } } } }),
    );
    await put(makeApp(), 'hermes', { presetId: 'xiaomi', apiKey: 'k' });
    const config = JSON.parse(
      fs.readFileSync(path.join(process.env['MOLIO_DATA_DIR']!, 'config.json'), 'utf8'),
    );
    assert.equal(config.agents.codex.provider.presetId, 'deepseek');
    assert.equal(config.agents.hermes.provider.presetId, 'xiaomi');
  });
});

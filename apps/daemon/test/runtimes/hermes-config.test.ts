/**
 * hermes-config.ts tests (mirrors codex-config.test.ts).
 *
 * Everything runs against a temp-dir hermes home — no real ~/.hermes or
 * %LOCALAPPDATA%\hermes is ever touched (hermesHome is an explicit parameter).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseDocument } from 'yaml';
import {
  applyHermesProvider,
  getHermesProviderState,
  resolveHermesHome,
  HermesConfigError,
} from '../../src/core/runtimes/hermes-config.js';

let tmp: string;
let hermesHome: string;
let backupDir: string;

const cfgPath = () => path.join(hermesHome, 'config.yaml');
const dotEnvPath = () => path.join(hermesHome, '.env');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-config-test-'));
  hermesHome = path.join(tmp, 'hermes-home');
  backupDir = path.join(tmp, 'backups');
  fs.mkdirSync(hermesHome, { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ─── resolveHermesHome ─── */

describe('resolveHermesHome', () => {
  it('honors the HERMES_HOME env override', () => {
    const saved = process.env['HERMES_HOME'];
    process.env['HERMES_HOME'] = path.join(tmp, 'custom-home');
    try {
      assert.equal(resolveHermesHome(), path.join(tmp, 'custom-home'));
    } finally {
      if (saved === undefined) delete process.env['HERMES_HOME'];
      else process.env['HERMES_HOME'] = saved;
    }
  });

  it('falls back to the platform default', () => {
    const saved = process.env['HERMES_HOME'];
    delete process.env['HERMES_HOME'];
    try {
      const home = resolveHermesHome();
      if (process.platform === 'win32') {
        assert.match(home, /hermes$/);
        assert.ok(!home.includes('.hermes'), 'windows uses LOCALAPPDATA\\hermes, not .hermes');
      } else {
        assert.equal(home, path.join(os.homedir(), '.hermes'));
      }
    } finally {
      if (saved !== undefined) process.env['HERMES_HOME'] = saved;
    }
  });
});

/* ─── getHermesProviderState ─── */

describe('getHermesProviderState', () => {
  it('returns empty/custom state when no files exist', () => {
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'custom');
    assert.equal(s.provider, null);
    assert.equal(s.baseUrl, null);
    assert.equal(s.model, null);
    assert.equal(s.hasKey, false);
  });

  it('detects the zai preset from config.yaml + .env key', () => {
    fs.writeFileSync(cfgPath(), `model:
  provider: zai
  default: glm-4.6
`);
    fs.writeFileSync(dotEnvPath(), 'GLM_API_KEY=sk-glm-123\n');
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'zai');
    assert.equal(s.provider, 'zai');
    assert.equal(s.model, 'glm-4.6');
    assert.equal(s.hasKey, true);
  });

  it('reads the model id from `model` when `default` is absent', () => {
    fs.writeFileSync(cfgPath(), `model:
  provider: anthropic
  model: claude-sonnet-4-5
`);
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.model, 'claude-sonnet-4-5');
  });

  it('custom preset: hasKey comes from config.yaml model.api_key, not .env', () => {
    fs.writeFileSync(cfgPath(), `model:
  provider: custom
  base_url: https://relay.example/v1
  api_key: sk-custom
`);
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'custom');
    assert.equal(s.baseUrl, 'https://relay.example/v1');
    assert.equal(s.hasKey, true);
  });

  it('base_url without a matching provider → custom hint', () => {
    fs.writeFileSync(cfgPath(), `model:
  base_url: https://relay.example/v1
`);
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'custom');
    assert.equal(s.baseUrl, 'https://relay.example/v1');
  });

  it('tolerates malformed YAML — defaults, no throw', () => {
    fs.writeFileSync(cfgPath(), 'model: [unclosed\n\tbad: indent');
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'custom');
    assert.equal(s.provider, null);
    assert.equal(s.hasKey, false);
  });

  it('.env parsing: export prefix, quotes, comments, last occurrence wins', () => {
    fs.writeFileSync(cfgPath(), 'model:\n  provider: kimi-coding\n');
    fs.writeFileSync(dotEnvPath(), `# my keys
export KIMI_API_KEY="sk-first"
KIMI_API_KEY='sk-last'
SOME_OTHER=whatever
`);
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'kimi-coding');
    assert.equal(s.hasKey, true, 'quoted/export-prefixed values must parse');
  });

  it('blank key value → hasKey=false', () => {
    fs.writeFileSync(cfgPath(), 'model:\n  provider: openrouter\n');
    fs.writeFileSync(dotEnvPath(), 'OPENROUTER_API_KEY=   \n');
    assert.equal(getHermesProviderState(hermesHome).hasKey, false);
  });
});

/* ─── applyHermesProvider — presets ─── */

describe('applyHermesProvider — preset providers', () => {
  it('writes provider/default to config.yaml and key/base-url to .env (zai defaults to 国内 endpoint)', () => {
    applyHermesProvider(
      { presetId: 'zai', apiKey: 'sk-glm', model: 'glm-4.6' },
      hermesHome, backupDir,
    );

    const doc = parseDocument(fs.readFileSync(cfgPath(), 'utf8'));
    assert.equal(doc.getIn(['model', 'provider']), 'zai');
    assert.equal(doc.getIn(['model', 'default']), 'glm-4.6');
    assert.equal(doc.getIn(['model', 'base_url']), undefined, 'preset base url goes to .env, not config.yaml');

    const env = fs.readFileSync(dotEnvPath(), 'utf8');
    assert.match(env, /^GLM_API_KEY=sk-glm$/m);
    assert.match(env, /^GLM_BASE_URL=https:\/\/open\.bigmodel\.cn\/api\/paas\/v4$/m);
  });

  it('explicit baseUrl overrides the preset default', () => {
    applyHermesProvider(
      { presetId: 'zai', apiKey: 'k', baseUrl: 'https://api.z.ai/api/paas/v4' },
      hermesHome, backupDir,
    );
    const env = fs.readFileSync(dotEnvPath(), 'utf8');
    assert.match(env, /^GLM_BASE_URL=https:\/\/api\.z\.ai\/api\/paas\/v4$/m);
    assert.ok(!env.includes('bigmodel.cn'));
  });

  it('preserves comments, _config_version and unrelated sections in config.yaml', () => {
    fs.writeFileSync(cfgPath(), `# Hermes configuration
_config_version: 3

model:
  provider: old
  # keep me
  temperature: 0.7

tools:
  browser: true
`);
    applyHermesProvider({ presetId: 'anthropic', apiKey: 'sk-ant', model: 'claude' }, hermesHome, backupDir);

    const text = fs.readFileSync(cfgPath(), 'utf8');
    assert.match(text, /# Hermes configuration/);
    assert.match(text, /_config_version: 3/);
    assert.match(text, /# keep me/);
    assert.match(text, /temperature: 0\.7/);
    assert.match(text, /tools:\n\s+browser: true/);
    const doc = parseDocument(text);
    assert.equal(doc.getIn(['model', 'provider']), 'anthropic');
    assert.equal(doc.getIn(['model', 'default']), 'claude');
  });

  it('.env upsert: replaces existing key in place, preserves other lines/comments and export prefix', () => {
    fs.writeFileSync(dotEnvPath(), `# comment stays
export GLM_API_KEY=sk-old
OTHER_VAR=keep-me
`);
    applyHermesProvider({ presetId: 'zai', apiKey: 'sk-new' }, hermesHome, backupDir);

    const lines = fs.readFileSync(dotEnvPath(), 'utf8').split('\n');
    assert.equal(lines[0], '# comment stays');
    assert.equal(lines[1], 'export GLM_API_KEY=sk-new', 'export prefix preserved, value replaced in place');
    assert.equal(lines[2], 'OTHER_VAR=keep-me');
    assert.equal(lines.filter((l) => l.startsWith('GLM_API_KEY=')).length, 0, 'no duplicate key appended');
  });

  it('anthropic preset writes no base-url line (no baseUrlEnvKey, no defaultBaseUrl)', () => {
    applyHermesProvider({ presetId: 'anthropic', apiKey: 'sk-ant' }, hermesHome, backupDir);
    const env = fs.readFileSync(dotEnvPath(), 'utf8');
    assert.match(env, /^ANTHROPIC_API_KEY=sk-ant$/m);
    assert.ok(!env.includes('BASE_URL'));
  });

  it('no apiKey → .env untouched (not even created)', () => {
    applyHermesProvider({ presetId: 'kimi-coding', model: 'kimi-k2' }, hermesHome, backupDir);
    assert.ok(!fs.existsSync(dotEnvPath()));
    const doc = parseDocument(fs.readFileSync(cfgPath(), 'utf8'));
    assert.equal(doc.getIn(['model', 'provider']), 'kimi-coding');
    assert.equal(doc.getIn(['model', 'default']), 'kimi-k2');
  });

  it('omitting model leaves the existing default untouched', () => {
    fs.writeFileSync(cfgPath(), 'model:\n  default: kept-model\n');
    applyHermesProvider({ presetId: 'openrouter', apiKey: 'k' }, hermesHome, backupDir);
    const doc = parseDocument(fs.readFileSync(cfgPath(), 'utf8'));
    assert.equal(doc.getIn(['model', 'provider']), 'openrouter');
    assert.equal(doc.getIn(['model', 'default']), 'kept-model');
  });

  it('.env is written 0600 on POSIX', () => {
    applyHermesProvider({ presetId: 'anthropic', apiKey: 'sk' }, hermesHome, backupDir);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(dotEnvPath()).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });
});

/* ─── applyHermesProvider — custom ─── */

describe('applyHermesProvider — custom provider', () => {
  it('writes everything into config.yaml (provider/base_url/api_key/default), no .env', () => {
    applyHermesProvider(
      { presetId: 'custom', baseUrl: 'https://relay.example/v1', apiKey: 'sk-relay', model: 'gpt-x' },
      hermesHome, backupDir,
    );

    const doc = parseDocument(fs.readFileSync(cfgPath(), 'utf8'));
    assert.equal(doc.getIn(['model', 'provider']), 'custom');
    assert.equal(doc.getIn(['model', 'base_url']), 'https://relay.example/v1');
    assert.equal(doc.getIn(['model', 'api_key']), 'sk-relay');
    assert.equal(doc.getIn(['model', 'default']), 'gpt-x');
    assert.ok(!fs.existsSync(dotEnvPath()), 'custom has no envKey — .env must not be created');
  });

  it('rejects custom without baseUrl and leaves files untouched', () => {
    fs.writeFileSync(cfgPath(), 'model:\n  provider: keep\n');
    assert.throws(
      () => applyHermesProvider({ presetId: 'custom', apiKey: 'k' }, hermesHome, backupDir),
      HermesConfigError,
    );
    assert.equal(fs.readFileSync(cfgPath(), 'utf8'), 'model:\n  provider: keep\n');
  });

  it('rejects an unknown preset id', () => {
    assert.throws(
      () => applyHermesProvider({ presetId: 'nope' as never }, hermesHome, backupDir),
      HermesConfigError,
    );
    assert.ok(!fs.existsSync(cfgPath()));
  });

  it('rejects when the existing config.yaml is malformed', () => {
    fs.writeFileSync(cfgPath(), 'model: [unclosed');
    assert.throws(
      () => applyHermesProvider({ presetId: 'anthropic', apiKey: 'k' }, hermesHome, backupDir),
      HermesConfigError,
    );
    assert.equal(fs.readFileSync(cfgPath(), 'utf8'), 'model: [unclosed');
  });
});

/* ─── backup / rollback ─── */

describe('applyHermesProvider — backup and rollback', () => {
  it('writes backup copies before modifying', () => {
    fs.writeFileSync(cfgPath(), 'model:\n  provider: old\n');
    fs.writeFileSync(dotEnvPath(), 'GLM_API_KEY=sk-old\n');
    applyHermesProvider({ presetId: 'zai', apiKey: 'sk-new' }, hermesHome, backupDir);

    assert.equal(fs.readFileSync(path.join(backupDir, 'config.yaml.bak'), 'utf8'), 'model:\n  provider: old\n');
    assert.equal(fs.readFileSync(path.join(backupDir, '.env.bak'), 'utf8'), 'GLM_API_KEY=sk-old\n');
  });

  it('rolls back config.yaml when the .env write fails', () => {
    const original = 'model:\n  provider: original\n';
    fs.writeFileSync(cfgPath(), original);
    // Failure injection: .env is a directory → atomic rename onto it fails
    fs.mkdirSync(dotEnvPath());

    assert.throws(
      () => applyHermesProvider({ presetId: 'zai', apiKey: 'sk-x' }, hermesHome, backupDir),
    );
    assert.equal(fs.readFileSync(cfgPath(), 'utf8'), original);
    assert.ok(fs.statSync(dotEnvPath()).isDirectory());
  });

  it('creates the hermes home directory when missing', () => {
    const fresh = path.join(tmp, 'no-home-yet');
    applyHermesProvider({ presetId: 'anthropic', apiKey: 'sk' }, fresh, backupDir);
    assert.ok(fs.existsSync(path.join(fresh, 'config.yaml')));
  });
});

/* ─── round-trip ─── */

describe('applyHermesProvider → getHermesProviderState round-trip', () => {
  it('preset apply is visible in state (presetHint + model + hasKey, never the key)', () => {
    applyHermesProvider({ presetId: 'minimax-cn', apiKey: 'sk-mm', model: 'MiniMax-M2' }, hermesHome, backupDir);
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'minimax-cn');
    assert.equal(s.provider, 'minimax-cn');
    assert.equal(s.model, 'MiniMax-M2');
    assert.equal(s.hasKey, true);
    assert.ok(!JSON.stringify(s).includes('sk-mm'), 'the key itself must never surface');
  });

  it('preset base-url override written to .env is echoed back in state.baseUrl', () => {
    applyHermesProvider(
      { presetId: 'zai', apiKey: 'a', baseUrl: 'https://api.z.ai/api/paas/v4' },
      hermesHome, backupDir,
    );
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'zai');
    assert.equal(s.baseUrl, 'https://api.z.ai/api/paas/v4');
  });

  it('custom apply is visible in state', () => {
    applyHermesProvider(
      { presetId: 'custom', baseUrl: 'https://relay.example/v1', apiKey: 'sk-r', model: 'm' },
      hermesHome, backupDir,
    );
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'custom');
    assert.equal(s.baseUrl, 'https://relay.example/v1');
    assert.equal(s.model, 'm');
    assert.equal(s.hasKey, true);
  });

  it('switching presets overwrites provider and model default', () => {
    applyHermesProvider({ presetId: 'zai', apiKey: 'a', model: 'glm' }, hermesHome, backupDir);
    applyHermesProvider({ presetId: 'anthropic', apiKey: 'b', model: 'claude' }, hermesHome, backupDir);
    const s = getHermesProviderState(hermesHome);
    assert.equal(s.presetHint, 'anthropic');
    assert.equal(s.model, 'claude');
    // stale GLM key remains in .env — harmless, hermes only reads the active provider's key
    assert.match(fs.readFileSync(dotEnvPath(), 'utf8'), /GLM_API_KEY=a/);
  });
});

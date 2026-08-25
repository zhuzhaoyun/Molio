import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyCodexProvider, CodexConfigError, getCodexProviderState } from '../../src/core/runtimes/codex-config.js';
import { parse } from 'smol-toml';

let tmp: string;
let codexDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-test-'));
  codexDir = path.join(tmp, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('getCodexProviderState', () => {
  it('returns official/empty state when no files exist', () => {
    const s = getCodexProviderState(codexDir);
    assert.equal(s.presetHint, 'official');
    assert.equal(s.baseUrl, null);
    assert.equal(s.model, null);
    assert.equal(s.wireApi, null);
    assert.equal(s.hasKey, false);
  });

  it('detects deepseek preset from model_providers section', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), `model_provider = "custom"
model = "deepseek-v4-flash"

[model_providers.custom]
name = "deepseek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
requires_openai_auth = true
`);
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
    const s = getCodexProviderState(codexDir);
    assert.equal(s.presetHint, 'deepseek');
    assert.equal(s.baseUrl, 'https://api.deepseek.com');
    assert.equal(s.model, 'deepseek-v4-flash');
    assert.equal(s.wireApi, 'responses');
    assert.equal(s.hasKey, true);
  });

  it('detects dashscope preset', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), `model_provider = "custom"
model = "qwen3.7-max"

[model_providers.custom]
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
wire_api = "responses"
`);
    const s = getCodexProviderState(codexDir);
    assert.equal(s.presetHint, 'dashscope');
    assert.equal(s.model, 'qwen3.7-max');
  });

  it('falls back to custom for unknown base_url and hasKey=false on empty key', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), `model_provider = "custom"

[model_providers.custom]
base_url = "https://some-relay.example/v1"
`);
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: '  ' }));
    const s = getCodexProviderState(codexDir);
    assert.equal(s.presetHint, 'custom');
    assert.equal(s.hasKey, false);
  });

  it('tolerates malformed TOML and malformed auth.json', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'this is [ not toml');
    fs.writeFileSync(path.join(codexDir, 'auth.json'), '{broken');
    const s = getCodexProviderState(codexDir);
    assert.equal(s.presetHint, 'official');
    assert.equal(s.hasKey, false);
  });
});

describe('applyCodexProvider', () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = path.join(tmp, 'backups');
  });

  it('merges provider section and preserves unrelated sections', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), `model = "old-model"
model_reasoning_effort = "high"

[projects."/home/yaol"]
trust_level = "trusted"

[model_providers.other]
base_url = "https://other.example"
`);
    applyCodexProvider(
      { presetId: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-new' },
      codexDir, backupDir,
    );

    const table = parse(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')) as Record<string, any>;
    assert.equal(table['model'], 'deepseek-v4-flash');
    assert.equal(table['model_provider'], 'custom');
    assert.equal(table['model_reasoning_effort'], 'high'); // untouched
    assert.equal(table['projects']['/home/yaol']['trust_level'], 'trusted'); // preserved
    assert.equal(table['model_providers']['other']['base_url'], 'https://other.example'); // preserved
    assert.equal(table['model_providers']['custom']['base_url'], 'https://api.deepseek.com');
    assert.equal(table['model_providers']['custom']['wire_api'], 'responses');
    assert.equal(table['model_providers']['custom']['requires_openai_auth'], true);

    const auth = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'));
    assert.equal(auth['OPENAI_API_KEY'], 'sk-new');
  });

  it('auth merge preserves other fields and writes 0600 on POSIX', () => {
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { refresh: 'r1' } }));
    applyCodexProvider({ presetId: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-k' }, codexDir, backupDir);

    const auth = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'));
    assert.deepEqual(auth['tokens'], { refresh: 'r1' });
    assert.equal(auth['OPENAI_API_KEY'], 'sk-k');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(codexDir, 'auth.json')).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });

  it('rejects custom preset without baseUrl and leaves files untouched', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "keep"\n');
    assert.throws(
      () => applyCodexProvider({ presetId: 'custom', model: 'm' }, codexDir, backupDir),
      CodexConfigError,
    );
    assert.equal(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), 'model = "keep"\n');
  });

  it('rejects when existing config.toml is malformed', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'not [ toml');
    assert.throws(
      () => applyCodexProvider({ presetId: 'deepseek', model: 'm' }, codexDir, backupDir),
      CodexConfigError,
    );
    assert.equal(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), 'not [ toml');
  });

  it('rolls back config.toml when auth.json write fails (pre-existing dir untouched)', () => {
    const original = 'model = "original"\n';
    fs.writeFileSync(path.join(codexDir, 'config.toml'), original);
    // Failure injection: auth.json is a directory → rename onto it fails
    fs.mkdirSync(path.join(codexDir, 'auth.json'));

    assert.throws(
      () => applyCodexProvider(
        { presetId: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-x' },
        codexDir, backupDir,
      ),
    );
    assert.equal(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), original);
    assert.ok(fs.statSync(path.join(codexDir, 'auth.json')).isDirectory());
  });

  it('writes backup copies before modifying', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "a"\n');
    fs.writeFileSync(path.join(codexDir, 'auth.json'), '{"OPENAI_API_KEY":"old"}');
    applyCodexProvider({ presetId: 'deepseek', model: 'm' }, codexDir, backupDir);
    assert.equal(fs.readFileSync(path.join(backupDir, 'config.toml.bak'), 'utf8'), 'model = "a"\n');
    assert.equal(fs.readFileSync(path.join(backupDir, 'auth.json.bak'), 'utf8'), '{"OPENAI_API_KEY":"old"}');
  });

  it('validation failure does not resurrect files via stale backups', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "a"\n');
    // apiKey so the first apply also creates auth.json (+ its .bak): both files
    // must be gone from codexDir afterwards, yet stale .baks must not resurrect them
    applyCodexProvider({ presetId: 'deepseek', model: 'm', apiKey: 'sk-old' }, codexDir, backupDir);
    // User resets codex outside Molio…
    fs.rmSync(path.join(codexDir, 'config.toml'));
    fs.rmSync(path.join(codexDir, 'auth.json'));
    // …then a validation-only failure must not resurrect anything from stale .bak
    assert.throws(
      () => applyCodexProvider({ presetId: 'custom', model: 'm' }, codexDir, backupDir),
      CodexConfigError,
    );
    assert.ok(!fs.existsSync(path.join(codexDir, 'config.toml')));
    assert.ok(!fs.existsSync(path.join(codexDir, 'auth.json')));
  });

  it('leaves a pre-existing config.toml directory untouched on failure', () => {
    const asDir = path.join(codexDir, 'config.toml');
    fs.mkdirSync(path.join(asDir, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(asDir, 'inner', 'file.txt'), 'x');
    assert.throws(
      () => applyCodexProvider({ presetId: 'deepseek', model: 'm' }, codexDir, backupDir),
    );
    assert.ok(fs.statSync(asDir).isDirectory());
    assert.equal(fs.readFileSync(path.join(asDir, 'inner', 'file.txt'), 'utf8'), 'x');
  });

  it('rejects malformed auth.json without touching it', () => {
    fs.writeFileSync(path.join(codexDir, 'auth.json'), '{broken');
    assert.throws(
      () => applyCodexProvider(
        { presetId: 'deepseek', model: 'm', apiKey: 'sk-x' }, codexDir, backupDir,
      ),
      CodexConfigError,
    );
    assert.equal(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'), '{broken');
  });

  it('official preset on an empty dir creates nothing', () => {
    applyCodexProvider({ presetId: 'official' }, codexDir, backupDir);
    assert.ok(!fs.existsSync(path.join(codexDir, 'config.toml')));
  });
});

describe('applyCodexProvider official preset', () => {
  let backupDir: string;
  beforeEach(() => { backupDir = path.join(tmp, 'backups'); });

  it('removes Molio overrides but preserves unrelated sections', () => {
    fs.writeFileSync(path.join(codexDir, 'config.toml'), `model = "deepseek-v4-flash"
model_provider = "custom"

[projects."/home/yaol"]
trust_level = "trusted"

[model_providers.custom]
base_url = "https://api.deepseek.com"

[model_providers.keepme]
base_url = "https://keep.example"
`);
    applyCodexProvider({ presetId: 'official' }, codexDir, backupDir);
    const table = parse(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')) as Record<string, any>;
    assert.equal(table['model'], undefined);
    assert.equal(table['model_provider'], undefined);
    assert.equal(table['model_providers']['custom'], undefined);
    assert.equal(table['model_providers']['keepme']['base_url'], 'https://keep.example');
    assert.equal(table['projects']['/home/yaol']['trust_level'], 'trusted');
  });
});

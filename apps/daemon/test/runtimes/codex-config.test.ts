import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getCodexProviderState } from '../../src/core/runtimes/codex-config.js';

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

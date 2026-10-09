import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveConfig, setAgentConfig } from '../../src/core/config.js';
import { configDir } from '../../src/core/channels/credentials-store.js';
import { defaultMolioHome, defaultClaudeHome } from '../../src/core/skills/paths.js';
import { getCodexProviderState } from '../../src/core/runtimes/codex-config.js';
import { openDatabase, closeDatabase } from '../../src/core/db.js';

it('isolates configuration, skills and the default database in MOLIO_DATA_DIR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-data-dir-'));
  const previous = process.env.MOLIO_DATA_DIR;
  process.env.MOLIO_DATA_DIR = dir;
  try {
    assert.equal(configDir(), dir);
    assert.equal(defaultMolioHome(), dir);
    saveConfig({ agents: {} });
    assert.ok(fs.existsSync(path.join(dir, 'config.json')));
    const db = openDatabase();
    assert.equal(db.name, path.join(dir, 'app.sqlite'));
    const explicit = path.join(dir, 'explicit');
    assert.equal(openDatabase(explicit).name, path.join(explicit, 'app.sqlite'));
  } finally {
    closeDatabase();
    if (previous === undefined) delete process.env.MOLIO_DATA_DIR;
    else process.env.MOLIO_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('isolates runtime provider configuration with explicit runtime homes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-runtime-homes-'));
  const keys = ['MOLIO_DATA_DIR', 'MOLIO_CLAUDE_HOME', 'MOLIO_CODEX_HOME'] as const;
  const previous = keys.map(key => process.env[key]);
  const claude = path.join(dir, 'claude');
  const codex = path.join(dir, 'codex');
  [dir, claude, codex].forEach((value, i) => { process.env[keys[i]!] = value; });
  try {
    assert.equal(defaultClaudeHome(), claude);
    setAgentConfig('claude', { env: { ANTHROPIC_API_KEY: 'isolated-test-key' } });
    assert.ok(fs.existsSync(path.join(claude, 'settings.json')));
    fs.mkdirSync(codex, { recursive: true });
    fs.writeFileSync(path.join(codex, 'config.toml'), 'model = "isolated-model"\n');
    assert.equal(getCodexProviderState().model, 'isolated-model');
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

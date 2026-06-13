import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnEnv } from '../../src/core/runtimes/env.js';
import type { RuntimeAgentDef } from '@molio/contracts';

/**
 * Tests for spawn environment building and API key stripping logic.
 * Error-driven: ensures API keys are not leaked to child processes
 * unless a custom base URL is explicitly configured.
 */

function makeDef(overrides: Partial<RuntimeAgentDef>): RuntimeAgentDef {
  return {
    id: 'test',
    name: 'Test Agent',
    bin: 'test-bin',
    versionArgs: ['--version'],
    buildArgs: () => [],
    streamFormat: 'text',
    fallbackModels: [],
    ...overrides,
  };
}

describe('buildSpawnEnv', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear relevant env vars
    savedEnv = {
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      ANTHROPIC_BASE_URL: process.env['ANTHROPIC_BASE_URL'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'],
      CODEX_API_KEY: process.env['CODEX_API_KEY'],
    };
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_BASE_URL'];
    delete process.env['CODEX_API_KEY'];
  });

  afterEach(() => {
    // Restore saved env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  describe('basic environment building', () => {
    it('should use process.env as base', () => {
      process.env['MY_VAR'] = 'hello';
      const def = makeDef({ id: 'generic' });
      const env = buildSpawnEnv(def);

      assert.equal(env['MY_VAR'], 'hello');
      delete process.env['MY_VAR'];
    });

    it('should use provided baseEnv instead of process.env', () => {
      const baseEnv = { CUSTOM: 'value', PATH: '/usr/bin' };
      const def = makeDef({ id: 'generic' });
      const env = buildSpawnEnv(def, baseEnv);

      assert.equal(env['CUSTOM'], 'value');
      assert.equal(env['PATH'], '/usr/bin');
    });

    it('should merge def.env into the environment', () => {
      const def = makeDef({
        id: 'generic',
        env: { AGENT_SPECIFIC: 'yes' },
      });
      const env = buildSpawnEnv(def, { BASE: 'value' });

      assert.equal(env['BASE'], 'value');
      assert.equal(env['AGENT_SPECIFIC'], 'yes');
    });

    it('should let def.env override baseEnv', () => {
      const def = makeDef({
        id: 'generic',
        env: { SHARED: 'from-def' },
      });
      const env = buildSpawnEnv(def, { SHARED: 'from-base' });

      assert.equal(env['SHARED'], 'from-def');
    });
  });

  describe('Claude API key stripping', () => {
    it('should strip ANTHROPIC_API_KEY when no custom base URL', () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_API_KEY: 'sk-ant-test-key',
        PATH: '/usr/bin',
      });

      assert.equal(env['ANTHROPIC_API_KEY'], undefined);
    });

    it('should keep ANTHROPIC_API_KEY when ANTHROPIC_BASE_URL is set', () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_API_KEY: 'sk-ant-test-key',
        ANTHROPIC_BASE_URL: 'https://my-proxy.example.com',
      });

      assert.equal(env['ANTHROPIC_API_KEY'], 'sk-ant-test-key');
      assert.equal(env['ANTHROPIC_BASE_URL'], 'https://my-proxy.example.com');
    });

    it('should strip ANTHROPIC_API_KEY when base URL is empty string', () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_API_KEY: 'sk-ant-test-key',
        ANTHROPIC_BASE_URL: '',
      });

      assert.equal(env['ANTHROPIC_API_KEY'], undefined);
    });

    it('should strip ANTHROPIC_API_KEY when base URL is whitespace only', () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_API_KEY: 'sk-ant-test-key',
        ANTHROPIC_BASE_URL: '   ',
      });

      assert.equal(env['ANTHROPIC_API_KEY'], undefined);
    });
  });

  describe('Codex/OpenAI API key stripping', () => {
    it('should strip OPENAI_API_KEY and CODEX_API_KEY when no custom base URL', () => {
      const def = makeDef({ id: 'codex' });
      const env = buildSpawnEnv(def, {
        OPENAI_API_KEY: 'sk-openai-key',
        CODEX_API_KEY: 'sk-codex-key',
        PATH: '/usr/bin',
      });

      assert.equal(env['OPENAI_API_KEY'], undefined);
      assert.equal(env['CODEX_API_KEY'], undefined);
    });

    it('should keep API keys when OPENAI_BASE_URL is set', () => {
      const def = makeDef({ id: 'codex' });
      const env = buildSpawnEnv(def, {
        OPENAI_API_KEY: 'sk-openai-key',
        CODEX_API_KEY: 'sk-codex-key',
        OPENAI_BASE_URL: 'https://my-openai-proxy.com',
      });

      assert.equal(env['OPENAI_API_KEY'], 'sk-openai-key');
      assert.equal(env['CODEX_API_KEY'], 'sk-codex-key');
    });
  });

  describe('non-Claude/Codex agents', () => {
    it('should not strip any keys for gemini agent', () => {
      const def = makeDef({ id: 'gemini' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_API_KEY: 'should-stay',
        OPENAI_API_KEY: 'should-stay-too',
        GEMINI_API_KEY: 'gemini-key',
      });

      assert.equal(env['ANTHROPIC_API_KEY'], 'should-stay');
      assert.equal(env['OPENAI_API_KEY'], 'should-stay-too');
      assert.equal(env['GEMINI_API_KEY'], 'gemini-key');
    });

    it('should not strip any keys for qwen agent', () => {
      const def = makeDef({ id: 'qwen' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_API_KEY: 'should-stay',
        QWEN_API_KEY: 'qwen-key',
      });

      assert.equal(env['ANTHROPIC_API_KEY'], 'should-stay');
      assert.equal(env['QWEN_API_KEY'], 'qwen-key');
    });
  });

  describe('Molio runtime identity injection', () => {
    it('should inject MOLIO_AGENT_ID and MOLIO_AGENT_NAME for all agents', () => {
      const def = makeDef({ id: 'qwen', name: 'Qwen Code' });
      const env = buildSpawnEnv(def, { PATH: '/usr/bin' });

      assert.equal(env['MOLIO_AGENT_ID'], 'qwen');
      assert.equal(env['MOLIO_AGENT_NAME'], 'Qwen Code');
    });

    it('should inject identity for claude agent', () => {
      const def = makeDef({ id: 'claude', name: 'Claude Code' });
      const env = buildSpawnEnv(def, {});

      assert.equal(env['MOLIO_AGENT_ID'], 'claude');
      assert.equal(env['MOLIO_AGENT_NAME'], 'Claude Code');
    });

    it('should inject identity for codex agent', () => {
      const def = makeDef({ id: 'codex', name: 'Codex CLI' });
      const env = buildSpawnEnv(def, {});

      assert.equal(env['MOLIO_AGENT_ID'], 'codex');
      assert.equal(env['MOLIO_AGENT_NAME'], 'Codex CLI');
    });

    it('should inject identity for gemini agent', () => {
      const def = makeDef({ id: 'gemini', name: 'Gemini CLI' });
      const env = buildSpawnEnv(def, {});

      assert.equal(env['MOLIO_AGENT_ID'], 'gemini');
      assert.equal(env['MOLIO_AGENT_NAME'], 'Gemini CLI');
    });

    it('should not be overridden by baseEnv', () => {
      const def = makeDef({ id: 'qwen', name: 'Qwen Code' });
      const env = buildSpawnEnv(def, { MOLIO_AGENT_ID: 'hijacked' });

      // def values should take precedence (spread order: baseEnv → def.env → MOLIO_*)
      assert.equal(env['MOLIO_AGENT_ID'], 'qwen');
    });
  });

  describe('case-insensitive base URL detection', () => {
    it('should detect lowercase base URL key', () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_API_KEY: 'sk-ant-key',
        anthropic_base_url: 'https://proxy.example.com',
      });

      // lowercase key should still count as "custom base URL set"
      assert.equal(env['ANTHROPIC_API_KEY'], 'sk-ant-key');
    });
  });

  describe('Claude Code git-bash auto-detection (Windows)', () => {
    const isWindows = process.platform === 'win32';

    it('should not override CLAUDE_CODE_GIT_BASH_PATH if already set', () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {
        CLAUDE_CODE_GIT_BASH_PATH: 'C:\\custom\\bash.exe',
      });

      assert.equal(env['CLAUDE_CODE_GIT_BASH_PATH'], 'C:\\custom\\bash.exe');
    });

    it('should not set CLAUDE_CODE_GIT_BASH_PATH for non-claude agents', () => {
      const def = makeDef({ id: 'codex' });
      const env = buildSpawnEnv(def, {});

      assert.equal(env['CLAUDE_CODE_GIT_BASH_PATH'], undefined);
    });

    // Windows-only: verify auto-detection finds git bash
    it({ skip: !isWindows ? 'Windows only' : undefined }, () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {});

      // On Windows with git installed, CLAUDE_CODE_GIT_BASH_PATH should be set
      if (env['CLAUDE_CODE_GIT_BASH_PATH']) {
        assert.ok(
          env['CLAUDE_CODE_GIT_BASH_PATH']!.endsWith('bash.exe'),
          `Expected path ending with bash.exe, got: ${env['CLAUDE_CODE_GIT_BASH_PATH']}`,
        );
      }
      // If git is not installed, we don't fail — just verify no crash
    });

    it('should not set CLAUDE_CODE_GIT_BASH_PATH on non-Windows', { skip: isWindows ? 'non-Windows only' : undefined }, () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {});

      assert.equal(env['CLAUDE_CODE_GIT_BASH_PATH'], undefined);
    });
  });
});

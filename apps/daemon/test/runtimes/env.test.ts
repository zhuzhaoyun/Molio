import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildSpawnEnv, createStderrDecoder, detectWindowsCodePage, resetCodePageCache } from '../../src/core/runtimes/env.js';
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
      // PATH may be augmented with Node.js/npm dirs by buildSpawnEnv,
      // but the original value should be preserved within it.
      assert.ok(env['PATH']?.includes('/usr/bin'), `PATH should contain /usr/bin, got: ${env['PATH']}`);
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

    it('should strip ANTHROPIC_AUTH_TOKEN and model mapping vars when no custom base URL', () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_AUTH_TOKEN: 'sk-third-party-token',
        ANTHROPIC_API_KEY: 'sk-ant-key',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-chat',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-reasoner',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-reasoner',
        ANTHROPIC_MODEL: 'deepseek-chat',
        PATH: '/usr/bin',
      });

      assert.equal(env['ANTHROPIC_AUTH_TOKEN'], undefined);
      assert.equal(env['ANTHROPIC_API_KEY'], undefined);
      assert.equal(env['ANTHROPIC_DEFAULT_SONNET_MODEL'], undefined);
      assert.equal(env['ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'], undefined);
      assert.equal(env['ANTHROPIC_DEFAULT_HAIKU_MODEL'], undefined);
      assert.equal(env['ANTHROPIC_DEFAULT_OPUS_MODEL'], undefined);
      assert.equal(env['ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'], undefined);
      assert.equal(env['ANTHROPIC_MODEL'], undefined);
    });

    it('should keep ANTHROPIC_AUTH_TOKEN and model mapping vars when custom base URL is set', () => {
      const def = makeDef({ id: 'claude' });
      const env = buildSpawnEnv(def, {
        ANTHROPIC_AUTH_TOKEN: 'sk-third-party-token',
        ANTHROPIC_API_KEY: 'sk-ant-key',
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-chat',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-reasoner',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-reasoner',
        ANTHROPIC_MODEL: 'deepseek-chat',
      });

      assert.equal(env['ANTHROPIC_AUTH_TOKEN'], 'sk-third-party-token');
      assert.equal(env['ANTHROPIC_API_KEY'], 'sk-ant-key');
      assert.equal(env['ANTHROPIC_BASE_URL'], 'https://api.deepseek.com/anthropic');
      assert.equal(env['ANTHROPIC_DEFAULT_SONNET_MODEL'], 'deepseek-chat');
      assert.equal(env['ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'], 'deepseek-chat');
      assert.equal(env['ANTHROPIC_DEFAULT_HAIKU_MODEL'], 'deepseek-chat');
      assert.equal(env['ANTHROPIC_DEFAULT_OPUS_MODEL'], 'deepseek-reasoner');
      assert.equal(env['ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'], 'deepseek-reasoner');
      assert.equal(env['ANTHROPIC_MODEL'], 'deepseek-chat');
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

  describe('agent .env file loading', () => {
    const testAgentId = '_molio_test_agent';
    const configDir = path.join(os.homedir(), `.${testAgentId}`);
    const envFile = path.join(configDir, '.env');

    afterEach(() => {
      // Clean up test config directory
      try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('should load vars from ~/.{agentId}/.env', () => {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(envFile, 'TEST_API_KEY=sk-test-123\nTEST_MODEL=gpt-4\n');

      const def = makeDef({ id: testAgentId });
      const env = buildSpawnEnv(def, {});

      assert.equal(env['TEST_API_KEY'], 'sk-test-123');
      assert.equal(env['TEST_MODEL'], 'gpt-4');
    });

    it('should let process.env override .env file', () => {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(envFile, 'SHARED_KEY=from-dotenv\n');

      const def = makeDef({ id: testAgentId });
      const env = buildSpawnEnv(def, { SHARED_KEY: 'from-process' });

      assert.equal(env['SHARED_KEY'], 'from-process');
    });

    it('should let def.env override both .env and process.env', () => {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(envFile, 'MY_KEY=from-dotenv\n');

      const def = makeDef({ id: testAgentId, env: { MY_KEY: 'from-def' } });
      const env = buildSpawnEnv(def, { MY_KEY: 'from-process' });

      assert.equal(env['MY_KEY'], 'from-def');
    });

    it('should handle quoted values in .env', () => {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(envFile, 'QUOTED_DOUBLE="hello world"\nQUOTED_SINGLE=\'single quoted\'\n');

      const def = makeDef({ id: testAgentId });
      const env = buildSpawnEnv(def, {});

      assert.equal(env['QUOTED_DOUBLE'], 'hello world');
      assert.equal(env['QUOTED_SINGLE'], 'single quoted');
    });

    it('should skip comments and blank lines', () => {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(envFile, '# this is a comment\n\nKEY_A=1\n  # another comment\nKEY_B=2\n');

      const def = makeDef({ id: testAgentId });
      const env = buildSpawnEnv(def, {});

      assert.equal(env['KEY_A'], '1');
      assert.equal(env['KEY_B'], '2');
      assert.equal(env['# this is a comment'], undefined);
    });

    it('should not fail when .env does not exist', () => {
      const def = makeDef({ id: testAgentId });
      const env = buildSpawnEnv(def, { SAFE: 'yes' });

      assert.equal(env['SAFE'], 'yes');
    });
  });
});

describe('Windows console encoding', () => {
  afterEach(() => {
    resetCodePageCache();
  });

  describe('detectWindowsCodePage', () => {
    it('should return a number', () => {
      const cp = detectWindowsCodePage();
      assert.equal(typeof cp, 'number');
      assert.ok(cp > 0);
    });

    it('should cache the result on repeated calls', () => {
      const cp1 = detectWindowsCodePage();
      const cp2 = detectWindowsCodePage();
      assert.equal(cp1, cp2);
    });

    it('should return 65001 on non-Windows', { skip: process.platform === 'win32' ? 'non-Windows only' : undefined }, () => {
      assert.equal(detectWindowsCodePage(), 65001);
    });

    it('should re-detect after cache reset', () => {
      const cp1 = detectWindowsCodePage();
      resetCodePageCache();
      const cp2 = detectWindowsCodePage();
      // Same platform, so result should be the same
      assert.equal(cp1, cp2);
    });
  });

  describe('createStderrDecoder', () => {
    it('should return null on non-Windows', { skip: process.platform === 'win32' ? 'non-Windows only' : undefined }, () => {
      assert.equal(createStderrDecoder(), null);
    });

    it('should decode GBK-encoded Chinese text correctly', { skip: process.platform !== 'win32' ? 'Windows only' : undefined }, () => {
      // On Chinese Windows, the code page is typically 936 (GBK).
      // "系统找不到指定的路径" in GBK encoding:
      const gbkBytes = Buffer.from([
        0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb,
        0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4,
        0xc2, 0xb7, 0xbe, 0xb6,
      ]);

      const decoder = createStderrDecoder();
      if (decoder) {
        // Code page is not UTF-8 — decoder should properly decode GBK
        const text = decoder(gbkBytes);
        assert.equal(text, '系统找不到指定的路径');
      }
      // If decoder is null, code page is already UTF-8 — no fix needed
    });

    it('should not garble ASCII text', { skip: process.platform !== 'win32' ? 'Windows only' : undefined }, () => {
      const decoder = createStderrDecoder();
      if (decoder) {
        const buf = Buffer.from('Error: file not found', 'ascii');
        const text = decoder(buf);
        assert.equal(text, 'Error: file not found');
      }
    });
  });
});

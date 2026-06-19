import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildAgentEnv, mergeConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import type { AgentConfig, AppConfig } from '../../src/core/config.js';

/**
 * Tests for config module.
 * Focuses on buildAgentEnv (pure function).
 * loadConfig/saveConfig require integration testing with real ~/.molio directory.
 */

describe('Config module', () => {
  describe('buildAgentEnv', () => {
    it('should include process.env variables', () => {
      process.env['TEST_VAR_CONFIG'] = 'test-value';
      const agentConfig: AgentConfig = {};
      const env = buildAgentEnv('test-agent', agentConfig);

      assert.equal(env['TEST_VAR_CONFIG'], 'test-value');
      delete process.env['TEST_VAR_CONFIG'];
    });

    it('should override with agent config env', () => {
      process.env['SHARED_VAR_CONFIG'] = 'original';
      const agentConfig: AgentConfig = {
        env: { SHARED_VAR_CONFIG: 'overridden' },
      };
      const env = buildAgentEnv('test-agent', agentConfig);

      assert.equal(env['SHARED_VAR_CONFIG'], 'overridden');
      delete process.env['SHARED_VAR_CONFIG'];
    });

    it('should add binary path as uppercase env var', () => {
      const agentConfig: AgentConfig = {
        binaryPath: '/custom/path/to/binary',
      };
      const env = buildAgentEnv('claude', agentConfig);

      assert.equal(env['CLAUDE_BIN'], '/custom/path/to/binary');
    });

    it('should handle agent id with mixed case', () => {
      const agentConfig: AgentConfig = {
        binaryPath: '/path/to/gemini',
      };
      const env = buildAgentEnv('gemini-cli', agentConfig);

      // Should uppercase the full agent id
      assert.equal(env['GEMINI-CLI_BIN'], '/path/to/gemini');
    });

    it('should not include undefined process.env values', () => {
      const agentConfig: AgentConfig = {};
      const env = buildAgentEnv('test', agentConfig);

      // Check that all values are strings
      for (const [key, value] of Object.entries(env)) {
        assert.equal(typeof value, 'string', `env[${key}] should be string, got ${typeof value}`);
      }
    });

    it('should merge both env and binaryPath', () => {
      const agentConfig: AgentConfig = {
        binaryPath: '/opt/claude/bin/claude',
        env: { CUSTOM_API_KEY: 'key123', WORKSPACE: '/home/user' },
      };
      const env = buildAgentEnv('claude', agentConfig);

      assert.equal(env['CLAUDE_BIN'], '/opt/claude/bin/claude');
      assert.equal(env['CUSTOM_API_KEY'], 'key123');
      assert.equal(env['WORKSPACE'], '/home/user');
    });

    it('should handle empty agent config', () => {
      const agentConfig: AgentConfig = {};
      const env = buildAgentEnv('qwen', agentConfig);

      // Should still have process.env vars but no agent-specific additions
      assert.equal(env['QWEN_BIN'], undefined);
      assert.equal(typeof env, 'object');
    });
  });

  describe('mergeConfig', () => {
    const configFile = path.join(os.homedir(), '.molio', 'config.json');
    let originalConfig: string | null = null;

    afterEach(() => {
      // Restore original config after each test
      try {
        if (originalConfig !== null) {
          if (originalConfig === '') {
            fs.unlinkSync(configFile);
          } else {
            fs.writeFileSync(configFile, originalConfig, 'utf8');
          }
        }
      } catch { /* ignore */ }
    });

    function backupConfig() {
      try {
        originalConfig = fs.readFileSync(configFile, 'utf8');
      } catch {
        originalConfig = '';
      }
    }

    function setupBaseConfig(agents: AppConfig['agents']) {
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      saveConfig({
        agents: agents ?? {},
        defaultAgentId: 'claude',
      });
    }

    it('should preserve agents when partial update does not include agents', () => {
      backupConfig();
      setupBaseConfig({
        claude: {
          env: {
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
            ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-key-123',
          },
        },
      });

      // Simulate a partial update like `{ defaultAgentId: "codex" }`
      saveConfig(mergeConfig({ defaultAgentId: 'codex' }));

      const config = loadConfig();
      assert.equal(config.defaultAgentId, 'codex');
      assert.ok(config.agents.claude, 'claude agent should be preserved');
      assert.equal(config.agents.claude?.env?.['ANTHROPIC_AUTH_TOKEN'], 'sk-deepseek-key-123');
    });

    it('should merge agents at per-agent level', () => {
      backupConfig();
      setupBaseConfig({
        claude: {
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-claude-key' },
        },
        codex: {
          env: { OPENAI_API_KEY: 'sk-codex-key' },
        },
      });

      // Partial update: only updates claude agent config
      saveConfig(mergeConfig({
        agents: {
          claude: {
            env: { ANTHROPIC_AUTH_TOKEN: 'sk-new-claude-key' },
          },
        },
      }));

      const config = loadConfig();
      // Claude updated
      assert.equal(config.agents.claude?.env?.['ANTHROPIC_AUTH_TOKEN'], 'sk-new-claude-key');
      // Codex preserved
      assert.equal(config.agents.codex?.env?.['OPENAI_API_KEY'], 'sk-codex-key');
    });

    it('should preserve agents when partial update sends only locale', () => {
      backupConfig();
      setupBaseConfig({
        claude: {
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-key' },
        },
      });

      // Simulate LanguageProvider setting locale
      saveConfig(mergeConfig({ locale: 'en' }));

      const config = loadConfig();
      assert.equal(config.locale, 'en');
      assert.ok(config.agents.claude, 'claude agent should be preserved');
      assert.equal(config.agents.claude?.env?.['ANTHROPIC_AUTH_TOKEN'], 'sk-key');
    });
  });
});

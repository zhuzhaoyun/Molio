import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentEnv } from '../src/core/config.js';
import type { AgentConfig } from '../src/core/config.js';

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
});

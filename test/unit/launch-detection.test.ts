import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { getWellKnownToolchainDirs } from '../src/daemon/runtimes/launch.js';

describe('Well-known toolchain dirs detection', () => {
  it('should return platform-specific directories', () => {
    const dirs = getWellKnownToolchainDirs();
    assert.ok(Array.isArray(dirs));
    assert.ok(dirs.length > 0, 'Should find at least some candidate dirs');
  });

  it('should include platform-appropriate paths', () => {
    const dirs = getWellKnownToolchainDirs();
    const home = os.homedir();

    if (process.platform === 'win32') {
      // Windows: should include AppData paths
      const hasAppData = dirs.some(d =>
        d.includes('AppData')
      );
      assert.ok(hasAppData, 'Windows should include AppData dirs');

      // Should NOT include POSIX paths
      const hasHomebrew = dirs.some(d => d.includes('homebrew'));
      assert.ok(!hasHomebrew, 'Windows should not include homebrew paths');
    } else {
      // POSIX: should include ~/.local/bin
      const hasLocalBin = dirs.some(d =>
        d === path.join(home, '.local', 'bin')
      );
      assert.ok(hasLocalBin, 'POSIX should include ~/.local/bin');

      // Should include cargo bin
      const hasCargo = dirs.some(d =>
        d === path.join(home, '.cargo', 'bin')
      );
      assert.ok(hasCargo, 'POSIX should include ~/.cargo/bin');
    }
  });

  it('should include NPM_CONFIG_PREFIX if set', () => {
    const original = process.env['NPM_CONFIG_PREFIX'];
    try {
      process.env['NPM_CONFIG_PREFIX'] = '/tmp/test-npm-prefix';
      const dirs = getWellKnownToolchainDirs();

      if (process.platform !== 'win32') {
        const hasPrefix = dirs.some(d =>
          d === path.join('/tmp/test-npm-prefix', 'bin')
        );
        assert.ok(hasPrefix, 'Should include NPM_CONFIG_PREFIX/bin');
      }
    } finally {
      if (original !== undefined) {
        process.env['NPM_CONFIG_PREFIX'] = original;
      } else {
        delete process.env['NPM_CONFIG_PREFIX'];
      }
    }
  });

  it('should return absolute paths', () => {
    const dirs = getWellKnownToolchainDirs();
    for (const dir of dirs) {
      assert.ok(path.isAbsolute(dir), `Path should be absolute: ${dir}`);
    }
  });
});

describe('resolveAgentBinary with env override', () => {
  it('should accept configuredEnv option', async () => {
    // Dynamic import to test the function signature
    const { resolveAgentBinary } = await import('../src/daemon/runtimes/launch.js');
    const { claudeAgentDef } = await import('../src/daemon/runtimes/claude.js');

    // Test with no override - should try PATH detection
    const result = resolveAgentBinary(claudeAgentDef);
    assert.ok(result.source);
    assert.ok(['env-override', 'path', 'well-known', 'fallback-bin', 'not-found'].includes(result.source));
  });

  it('should return not-found for non-existent binary', async () => {
    const { resolveAgentBinary } = await import('../src/daemon/runtimes/launch.js');

    const fakeDef = {
      id: 'fake-agent',
      name: 'Fake Agent',
      bin: 'this-binary-definitely-does-not-exist-12345',
      versionArgs: ['--version'],
      fallbackModels: [],
      buildArgs: () => [],
      streamFormat: 'test',
    };

    const result = resolveAgentBinary(fakeDef);
    assert.equal(result.binary, null);
    assert.equal(result.source, 'not-found');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getWellKnownToolchainDirs, validateBinary } from '../../src/core/runtimes/launch.js';

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

      // Hermes Agent — official installer puts hermes-acp.exe in this venv
      // Scripts dir. Must be in well-known dirs so detection does not depend
      // on PATH propagation (daemon may have started before the installer
      // updated PATH, in which case the inherited PATH snapshot misses it).
      const hasHermesVenv = dirs.some(d =>
        d === path.join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts')
      );
      assert.ok(hasHermesVenv, 'Windows should include Hermes venv Scripts dir');

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
    const { resolveAgentBinary } = await import('../../src/core/runtimes/launch.js');
    const { claudeAgentDef } = await import('../../src/core/runtimes/claude.js');

    // Test with no override - should try PATH detection
    const result = resolveAgentBinary(claudeAgentDef);
    assert.ok(result.source);
    assert.ok(['env-override', 'path', 'well-known', 'fallback-bin', 'not-found'].includes(result.source));
  });

  it('should return not-found for non-existent binary', async () => {
    const { resolveAgentBinary } = await import('../../src/core/runtimes/launch.js');

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

describe('validateBinary Mach-O detection', () => {
  it('should accept little-endian 64-bit Mach-O headers', () => {
    const tmpFile = path.join(os.tmpdir(), `molio-macho-${Date.now()}`);
    const payload = Buffer.alloc(1_024 * 1_024, 0);
    payload.writeUInt32BE(0xCFFAEDFE, 0);

    try {
      fs.writeFileSync(tmpFile, payload);
      assert.equal(validateBinary(tmpFile, 'darwin'), null);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('should reject non-native headers on darwin', () => {
    const tmpFile = path.join(os.tmpdir(), `molio-bad-header-${Date.now()}`);
    const payload = Buffer.alloc(1_024 * 1_024, 0);
    payload.write('TEXT', 0, 'ascii');

    try {
      fs.writeFileSync(tmpFile, payload);
      assert.match(validateBinary(tmpFile, 'darwin') ?? '', /Invalid ELF\/Mach-O header/);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});

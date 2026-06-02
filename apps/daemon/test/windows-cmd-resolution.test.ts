import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentBinary, probeVersion } from '../src/core/runtimes/launch.js';
import { claudeAgentDef } from '../src/core/runtimes/claude.js';

/**
 * Error-driven test for Windows .cmd binary resolution.
 *
 * Bug: On Windows, `where.exe claude` finds the binary and `isOnPath` returns true,
 * but `execFileSync('claude', ['--version'])` fails with ENOENT because:
 * 1. where.exe may return `C:\nvm4w\nodejs\claude` (extensionless) as first result
 * 2. execFileSync cannot execute `.cmd` files without `shell: true`
 * 3. execFileSync cannot execute extensionless files on Windows
 *
 * Fix: resolveOnPath() now prefers .cmd/.exe/.bat files from where.exe output,
 * and probeVersion() uses `shell: true` for .cmd/.bat files on Windows.
 */
describe('Windows .cmd binary resolution (error-driven)', () => {
  it('should resolve claude binary to .cmd path on Windows', () => {
    if (process.platform !== 'win32') {
      return; // Skip on non-Windows
    }

    const result = resolveAgentBinary(claudeAgentDef);

    if (result.binary) {
      // Should resolve to a .cmd or .exe file, not extensionless
      const hasExtension = result.binary.endsWith('.cmd')
        || result.binary.endsWith('.exe')
        || result.binary.endsWith('.bat');

      assert.ok(hasExtension,
        `Binary should have executable extension (.cmd/.exe/.bat), got: ${result.binary}`);
    }
  });

  it('should successfully probe version for .cmd binaries on Windows', () => {
    if (process.platform !== 'win32') {
      return; // Skip on non-Windows
    }

    const result = resolveAgentBinary(claudeAgentDef);

    if (result.binary && result.binary.endsWith('.cmd')) {
      const version = probeVersion(result.binary, claudeAgentDef.versionArgs);
      // If claude is installed, version should be detected
      assert.ok(version !== null,
        `probeVersion should succeed for .cmd binary: ${result.binary}`);
      assert.ok(version!.length > 0, 'Version string should not be empty');
    }
  });

  it('should not return extensionless binary paths on Windows', () => {
    if (process.platform !== 'win32') {
      return; // Skip on non-Windows
    }

    const result = resolveAgentBinary(claudeAgentDef);

    if (result.binary) {
      const ext = result.binary.split('.').pop();
      assert.notEqual(ext, result.binary,
        'Binary path should have a file extension on Windows');
    }
  });
});

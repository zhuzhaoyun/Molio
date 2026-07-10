import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentBinary, probeVersion, needsShellOnWindows } from '../../src/core/runtimes/launch.js';
import { claudeAgentDef } from '../../src/core/runtimes/claude.js';

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
      const probeResult = probeVersion(result.binary, claudeAgentDef.versionArgs);
      // If claude is installed, version should be detected
      assert.ok(probeResult.version !== null,
        `probeVersion should succeed for .cmd binary: ${result.binary}`);
      assert.ok(probeResult.version!.length > 0, 'Version string should not be empty');
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

describe('needsShellOnWindows (D8: extensionless shim detection)', () => {
  // Bug: Python venv creates an extensionless `hermes-acp` shim alongside the
  // `.exe` for Git Bash compatibility. If resolveOnPath returns that shim
  // (e.g. the `.exe` was deleted, or `where` only surfaced the extensionless
  // entry), spawn/execFile without `shell: true` fails with ENOENT because
  // CreateProcess only resolves `.exe` without PATHEXT lookup. needsShellOnWindows
  // must return true for extensionless paths so callers set `shell: true`.

  it('returns true for .cmd shims', () => {
    if (process.platform !== 'win32') return;
    assert.equal(needsShellOnWindows('C:\\Users\\test\\venv\\Scripts\\hermes-acp.cmd'), true);
  });

  it('returns true for .bat shims', () => {
    if (process.platform !== 'win32') return;
    assert.equal(needsShellOnWindows('C:\\Users\\test\\hermes-acp.bat'), true);
  });

  it('returns true for extensionless POSIX shim', () => {
    if (process.platform !== 'win32') return;
    assert.equal(needsShellOnWindows('C:\\Users\\test\\venv\\Scripts\\hermes-acp'), true);
  });

  it('returns false for .exe (real PE binary)', () => {
    if (process.platform !== 'win32') return;
    assert.equal(needsShellOnWindows('C:\\Users\\test\\venv\\Scripts\\hermes-acp.exe'), false);
  });

  it('returns false on non-Windows platforms', () => {
    if (process.platform === 'win32') return;
    assert.equal(needsShellOnWindows('/usr/local/bin/hermes-acp'), false);
    assert.equal(needsShellOnWindows('/home/test/venv/bin/hermes-acp'), false);
  });
});

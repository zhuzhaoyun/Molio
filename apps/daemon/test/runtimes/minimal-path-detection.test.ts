import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RunManager } from '../../src/core/RunManager.js';

/**
 * Error-driven test: runtime detection must work even with minimal PATH.
 *
 * Bug: When Electron is launched from the desktop (not a terminal),
 * it inherits a limited PATH that may not include nvm/fnm/npm directories.
 * This caused Claude Code to not be detected.
 *
 * Fix:
 * - resolveOnPath uses C:\Windows\System32\where.exe (full path)
 * - Well-known dirs include nvm4w, fnm, npm, pnpm locations
 * - probeVersion adds well-known dirs to PATH for .cmd shim execution
 */
describe('Detection with minimal PATH (Electron desktop launch)', () => {
  it('should detect claude even with minimal Windows PATH', () => {
    if (process.platform !== 'win32') {
      return; // Skip on non-Windows
    }

    // Pre-check: if claude is not installed at all, skip rather than fail.
    // This test validates the fallback search logic, not the presence of claude.
    const baselineRm = new RunManager();
    const baseline = baselineRm.detectAgents().find(a => a.id === 'claude');
    if (!baseline?.available) {
      return; // claude not installed — nothing to detect regardless of PATH
    }

    const originalPath = process.env['PATH'];
    try {
      // Simulate Electron launched from desktop: minimal PATH
      process.env['PATH'] = 'C:\\Windows\\system32;C:\\Windows';

      const rm = new RunManager();
      const agents = rm.detectAgents();

      const claude = agents.find(a => a.id === 'claude');
      assert.ok(claude, 'Claude agent should be in detection results');
      assert.ok(claude!.available, 'Claude should be detected even with minimal PATH');
      assert.ok(claude!.binary, 'Binary path should be resolved');
      assert.ok(claude!.source === 'well-known' || claude!.source === 'path',
        `Source should be well-known or path, got: ${claude!.source}`);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('should detect claude even with empty PATH', () => {
    if (process.platform !== 'win32') {
      return; // Skip on non-Windows
    }

    // Pre-check: skip if claude is not installed on this machine.
    const baselineRm = new RunManager();
    const baseline = baselineRm.detectAgents().find(a => a.id === 'claude');
    if (!baseline?.available) {
      return;
    }

    const originalPath = process.env['PATH'];
    try {
      process.env['PATH'] = '';

      const rm = new RunManager();
      const agents = rm.detectAgents();

      const claude = agents.find(a => a.id === 'claude');
      assert.ok(claude, 'Claude agent should be in detection results');
      assert.ok(claude!.available, 'Claude should be detected even with empty PATH');
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('should probe version even with minimal PATH', () => {
    if (process.platform !== 'win32') {
      return; // Skip on non-Windows
    }

    const originalPath = process.env['PATH'];
    try {
      process.env['PATH'] = 'C:\\Windows\\system32;C:\\Windows';

      const rm = new RunManager();
      const agents = rm.detectAgents();

      const claude = agents.find(a => a.id === 'claude');
      if (claude?.available) {
        assert.ok(claude.version,
          `Version should be probed even with minimal PATH (got binary: ${claude.binary})`);
        assert.ok(claude.version!.length > 0, 'Version should not be empty');
      }
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});

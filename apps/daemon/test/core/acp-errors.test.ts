import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAcpInitFailure, detectBrokenInstallHint } from '../../src/core/acp-errors.js';

/**
 * Unit tests for acp-errors — the broken-install detection + friendly error
 * formatting used by RunManager's ACP init catch handler.
 *
 * Bug origin: reporter's hermes-acp venv was missing the `acp` Python module.
 * The raw error "ACP init failed: hermes-acp process exited (code=1) (last
 * stderr: ModuleNotFoundError: No module named 'acp')" was technically correct
 * but meaningless to a non-developer. Fix: detect the pattern and prepend a
 * "reinstall hermes-agent" hint with the install URL.
 */
describe('acp-errors', () => {
  describe('detectBrokenInstallHint', () => {
    it('detects ModuleNotFoundError and extracts the missing module name', () => {
      const hint = detectBrokenInstallHint("ModuleNotFoundError: No module named 'acp'");
      assert.ok(hint, 'should return a hint');
      assert.match(hint!, /hermes-agent 安装损坏/);
      assert.match(hint!, /'acp'/);
      assert.match(hint!, /https:\/\/github\.com\/NousResearch\/hermes-agent/);
    });

    it('detects ImportError cannot import name', () => {
      const hint = detectBrokenInstallHint("ImportError: cannot import name 'X' from 'Y'");
      assert.ok(hint);
      assert.match(hint!, /'X'/);
    });

    it('returns null for INFO log lines', () => {
      assert.equal(
        detectBrokenInstallHint('2026-07-08 10:00:00 [INFO] hermes: connecting to provider'),
        null,
      );
    });

    it('returns null for undefined / empty stderr', () => {
      assert.equal(detectBrokenInstallHint(undefined), null);
      assert.equal(detectBrokenInstallHint(''), null);
      assert.equal(detectBrokenInstallHint('   '), null);
    });

    it('returns null for non-install errors', () => {
      assert.equal(detectBrokenInstallHint('ACP idle timeout: initialize (no activity for 15000ms)'), null);
      assert.equal(detectBrokenInstallHint('connection refused'), null);
    });
  });

  describe('formatAcpInitFailure', () => {
    it('prepends hint when stderr matches broken-install pattern', () => {
      const msg = formatAcpInitFailure(
        new Error('hermes-acp process exited (code=1)'),
        "ModuleNotFoundError: No module named 'acp'",
        'C:\\Users\\Administrator\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes-acp.exe',
      );
      // Friendly hint first
      assert.match(msg, /^hermes-agent 安装损坏.*'acp'.*— /);
      // Technical detail preserved for power users
      assert.match(msg, /ACP init failed: hermes-acp process exited \(code=1\)/);
      assert.match(msg, /last stderr: "ModuleNotFoundError: No module named 'acp'"/);
      // Binary path surfaced so users can spot wrong-install cases
      assert.match(msg, /\[binary:.*hermes-acp\.exe\]/);
    });

    it('keeps raw format when last stderr is a normal INFO log', () => {
      const msg = formatAcpInitFailure(
        new Error('ACP idle timeout: initialize (no activity for 15000ms)'),
        '2026-07-08 10:00:00 [INFO] hermes: loading plugins...',
        '/usr/local/bin/hermes-acp',
      );
      assert.doesNotMatch(msg, /安装损坏/);
      assert.match(msg, /^ACP init failed: ACP idle timeout/);
      assert.match(msg, /last stderr:.*loading plugins/);
      assert.match(msg, /\[binary: \/usr\/local\/bin\/hermes-acp\]/);
    });

    it('keeps raw format when lastStderr is undefined', () => {
      const msg = formatAcpInitFailure(new Error('some failure'), undefined, '/bin/hermes-acp');
      assert.equal(msg, 'ACP init failed: some failure [binary: /bin/hermes-acp]');
    });

    it('does not crash on process-exit errors without stderr or binary path', () => {
      // Reporter scenario: hermes-acp crashes so fast no stderr lands at all,
      // and the run was never assigned a binary path (shouldn't happen, but
      // be defensive).
      const msg = formatAcpInitFailure(new Error('hermes-acp process exited (code=1)'), undefined, undefined);
      assert.equal(msg, 'ACP init failed: hermes-acp process exited (code=1)');
    });
  });
});

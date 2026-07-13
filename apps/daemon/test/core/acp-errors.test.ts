import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAcpInitFailure,
  detectBrokenInstallHint,
  extractMissingModuleName,
  buildManualPipCommand,
  buildRepairErrorMessage,
} from '../../src/core/acp-errors.js';

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

    it('detects "No matching distribution" (pip install failure)', () => {
      const hint = detectBrokenInstallHint('ERROR: No matching distribution found for agent-client-protocol==0.9.0');
      assert.ok(hint);
      assert.match(hint!, /无法安装.*agent-client-protocol==0.9.0/);
      assert.match(hint!, /Python 版本不兼容或网络问题/);
    });

    it('detects SyntaxError (venv python too old)', () => {
      const hint = detectBrokenInstallHint("SyntaxError: invalid syntax. Perhaps you forgot a ','?");
      assert.ok(hint);
      assert.match(hint!, /SyntaxError/);
      assert.match(hint!, /venv Python 版本可能过低/);
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

    it('preserves copyable command block from ensureAcpExtra errors', () => {
      // When ensureAcpExtra throws HermesRepairError, the message already
      // contains a fenced code block with the manual pip command. The web UI
      // detects ``` blocks and renders a 复制 button. formatAcpInitFailure
      // must pass the block through verbatim and append only the binary path
      // so users can compare installs.
      const err = new Error(
        'Hermes 自动修复失败（pip install 出错）。请手动运行以下命令修复（hermes-agent venv）：\n\n```\n& "C:\\py.exe" -m pip install agent-client-protocol==0.9.0\n```\n\n最后 stderr：\n```\nERROR: network down\n```',
      );
      const msg = formatAcpInitFailure(
        err,
        undefined,
        'C:\\Users\\Administrator\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes-acp.exe',
      );
      // Fenced block preserved (use string includes, not regex, to avoid
      // backslash-escaping confusion between source literal and regex)
      assert.ok(msg.includes('```\n& "C:\\py.exe" -m pip install agent-client-protocol==0.9.0\n```'));
      // Binary path appended for diagnosis
      assert.ok(msg.includes('[binary:'));
      assert.ok(msg.includes('hermes-acp.exe]'));
      // No duplicate "ACP init failed:" prefix tacked on (would mangle the block)
      assert.ok(!msg.startsWith('ACP init failed: Hermes'));
    });
  });

  describe('extractMissingModuleName', () => {
    it('extracts the module name from ModuleNotFoundError', () => {
      assert.equal(extractMissingModuleName("ModuleNotFoundError: No module named 'acp'"), 'acp');
      assert.equal(extractMissingModuleName("ModuleNotFoundError: No module named 'foo.bar'"), 'foo.bar');
    });

    it('extracts the name from ImportError cannot import name', () => {
      assert.equal(extractMissingModuleName("ImportError: cannot import name 'X' from 'Y'"), 'X');
    });

    it('returns null for non-import errors and non-module patterns', () => {
      // DistributionNotFoundError and SyntaxError are not missing-module
      // categories — extractMissingModuleName must return null for them so
      // ensureAcpExtra (hermes.ts) doesn't try to auto-repair them as if
      // they were a missing `acp` module.
      assert.equal(extractMissingModuleName('RuntimeError: foo'), null);
      assert.equal(extractMissingModuleName('2026-07-08 10:00:00 [INFO] hermes: starting'), null);
      assert.equal(
        extractMissingModuleName('ERROR: No matching distribution found for agent-client-protocol==0.9.0'),
        null,
      );
      assert.equal(extractMissingModuleName("SyntaxError: invalid syntax"), null);
      assert.equal(extractMissingModuleName(undefined), null);
      assert.equal(extractMissingModuleName(''), null);
    });
  });

  describe('buildManualPipCommand', () => {
    it('produces a PowerShell call-operator command on Windows', () => {
      if (process.platform !== 'win32') return;
      const cmd = buildManualPipCommand('C:\\Users\\test\\venv\\Scripts\\python.exe');
      assert.equal(cmd, '& "C:\\Users\\test\\venv\\Scripts\\python.exe" -m pip install agent-client-protocol==0.9.0');
    });

    it('produces a quoted POSIX command on non-Windows', () => {
      if (process.platform === 'win32') return;
      const cmd = buildManualPipCommand('/home/test/venv/bin/python');
      assert.equal(cmd, '"/home/test/venv/bin/python" -m pip install agent-client-protocol==0.9.0');
    });
  });

  describe('buildRepairErrorMessage', () => {
    it('wraps the copyable command in a fenced code block', () => {
      const msg = buildRepairErrorMessage('自动修复失败', '/bin/python', undefined);
      assert.ok(msg.startsWith('自动修复失败。请手动运行以下命令修复（hermes-agent venv）：\n\n```\n'));
      assert.ok(msg.includes('pip install agent-client-protocol==0.9.0'));
      assert.ok(msg.endsWith('\n```'));
      // No trailing stderr when stderr is undefined
      assert.ok(!msg.includes('最后 stderr'));
    });

    it('appends stderr fenced block when stderr is provided', () => {
      const msg = buildRepairErrorMessage('修复失败', '/bin/python', 'ERROR: network down');
      assert.ok(msg.includes('最后 stderr：\n```\nERROR: network down\n```'));
    });
  });
});

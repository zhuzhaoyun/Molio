import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { InstallEvent } from '@molio/contracts';
import { installAgent, getMolioBinDir, extractFromTarball, extractTreeFromTarball, buildTarballName, addToUserPath, updateCurrentProcessPath, getPlatformKey, parseLatestVersionFromPackument, matchPlatformArgs, classifyScriptExitError } from '../../src/core/runtimes/install.js';
import { claudeAgentDef } from '../../src/core/runtimes/claude.js';
import { codexAgentDef } from '../../src/core/runtimes/codex.js';
import { hermesAgentDef } from '../../src/core/runtimes/hermes.js';
import { getAgentDef } from '../../src/core/runtimes/registry.js';

// ─── Platform Detection ───────────────────────────────────────────────────

describe('getPlatformKey', () => {
  it('should return a valid platform key string', () => {
    const key = getPlatformKey();
    assert.ok(typeof key === 'string' && key.length > 0);
    // Should be in the form "platform-arch" or "linux-arch-musl"
    const parts = key.split('-');
    assert.ok(parts.length >= 2, `platform key "${key}" should have at least 2 parts`);
    assert.ok(['win32', 'darwin', 'linux'].includes(parts[0]!),
      `platform should be one of win32/darwin/linux, got: ${parts[0]}`);
  });
});

// ─── getMolioBinDir ────────────────────────────────────────────────────────

describe('getMolioBinDir', () => {
  it('should return a path inside ~/.molio/bin', () => {
    const binDir = getMolioBinDir();
    const home = os.homedir();
    assert.ok(binDir.startsWith(home), `binDir ${binDir} should be inside home directory ${home}`);
    assert.ok(binDir.includes('.molio'), 'binDir should be inside .molio directory');
    assert.ok(binDir.endsWith('bin'), 'binDir should end with "bin"');
  });
});

// ─── installAgent ──────────────────────────────────────────────────────────

describe('installAgent', () => {
  it('should emit structured error for unknown agent', async () => {
    const events: InstallEvent[] = [];
    await installAgent({
      agentId: 'nonexistent-agent',
      onEvent: (event) => events.push(event),
    });

    assert.ok(events.length > 0, 'should emit at least one event');
    const lastEvent = events[events.length - 1]!;
    assert.equal(lastEvent.type, 'error');
    if (lastEvent.type === 'error') {
      assert.match(lastEvent.message, /No install configuration found/);
      assert.equal(lastEvent.category, 'unknown');
      assert.equal(lastEvent.retryable, false);
      assert.ok(lastEvent.hint, 'error should include a hint for manual install');
    }
  });

  it('should support AbortSignal cancellation', async () => {
    const ac = new AbortController();
    ac.abort(); // Abort immediately

    const events: InstallEvent[] = [];
    await installAgent({
      agentId: 'claude',
      signal: ac.signal,
      onEvent: (event) => events.push(event),
    });

    // Should emit an error event about cancellation or never start downloading
    // The preflight phase may run before the abort checkpoint, so we just verify
    // no 'done' event was emitted.
    const doneEvents = events.filter(e => e.type === 'done');
    assert.equal(doneEvents.length, 0, 'should not emit done when aborted');
  });
});

/**
 * Error-driven test for Windows version check during install.
 *
 * Bug: On Windows 10 1607 (build 14393) / Server 2016, the Claude Code native
 * binary fails with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139).
 * Fix: Check Windows build number before downloading; reject with a clear
 * error message including category='platform' and retryable=false.
 */
describe('Windows version check (error-driven)', () => {
  it('should reject install on Windows builds older than 17763', async () => {
    if (process.platform !== 'win32') return;

    const release = os.release();
    const parts = release.split('.');
    const build = parseInt(parts[parts.length - 1] || '', 10);

    if (build >= 17763) return; // Skip on modern Windows

    const events: InstallEvent[] = [];
    await installAgent({
      agentId: 'claude',
      onEvent: (event) => events.push(event),
    });

    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent?.type, 'error', 'should fail on old Windows');
    if (lastEvent?.type === 'error') {
      assert.match(lastEvent.message, /Windows version too old|build/i);
      assert.match(lastEvent.message, /17763/);
      assert.equal(lastEvent.category, 'platform');
      assert.equal(lastEvent.retryable, false);
      assert.ok(lastEvent.hint, 'should include hint for manual install');
    }
  });
});

// ─── Tarball Extraction ────────────────────────────────────────────────────

describe('tarball extraction', () => {
  it('should extract file from a simple tarball', () => {
    const content = Buffer.from('fake-binary-content');
    const header = Buffer.alloc(512);

    header.write('package/claude.exe', 0, 100, 'utf8');
    header.write('100755 ', 100, 8, 'utf8');
    header.write('00000000', 108, 8, 'utf8');
    header.write('00000000', 116, 8, 'utf8');
    header.write(content.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'utf8');
    header.write('00000000000 ', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\x0000', 257, 8, 'utf8');

    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      if (i >= 148 && i < 156) {
        checksum += 32;
      } else {
        checksum += header[i] ?? 0;
      }
    }
    header.write(checksum.toString(8).padStart(6, '0') + ' \0', 148, 8, 'utf8');

    const paddingSize = content.length % 512 === 0 ? 0 : 512 - (content.length % 512);
    const padding = Buffer.alloc(paddingSize);
    const tarBuffer = Buffer.concat([header, content, padding]);
    const gzipped = gzipSync(tarBuffer);

    const extracted = extractFromTarball(gzipped, 'package/claude.exe');
    assert.ok(extracted, 'should extract the file');
    assert.equal(extracted?.toString(), 'fake-binary-content');
  });

  it('should return null when file is not in tarball', () => {
    const header = Buffer.alloc(512);
    header.write('package/other.exe', 0, 100, 'utf8');
    header.write('00000000000 ', 124, 12, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\x0000', 257, 8, 'utf8');

    const gzipped = gzipSync(header);
    const extracted = extractFromTarball(gzipped, 'package/claude.exe');
    assert.equal(extracted, null);
  });
});

// ─── PATH Management ──────────────────────────────────────────────────────

describe('PATH update after install (error-driven)', () => {
  it('addToUserPath should be a function', () => {
    assert.equal(typeof addToUserPath, 'function');
  });

  it('updateCurrentProcessPath should add dir to process PATH', () => {
    const tmpDir = path.join(os.tmpdir(), `molio-proc-${Date.now()}`);
    const pathKey = Object.keys(process.env).find(
      (k) => k.toUpperCase() === 'PATH',
    ) || 'PATH';
    const savedPath = process.env[pathKey];

    try {
      updateCurrentProcessPath(tmpDir);
      const pathAfter = process.env[pathKey] || '';
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const normDir = tmpDir.replace(/[\\/]+$/, '').toLowerCase();
      const isPresent = pathAfter.split(pathSep).some(
        (d) => d.replace(/[\\/]+$/, '').toLowerCase() === normDir,
      );
      assert.ok(isPresent, `process PATH should contain ${tmpDir}`);
    } finally {
      process.env[pathKey] = savedPath;
    }
  });

});

// ─── Latest version resolution ────────────────────────────────────────────

describe('parseLatestVersionFromPackument', () => {
  it('should extract dist-tags.latest from a packument', () => {
    const json = JSON.stringify({ name: '@anthropic-ai/claude-code-win32-x64', 'dist-tags': { latest: '2.1.235' } });
    assert.equal(parseLatestVersionFromPackument(json), '2.1.235');
  });

  it('should return null for malformed JSON', () => {
    assert.equal(parseLatestVersionFromPackument('<html>502 Bad Gateway</html>'), null);
    assert.equal(parseLatestVersionFromPackument(''), null);
  });

  it('should return null when dist-tags.latest is missing or empty', () => {
    assert.equal(parseLatestVersionFromPackument(JSON.stringify({ 'dist-tags': {} })), null);
    assert.equal(parseLatestVersionFromPackument(JSON.stringify({ 'dist-tags': { latest: '' } })), null);
    assert.equal(parseLatestVersionFromPackument(JSON.stringify({ 'dist-tags': { latest: 123 } })), null);
    assert.equal(parseLatestVersionFromPackument(JSON.stringify({})), null);
  });
});

describe('claude agent install source uses latest with fallback', () => {
  it('should use version "latest" with a concrete fallbackVersion', () => {
    const source = claudeAgentDef.install?.source;
    assert.ok(source, 'claude agent must have an install source');
    assert.equal(source!.type, 'npm-native');
    assert.equal(source!.version, 'latest', 'version should be "latest" so installs track upstream');
    if (source!.version === 'latest') {
      assert.match(
        source!.fallbackVersion ?? '',
        /^\d+\.\d+\.\d+/,
        'fallbackVersion must be a concrete semver so offline installs still work',
      );
    }
  });
});

// ─── Codex one-click install ───────────────────────────────────────────────

/** Build a single tar entry header + content (minimal ustar, like npm uses). */
function makeTarEntry(name: string, content: Buffer | string, typeflag = '0'): Buffer {
  const data = typeof content === 'string' ? Buffer.from(content) : content;
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('100755 ', 100, 8, 'utf8');
  header.write('00000000', 108, 8, 'utf8');
  header.write('00000000', 116, 8, 'utf8');
  header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'utf8');
  header.write('00000000000 ', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write(typeflag, 156, 1, 'utf8');
  header.write('ustar\x0000', 257, 8, 'utf8');

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += (i >= 148 && i < 156) ? 32 : (header[i] ?? 0);
  }
  header.write(checksum.toString(8).padStart(6, '0') + ' \0', 148, 8, 'utf8');

  const paddingSize = data.length % 512 === 0 ? 0 : 512 - (data.length % 512);
  return Buffer.concat([header, data, Buffer.alloc(paddingSize)]);
}

describe('buildTarballName', () => {
  it('should use the version verbatim without a tarballVersion template', () => {
    const name = buildTarballName(
      { pkgName: '@anthropic-ai/claude-code-win32-x64', binInTar: 'package/claude.exe' },
      '2.1.235',
    );
    assert.equal(name, 'claude-code-win32-x64-2.1.235.tgz');
  });

  it('should apply the {version} template for version-suffixed packages', () => {
    // Codex publishes platform builds as variants of ONE package:
    // @openai/codex@0.149.0-win32-x64 → codex-0.149.0-win32-x64.tgz
    const name = buildTarballName(
      { pkgName: '@openai/codex', binInTar: 'package/vendor/x/bin/codex', tarballVersion: '{version}-win32-x64' },
      '0.149.0',
    );
    assert.equal(name, 'codex-0.149.0-win32-x64.tgz');
  });

  it('should replace every {version} occurrence', () => {
    const name = buildTarballName(
      { pkgName: 'foo', binInTar: 'x', tarballVersion: '{version}-{version}' },
      '1.2.3',
    );
    assert.equal(name, 'foo-1.2.3-1.2.3.tgz');
  });
});

describe('extractTreeFromTarball', () => {
  const prefix = 'package/vendor/x86_64-pc-windows-msvc/';

  function makeCodexLikeTarball(): Buffer {
    return Buffer.concat([
      makeTarEntry(`${prefix}bin/codex.exe`, 'main-binary'),
      makeTarEntry(`${prefix}codex-path/rg.exe`, 'bundled-rg'),
      makeTarEntry(`${prefix}codex-package.json`, '{}'),
      makeTarEntry('package/package.json', 'outside-prefix'),
      makeTarEntry(`${prefix}bin/`, '', '5'), // directory entry — must be skipped
    ]);
  }

  it('should extract all regular files under the prefix with relative paths', () => {
    const gzipped = gzipSync(makeCodexLikeTarball());
    const files = extractTreeFromTarball(gzipped, prefix);
    assert.ok(files, 'should find files under the prefix');
    const byPath = new Map(files!.map((f) => [f.relPath, f.data.toString()]));
    assert.equal(byPath.get('bin/codex.exe'), 'main-binary');
    assert.equal(byPath.get('codex-path/rg.exe'), 'bundled-rg');
    assert.equal(byPath.get('codex-package.json'), '{}');
    assert.equal(files!.length, 3, 'directory entry and out-of-prefix file must be excluded');
  });

  it('should accept the prefix without a trailing slash', () => {
    const gzipped = gzipSync(makeCodexLikeTarball());
    const files = extractTreeFromTarball(gzipped, prefix.replace(/\/$/, ''));
    assert.ok(files);
    assert.equal(files!.length, 3);
  });

  it('should return null when nothing matches the prefix', () => {
    const gzipped = gzipSync(makeTarEntry('package/other/file', 'x'));
    assert.equal(extractTreeFromTarball(gzipped, prefix), null);
  });

  it('should skip entries escaping the prefix via ..', () => {
    const tarball = Buffer.concat([
      makeTarEntry(`${prefix}../evil.exe`, 'escaped'),
      makeTarEntry(`${prefix}bin/codex.exe`, 'main-binary'),
    ]);
    const files = extractTreeFromTarball(gzipSync(tarball), prefix);
    assert.ok(files);
    assert.deepEqual(files!.map((f) => f.relPath), ['bin/codex.exe']);
  });
});

describe('codex agent install config', () => {
  const source = codexAgentDef.install?.source;

  it('should be installable via the registry', () => {
    const def = getAgentDef('codex');
    assert.ok(def?.install, 'codex must expose an install config so the one-click button shows');
  });

  it('should use version "latest" with a concrete fallbackVersion', () => {
    assert.ok(source, 'codex agent must have an install source');
    assert.equal(source!.type, 'npm-native');
    assert.equal(source!.version, 'latest');
    assert.match(
      source!.fallbackVersion ?? '',
      /^\d+\.\d+\.\d+$/,
      'fallbackVersion must be a concrete semver so offline installs still work',
    );
  });

  it('should cover win32/darwin/linux platform keys', () => {
    if (source!.type !== 'npm-native') assert.fail('expected npm-native source');
    const keys = Object.keys(source!.packages);
    for (const required of ['win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
      assert.ok(keys.includes(required), `missing platform package for ${required}`);
    }
  });

  it('every package entry must have binInTar inside extractDir and a {version} template', () => {
    if (source!.type !== 'npm-native') assert.fail('expected npm-native source');
    for (const [platformKey, pkg] of Object.entries(source!.packages)) {
      assert.ok(pkg.extractDir, `${platformKey}: extractDir required (bundled layout)`);
      const prefix = pkg.extractDir!.endsWith('/') ? pkg.extractDir! : `${pkg.extractDir!}/`;
      assert.ok(
        pkg.binInTar.startsWith(prefix),
        `${platformKey}: binInTar "${pkg.binInTar}" must be inside extractDir "${prefix}"`,
      );
      assert.ok(
        pkg.tarballVersion?.includes('{version}'),
        `${platformKey}: tarballVersion must template {version} (codex publishes version-suffixed variants)`,
      );
      assert.equal(pkg.pkgName, '@openai/codex');
    }
  });

  it('every platform tarballVersion must build a plausible tarball name', () => {
    if (source!.type !== 'npm-native') assert.fail('expected npm-native source');
    for (const [platformKey, pkg] of Object.entries(source!.packages)) {
      const name = buildTarballName(pkg, '0.149.0');
      assert.match(name, /^codex-0\.149\.0-[a-z0-9-]+\.tgz$/, `${platformKey}: bad tarball name ${name}`);
    }
  });
});

describe('PATH update duplication guard (error-driven)', () => {
  it('updateCurrentProcessPath should not duplicate when called twice', () => {
    const tmpDir = path.join(os.tmpdir(), `molio-dup-${Date.now()}`);
    const pathKey = Object.keys(process.env).find(
      (k) => k.toUpperCase() === 'PATH',
    ) || 'PATH';
    const savedPath = process.env[pathKey];

    try {
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const normDir = tmpDir.replace(/[\\/]+$/, '').toLowerCase();

      updateCurrentProcessPath(tmpDir);
      const count1 = (process.env[pathKey] || '').split(pathSep).filter(
        (d) => d.replace(/[\\/]+$/, '').toLowerCase() === normDir,
      ).length;

      updateCurrentProcessPath(tmpDir);
      const count2 = (process.env[pathKey] || '').split(pathSep).filter(
        (d) => d.replace(/[\\/]+$/, '').toLowerCase() === normDir,
      ).length;

      assert.equal(count2, count1, 'should not duplicate');
    } finally {
      process.env[pathKey] = savedPath;
    }
  });
});

// ─── hermes script install config ──────────────────────────────────────────

describe('hermes agent install config (script source)', () => {
  const source = hermesAgentDef.install?.source;

  it('should be installable via the registry', () => {
    const def = getAgentDef('hermes');
    assert.ok(def?.install, 'hermes must expose an install config so the one-click button shows');
  });

  it('should use the script strategy with the official installer URLs', () => {
    assert.ok(source, 'hermes must have an install source');
    assert.equal(source.type, 'script');
    if (source.type !== 'script') assert.fail('expected script source');
    for (const [platformKey, url] of Object.entries(source.scripts)) {
      assert.match(url, /^https:\/\/hermes-agent\.nousresearch\.com\/install\.(ps1|sh)$/,
        `${platformKey}: unexpected script URL ${url}`);
      if (platformKey.startsWith('win32')) {
        assert.ok(url.endsWith('.ps1'), `${platformKey}: windows must use the .ps1 installer`);
      } else {
        assert.ok(url.endsWith('.sh'), `${platformKey}: non-windows must use the .sh installer`);
      }
    }
  });

  it('should cover win32/darwin/linux platform keys', () => {
    if (source?.type !== 'script') assert.fail('expected script source');
    const keys = Object.keys(source.scripts);
    for (const required of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
      assert.ok(keys.includes(required), `missing installer script for ${required}`);
    }
  });

  it('should skip browser + computer-use tools by default and verify with --check + --version', () => {
    if (source?.type !== 'script') assert.fail('expected script source');
    assert.deepEqual(source.platformArgs?.['win32'], ['-SkipBrowser', '-SkipComputerUse']);
    assert.deepEqual(source.platformArgs?.['posix'], ['--skip-browser', '--skip-computer-use']);
    assert.deepEqual(source.verifyArgs, [['--check'], ['--version']]);
    // 30min PER-STAGE budget: the real-world failure was pm's ffmpeg download
    // (~169MB GitHub release) trickle-throttled on CN lines — the .part file
    // was fully PRE-ALLOCATED at 169MB but only ~8MB of ranges were durable
    // when the 600s wall-clock kill fired. With `stages` set the budget
    // applies to each stage run separately. See hermes.ts comment.
    assert.equal(source.timeoutMs, 1_800_000);
  });

  it('should drive the installer through its official stage protocol', () => {
    if (source?.type !== 'script') assert.fail('expected script source');
    // Must match install.ps1's $Stages ladder order (Invoke-StageByName
    // dispatcher rejects unknown stages with exit 2).
    assert.deepEqual(source.stages, [
      'prerequisites', 'repository', 'venv', 'python-deps',
      'config', 'products', 'setup', 'gateway', 'complete',
    ]);
  });

  it('should rewrite the pm lockfile via CN mirrors after the clone stage', () => {
    if (source?.type !== 'script') assert.fail('expected script source');
    const cfg = source.mirrorLockfile;
    assert.ok(cfg, 'mirrorLockfile must be configured — GitHub CDN trickle-throttling on CN lines was the install timeout root cause');
    // Hook must fire after the repo is on disk but BEFORE python-deps, where
    // pm starts pulling ffmpeg & co.
    assert.equal(cfg.afterStage, 'repository');
    const repoIdx = source.stages!.indexOf(cfg.afterStage);
    const depsIdx = source.stages!.indexOf('python-deps');
    assert.ok(repoIdx >= 0 && depsIdx > repoIdx, 'afterStage must precede python-deps in the stage ladder');
    assert.equal(cfg.relPath, 'hermes-agent/pm/lock.json');
    assert.equal(cfg.homeEnv, 'HERMES_HOME');
    assert.equal(cfg.defaultHome.win32, '%LOCALAPPDATA%\\hermes');
    assert.equal(cfg.defaultHome.posix, '~/.hermes');
  });

  it('should keep installUrl for manual-install fallback', () => {
    assert.ok(hermesAgentDef.installUrl, 'installUrl must stay for error hints / manual install');
  });
});

// ─── matchPlatformArgs ─────────────────────────────────────────────────────

describe('matchPlatformArgs', () => {
  it('should return empty array when platformArgs is undefined', () => {
    assert.deepEqual(matchPlatformArgs('win32-x64', undefined), []);
  });

  it('should match family-specific keys by platform prefix', () => {
    const args = { win32: ['-SkipBrowser'], darwin: ['--darwin-flag'] };
    assert.deepEqual(matchPlatformArgs('win32-x64', args), ['-SkipBrowser']);
    assert.deepEqual(matchPlatformArgs('win32-arm64', args), ['-SkipBrowser']);
    assert.deepEqual(matchPlatformArgs('darwin-arm64', args), ['--darwin-flag']);
  });

  it('should fall back to posix for any non-win32 platform', () => {
    const args = { win32: ['-SkipBrowser'], posix: ['--skip-browser'] };
    assert.deepEqual(matchPlatformArgs('darwin-x64', args), ['--skip-browser']);
    assert.deepEqual(matchPlatformArgs('linux-x64', args), ['--skip-browser']);
    assert.deepEqual(matchPlatformArgs('linux-arm64-musl', args), ['--skip-browser']);
  });

  it('should prefer family-specific over posix', () => {
    const args = { darwin: ['--darwin-only'], posix: ['--skip-browser'] };
    assert.deepEqual(matchPlatformArgs('darwin-arm64', args), ['--darwin-only']);
  });

  it('should NOT apply posix to win32', () => {
    const args = { posix: ['--skip-browser'] };
    assert.deepEqual(matchPlatformArgs('win32-x64', args), []);
  });

  it('should return empty array when nothing matches', () => {
    assert.deepEqual(matchPlatformArgs('freebsd-x64', { darwin: ['--x'] }), []);
  });
});

// ─── classifyScriptExitError ───────────────────────────────────────────────

describe('classifyScriptExitError', () => {
  it('should classify DNS failures as network + retryable with mirror hint', () => {
    const r = classifyScriptExitError(
      'fatal: unable to access \'https://github.com/NousResearch/hermes-agent/\': Could not resolve host: github.com',
      128,
    );
    assert.equal(r.category, 'network');
    assert.equal(r.retryable, true);
    assert.match(r.hint ?? '', /MOLIO_HERMES_REPO_URL/);
    assert.match(r.hint ?? '', /proxy/i);
  });

  it('should classify connection failures as network + retryable', () => {
    const networkStderrs = [
      'connect ECONNREFUSED 140.82.112.3:443',
      'getaddrinfo ENOTFOUND github.com',
      'Connection timed out after 30000 milliseconds',
      'error: RPC failed; curl 56 OpenSSL SSL_read: connection was aborted (github.com)',
    ];
    for (const stderr of networkStderrs) {
      const r = classifyScriptExitError(stderr, 1);
      assert.equal(r.category, 'network', `expected network for: ${stderr}`);
      assert.equal(r.retryable, true);
    }
  });

  it('should classify permission failures as permission + non-retryable', () => {
    for (const stderr of [
      'mkdir: cannot create directory \'/opt/hermes\': Permission denied',
      'Error: EACCES: permission denied, mkdir',
      'Access is denied. (os error 5)',
    ]) {
      const r = classifyScriptExitError(stderr, 1);
      assert.equal(r.category, 'permission');
      assert.equal(r.retryable, false);
    }
  });

  it('should classify unknown failures as runtime + retryable', () => {
    const r = classifyScriptExitError('uv panicked: internal compiler error', 101);
    assert.equal(r.category, 'runtime');
    assert.equal(r.retryable, true);
  });

  it('should carry the last stderr line as detail', () => {
    const r = classifyScriptExitError('noise line\nfatal: something exploded\n', 1);
    assert.match(r.detail ?? '', /something exploded/);
  });

  it('should include installUrl in the network hint when given', () => {
    const r = classifyScriptExitError('Could not resolve host: github.com', 1, 'https://example.com/hermes');
    assert.match(r.hint ?? '', /example\.com\/hermes/);
  });
});

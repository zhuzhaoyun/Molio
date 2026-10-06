import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { InstallEvent, NpmJsInstallSource } from '@molio/contracts';
import {
  installAgent, getMolioBinDir, extractFromTarball, extractTreeFromTarball,
  buildTarballName, addToUserPath, updateCurrentProcessPath, getPlatformKey,
  parseLatestVersionFromPackument, parseShaForFile, writeShim, nodeDistInfo,
  probeHostNode, ensureManagedNode, installNpmDeps, managedNodeBin, managedNpmCli,
} from '../../src/core/runtimes/install.js';
import { claudeAgentDef } from '../../src/core/runtimes/claude.js';
import { codexAgentDef } from '../../src/core/runtimes/codex.js';
import { dshAgentDef } from '../../src/core/runtimes/dsh.js';
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
  const installSource = codexAgentDef.install?.source;
  // Narrow to npm-native once so native-only fields (.packages, .fallbackVersion)
  // type-check — InstallSource is a union now that npm-js (dsh) exists.
  const source = installSource?.type === 'npm-native' ? installSource : undefined;

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

// ─── dsh (npm-js) install config ───────────────────────────────────────────

describe('dsh agent install config (npm-js)', () => {
  const installSource = dshAgentDef.install?.source;
  const source = installSource?.type === 'npm-js' ? installSource : undefined;

  it('should be installable via the registry', () => {
    const def = getAgentDef('dsh');
    assert.ok(def?.install, 'dsh must expose an install config so the one-click button shows');
  });

  it('should use the npm-js source with a pinned exact version', () => {
    assert.ok(source, 'dsh must have an npm-js install source');
    assert.equal(source!.type, 'npm-js');
    assert.equal(source!.pkgName, '@deepseek-ai/dsh');
    // dist-tag bug #4222: never 'latest' — pin an exact version so installs are
    // reproducible and a bad upstream rc doesn't silently break one-click install.
    assert.notEqual(source!.version, 'latest');
    assert.match(source!.version, /^\d+\.\d+\.\d+/, 'version must be an exact semver');
    assert.ok(source!.binEntry.length > 0, 'binEntry must point at the launcher JS');
  });

  it('should require Node >= 22 and configure multi-mirror managed Node', () => {
    assert.ok(source);
    assert.equal(source!.minNodeMajor, 22, 'dsh requires Node >= 22');
    assert.match(source!.managedNode.version, /^v\d+\.\d+\.\d+$/, 'managed Node version must be exact');
    // Multi-tier mirror fallback: at least one China mirror + the official dist.
    assert.ok(source!.managedNode.mirrors.length >= 2, 'need mirror fallback');
    assert.ok(
      source!.managedNode.mirrors.some((m) => m.includes('npmmirror') || m.includes('tencent') || m.includes('aliyun')),
      'should include a China mirror for non-technical users',
    );
    assert.ok(
      source!.managedNode.mirrors.some((m) => m.includes('nodejs.org')),
      'should include the official nodejs.org dist as final fallback',
    );
  });

  it('should configure registry fallback (npmmirror first, npmjs last)', () => {
    assert.ok(source);
    assert.ok(source!.registries.length >= 2, 'need registry fallback');
    assert.ok(source!.registries[0]!.includes('npmmirror'), 'npmmirror should be tried first');
    assert.ok(
      source!.registries[source!.registries.length - 1]!.includes('npmjs.org'),
      'official npmjs should be the last-resort registry',
    );
  });
});

// ─── parseShaForFile ─────────────────────────────────────────────────────────

describe('parseShaForFile', () => {
  const shasums = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v22.20.0-linux-x64.tar.gz',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  node-v22.20.0-win-x64.zip',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  node-v22.20.0-darwin-arm64.tar.gz',
  ].join('\n');

  it('should extract the sha256 for a matching filename', () => {
    assert.equal(
      parseShaForFile(shasums, 'node-v22.20.0-win-x64.zip'),
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
  });

  it('should return null for a filename not in the list', () => {
    assert.equal(parseShaForFile(shasums, 'node-v22.20.0-win-arm64.zip'), null);
  });

  it('should return null for malformed / empty input', () => {
    assert.equal(parseShaForFile('', 'x.zip'), null);
    assert.equal(parseShaForFile('not-a-sha-line', 'x.zip'), null);
  });

  it('should not match a filename that is a prefix of another', () => {
    const body = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  node-v22.20.0-win-x64.zip.extra\n';
    assert.equal(parseShaForFile(body, 'node-v22.20.0-win-x64.zip'), null);
  });
});

// ─── nodeDistInfo ────────────────────────────────────────────────────────────

describe('nodeDistInfo', () => {
  it('should build a plausible distribution filename for the current platform', () => {
    const info = nodeDistInfo('v22.20.0');
    assert.equal(info.distName, `node-v22.20.0-${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${info.distName.split('-').pop()}`);
    assert.equal(info.ext, process.platform === 'win32' ? 'zip' : 'tar.gz');
    assert.equal(info.fileName, `${info.distName}.${info.ext}`);
  });
});

// ─── writeShim ───────────────────────────────────────────────────────────────

describe('writeShim', () => {
  function withTmpDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-shim-'));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('should quote node + binEntry paths (spaces / CJK usernames safe)', () => {
    withTmpDir((dir) => {
      const nodeBin = path.join(dir, 'path with space', 'node');
      const binEntry = path.join(dir, 'path with space', 'bin.js');
      const shimPath = writeShim(dir, 'dsh', nodeBin, binEntry);
      const content = fs.readFileSync(shimPath, 'utf8');
      assert.ok(content.includes(`"${nodeBin}"`), 'node path must be quoted');
      assert.ok(content.includes(`"${binEntry}"`), 'binEntry path must be quoted');
    });
  });

  if (process.platform === 'win32') {
    it('should write a .cmd shim that forwards args via %*', () => {
      withTmpDir((dir) => {
        const shimPath = writeShim(dir, 'dsh', 'C:\\n\\node.exe', 'C:\\n\\bin.js');
        assert.ok(shimPath.endsWith('dsh.cmd'), `expected .cmd on Windows, got ${shimPath}`);
        const content = fs.readFileSync(shimPath, 'utf8');
        assert.match(content, /@echo off/);
        assert.match(content, /%\*/, 'must forward args with %*');
      });
    });
  } else {
    it('should write an executable sh shim that forwards args via "$@"', () => {
      withTmpDir((dir) => {
        const shimPath = writeShim(dir, 'dsh', '/usr/bin/node', '/n/bin.js');
        assert.equal(path.basename(shimPath), 'dsh');
        const content = fs.readFileSync(shimPath, 'utf8');
        assert.match(content, /^#!/, 'must start with a shebang');
        assert.match(content, /"\$@"/, 'must forward args with "$@"');
        const mode = fs.statSync(shimPath).mode & 0o777;
        assert.equal(mode, 0o755, 'shim must be chmod 755');
      });
    });
  }
});

// ─── probeHostNode (child-process probe, never process.version) ──────────────

describe('probeHostNode', () => {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';

  it('should return null when no node is on PATH, regardless of process.version', () => {
    // THE desktop scenario: the daemon runs under ELECTRON_RUN_AS_NODE with an
    // embedded Node (process.version says v22+), but the HOST has no node/npm.
    // probeHostNode must spawn a child against the host PATH — so with PATH
    // stripped it returns null even though process.version is high. This is the
    // whole reason we never read process.version.
    assert.match(process.version, /^v\d+\./, 'sanity: the test runner has a process.version');
    const savedPath = process.env[pathKey];
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-nopath-'));
    try {
      process.env[pathKey] = emptyDir; // node/npm not resolvable
      const events: InstallEvent[] = [];
      const result = probeHostNode(22, (e) => events.push(e));
      assert.equal(result, null, 'must fall back to portable Node when the host has none');
      assert.ok(events.some((e) => e.type === 'log'), 'should log why it fell back');
    } finally {
      if (savedPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = savedPath;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('should reject a host Node below the required major', () => {
    // minMajor=999 is impossible for any real node → the child-process probe
    // reports the true host version as too old (proving it reads the child's
    // `node --version`, not a hard-coded pass).
    const events: InstallEvent[] = [];
    const result = probeHostNode(999, (e) => events.push(e));
    assert.equal(result, null);
  });

  it('should return nodeBin + version when the host Node satisfies the minimum', (t) => {
    // Only meaningful on a machine that actually has node on PATH (CI + dev do).
    const events: InstallEvent[] = [];
    const result = probeHostNode(1, (e) => events.push(e));
    if (result === null) {
      t.skip('host has no node on PATH — nothing to assert');
      return;
    }
    assert.match(result.version, /^v\d+\./);
    assert.ok(fs.existsSync(result.nodeBin), 'nodeBin must be an existing absolute path');
  });
});

// ─── ensureManagedNode (mirror fallback + sha256 + atomic swap) ──────────────

describe('ensureManagedNode', () => {
  const version = 'v22.20.0';
  const { fileName, distName } = nodeDistInfo(version);
  const archive = Buffer.from('fake-node-distribution-archive-bytes');
  const goodSha = createHash('sha256').update(archive).digest('hex');
  const badSha = 'f'.repeat(64);

  function makeSource(mirrors: string[]): NpmJsInstallSource {
    return {
      type: 'npm-js',
      pkgName: '@deepseek-ai/dsh',
      version: '0.2.0-rc.2',
      binEntry: 'lib/bin.js',
      registries: ['https://registry.npmmirror.com'],
      minNodeMajor: 22,
      managedNode: { version, mirrors },
    };
  }

  /** Fake extract that lays down a minimal valid portable-Node tree. */
  async function fakeExtract(_archive: Buffer, _ext: 'zip' | 'tar.gz', stagingDir: string): Promise<void> {
    const innerDir = path.join(stagingDir, distName);
    fs.mkdirSync(path.dirname(managedNodeBin(innerDir)), { recursive: true });
    fs.writeFileSync(managedNodeBin(innerDir), 'fake-node');
    fs.mkdirSync(path.dirname(managedNpmCli(innerDir)), { recursive: true });
    fs.writeFileSync(managedNpmCli(innerDir), 'fake-npm-cli');
  }

  /** Run fn with HOME/USERPROFILE pointed at a throwaway dir. */
  function withFakeHome(fn: (home: string) => Promise<void>): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-home-'));
    const savedHome = process.env['HOME'];
    const savedProfile = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    return fn(home).finally(() => {
      if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
      if (savedProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = savedProfile;
      fs.rmSync(home, { recursive: true, force: true });
    });
  }

  it('should download, verify, extract and atomically place portable Node', () =>
    withFakeHome(async (home) => {
      const source = makeSource(['https://cdn.npmmirror.com/binaries/node']);
      const urls: string[] = [];
      const deps = {
        download: async (url: string): Promise<Buffer> => {
          urls.push(url);
          if (url.endsWith('SHASUMS256.txt')) return Buffer.from(`${goodSha}  ${fileName}\n`);
          return archive;
        },
        extract: fakeExtract,
      };
      const dir = await ensureManagedNode(source, () => {}, undefined, deps);
      assert.equal(dir, path.join(home, '.molio', 'node', version));
      assert.ok(fs.existsSync(managedNodeBin(dir)), 'node binary must be in place');
      assert.ok(fs.existsSync(managedNpmCli(dir)), 'npm-cli.js must be in place');
      assert.ok(urls.some((u) => u.endsWith(fileName)), 'should fetch the archive');
      assert.ok(urls.some((u) => u.endsWith('SHASUMS256.txt')), 'should fetch SHASUMS256.txt from the same mirror');
    }));

  it('should fall back to the next mirror when the first fails', () =>
    withFakeHome(async (home) => {
      const source = makeSource(['https://broken.example/node', 'https://cdn.npmmirror.com/binaries/node']);
      const hosts: string[] = [];
      const deps = {
        download: async (url: string): Promise<Buffer> => {
          hosts.push(new URL(url).host);
          if (url.includes('broken.example')) throw new Error('HTTP 500');
          if (url.endsWith('SHASUMS256.txt')) return Buffer.from(`${goodSha}  ${fileName}\n`);
          return archive;
        },
        extract: fakeExtract,
      };
      const dir = await ensureManagedNode(source, () => {}, undefined, deps);
      assert.ok(fs.existsSync(managedNodeBin(dir)));
      assert.equal(hosts[0], 'broken.example', 'first mirror tried first');
      assert.ok(hosts.some((h) => h.includes('npmmirror')), 'should fall back to the second mirror');
    }));

  it('should reject a mirror whose sha256 does not match', () =>
    withFakeHome(async (home) => {
      const source = makeSource(['https://badsha.example/node', 'https://cdn.npmmirror.com/binaries/node']);
      const deps = {
        download: async (url: string): Promise<Buffer> => {
          if (url.includes('badsha.example') && url.endsWith('SHASUMS256.txt')) {
            return Buffer.from(`${badSha}  ${fileName}\n`);
          }
          if (url.endsWith('SHASUMS256.txt')) return Buffer.from(`${goodSha}  ${fileName}\n`);
          return archive;
        },
        extract: fakeExtract,
      };
      const dir = await ensureManagedNode(source, () => {}, undefined, deps);
      // Succeeded via the good mirror because the bad-sha mirror was rejected.
      assert.ok(fs.existsSync(managedNodeBin(dir)));
      assert.ok(!fs.existsSync(path.join(home, '.molio', 'node', `${version}.staging`)), 'no leftover staging');
    }));

  it('should throw when every mirror fails', () =>
    withFakeHome(async () => {
      const source = makeSource(['https://a.example/node', 'https://b.example/node']);
      const deps = {
        download: async (): Promise<Buffer> => { throw new Error('network down'); },
        extract: fakeExtract,
      };
      await assert.rejects(
        () => ensureManagedNode(source, () => {}, undefined, deps),
        /All Node\.js mirrors failed/,
      );
    }));

  it('should reuse an existing portable Node without a network hit', () =>
    withFakeHome(async (home) => {
      const dir = path.join(home, '.molio', 'node', version);
      fs.mkdirSync(path.dirname(managedNodeBin(dir)), { recursive: true });
      fs.writeFileSync(managedNodeBin(dir), 'existing-node');
      fs.mkdirSync(path.dirname(managedNpmCli(dir)), { recursive: true });
      fs.writeFileSync(managedNpmCli(dir), 'existing-npm');

      let downloadCalled = false;
      const deps = {
        download: async (): Promise<Buffer> => { downloadCalled = true; return archive; },
        extract: fakeExtract,
      };
      const source = makeSource(['https://cdn.npmmirror.com/binaries/node']);
      const result = await ensureManagedNode(source, () => {}, undefined, deps);
      assert.equal(result, dir);
      assert.equal(downloadCalled, false, 'idempotent: existing install must not re-download');
    }));
});

// ─── installNpmDeps (registry fallback + abort) ──────────────────────────────

describe('installNpmDeps', () => {
  // A runner that shells out to the real node, running an inline script that
  // exits non-zero for a registry whose host contains "bad".
  const script =
    'const a=process.argv;const i=a.indexOf("--registry");const reg=i>=0?a[i+1]:"";' +
    'if(reg.includes("bad")){process.stderr.write("npm ERR! 404 Not Found");process.exit(1);}process.exit(0);';
  const runner = { cmd: process.execPath, baseArgs: ['-e', script], shell: false };
  const flags = ['--no-save', '--no-package-lock'];

  function withTmpCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-npm-'));
    return fn(cwd).finally(() => fs.rmSync(cwd, { recursive: true, force: true }));
  }

  it('should fall back to the next registry when the first fails', () =>
    withTmpCwd(async (cwd) => {
      const events: InstallEvent[] = [];
      const res = await installNpmDeps(
        runner,
        ['https://bad.example', 'https://good.example'],
        flags,
        cwd,
        (e) => events.push(e),
      );
      assert.equal(res.installed, true, 'should succeed on the second registry');
      assert.equal(res.aborted, false);
      assert.match(res.lastFailure, /404 Not Found/, 'captures the failing registry stderr');
      assert.ok(events.some((e) => e.type === 'log' && /trying next/i.test(e.message)));
    }));

  it('should report not-installed when every registry fails', () =>
    withTmpCwd(async (cwd) => {
      const res = await installNpmDeps(runner, ['https://bad1.example', 'https://bad2.example'], flags, cwd, () => {});
      assert.equal(res.installed, false);
      assert.equal(res.aborted, false);
    }));

  it('should short-circuit to aborted when the signal is already aborted', () =>
    withTmpCwd(async (cwd) => {
      const ac = new AbortController();
      ac.abort();
      // If it tried to spawn, cmd would be a nonexistent binary — but the
      // aborted check must break before any spawn.
      const res = await installNpmDeps(
        { cmd: 'this-binary-does-not-exist', baseArgs: [], shell: false },
        ['https://good.example'],
        flags,
        cwd,
        () => {},
        ac.signal,
      );
      assert.equal(res.aborted, true);
      assert.equal(res.installed, false);
    }));

  it('should kill the npm child and report aborted when cancelled mid-install', () =>
    withTmpCwd(async (cwd) => {
      const slowRunner = {
        cmd: process.execPath,
        baseArgs: ['-e', 'setTimeout(()=>{},30000)'],
        shell: false,
      };
      const ac = new AbortController();
      const started = Date.now();
      const promise = installNpmDeps(slowRunner, ['https://good.example'], flags, cwd, () => {}, ac.signal);
      setTimeout(() => ac.abort(), 300);
      const res = await promise;
      assert.equal(res.aborted, true, 'abort must propagate');
      assert.equal(res.installed, false);
      assert.ok(Date.now() - started < 5000, 'should not wait for the 30s child — abort kills it');
    }));
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

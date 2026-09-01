import type { RuntimeAgentDef } from '@molio/contracts';

export const codexAgentDef: RuntimeAgentDef = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  versionArgs: ['--version'],

  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'o3', label: 'o3' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
  ],

  buildArgs: (_prompt, options = {}, runtimeContext = {}) => {
    const needsDanger = process.platform === 'win32'
      || !!process.env['WSL_DISTRO_NAME'];
    const args = needsDanger
      ? ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access']
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write'];

    if (runtimeContext.cwd) {
      args.push('-C', runtimeContext.cwd);
    }
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },

  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'codex',

  install: {
    source: {
      type: 'npm-native',
      // Install the latest Codex CLI at install time (dist-tags.latest).
      // fallbackVersion: last manually verified good version — bump on release.
      version: 'latest',
      fallbackVersion: '0.149.0',
      // Unlike Claude Code (separate per-platform packages), Codex publishes
      // platform builds as version-suffixed variants of ONE package:
      // @openai/codex@0.149.0-win32-x64 → codex-0.149.0-win32-x64.tgz.
      // Each tarball contains a full vendor tree (binary + rg/sandbox/zsh
      // helpers resolved relative to it), so the whole tree is extracted.
      // Linux builds are static musl — they run on glibc too, so both
      // linux-* platform keys map to the same tarball.
      packages: {
        'win32-x64': {
          pkgName: '@openai/codex',
          binInTar: 'package/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
          tarballVersion: '{version}-win32-x64',
          extractDir: 'package/vendor/x86_64-pc-windows-msvc/',
        },
        'win32-arm64': {
          pkgName: '@openai/codex',
          binInTar: 'package/vendor/aarch64-pc-windows-msvc/bin/codex.exe',
          tarballVersion: '{version}-win32-arm64',
          extractDir: 'package/vendor/aarch64-pc-windows-msvc/',
        },
        'darwin-arm64': {
          pkgName: '@openai/codex',
          binInTar: 'package/vendor/aarch64-apple-darwin/bin/codex',
          tarballVersion: '{version}-darwin-arm64',
          extractDir: 'package/vendor/aarch64-apple-darwin/',
        },
        'darwin-x64': {
          pkgName: '@openai/codex',
          binInTar: 'package/vendor/x86_64-apple-darwin/bin/codex',
          tarballVersion: '{version}-darwin-x64',
          extractDir: 'package/vendor/x86_64-apple-darwin/',
        },
        'linux-x64': {
          pkgName: '@openai/codex',
          binInTar: 'package/vendor/x86_64-unknown-linux-musl/bin/codex',
          tarballVersion: '{version}-linux-x64',
          extractDir: 'package/vendor/x86_64-unknown-linux-musl/',
        },
        'linux-x64-musl': {
          pkgName: '@openai/codex',
          binInTar: 'package/vendor/x86_64-unknown-linux-musl/bin/codex',
          tarballVersion: '{version}-linux-x64',
          extractDir: 'package/vendor/x86_64-unknown-linux-musl/',
        },
        'linux-arm64': {
          pkgName: '@openai/codex',
          binInTar: 'package/vendor/aarch64-unknown-linux-musl/bin/codex',
          tarballVersion: '{version}-linux-arm64',
          extractDir: 'package/vendor/aarch64-unknown-linux-musl/',
        },
        'linux-arm64-musl': {
          pkgName: '@openai/codex',
          binInTar: 'package/vendor/aarch64-unknown-linux-musl/bin/codex',
          tarballVersion: '{version}-linux-arm64',
          extractDir: 'package/vendor/aarch64-unknown-linux-musl/',
        },
      },
      // Mirror-first: Molio's user base is primarily in China, where direct
      // downloads from registry.npmjs.org are slow; npmmirror is the fallback
      // mirror. Official registry stays as the last-resort fallback.
      registries: [
        'https://registry.npmmirror.com',
        'https://registry.npmjs.org',
      ],
    },
    requirements: {
      minWindowsBuild: 17763,
    },
  },
  installUrl: 'https://github.com/openai/codex',
};

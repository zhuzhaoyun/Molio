import type { RuntimeAgentDef } from '@molio/contracts';

export const claudeAgentDef: RuntimeAgentDef = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  fallbackBins: ['openclaude'],
  versionArgs: ['--version'],

  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'sonnet', label: 'Sonnet (alias)' },
    { id: 'opus', label: 'Opus (alias)' },
    { id: 'haiku', label: 'Haiku (alias)' },
    { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
    { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
  ],

  buildArgs: (_prompt, options = {}) => {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    args.push('--dangerously-skip-permissions');
    return args;
  },

  promptViaStdin: true,
  promptInputFormat: 'stream-json',
  streamFormat: 'claude-stream-json',
  multiTurn: true,

  install: {
    source: {
      type: 'npm-native',
      // Install the latest Claude Code at install time (dist-tags.latest).
      // fallbackVersion: last manually verified good version — bump on release.
      version: 'latest',
      fallbackVersion: '2.1.235',
      packages: {
        'win32-x64':        { pkgName: '@anthropic-ai/claude-code-win32-x64',       binInTar: 'package/claude.exe' },
        'win32-arm64':      { pkgName: '@anthropic-ai/claude-code-win32-arm64',     binInTar: 'package/claude.exe' },
        'darwin-arm64':     { pkgName: '@anthropic-ai/claude-code-darwin-arm64',    binInTar: 'package/claude' },
        'darwin-x64':       { pkgName: '@anthropic-ai/claude-code-darwin-x64',      binInTar: 'package/claude' },
        'linux-x64':        { pkgName: '@anthropic-ai/claude-code-linux-x64',       binInTar: 'package/claude' },
        'linux-arm64':      { pkgName: '@anthropic-ai/claude-code-linux-arm64',     binInTar: 'package/claude' },
        'linux-x64-musl':   { pkgName: '@anthropic-ai/claude-code-linux-x64-musl',  binInTar: 'package/claude' },
        'linux-arm64-musl': { pkgName: '@anthropic-ai/claude-code-linux-arm64-musl', binInTar: 'package/claude' },
      },
      registries: [
        'https://registry.npmjs.org',
        'https://registry.npmmirror.com',
      ],
    },
    requirements: {
      minWindowsBuild: 17763,
    },
  },
  installUrl: 'https://code.claude.com/docs/en/setup',
};

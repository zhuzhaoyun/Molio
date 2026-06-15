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
    args.push('--permission-mode', 'acceptEdits');
    // Pre-approve autonomous operation tools — but NOT AskUserQuestion,
    // which must remain interactive so the user can respond.
    args.push('--allowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch');
    return args;
  },

  promptViaStdin: true,
  promptInputFormat: 'stream-json',
  streamFormat: 'claude-stream-json',
  multiTurn: true,

  installable: true,
  installUrl: 'https://code.claude.com/docs/en/setup',
};

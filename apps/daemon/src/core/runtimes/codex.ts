import type { RuntimeAgentDef } from '@kge/contracts';

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

  installUrl: 'https://github.com/openai/codex',
};

import type { RuntimeAgentDef } from '@molio/contracts';

export const qwenAgentDef: RuntimeAgentDef = {
  id: 'qwen',
  name: 'Qwen Code',
  bin: 'qwen',
  versionArgs: ['--version'],

  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'qwen-max', label: 'Qwen Max' },
    { id: 'qwen-plus', label: 'Qwen Plus' },
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
    return args;
  },

  promptViaStdin: true,
  promptInputFormat: 'stream-json',
  streamFormat: 'claude-stream-json',
  multiTurn: true,

  installUrl: 'https://github.com/QwenLM/qwen-code',
};

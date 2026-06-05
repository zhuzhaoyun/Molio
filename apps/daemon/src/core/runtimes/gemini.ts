import type { RuntimeAgentDef } from '@molio/contracts';

export const geminiAgentDef: RuntimeAgentDef = {
  id: 'gemini',
  name: 'Gemini CLI',
  bin: 'gemini',
  versionArgs: ['--version'],

  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],

  buildArgs: (_prompt, options = {}) => {
    const args: string[] = [];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },

  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'gemini',

  installUrl: 'https://github.com/google-gemini/gemini-cli',
};

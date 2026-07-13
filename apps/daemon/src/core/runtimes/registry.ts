import type { RuntimeAgentDef } from '@molio/contracts';
import { claudeAgentDef } from './claude.js';
import { codexAgentDef } from './codex.js';
import { geminiAgentDef } from './gemini.js';
import { qwenAgentDef } from './qwen.js';
import { hermesAgentDef } from './hermes.js';

const AGENT_DEFS: RuntimeAgentDef[] = [
  claudeAgentDef,
  codexAgentDef,
  geminiAgentDef,
  qwenAgentDef,
  hermesAgentDef,
];

const ids = new Set<string>();
for (const def of AGENT_DEFS) {
  if (ids.has(def.id)) throw new Error(`Duplicate agent def: ${def.id}`);
  ids.add(def.id);
}

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((d) => d.id === id) ?? null;
}

export function listAgentDefs(): RuntimeAgentDef[] {
  return AGENT_DEFS;
}

import type Database from 'better-sqlite3';
import { getVaultByPath } from '../db.js';
import { WEIXIN_SYS_PROMPT_FILE } from '../wiki-prompts.js';

/**
 * Resolve the weixin-specific wiki system-prompt file for a fresh spawn.
 *
 * The shared `ChannelDispatcher` takes a `wikiPromptFileFor` resolver in its
 * deps so it stays channel-agnostic; weixin injects this function (feishu will
 * inject its own pointing at `FEISHU_SYS_PROMPT_FILE`).
 *
 * Pure function of (db, cwd) — called at spawn time so the prompt is always
 * derived from the live cwd, never frozen at queue time. This is the single
 * place that decides whether a weixin run carries the wiki frame.
 */
export function wikiPromptFileFor(
  db: Database.Database | undefined,
  cwd: string | undefined,
): string | undefined {
  if (!db || !cwd) return undefined;
  const vault = getVaultByPath(db, cwd);
  return vault ? WEIXIN_SYS_PROMPT_FILE : undefined;
}

// Re-export the shared dispatcher + types so existing callers can keep
// importing from 'weixin/dispatcher'. New code should import from
// 'core/channels/dispatcher' directly.
export {
  ChannelDispatcher as WeixinRunDispatcher,
  type ChannelDispatcherDeps as DispatchDeps,
  type DispatchRequest,
} from '../channels/dispatcher.js';

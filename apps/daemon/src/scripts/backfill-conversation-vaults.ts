import type Database from 'better-sqlite3';

/**
 * One-time backfill for conversations.vault_id on pre-existing data.
 *
 * Conservative: the vault for a conversation was originally resolved from the
 * run's `cwd` at creation time (run-starter.ts → getVaultByPath). That cwd is
 * NOT persisted on the conversation or in the run's events.jsonl, so it cannot
 * be reliably reconstructed for historical rows. This script therefore:
 *   1. Leaves vault_id NULL where it cannot be determined (the common case).
 *   2. Is a safe, idempotent framework — re-running never throws and never
 *      overwrites an already-set vault_id.
 *
 * Users filter NULL vault rows via the "未关联知识库" filter option.
 *
 * CLI: `pnpm tsx scripts/backfill-conversation-vaults.ts` (root wrapper).
 */
export function backfillConversationVaults(db: Database.Database): void {
  // No reliable source to infer from today. Intentionally a no-op body that
  // guards against future partial inference logic being added unguarded:
  // never overwrite an existing non-null vault_id.
  const rows = db.prepare(
    "SELECT id FROM conversations WHERE vault_id IS NULL AND channel_type = 'desktop'"
  ).all() as Array<{ id: string }>;
  // Nothing to write — keep NULL. The loop exists so a future inference step
  // can be inserted here without changing the call sites.
  for (const row of rows) {
    // future: if a reliable cwd source is found, resolve vault and UPDATE here.
    void row.id;
  }
}
/**
 * Pure translation layer for the history page vault filter.
 *
 * The dropdown value `'__current__'` means "this vault + unassociated channel
 * chats" — the multi-window default scope. Splitting this out of the React
 * hook keeps the query mapping unit-testable without a renderer.
 */

export type VaultFilterValue = '' | '__current__' | '__none__' | (string & {});

/** Default scope for the history page: the window's vault when one is active. */
export function initialVaultFilter(currentVaultId: string | null): VaultFilterValue {
  return currentVaultId ? '__current__' : '';
}

export interface HistoryListQuery {
  vaultId?: string;
  includeUnassociated?: boolean;
  query?: string;
  before?: number;
  limit?: number;
}

/** Map the dropdown value + search text onto the daemon ListHistoryQuery. */
export function buildListQuery(
  f: { vaultFilter: VaultFilterValue; query: string },
  currentVaultId: string | null,
  before?: number | null,
): HistoryListQuery {
  const q: HistoryListQuery = { limit: 50 };
  if (f.vaultFilter === '__current__') {
    // No active vault → "this vault" is meaningless; show everything instead.
    if (currentVaultId) {
      q.vaultId = currentVaultId;
      q.includeUnassociated = true;
    }
  } else if (f.vaultFilter === '__none__') {
    q.vaultId = '__none__';
  } else if (f.vaultFilter) {
    q.vaultId = f.vaultFilter;
  }
  const trimmed = f.query.trim();
  if (trimmed) q.query = trimmed;
  if (before != null) q.before = before;
  return q;
}

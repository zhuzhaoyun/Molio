import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialVaultFilter, buildListQuery } from './historyFilterQuery.ts';

describe('initialVaultFilter', () => {
  it('scopes to current vault when one is active', () => {
    assert.equal(initialVaultFilter('vault-1'), '__current__');
  });

  it('falls back to all conversations without an active vault', () => {
    assert.equal(initialVaultFilter(null), '');
  });
});

describe('buildListQuery', () => {
  it("'__current__' → vaultId + includeUnassociated", () => {
    const q = buildListQuery({ vaultFilter: '__current__', query: '' }, 'vault-1');
    assert.deepEqual(q, { limit: 50, vaultId: 'vault-1', includeUnassociated: true });
  });

  it("'__current__' without active vault → all conversations", () => {
    const q = buildListQuery({ vaultFilter: '__current__', query: '' }, null);
    assert.deepEqual(q, { limit: 50 });
  });

  it("'' → all conversations", () => {
    assert.deepEqual(buildListQuery({ vaultFilter: '', query: '' }, 'vault-1'), { limit: 50 });
  });

  it("'__none__' → only unassociated, no includeUnassociated flag", () => {
    assert.deepEqual(buildListQuery({ vaultFilter: '__none__', query: '' }, 'vault-1'), {
      limit: 50,
      vaultId: '__none__',
    });
  });

  it('concrete vault id → strict vault filter', () => {
    assert.deepEqual(buildListQuery({ vaultFilter: 'vault-2', query: '' }, 'vault-1'), {
      limit: 50,
      vaultId: 'vault-2',
    });
  });

  it('query is trimmed and passed; before cursor passes through', () => {
    const q = buildListQuery({ vaultFilter: '__current__', query: '  随笔  ' }, 'vault-1', 1234);
    assert.deepEqual(q, {
      limit: 50,
      vaultId: 'vault-1',
      includeUnassociated: true,
      query: '随笔',
      before: 1234,
    });
  });
});

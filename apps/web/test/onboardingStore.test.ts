import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  seed(k: string, v: string) { this.m.set(k, v); }
}

(globalThis as Record<string, unknown>).localStorage = new MemStorage();

const { createOnboardingStore } = await import('../src/stores/onboardingStore.ts');
const KEY = 'molio.onboarding.v1';
const storage = (globalThis as Record<string, unknown>).localStorage as MemStorage;

describe('onboardingStore', () => {
  beforeEach(() => storage.clear());

  it('activates only when the key is absent and there are zero vaults', () => {
    const s = createOnboardingStore(storage);
    s.init(0);
    assert.equal(s.getState()?.status, 'active');
    assert.deepEqual(s.getState()?.steps, { vault: false, openOrImport: false, ask: false });
  });

  it('marks an existing-vault user as done immediately', () => {
    const s = createOnboardingStore(storage);
    s.init(3);
    assert.equal(s.getState()?.status, 'done');
    assert.deepEqual(s.getState()?.steps, { vault: true, openOrImport: true, ask: true });
  });

  it('does not re-initialize once a state exists', () => {
    storage.seed(KEY, JSON.stringify({
      status: 'dismissed',
      steps: { vault: false, openOrImport: false, ask: false },
      startedAt: 1,
    }));
    const s = createOnboardingStore(storage);
    s.init(0);
    assert.equal(s.getState()?.status, 'dismissed');
  });

  it('treats malformed JSON as absent and falls back to vault count', () => {
    storage.seed(KEY, '{not json');
    const s = createOnboardingStore(storage);
    s.init(2);
    assert.equal(s.getState()?.status, 'done');
  });

  it('treats an unknown status as absent', () => {
    storage.seed(KEY, JSON.stringify({ status: 'later', steps: {}, startedAt: 1 }));
    const s = createOnboardingStore(storage);
    s.init(0);
    assert.equal(s.getState()?.status, 'active');
  });

  it('advances steps forward only and completes after all three', () => {
    const s = createOnboardingStore(storage);
    s.init(0);
    s.markVault();
    s.markVault();
    assert.equal(s.getState()?.steps.vault, true);
    s.markOpenOrImport();
    assert.equal(s.getState()?.status, 'active');
    s.markAsk();
    assert.equal(s.getState()?.status, 'done');
    assert.deepEqual(s.getState()?.steps, { vault: true, openOrImport: true, ask: true });
  });

  it('ignores step marks once done or dismissed', () => {
    const s = createOnboardingStore(storage);
    s.init(1);
    s.markAsk();
    assert.equal(s.getState()?.status, 'done');
    s.dismiss();
    assert.equal(s.getState()?.status, 'done', 'done must not become dismissed');
  });

  it('dismiss persists and survives a fresh store instance', () => {
    const s = createOnboardingStore(storage);
    s.init(0);
    s.dismiss();
    const reopened = createOnboardingStore(storage);
    assert.equal(reopened.getState()?.status, 'dismissed');
  });

  it('persists progress across a fresh store instance', () => {
    const s = createOnboardingStore(storage);
    s.init(0);
    s.markVault();
    s.markOpenOrImport();
    const reopened = createOnboardingStore(storage);
    assert.deepEqual(reopened.getState()?.steps, { vault: true, openOrImport: true, ask: false });
    assert.equal(reopened.getState()?.status, 'active');
  });

  it('notifies subscribers on every state change', () => {
    const s = createOnboardingStore(storage);
    let n = 0;
    const un = s.subscribe(() => { n += 1; });
    s.init(0);
    s.markVault();
    s.markVault();
    s.dismiss();
    un();
    s.markAsk();
    assert.equal(n, 3);
  });
});

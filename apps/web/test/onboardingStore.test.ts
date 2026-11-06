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
    assert.deepEqual(s.getState()?.steps, {
      vault: false,
      openOrImport: false,
      import: false,
      ask: false,
      save: false,
    });
  });

  it('marks an existing-vault user as done immediately', () => {
    const s = createOnboardingStore(storage);
    s.init(3);
    assert.equal(s.getState()?.status, 'done');
    assert.deepEqual(s.getState()?.steps, {
      vault: true,
      openOrImport: true,
      import: true,
      ask: true,
      save: true,
    });
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

  it('advances steps forward only and completes after all five', () => {
    const s = createOnboardingStore(storage);
    s.init(0);
    s.markVault();
    s.markVault();
    assert.equal(s.getState()?.steps.vault, true);
    s.markOpenOrImport();
    s.markImport();
    assert.equal(s.getState()?.status, 'active', 'needs a question and a save-back too');
    s.markAsk();
    assert.equal(s.getState()?.status, 'active', 'needs the save-back milestone too');
    s.markSave();
    assert.equal(s.getState()?.status, 'done');
    assert.deepEqual(s.getState()?.steps, {
      vault: true,
      openOrImport: true,
      import: true,
      ask: true,
      save: true,
    });
  });

  it('treats a stored three-step state as missing the new steps', () => {
    storage.seed(KEY, JSON.stringify({
      status: 'active',
      steps: { vault: true, openOrImport: true, ask: false },
      startedAt: 1,
    }));
    const s = createOnboardingStore(storage);
    assert.deepEqual(s.getState()?.steps, {
      vault: true,
      openOrImport: true,
      import: false,
      ask: false,
      save: false,
    });
    assert.equal(s.getState()?.mapDismissed, true, 'old states must not pop a map unprompted');
  });

  it('normalizes a completed state so every step reads as done', () => {
    storage.seed(KEY, JSON.stringify({
      status: 'done',
      steps: { vault: true, openOrImport: true, ask: true },
      startedAt: 1,
    }));
    const s = createOnboardingStore(storage);
    assert.deepEqual(s.getState()?.steps, {
      vault: true,
      openOrImport: true,
      import: true,
      ask: true,
      save: true,
    });
  });

  it('replays the checklist instead of the map when an existing library opens the guide', () => {
    const s = createOnboardingStore(storage);
    s.init(1); // an install that never ran the guide still has a library
    assert.equal(s.getState()?.status, 'done');
    assert.equal(s.getState()?.mapDismissed, true, 'upgrades must stay quiet until asked');

    s.openGuide(true);

    // 「上手引导」是来学的，不是来被告知已经学完的：从第 2 步开始重走，
    // 库步骤沿用既成事实，其余进度清零（只动引导状态，不碰库内容）。
    assert.equal(s.getState()?.status, 'active');
    assert.deepEqual(s.getState()?.steps, {
      vault: true,
      openOrImport: false,
      import: false,
      ask: false,
      save: false,
    });
    assert.equal(s.getState()?.mapDismissed, true);
  });

  it('reopens the completion map without touching guide progress', () => {
    const s = createOnboardingStore(storage);
    s.init(1);
    s.showMap();
    assert.equal(s.getState()?.status, 'done');
    assert.equal(s.getState()?.mapDismissed, false);
    assert.equal(s.getState()?.steps.save, true, 'showing the map must not reset anything');
  });

  it('reveals the map to an in-progress guide migrated from the old shape', () => {
    storage.seed(KEY, JSON.stringify({
      status: 'active',
      steps: { vault: true, openOrImport: true, ask: true },
      startedAt: 1,
    }));
    const s = createOnboardingStore(storage);
    // old state: import/save missing; ask already done
    s.markImport();
    s.markSave();
    assert.equal(s.getState()?.status, 'done');
    assert.equal(s.getState()?.mapDismissed, false, 'finishing the guide must reveal the map');
  });

  it('shows the completion map right after the last step and remembers dismissal', () => {
    const s = createOnboardingStore(storage);
    s.init(0);
    s.markVault();
    s.markOpenOrImport();
    s.markImport();
    s.markAsk();
    s.markSave();
    assert.equal(s.getState()?.status, 'done');
    assert.equal(s.getState()?.mapDismissed, false, 'finishing the guide shows the map once');
    s.dismissMap();
    assert.equal(s.getState()?.mapDismissed, true);
    const reopened = createOnboardingStore(storage);
    assert.equal(reopened.getState()?.mapDismissed, true, 'dismissal survives reload');
    reopened.showMap();
    assert.equal(reopened.getState()?.mapDismissed, false);
    assert.equal(reopened.getState()?.status, 'done');
  });

  it('opening the guide on a dismissed checklist resumes from the steps already done', () => {
    const s = createOnboardingStore(storage);
    s.init(0);
    s.markVault();
    s.markOpenOrImport();
    s.dismiss();
    const reopened = createOnboardingStore(storage);
    reopened.openGuide(true);
    assert.equal(reopened.getState()?.status, 'active');
    assert.equal(reopened.getState()?.steps.vault, true);
    assert.equal(reopened.getState()?.steps.openOrImport, true);
  });

  it('starts the same fresh flow when the install has no library', () => {
    const s = createOnboardingStore(storage);
    s.init(2);
    s.openGuide(false);
    assert.equal(s.getState()?.status, 'active');
    assert.deepEqual(s.getState()?.steps, {
      vault: false,
      openOrImport: false,
      import: false,
      ask: false,
      save: false,
    });
  });

  it('never resets progress when an existing library opens the guide', () => {
    storage.seed(KEY, JSON.stringify({
      status: 'dismissed',
      steps: { vault: false, openOrImport: true, import: true, ask: true, save: false },
      mapDismissed: true,
      startedAt: 1,
    }));
    const s = createOnboardingStore(storage);
    s.openGuide(true);
    assert.equal(s.getState()?.status, 'active', 'resumes instead of restarting');
    assert.deepEqual(s.getState()?.steps, {
      vault: true, // having a library is a fact; the guide must not ask to create one
      openOrImport: true,
      import: true,
      ask: true,
      save: false,
    });
  });

  it('does not invent a guide when the library state is unknown and no state exists', () => {
    const s = createOnboardingStore(storage);
    s.openGuide(null);
    assert.equal(s.getState(), null);
  });

  it('starts a replay, not a completion map, when a library exists but the key is missing', () => {
    const s = createOnboardingStore(storage);
    s.openGuide(true);
    assert.equal(s.getState()?.status, 'active');
    assert.deepEqual(s.getState()?.steps, {
      vault: true,
      openOrImport: false,
      import: false,
      ask: false,
      save: false,
    });
  });

  it('ignores showMap while the guide is still in progress', () => {
    const s = createOnboardingStore(storage);
    s.init(0);
    s.markVault();
    s.showMap();
    assert.equal(s.getState()?.status, 'active');
    assert.equal(s.getState()?.mapDismissed, false, 'no map exists before completion');
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
    assert.deepEqual(reopened.getState()?.steps, {
      vault: true,
      openOrImport: true,
      import: false,
      ask: false,
      save: false,
    });
    assert.equal(reopened.getState()?.status, 'active');
  });

  it('treats a storage read that throws as absent and keeps working in memory', () => {
    const hostile = {
      getItem(): string | null { throw new Error('SecurityError'); },
      setItem(): void { throw new Error('QuotaExceededError'); },
    };
    const s = createOnboardingStore(hostile);
    assert.equal(s.getState(), null, 'a throwing getItem must not escape the constructor');
    s.init(0);
    assert.equal(s.getState()?.status, 'active', 'setItem failure must not lose in-memory state');
    s.markVault();
    assert.equal(s.getState()?.steps.vault, true);
  });

  it('falls back to noop storage when the localStorage accessor itself throws', async () => {
    const { resolveDefaultStorage } = await import('../src/stores/onboardingStore.ts');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError'); },
    });
    try {
      const fallback = resolveDefaultStorage();
      assert.equal(fallback.getItem('molio.onboarding.v1'), null);
      assert.doesNotThrow(() => fallback.setItem('molio.onboarding.v1', '{}'));
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
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

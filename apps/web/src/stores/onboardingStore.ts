/**
 * First-run activation checklist — localStorage-backed, factory-built so
 * node:test can inject a MemStorage stub (same pattern as kbTabsStore).
 *
 * Activation is intentionally conservative: the banner only ever appears on an
 * install that has never had a vault. Existing users initialize straight to
 * `done`, so upgrades leave zero onboarding traces.
 */

export interface OnboardingSteps {
  vault: boolean;
  openOrImport: boolean;
  import: boolean;
  ask: boolean;
  save: boolean;
}

export interface OnboardingState {
  status: 'active' | 'done' | 'dismissed';
  steps: OnboardingSteps;
  /** The completion map ("what else can I do") collapses to a quiet line. */
  mapDismissed: boolean;
  startedAt: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Listener = () => void;

export const ONBOARDING_STORAGE_KEY = 'molio.onboarding.v1';

export const ONBOARDING_STEP_KEYS = ['vault', 'openOrImport', 'import', 'ask', 'save'] as const;

function allSteps(value: boolean): OnboardingSteps {
  return { vault: value, openOrImport: value, import: value, ask: value, save: value };
}

function freshState(status: OnboardingState['status'], now: () => number): OnboardingState {
  return {
    status,
    steps: allSteps(status === 'done'),
    // Existing installs initialize straight to `done`; they never ran the guide,
    // so the completion map stays collapsed until Help asks for it.
    mapDismissed: status !== 'active',
    startedAt: now(),
  };
}

/**
 * Replay from step 2 for a user who already has a library: having a vault is a
 * fact, so it stays done; the rest resets so the guide actually teaches the
 * loop instead of showing "you already finished". Only guide state changes —
 * no library content is touched.
 */
function replayState(now: () => number): OnboardingState {
  return {
    status: 'active',
    steps: { vault: true, openOrImport: false, import: false, ask: false, save: false },
    mapDismissed: true,
    startedAt: now(),
  };
}

function parseState(raw: string | null, now: () => number): OnboardingState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingState> | null;
    if (!parsed) return null;
    if (parsed.status !== 'active' && parsed.status !== 'done' && parsed.status !== 'dismissed') {
      return null;
    }
    const steps = (parsed.steps ?? {}) as Partial<OnboardingSteps>;
    // States written before the 5-step model lack `import`/`save`; they read as
    // not-done so the checklist continues from real progress. A `done` state is
    // complete by definition, so normalize its steps instead of showing 3/5.
    const complete = parsed.status === 'done';
    return {
      status: parsed.status,
      steps: {
        vault: complete || steps.vault === true,
        openOrImport: complete || steps.openOrImport === true,
        import: complete || steps.import === true,
        ask: complete || steps.ask === true,
        save: complete || steps.save === true,
      },
      // Absent means a state written before the map existed: keep it collapsed
      // rather than surprise existing users with a panel they did not earn yet.
      mapDismissed: parsed.mapDismissed !== false,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : now(),
    };
  } catch {
    return null;
  }
}

function safeGetItem(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    // Storage blocked (Third-party context / SecurityError): behave as "no key".
    return null;
  }
}

export function createOnboardingStore(storage: StorageLike, now: () => number = Date.now) {
  let state: OnboardingState | null = parseState(safeGetItem(storage, ONBOARDING_STORAGE_KEY), now);
  const listeners = new Set<Listener>();

  function emit() {
    for (const listener of listeners) listener();
  }

  function persist(next: OnboardingState) {
    state = next;
    try {
      storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable — keep the in-memory state for this session.
    }
    emit();
  }

  function mark(step: keyof OnboardingSteps) {
    if (!state || state.status !== 'active' || state.steps[step]) return;
    const steps = { ...state.steps, [step]: true };
    const complete = ONBOARDING_STEP_KEYS.every((key) => steps[key]);
    persist({
      ...state,
      steps,
      status: complete ? 'done' : 'active',
      // 完成的那一刻必须看到地图，哪怕这条状态是从旧版迁移来的（旧状态默认收起）。
      mapDismissed: complete ? false : state.mapDismissed,
    });
  }

  return {
    subscribe(callback: Listener) {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },

    getState(): OnboardingState | null {
      return state;
    },

    /** Call once when the vault list has first loaded. Idempotent. */
    init(vaultCount: number) {
      if (state) return;
      persist(freshState(vaultCount === 0 ? 'active' : 'done', now));
    },

    markVault() { mark('vault'); },
    markOpenOrImport() { mark('openOrImport'); },
    markImport() { mark('import'); },
    markAsk() { mark('ask'); },
    markSave() { mark('save'); },

    dismiss() {
      if (!state || state.status !== 'active') return;
      persist({ ...state, status: 'dismissed' });
    },

    /** Collapse the completed feature map; it stays reopenable from Help. */
    dismissMap() {
      if (!state || state.status !== 'done' || state.mapDismissed) return;
      persist({ ...state, mapDismissed: true });
    },

    /**
     * Help → onboarding guide ("上手引导").
     *
     * - `false` (no library yet): restart exactly like a fresh install. The
     *   zero-vault welcome screen is the first step, so there is no existing
     *   content for stale progress to refer to.
     * - `true` (already has a library): open the checklist, never the
     *   completion map — the user clicked the guide to learn. A finished
     *   install replays from step 2; an in-progress install resumes where it
     *   was. The library step stays done because having a vault is a fact.
     *   Only guide state changes: no vault reads/writes, no sample vault.
     * - `null` (library count unavailable): change nothing we cannot justify;
     *   a state that exists is resumed as if it had a library, and a missing
     *   state stays missing.
     */
    openGuide(hasVaults: boolean | null) {
      if (hasVaults === false) {
        persist(freshState('active', now));
        return;
      }
      const current = state;
      if (hasVaults === true && (!current || current.status === 'done')) {
        persist(replayState(now));
        return;
      }
      if (!current) return;
      const steps = hasVaults ? { ...current.steps, vault: true } : current.steps;
      const complete = ONBOARDING_STEP_KEYS.every((key) => steps[key]);
      persist({
        ...current,
        steps,
        status: complete ? 'done' : 'active',
        mapDismissed: complete ? false : current.mapDismissed,
      });
    },

    /** Help → feature map. Only meaningful after the guide is complete. */
    showMap() {
      if (!state || state.status !== 'done' || !state.mapDismissed) return;
      persist({ ...state, mapDismissed: false });
    },
  };
}

const noopStorage: StorageLike = {
  getItem: () => null,
  setItem: () => {},
};

/**
 * Resolve browser storage defensively: in storage-restricted contexts even
 * *reading* the `localStorage` global throws (SecurityError), and this module
 * is imported by App-level code — a throw here would break boot, not just the
 * banner. Probe once and fall back to noop.
 */
export function resolveDefaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') {
      // Probe: merely referencing the global can throw in blocked contexts.
      localStorage.getItem(ONBOARDING_STORAGE_KEY);
      return localStorage;
    }
  } catch {
    // fall through to noop
  }
  return noopStorage;
}

/** Singleton used by the app; node:test builds its own via createOnboardingStore. */
export const onboardingStore = createOnboardingStore(resolveDefaultStorage());

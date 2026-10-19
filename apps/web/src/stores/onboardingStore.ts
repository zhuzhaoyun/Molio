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
  ask: boolean;
}

export interface OnboardingState {
  status: 'active' | 'done' | 'dismissed';
  steps: OnboardingSteps;
  startedAt: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Listener = () => void;

export const ONBOARDING_STORAGE_KEY = 'molio.onboarding.v1';

function freshState(status: OnboardingState['status'], now: () => number): OnboardingState {
  return {
    status,
    steps:
      status === 'done'
        ? { vault: true, openOrImport: true, ask: true }
        : { vault: false, openOrImport: false, ask: false },
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
    return {
      status: parsed.status,
      steps: {
        vault: steps.vault === true,
        openOrImport: steps.openOrImport === true,
        ask: steps.ask === true,
      },
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
    const complete = steps.vault && steps.openOrImport && steps.ask;
    persist({ ...state, steps, status: complete ? 'done' : 'active' });
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
    markAsk() { mark('ask'); },

    dismiss() {
      if (!state || state.status !== 'active') return;
      persist({ ...state, status: 'dismissed' });
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

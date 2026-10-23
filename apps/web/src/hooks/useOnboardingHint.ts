import { useSyncExternalStore } from 'react';
import { onboardingStore } from '../stores/onboardingStore';

/**
 * Which onboarding step's real in-page control should draw attention now.
 *
 * The checklist's own CTA is a fallback, not the thing to teach: once the
 * guide is gone the user is left with the product UI, so the animation must
 * live on the button they will actually use again (import / ask / save).
 *
 * Returns null unless the guide is active, so a dismissed or completed flow
 * never leaves a pulsing control behind.
 */
export type OnboardingHint = 'import' | 'ask' | 'save';

export function useOnboardingHint(): OnboardingHint | null {
  const state = useSyncExternalStore(
    onboardingStore.subscribe,
    onboardingStore.getState,
    onboardingStore.getState,
  );
  if (!state || state.status !== 'active') return null;

  const { openOrImport, import: imported, ask, save } = state.steps;
  if (!openOrImport || !imported) return 'import';
  if (!ask) return 'ask';
  if (!save) return 'save';
  return null;
}

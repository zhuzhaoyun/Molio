/**
 * Renderer readiness gate for `molio://open/...` delivery (desktop main process).
 *
 * `ready` answers exactly one question: *is the SPA mounted in this window, with
 * its `molio:navigate` IPC listener registered?* It picks the delivery strategy
 * for a clip's open-file request:
 *
 *   ready     → in-page IPC + React Router navigation (no reload, no state loss)
 *   not ready → full `loadURL` of the knowledge route (cold start / broken page)
 *
 * Because that fallback destroys the React tree — taking the user's in-flight
 * streaming reply with it — the CLEARING rules are the whole game. Readiness may
 * only be cleared by something that actually destroys the tree: the top-level
 * document being replaced, the window closing, or the renderer process dying.
 *
 * Electron's `did-start-loading` is NOT such a signal: it also fires for
 * same-document SPA navigation (pushState / replaceState / hash) and for
 * subframe loads. Clearing on it marked a perfectly healthy renderer as dead,
 * and since the SPA only re-announces readiness on mount (web `App.tsx`
 * `notifyReady`), the flag never recovered — one in-app route change was enough
 * to make every later clip reload the window mid-stream. Feed
 * `onNavigationStarted()` instead: it ignores those cases.
 *
 * Payload shapes below are the real ones Electron 40 hands to
 * `did-start-navigation` (verified against a live window, not just the typings).
 *
 * Electron-free (same pattern as vault-recency.js): the caller feeds event
 * payloads in, so the state machine is unit-testable without a window.
 */

/**
 * @typedef {{ vaultId: string|null, filePath: string }} NavigationTarget
 * @typedef {{ url: string, isSameDocument: boolean, isMainFrame: boolean }} NavigationStartedDetails
 */

export function createRendererReadiness() {
  /** Map<webContentsId, { ready: boolean, pending: NavigationTarget|null }> */
  const states = new Map();

  return {
    /** Current state, or undefined for a webContents we have never seen. */
    get(id) {
      return states.get(id);
    },

    isReady(id) {
      return states.get(id)?.ready === true;
    },

    /**
     * The SPA mounted and registered its listener. Returns the navigation queued
     * while it was still booting (cold start), or null when nothing is pending —
     * the caller flushes it so a clip that raced the boot still opens its file.
     */
    markReady(id) {
      const pending = states.get(id)?.pending ?? null;
      states.set(id, { ready: true, pending: null });
      return pending;
    },

    /** Renderer not ready yet: remember the intent for markReady() to flush. */
    queue(id, target) {
      states.set(id, { ready: false, pending: { ...target } });
    },

    /** Drop this window's state (closed / renderer gone / superseded by loadURL). */
    forget(id) {
      states.delete(id);
    },

    /**
     * A navigation started (`did-start-navigation` details).
     *
     * Clears readiness only for a real document swap in the top frame — the one
     * case where the React tree, and with it the `molio:navigate` listener, is
     * about to be destroyed. Same-document navigation (pushState / replaceState
     * / hash) and subframe loads leave the SPA alive, so delivery must still
     * take the in-page path. Returns true when readiness was cleared.
     */
    onNavigationStarted(id, details) {
      if (!details || !details.isMainFrame || details.isSameDocument) return false;
      return states.delete(id);
    },
  };
}

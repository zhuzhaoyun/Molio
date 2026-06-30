import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { vaultStore } from '../stores/vaultStore';

export interface NavState {
  route: string;
  state: { openFile: string; vaultId: string };
}

/**
 * Build the navigation target for opening a file.
 * Returns null if vaultId is missing (file navigation impossible).
 *
 * Always navigates to /knowledge with state. The KnowledgeBasePage
 * useEffect already watches location.state.openFile — it opens the file
 * whether arriving fresh or already on the page.
 */
export function buildNavState(
  vaultId: string | null,
  filePath: string,
): NavState | null {
  if (!vaultId) return null;

  return {
    route: '/knowledge',
    state: { openFile: filePath, vaultId },
  };
}

export interface AskAboutState {
  route: string;
  state: { askAboutFile: string; vaultId: string };
}

/**
 * Build the navigation target for "ask about this file".
 * Navigates to home page with file context for a new chat.
 */
export function buildAskAboutState(
  vaultId: string,
  filePath: string,
): AskAboutState {
  return {
    route: '/',
    state: { askAboutFile: filePath, vaultId },
  };
}

/**
 * React hook for file navigation.
 *
 * openFile: navigate to /knowledge with openFile state.
 *   Works regardless of current page — React Router triggers
 *   the KB page's useEffect even when already on /knowledge
 *   because location.state changes.
 *
 * askAboutFile: navigate to / with askAboutFile state.
 *   HomePage can use this to start a new conversation with
 *   file context pre-loaded.
 */
export function useFileNavigation() {
  const navigate = useNavigate();

  const getActiveVaultId = useCallback((): string | null => {
    return vaultStore.getActiveVaultId();
  }, []);

  const openFile = useCallback(
    (vaultId: string, filePath: string) => {
      const nav = buildNavState(vaultId, filePath);
      if (nav) {
        navigate(nav.route, { state: nav.state });
      }
    },
    [navigate],
  );

  const askAboutFile = useCallback(
    (vaultId: string, filePath: string) => {
      const nav = buildAskAboutState(vaultId, filePath);
      navigate(nav.route, { state: nav.state });
    },
    [navigate],
  );

  return { openFile, askAboutFile, getActiveVaultId };
}

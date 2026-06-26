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

/**
 * React hook for file navigation.
 *
 * openFile: navigate to /knowledge with openFile state.
 *   Works regardless of current page — React Router triggers
 *   the KB page's useEffect even when already on /knowledge
 *   because location.state changes.
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

  return { openFile, getActiveVaultId };
}

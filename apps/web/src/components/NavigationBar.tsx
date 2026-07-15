import { useNavigationHistory, navigationHistoryStore } from '../stores/navigationHistoryStore';

export function NavigationBar() {
  const { canGoBack, canGoForward, currentLabel, backLabel, forwardLabel } =
    useNavigationHistory();

  return (
    <div className="nav-topbar" data-testid="nav-topbar">
      <div className="nav-topbar__nav">
        <button
          className="nav-topbar__btn"
          data-testid="nav-back"
          disabled={!canGoBack}
          onClick={() => navigationHistoryStore.back()}
          title={canGoBack ? `后退到：${backLabel}` : undefined}
          aria-label="后退"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          className="nav-topbar__btn"
          data-testid="nav-forward"
          disabled={!canGoForward}
          onClick={() => navigationHistoryStore.forward()}
          title={canGoForward ? `前进到：${forwardLabel}` : undefined}
          aria-label="前进"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
      <div className="nav-topbar__divider" />
      <span className="nav-topbar__breadcrumb">{currentLabel}</span>
    </div>
  );
}

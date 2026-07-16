import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useNavigationHistory, navigationHistoryStore } from '../stores/navigationHistoryStore';

const ROUTE_I18N_KEYS: Record<string, string> = {
  '/': 'nav.home',
  '/knowledge': 'nav.knowledge',
  '/graph': 'nav.graph',
  '/history': 'nav.history',
  '/settings': 'nav.settings',
};

function resolveLabel(rawLabel: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  const i18nKey = ROUTE_I18N_KEYS[rawLabel];
  if (i18nKey) return t(i18nKey);
  return rawLabel;
}

export function NavRail() {
  const { t } = useI18n();
  const { canGoBack, canGoForward, backLabel, forwardLabel } =
    useNavigationHistory();

  const resolvedBack = resolveLabel(backLabel, t);
  const resolvedForward = resolveLabel(forwardLabel, t);

  return (
    <nav className="entry-nav-rail">
      <div className="entry-nav-rail__section">
        {/* Navigation history — back / forward, side by side */}
        <div className="entry-nav-rail__group entry-nav-rail__group--history">
          <button
            className="entry-nav-rail__btn entry-nav-rail__btn--sm"
            data-testid="nav-back"
            disabled={!canGoBack}
            onClick={() => navigationHistoryStore.back()}
            data-tooltip={canGoBack ? t('nav.backTo', { label: resolvedBack }) : undefined}
            aria-label={t('nav.back')}
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
            className="entry-nav-rail__btn entry-nav-rail__btn--sm"
            data-testid="nav-forward"
            disabled={!canGoForward}
            onClick={() => navigationHistoryStore.forward()}
            data-tooltip={canGoForward ? t('nav.forwardTo', { label: resolvedForward }) : undefined}
            aria-label={t('nav.forward')}
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

        <div className="entry-nav-rail__group">
        {/* Home — Create/Chat */}
        <NavLink
          to="/"
          end
          data-view="home"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip={t('nav.home')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </NavLink>

        {/* Knowledge Base */}
        <NavLink
          to="/knowledge"
          data-view="knowledge"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip={t('nav.knowledge')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </NavLink>

        {/* Graph View */}
        <NavLink
          to="/graph"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-view="graph"
          data-tooltip={t('nav.graph')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="6" r="2" />
            <circle cx="12" cy="18" r="2" />
            <line x1="7.5" y1="7.5" x2="10.5" y2="16.5" />
            <line x1="16.5" y1="7.5" x2="13.5" y2="16.5" />
            <line x1="6" y1="8" x2="18" y2="8" />
          </svg>
        </NavLink>

        <div className="entry-nav-rail__divider" />

        {/* History */}
        <NavLink
          to="/history"
          data-view="history"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip={t('nav.history')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <polyline points="3 3 3 9 9 9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </NavLink>
      </div>
      </div>{/* entry-nav-rail__section */}

      {/* Bottom group: Help + Settings */}
      <div className="entry-nav-rail__group">
        {/* Help — external link to online docs */}
        <a
          href="https://molio.cn/help.html"
          target="_blank"
          rel="noopener noreferrer"
          className="entry-nav-rail__btn"
          data-view="help"
          data-tooltip={t('nav.help')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </a>

        <NavLink
          to="/settings"
          data-view="settings"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip={t('nav.settings')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </NavLink>
      </div>
    </nav>
  );
}

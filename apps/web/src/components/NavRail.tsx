import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';

export function NavRail() {
  const { t } = useI18n();

  return (
    <nav className="entry-nav-rail">
      <div className="entry-nav-rail__group">
        {/* Home */}
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

        {/* Runtimes */}
        <NavLink
          to="/runtimes"
          data-view="runtimes"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip={t('nav.runtimes')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </NavLink>

        {/* Channels */}
        <NavLink
          to="/channels"
          data-view="channels"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip={t('nav.channels')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 7h5" />
            <path d="M15 7h5" />
            <path d="M9 7a3 3 0 0 0 6 0" />
            <path d="M4 17h5" />
            <path d="M15 17h5" />
            <path d="M9 17a3 3 0 0 1 6 0" />
            <path d="M12 10v4" />
          </svg>
        </NavLink>
      </div>

      {/* Bottom group: Settings */}
      <div className="entry-nav-rail__group">
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

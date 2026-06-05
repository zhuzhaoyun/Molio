import { NavLink } from 'react-router-dom';

export function NavRail() {
  return (
    <nav className="entry-nav-rail">
      <div className="entry-nav-rail__group">
        {/* Home */}
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip="Home"
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
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip="Knowledge Base"
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

        <div className="entry-nav-rail__divider" />

        {/* Runtimes */}
        <NavLink
          to="/runtimes"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip="Runtimes"
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
      </div>
    </nav>
  );
}

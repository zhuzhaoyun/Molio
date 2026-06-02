interface Props {
  activeView: 'home' | 'knowledge' | 'runtimes';
  onViewChange: (view: 'home' | 'knowledge' | 'runtimes') => void;
}

export function NavRail({ activeView, onViewChange }: Props) {
  return (
    <nav className="entry-nav-rail">
      <div className="entry-nav-rail__group">
        {/* Home */}
        <button
          type="button"
          className={`entry-nav-rail__btn ${activeView === 'home' ? 'is-active' : ''}`}
          onClick={() => onViewChange('home')}
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
        </button>

        {/* Knowledge Base */}
        <button
          type="button"
          className={`entry-nav-rail__btn ${activeView === 'knowledge' ? 'is-active' : ''}`}
          onClick={() => onViewChange('knowledge')}
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
        </button>

        <div className="entry-nav-rail__divider" />

        {/* Runtimes */}
        <button
          type="button"
          className={`entry-nav-rail__btn ${activeView === 'runtimes' ? 'is-active' : ''}`}
          onClick={() => onViewChange('runtimes')}
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
        </button>
      </div>
    </nav>
  );
}

import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useAuthStatus } from '../stores/authStore';
import { loginIntentStore } from '../stores/loginIntentStore';
import { AccountModal } from './account/AccountModal';

export function NavRail() {
  const { t } = useI18n();
  const auth = useAuthStatus();
  const [accountOpen, setAccountOpen] = useState(false);
  /** 登录意图打开时直达 login 视图（资源下载/购买门槛触发） */
  const [accountInitialView, setAccountInitialView] = useState<'main' | 'login'>('main');
  /** 登录成功后要续接的动作（被门槛拦下的下载/购买）；未登录关闭则丢弃 */
  const loginResumeRef = useRef<(() => void) | null>(null);

  // 资源动作请求登录 → 打开账号面板直达登录视图
  useEffect(
    () =>
      loginIntentStore.subscribe(() => {
        if (!loginIntentStore.hasPending()) return;
        loginResumeRef.current = loginIntentStore.consume();
        setAccountInitialView('login');
        setAccountOpen(true);
      }),
    [],
  );

  function closeAccount() {
    setAccountOpen(false);
    loginResumeRef.current = null;
    setAccountInitialView('main');
  }

  return (
    <>
    <nav className="entry-nav-rail">
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

        {/* Resources — knowledge base packs (browse / pay / download) */}
        <NavLink
          to="/resources"
          data-view="resources"
          className={({ isActive }) =>
            `entry-nav-rail__btn ${isActive ? 'is-active' : ''}`
          }
          data-tooltip={t('nav.resources')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.29 7 12 12 20.71 7" />
            <line x1="12" y1="22" x2="12" y2="12" />
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

      {/* Bottom group: Account + Help + Settings */}
      <div className="entry-nav-rail__group">
        {/* Account — 登录态入口（绿点 = 已登录），打开账号面板（设计 §7.4） */}
        <button
          type="button"
          className={`entry-nav-rail__btn ${auth?.loggedIn ? 'is-logged-in' : ''}`}
          data-view="account"
          data-testid="nav-account-btn"
          data-tooltip={t('nav.account')}
          onClick={() => setAccountOpen(true)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          {auth?.loggedIn && <span className="entry-nav-rail__dot" />}
        </button>

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
    <AccountModal
      show={accountOpen}
      onClose={closeAccount}
      initialView={accountInitialView}
      onLoggedIn={() => {
        const resume = loginResumeRef.current;
        loginResumeRef.current = null;
        if (resume) resume();
      }}
    />
    </>
  );
}

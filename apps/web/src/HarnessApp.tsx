import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LanguageProvider } from './i18n/LanguageProvider';
import { useI18n } from './i18n';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { AccountModal } from './components/account/AccountModal';
import { authStore, useAuthStatus } from './stores/authStore';
import { useMarketRole } from './stores/marketRoleStore';
import { loginIntentStore } from './stores/loginIntentStore';
import './styles/harness.css';
import './styles/knowledge.css';
import './styles/graph.css';
import './styles/resources.css';
import './styles/account.css';
import './styles/settings.css';

const Knowledge = lazy(() => import('./components/kb/KnowledgeBasePage').then(m => ({ default: m.KnowledgeBasePage })));
const Market = lazy(() => import('./components/resources/ResourcesPage').then(m => ({ default: m.ResourcesPage })));
const Detail = lazy(() => import('./components/resources/ResourceDetailPage').then(m => ({ default: m.ResourceDetailPage })));
const Account = lazy(() => import('./components/account/AccountPage').then(m => ({ default: m.AccountPage })));

function HarnessRoutes() {
  const { pathname, search } = useLocation();
  const { t } = useI18n();
  const status = useAuthStatus();
  const { role } = useMarketRole();
  const resume = useRef<(() => void) | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  useEffect(() => {
    const refresh = () => { void authStore.refresh(); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => loginIntentStore.subscribe(() => {
    if (!loginIntentStore.hasPending()) return;
    resume.current = loginIntentStore.consume();
    setLoginOpen(true);
  }), []);
  function finishLogin() {
    const action = resume.current;
    resume.current = null;
    setLoginOpen(false);
    action?.();
  }
  useEffect(() => {
    if (loginOpen && status?.loggedIn) finishLogin();
  }, [loginOpen, status?.loggedIn]);

  return (
    <main className="harness-page">
      {(pathname.startsWith('/resources') || pathname === '/me') && (
        <nav className="harness-market-nav">
          {status?.loggedIn && role === 'admin' && (
            <Link to="/knowledge?panel=publish" data-testid="harness-publish-vault">{t('publish.tabTitle')}</Link>
          )}
          <Link to={pathname === '/me' ? '/resources' : '/me'} data-testid="harness-market-account">
            {t(pathname === '/me' ? 'nav.resources' : 'nav.me')}
          </Link>
        </nav>
      )}
      <section className="harness-content">
        <Suspense fallback={null}>
          <Routes>
            <Route path="/knowledge" element={<Knowledge agentId={null} />} />
            <Route path="/resources" element={<Market />} />
            <Route path="/resources/:id" element={<Detail />} />
            <Route path="/me" element={<Account />} />
            <Route path="*" element={<Navigate to={{ pathname: '/knowledge', search }} replace />} />
          </Routes>
        </Suspense>
      </section>
      <AccountModal show={loginOpen} elevated onLoggedIn={finishLogin} onClose={() => {
        resume.current = null;
        setLoginOpen(false);
      }} />
    </main>
  );
}

export default function HarnessApp() {
  return <LanguageProvider><AppErrorBoundary><HarnessRoutes /></AppErrorBoundary></LanguageProvider>;
}

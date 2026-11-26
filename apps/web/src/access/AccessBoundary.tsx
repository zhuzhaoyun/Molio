import { lazy, Suspense, useEffect, useRef, useSyncExternalStore } from 'react';
import { accessController, startAccessRuntime } from './runtime';
import { AdminLoginPage, accessLocale } from '../components/access/AdminLoginPage';
import { translate } from '../i18n';
import '../styles/admin-access.css';
import { isDaemonApiUrl } from '../api/http';

const PrivateApp = lazy(() => import('../App'));
export function AccessBoundary() {
  const state = useSyncExternalStore(accessController.subscribe, accessController.getSnapshot);
  const context = accessController.getContext(); const epoch = useRef<number | null>(null);
  if (context) epoch.current = context.resources.epoch;
  const keepApp = epoch.current !== null && (state.status === 'local' || state.status === 'authenticated' || state.status === 'logging-out');
  const blocked = !context; const t = (key: string) => translate(accessLocale(), key);
  useEffect(startAccessRuntime, []);
  useEffect(() => {
    const failed = (event: Event) => {
      if (event.target instanceof HTMLImageElement && accessController.getContext()?.mode === 'server' && isDaemonApiUrl(event.target.currentSrc || event.target.src)) void accessController.revalidate('asset-error');
    };
    document.addEventListener('error', failed, true);
    return () => document.removeEventListener('error', failed, true);
  }, []);
  if (state.status === 'anonymous') return <AdminLoginPage />;
  return <>
    {keepApp && <div className="admin-private-shell" hidden={blocked} inert={blocked} aria-hidden={blocked || undefined}><Suspense fallback={<p role="status">{t('adminAccess.loading')}</p>}><PrivateApp key={epoch.current} /></Suspense></div>}
    {blocked && <main className="admin-access-page" aria-live="polite"><section className="admin-access-card">
      <p className="admin-access-brand">Molio</p>
      {state.status === 'logging-out' ? <>
        <p data-testid={state.phase === 'unconfirmed' ? 'admin-logout-unconfirmed' : undefined}>{t(state.phase === 'unconfirmed' ? 'adminAccess.logoutUnconfirmed' : 'adminAccess.signingOut')}</p>
        {state.phase === 'unconfirmed' && <div className="admin-access-actions"><button data-testid="admin-logout-retry" onClick={() => { void accessController.logout(); }}>{t('adminAccess.retry')}</button><button data-testid="admin-logout-resume" onClick={() => { void accessController.resumeAfterFailedLogout(); }}>{t('adminAccess.returnToApp')}</button></div>}
      </> : <>
        <p role="status">{t(state.status === 'unavailable' || (state.status === 'authenticated' && state.health === 'unreachable') ? 'adminAccess.unreachable' : 'adminAccess.loading')}</p>
        {(state.status === 'unavailable' || state.status === 'authenticated') && <button data-testid="admin-access-retry" onClick={() => { void accessController.revalidate('focus'); }}>{t('adminAccess.retry')}</button>}
      </>}
    </section></main>}
  </>;
}

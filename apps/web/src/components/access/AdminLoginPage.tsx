import { useEffect, useState } from 'react';
import { translate, type Locale } from '../../i18n';
import { accessController, REASON_KEY } from '../../access/runtime';
import { AdminAccessError } from '../../access/session-controller';

export function accessLocale(): Locale {
  try { return localStorage.getItem('molio.locale') === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}
export function AdminLoginPage() {
  const locale = accessLocale(); const t = (key: string) => translate(locale, key);
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [retryAt, setRetryAt] = useState(0); const [now, setNow] = useState(Date.now);
  const [notice] = useState(() => { try { const reason = sessionStorage.getItem(REASON_KEY); sessionStorage.removeItem(REASON_KEY); return reason === 'signed-out' ? 'adminAccess.signedOut' : reason ? 'adminAccess.expired' : ''; } catch { return ''; } });
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => { if (!retryAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [retryAt]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy || retryAt > Date.now()) return;
    setBusy(true); setError('');
    try { await accessController.login({ username, password }); }
    catch (err) {
      const status = err instanceof AdminAccessError ? err.status : null;
      setError(status === 401 ? 'adminAccess.invalidCredentials' : status === 429 ? 'adminAccess.rateLimited' : status === 403 ? 'adminAccess.forbidden' : 'adminAccess.unreachable');
      setRetryAt(err instanceof AdminAccessError ? err.retryAt ?? 0 : 0); setNow(Date.now());
    } finally { setPassword(''); setBusy(false); }
  }
  return <main className="admin-access-page"><form className="admin-access-card" data-testid="admin-login-form" onSubmit={submit}>
    <p className="admin-access-brand">Molio</p><h1>{t('adminAccess.title')}</h1><p>{t('adminAccess.subtitle')}</p>
    {notice && <p role="status">{t(notice)}</p>}
    <label htmlFor="admin-username">{t('adminAccess.username')}</label><input id="admin-username" data-testid="admin-username-input" autoComplete="username" required maxLength={128} value={username} onChange={e => setUsername(e.target.value)} disabled={busy} />
    <label htmlFor="admin-password">{t('adminAccess.password')}</label><input id="admin-password" data-testid="admin-password-input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} disabled={busy} />
    {error && <p role="alert" data-testid="admin-login-error">{t(error)}{retryAt > now ? ` (${Math.ceil((retryAt - now) / 1000)}s)` : ''}</p>}
    <button type="submit" className="primary" data-testid="admin-login-submit" disabled={busy || retryAt > now}>{t(busy ? 'adminAccess.signingIn' : 'adminAccess.signIn')}</button>
  </form></main>;
}

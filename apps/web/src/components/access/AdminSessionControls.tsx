import { useRef, useState, useSyncExternalStore } from 'react';
import { accessController } from '../../access/runtime';
import { useI18n } from '../../i18n';

export function AdminSessionControls() {
  const state = useSyncExternalStore(accessController.subscribe, accessController.getSnapshot);
  const trigger = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const cancel = () => { setConfirm(false); trigger.current?.focus(); };
  if (state.status !== 'authenticated') return null;
  return <>
    <button type="button" ref={trigger} className="entry-nav-rail__btn admin-logout-btn" data-testid="admin-logout-btn" title={t('adminAccess.signOut')} onClick={() => setConfirm(true)} aria-label={t('adminAccess.signOut')}>↪</button>
    {state.expiresSoon && <div className="admin-expiry-notice" role="status">{t('adminAccess.expiryWarning')}</div>}
    {confirm && <div className="admin-access-overlay"><section className="admin-access-card" role="alertdialog" aria-modal="true" aria-labelledby="admin-exit-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      if (event.key === 'Tab') {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
        const target = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
        if (document.activeElement === target) { event.preventDefault(); (event.shiftKey ? buttons[buttons.length - 1] : buttons[0]).focus(); }
      }
    }}>
      <h2 id="admin-exit-title">{t('adminAccess.signOut')}</h2><p>{t('adminAccess.unsavedWarning')}</p>
      <div className="admin-access-actions"><button type="button" data-testid="admin-logout-cancel" onClick={cancel} autoFocus>{t('adminAccess.cancel')}</button><button type="button" data-testid="admin-logout-confirm" onClick={() => { void accessController.logout(); }}>{t('adminAccess.confirmSignOut')}</button></div>
    </section></div>}
  </>;
}

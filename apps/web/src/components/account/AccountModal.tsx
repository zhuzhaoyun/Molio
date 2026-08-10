/**
 * 账号面板模态框（设计 §7.4）：登录态展示 + 退出登录 + 注销账号。
 * 三个视图：main（登录态/未登录）、login（LoginForm 两步验证码）、delete（注销二次确认）。
 * 数据源是 authStore（daemon GET /api/auth/status 的镜像）；所有写操作经
 * daemon 本地镜像端点，UI 从不直连云端。
 */

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { authStore, useAuthStatus } from '../../stores/authStore';
import { authErrorRef } from './authErrors';
import { LoginForm } from './LoginForm';

type View = 'main' | 'login' | 'delete';

interface AccountModalProps {
  show: boolean;
  onClose: () => void;
}

export function AccountModal({ show, onClose }: AccountModalProps) {
  const { t } = useI18n();
  const status = useAuthStatus();
  const [view, setView] = useState<View>('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);

  // 每次打开时拉最新快照并复位内部状态
  useEffect(() => {
    if (!show) return;
    setView('main');
    setBusy(false);
    setError(null);
    setAck(false);
    void authStore.refresh();
  }, [show]);

  if (!show) return null;

  async function handleLogout() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.authLogout();
      await authStore.invalidate();
    } catch (e) {
      const ref = authErrorRef(e);
      setError(t(ref.key, ref.params));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (busy || !ack) return;
    setBusy(true);
    setError(null);
    try {
      await api.authDeleteAccount();
      await authStore.invalidate();
      setView('main');
      setAck(false);
    } catch (e) {
      const ref = authErrorRef(e);
      setError(t(ref.key, ref.params));
      setView('main');
    } finally {
      setBusy(false);
    }
  }

  function renderMain() {
    if (status === null) {
      return <p className="account-note" data-testid="account-loading">{t('account.loading')}</p>;
    }

    if (!status.configured) {
      return (
        <p className="account-note account-note-info" data-testid="account-not-configured">
          {t('account.notConfigured')}
        </p>
      );
    }

    if (status.loggedIn && status.user) {
      const initial = (status.user.email ?? '?').slice(0, 1).toUpperCase();
      return (
        <>
          {status.stale && (
            <p className="account-note account-note-warn" data-testid="account-stale-note">
              {t('account.stale')}
            </p>
          )}
          <div className="account-profile" data-testid="account-profile">
            <span className="account-avatar">{initial}</span>
            <span className="account-logged-email" data-testid="account-logged-email">
              {status.user.email}
            </span>
          </div>
          <div className="account-actions">
            <button
              type="button"
              className="kb-btn"
              data-testid="account-logout-btn"
              disabled={busy}
              onClick={() => void handleLogout()}
            >
              {busy ? t('account.busy') : t('account.logout')}
            </button>
            <span className="account-hint">{t('account.logoutHint')}</span>
          </div>
          <div className="account-danger-zone">
            <button
              type="button"
              className="kb-btn kb-btn-danger"
              data-testid="account-delete-btn"
              disabled={busy}
              onClick={() => {
                setError(null);
                setAck(false);
                setView('delete');
              }}
            >
              {t('account.delete')}
            </button>
            <span className="account-hint">{t('account.deleteHint')}</span>
          </div>
        </>
      );
    }

    // 未登录
    return (
      <>
        {status.loginExpired && (
          <p className="account-note account-note-warn" data-testid="account-expired-note">
            {t('account.loginExpired')}
          </p>
        )}
        <p className="account-intro">{t('account.loginIntro')}</p>
        <div className="account-actions">
          <button
            type="button"
            className="kb-btn kb-btn-primary"
            data-testid="account-login-btn"
            onClick={() => {
              setError(null);
              setView('login');
            }}
          >
            {status.loginExpired ? t('account.relogin') : t('account.loginCta')}
          </button>
        </div>
      </>
    );
  }

  function renderDelete() {
    return (
      <>
        <p className="account-warning" data-testid="account-delete-warning">
          {t('account.deleteWarning')}
        </p>
        <label className="account-ack-row">
          <input
            type="checkbox"
            data-testid="account-delete-ack"
            checked={ack}
            disabled={busy}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>{t('account.deleteAck')}</span>
        </label>
        <div className="account-form-actions">
          <button
            type="button"
            className="kb-btn kb-btn-danger"
            data-testid="account-delete-confirm-btn"
            disabled={busy || !ack}
            onClick={() => void handleDelete()}
          >
            {busy ? t('account.busy') : t('account.deleteConfirm')}
          </button>
          <button
            type="button"
            className="kb-btn"
            data-testid="account-delete-cancel-btn"
            disabled={busy}
            onClick={() => setView('main')}
          >
            {t('account.cancel')}
          </button>
        </div>
      </>
    );
  }

  return (
    <div
      className="kb-overlay show"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="kb-modal account-modal">
        <div className="kb-modal-header">
          <h2>{view === 'delete' ? t('account.deleteTitle') : t('account.title')}</h2>
          <button
            type="button"
            className="kb-modal-close"
            data-testid="account-modal-close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>
        <div className="kb-modal-body">
          {view === 'main' && renderMain()}
          {view === 'login' && (
            <LoginForm
              onSuccess={() => {
                void authStore.invalidate();
                setView('main');
              }}
              onBack={() => setView('main')}
            />
          )}
          {view === 'delete' && renderDelete()}
          {error && (
            <p className="account-error" data-testid="account-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

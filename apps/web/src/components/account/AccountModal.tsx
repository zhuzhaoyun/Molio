/**
 * 账号面板模态框（设计 §7.4）：登录态展示 + 退出登录 + 注销账号。
 * 三个视图：main（登录态/未登录）、login（LoginForm 两步验证码）、delete（注销二次确认）。
 * 数据源是 authStore（daemon GET /api/auth/status 的镜像）；所有写操作经
 * daemon 本地镜像端点，UI 从不直连云端。
 */

import { useEffect, useRef, useState } from 'react';
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
  /**
   * 打开代数（open generation）。模态框关闭时只是隐藏（组件保持挂载），
   * 登出/注销这类慢请求可能在「关闭 → 再次打开」之后才 settle——若不加守卫，
   * 上一轮的 setError/setView/setBusy 会打到新一轮打开的 UI 上（例如刚打开
   * 就冒出上一次请求的错误，或 busy 卡死）。每次打开递增，异步续体只允许
   * 同一代数内应用状态。
   */
  const openGenRef = useRef(0);

  // 每次打开时拉最新快照并复位内部状态
  useEffect(() => {
    if (!show) return;
    openGenRef.current += 1;
    setView('main');
    setBusy(false);
    setError(null);
    setAck(false);
    void authStore.refresh();
  }, [show]);

  if (!show) return null;

  async function handleLogout() {
    if (busy) return;
    const gen = openGenRef.current;
    setBusy(true);
    setError(null);
    try {
      await api.authLogout();
      await authStore.invalidate();
      if (gen !== openGenRef.current) return;
    } catch (e) {
      if (gen !== openGenRef.current) return;
      const ref = authErrorRef(e);
      setError(t(ref.key, ref.params));
    } finally {
      if (gen === openGenRef.current) setBusy(false);
    }
  }

  async function handleDelete() {
    if (busy || !ack) return;
    const gen = openGenRef.current;
    setBusy(true);
    setError(null);
    try {
      await api.authDeleteAccount();
      await authStore.invalidate();
      if (gen !== openGenRef.current) return;
      setView('main');
      setAck(false);
    } catch (e) {
      if (gen !== openGenRef.current) return;
      const ref = authErrorRef(e);
      setError(t(ref.key, ref.params));
      setView('main');
    } finally {
      if (gen === openGenRef.current) setBusy(false);
    }
  }

  function renderMain() {
    if (status === null) {
      return <p className="account-note" data-testid="account-loading">{t('account.loading')}</p>;
    }

    // loggedIn 先于 configured：已登录但云端未配置（MOLIO_AUTH_URL 后来被移除）时
    // 本地会话仍在，退出登录是纯本地操作——必须能看到资料卡与退出入口，
    // 而不是被「未配置」提示挡掉（想退出都做不到）。
    if (status.loggedIn) {
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

    // 未登录且云端未配置：登录必然失败，隐藏登录表单、只给说明
    if (!status.configured) {
      return (
        <p className="account-note account-note-info" data-testid="account-not-configured">
          {t('account.notConfigured')}
        </p>
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

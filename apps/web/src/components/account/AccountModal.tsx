/**
 * 账号面板模态框（设计 §7.4）：登录态展示 + 退出登录。
 * 未登录时**直接显示邮箱验证表单**（无中间欢迎页）；登录成功后同一面板
 * 切换为资料卡。数据源是 authStore（daemon GET /api/auth/status 的镜像）；
 * 所有写操作经 daemon 本地镜像端点，UI 从不直连云端。
 *
 * 注销账号入口已按产品决定下线（第一期云端无用户数据，注销无实际意义）；
 * 云端/后端接口保留，恢复时只需加回 UI。
 */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { authStore, useAuthStatus } from '../../stores/authStore';
import { authErrorRef } from './authErrors';
import { LoginForm } from './LoginForm';
import { MyListingsPanel } from '../resources/MyListingsPanel';

interface AccountModalProps {
  show: boolean;
  onClose: () => void;
  /** 登录成功后回调（登录意图场景用来续接被门槛拦下的动作） */
  onLoggedIn?: () => void;
}

export function AccountModal({ show, onClose, onLoggedIn }: AccountModalProps) {
  const { t } = useI18n();
  const status = useAuthStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [showMyListings, setShowMyListings] = useState(false);
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
    setBusy(false);
    setError(null);
    setEditingNickname(false);
    setNicknameDraft('');
    setShowMyListings(false);
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

  async function handleSaveNickname() {
    const trimmed = nicknameDraft.trim();
    if (busy || trimmed === '') return;
    const gen = openGenRef.current;
    setBusy(true);
    setError(null);
    try {
      await api.authUpdateMe(trimmed);
      // daemon 已同步 token/权益快照；invalidate 拉最新 status 供本视图渲染
      await authStore.invalidate();
      if (gen !== openGenRef.current) return;
      setEditingNickname(false);
    } catch (e) {
      if (gen !== openGenRef.current) return;
      const ref = authErrorRef(e);
      setError(t(ref.key, ref.params));
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
      const nickname = status.user.nickname ?? '';
      // 头像首字母：昵称优先（Array.from 取首 code point，emoji 安全），回退邮箱
      const initial = (Array.from(nickname)[0] ?? status.user.email.slice(0, 1)).toUpperCase();
      // 展示名：旧 token 无昵称时回退邮箱前缀
      const displayName = nickname !== '' ? nickname : (status.user.email.split('@')[0] ?? status.user.email);
      // 权益：第一期 plan 只有 free；缺失/free 一律显示「免费版」，其余原样
      const plan = status.entitlement?.plan;
      const planLabel = !plan || plan === 'free' ? t('account.planFree') : plan;
      return (
        <>
          {status.stale && (
            <p className="account-note account-note-warn" data-testid="account-stale-note">
              {t('account.stale')}
            </p>
          )}
          <div className="account-profile" data-testid="account-profile">
            <span className="account-avatar">{initial}</span>
            <div className="account-identity">
              {editingNickname ? (
                <div className="account-nickname-edit">
                  <input
                    className="account-nickname-input"
                    data-testid="account-nickname-input"
                    value={nicknameDraft}
                    maxLength={20}
                    placeholder={t('account.nicknamePlaceholder')}
                    disabled={busy}
                    autoFocus
                    onChange={(e) => setNicknameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSaveNickname();
                      if (e.key === 'Escape') {
                        setEditingNickname(false);
                        setError(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="kb-btn kb-btn-primary account-nickname-save-btn"
                    data-testid="account-nickname-save-btn"
                    disabled={busy || nicknameDraft.trim() === ''}
                    onClick={() => void handleSaveNickname()}
                  >
                    {busy ? t('account.busy') : t('account.save')}
                  </button>
                  <button
                    type="button"
                    className="kb-btn account-nickname-cancel-btn"
                    data-testid="account-nickname-cancel-btn"
                    disabled={busy}
                    onClick={() => {
                      setEditingNickname(false);
                      setError(null);
                    }}
                  >
                    {t('account.cancel')}
                  </button>
                </div>
              ) : (
                <div className="account-nickname-row">
                  <span className="account-nickname" data-testid="account-nickname">
                    {displayName}
                  </span>
                  <button
                    type="button"
                    className="account-nickname-edit-btn"
                    data-testid="account-nickname-edit-btn"
                    disabled={busy || status.stale === true}
                    aria-label={t('account.editNickname')}
                    title={t('account.editNickname')}
                    onClick={() => {
                      setNicknameDraft(nickname);
                      setError(null);
                      setEditingNickname(true);
                    }}
                  >
                    ✎
                  </button>
                </div>
              )}
              <span className="account-logged-email" data-testid="account-logged-email">
                {status.user.email}
              </span>
            </div>
          </div>
          <div className="account-entitlement">
            <span className="account-entitlement-label">{t('account.entitlementLabel')}</span>
            <span className="account-entitlement-value" data-testid="account-entitlement-value">
              {planLabel}
            </span>
          </div>
          <div className="account-actions">
            <button
              type="button"
              className="kb-btn"
              data-testid="account-my-listings-btn"
              disabled={busy}
              onClick={() => setShowMyListings(true)}
            >
              {t('account.myListings')}
            </button>
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

    // 未登录：直接显示邮箱验证表单（不做中间欢迎页）；
    // 登录成功后 authStore 刷新，本面板自动切到资料卡
    return (
      <>
        {status.loginExpired && (
          <p className="account-note account-note-warn" data-testid="account-expired-note">
            {t('account.loginExpired')}
          </p>
        )}
        <LoginForm
          onSuccess={() => {
            void authStore.invalidate();
            onLoggedIn?.();
          }}
        />
      </>
    );
  }

  return (
    <div
      className="kb-overlay show"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="kb-modal account-modal">
        {/* 无标题栏：关闭按钮悬浮右上角，面板空间全留给内容 */}
        <button
          type="button"
          className="kb-modal-close account-close"
          data-testid="account-modal-close"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          &times;
        </button>
        <div className="kb-modal-body">
          {renderMain()}
          {error && (
            <p className="account-error" data-testid="account-error">
              {error}
            </p>
          )}
        </div>
      </div>
      {showMyListings && (
        <MyListingsPanel onClose={() => setShowMyListings(false)} />
      )}
    </div>
  );
}

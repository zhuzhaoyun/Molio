/**
 * 「我的」独立页面（/me）—— 账号模块从小弹窗升级为页面（页内 Tab，仿 SettingsPage）。
 *
 * Tab：资料（昵称/邮箱/权益/退出登录）/ 已购（重复下载最新版）/ 上架（仅市场管理员）。
 * 未登录直达本页（如书签/外部链接）时渲染登录表单（复用 LoginForm），登录成功自动
 * 切换到已登录视图；正常入口是 NavRail 账号按钮（已登录 → /me，未登录 → 登录弹窗）。
 *
 * 骨架复用 settings-shell / settings-tab-nav 版式体系；已购/上架列表复用 mylistings-*。
 * 资料卡数据源是 authStore（daemon GET /api/auth/status 镜像）；写操作经 daemon 镜像端点。
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { authStore, useAuthStatus } from '../../stores/authStore';
import { authErrorRef } from './authErrors';
import { LoginForm } from './LoginForm';
import { PurchasesSection } from './PurchasesSection';
import { ListingsSection } from './ListingsSection';

type MeTab = 'profile' | 'purchases' | 'listings';

export function AccountPage() {
  const { t } = useI18n();
  const status = useAuthStatus();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<MeTab>(
    initialTab === 'purchases' || initialTab === 'listings' ? initialTab : 'profile',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  // 「上架」Tab 仅市场管理员可见（门禁与云端 /market/my 的 isAdmin 同源）。
  // 未登录 / 未决 / 失败一律按非管理员处理（隐藏 Tab）
  const [isMarketAdmin, setIsMarketAdmin] = useState(false);
  const loggedIn = status?.loggedIn === true;

  useEffect(() => {
    if (!loggedIn) { setIsMarketAdmin(false); return; }
    let alive = true;
    fetch('/api/market/my')
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { isAdmin?: boolean } | null) => { if (alive) setIsMarketAdmin(m?.isAdmin === true); })
      .catch(() => { if (alive) setIsMarketAdmin(false); });
    return () => { alive = false; };
  }, [loggedIn]);

  // 每次进入页面拉最新快照
  useEffect(() => { void authStore.refresh(); }, []);

  function switchTab(tab: MeTab) {
    setActiveTab(tab);
    setSearchParams(tab === 'profile' ? {} : { tab }, { replace: true });
  }

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

  async function handleSaveNickname() {
    const trimmed = nicknameDraft.trim();
    if (busy || trimmed === '') return;
    setBusy(true);
    setError(null);
    try {
      await api.authUpdateMe(trimmed);
      // daemon 已同步 token/权益快照；invalidate 拉最新 status 供本页渲染
      await authStore.invalidate();
      setEditingNickname(false);
    } catch (e) {
      const ref = authErrorRef(e);
      setError(t(ref.key, ref.params));
    } finally {
      setBusy(false);
    }
  }

  function renderProfile() {
    if (!status || !status.loggedIn) return null;
    const nickname = status.user.nickname ?? '';
    // 头像首字母：昵称优先（Array.from 取首 code point，emoji 安全），回退邮箱
    const initial = (Array.from(nickname)[0] ?? status.user.email.slice(0, 1)).toUpperCase();
    // 展示名：旧 token 无昵称时回退邮箱前缀
    const displayName = nickname !== '' ? nickname : (status.user.email.split('@')[0] ?? status.user.email);
    // 权益：第一期 plan 只有 free；缺失/free 一律显示「免费版」，其余原样
    const plan = status.entitlement?.plan;
    const planLabel = !plan || plan === 'free' ? t('account.planFree') : plan;
    return (
      <div className="me-section">
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
            data-testid="account-logout-btn"
            disabled={busy}
            onClick={() => void handleLogout()}
          >
            {busy ? t('account.busy') : t('account.logout')}
          </button>
          <span className="account-hint">{t('account.logoutHint')}</span>
        </div>
      </div>
    );
  }

  function renderContent() {
    // 登录态未决
    if (status === null) {
      return <p className="account-note" data-testid="account-loading">{t('account.loading')}</p>;
    }

    // 未登录直达 /me：页面内嵌登录表单（正常入口下不会走到——NavRail 未登录开弹窗）
    if (!status.loggedIn) {
      if (!status.configured) {
        return (
          <p className="account-note account-note-info" data-testid="account-not-configured">
            {t('account.notConfigured')}
          </p>
        );
      }
      return (
        <div className="me-section me-login-inline" data-testid="me-login-inline">
          {status.loginExpired && (
            <p className="account-note account-note-warn" data-testid="account-expired-note">
              {t('account.loginExpired')}
            </p>
          )}
          <LoginForm onSuccess={() => void authStore.invalidate()} />
        </div>
      );
    }

    if (activeTab === 'purchases') return <PurchasesSection />;
    if (activeTab === 'listings' && isMarketAdmin) return <ListingsSection />;
    return renderProfile();
  }

  return (
    <div className="settings-shell" data-testid="me-page">
      <div className="settings-header">
        <h1 className="settings-header__title">{t('me.title')}</h1>
      </div>

      {loggedIn && (
        <div className="settings-tab-nav" data-testid="me-tab-nav">
          <button
            type="button"
            className={`settings-tab-btn${activeTab === 'profile' ? ' is-active' : ''}`}
            data-testid="me-tab-profile"
            onClick={() => switchTab('profile')}
          >
            {t('me.tabProfile')}
          </button>
          <button
            type="button"
            className={`settings-tab-btn${activeTab === 'purchases' ? ' is-active' : ''}`}
            data-testid="me-tab-purchases"
            onClick={() => switchTab('purchases')}
          >
            {t('me.tabPurchases')}
          </button>
          {isMarketAdmin && (
            <button
              type="button"
              className={`settings-tab-btn${activeTab === 'listings' ? ' is-active' : ''}`}
              data-testid="me-tab-listings"
              onClick={() => switchTab('listings')}
            >
              {t('me.tabListings')}
            </button>
          )}
        </div>
      )}

      <div className="settings-content">
        {renderContent()}
        {error && (
          <p className="account-error" data-testid="account-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

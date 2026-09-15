/**
 * 登录弹窗（原「账号面板」，账号模块页面化后瘦身为纯登录职责）。
 *
 * 打开时机（NavRail 分流）：
 * - 未登录点账号按钮 → 本弹窗（直接显示邮箱验证表单，无中间欢迎页）
 * - 资源下载/购买等登录门槛（loginIntentStore）→ 本弹窗，登录成功后由父级续接原动作
 * - 已登录点账号按钮 → 不再开弹窗，直接导航 /me「我的」页面（资料/已购/上架）
 *
 * 登录成功后本弹窗无事可做：父级（NavRail）负责关闭与后续导航，loggedIn 态渲染 null
 * 兜底（防御性——正常链路下已登录不会打开本弹窗）。
 */

import { useEffect } from 'react';
import { useI18n } from '../../i18n';
import { authStore, useAuthStatus } from '../../stores/authStore';
import { LoginForm } from './LoginForm';

// 已登录误开弹窗时的收起/导航兜底在 NavRail（它持有登录意图与 router）；
// 本组件只负责渲染：loggedIn 态返回 null，绝不渲染登录表单。

interface AccountModalProps {
  show: boolean;
  onClose: () => void;
  /** 登录成功后回调（登录意图场景用来续接被门槛拦下的动作；NavRail 亦据此导航 /me） */
  onLoggedIn?: () => void;
  /** 登录意图打开时提层（kb-overlay-elevated，z-320），盖过仓库管理器 vm-overlay(z-200) */
  elevated?: boolean;
}

export function AccountModal({ show, onClose, onLoggedIn, elevated = false }: AccountModalProps) {
  const { t } = useI18n();
  const status = useAuthStatus();

  // 每次打开时拉最新快照
  useEffect(() => {
    if (show) void authStore.refresh();
  }, [show]);

  if (!show) return null;
  // loggedIn 先于 configured 判定：已登录但云端未配置的残留会话不该看到登录表单
  if (status?.loggedIn === true) return null;

  return (
    <div className={`kb-overlay show${elevated ? ' kb-overlay-elevated' : ''}`}>
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
          {status === null ? (
            <p className="account-note" data-testid="account-loading">{t('account.loading')}</p>
          ) : !status.configured ? (
            // 未登录且云端未配置：登录必然失败，隐藏登录表单、只给说明
            <p className="account-note account-note-info" data-testid="account-not-configured">
              {t('account.notConfigured')}
            </p>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}

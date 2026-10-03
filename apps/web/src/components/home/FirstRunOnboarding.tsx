/**
 * 首次运行引导卡 —— 「一个知识库都没有」时出现在主页。
 *
 * 背景：全新安装的主页原来直接落在聊天框上，全程没有一个字提到知识库，
 * 客户不知道文件该往哪里放，折腾一个多小时后放弃。这张卡把「建库 → 导入」
 * 这条唯一正确的第一步显式摆出来。
 *
 * 自包含：自己订阅 vaultStore（不靠 HomePage 传 prop），自己接路由。
 * 库列表取回之前不渲染（避免对着已有库的用户闪一下）；用户手动关掉后
 * 记在 localStorage，不再打扰（聊天-only 的用法也该被尊重）。
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { useVaults, useVaultsLoaded } from '../../stores/vaultStore';

const DISMISS_KEY = 'molio.firstRunOnboarding.dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function FirstRunOnboarding() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const vaults = useVaults();
  const loaded = useVaultsLoaded();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (!loaded || dismissed || vaults.length > 0) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch { /* storage unavailable — 本次会话内仍生效 */ }
  };

  return (
    <div className="home-onboarding" data-testid="home-onboarding-card">
      <div className="home-onboarding__head">
        <span className="home-onboarding__icon">📚</span>
        <div>
          <h2 className="home-onboarding__title">{t('home.onboarding.title')}</h2>
          <p className="home-onboarding__body">{t('home.onboarding.body')}</p>
        </div>
        <button
          type="button"
          className="home-onboarding__close"
          onClick={dismiss}
          title={t('home.onboarding.dismiss')}
          aria-label={t('home.onboarding.dismiss')}
          data-testid="home-onboarding-dismiss"
        >
          ×
        </button>
      </div>

      <ol className="home-onboarding__steps">
        <li>{t('home.onboarding.step1')}</li>
        <li>{t('home.onboarding.step2')}</li>
        <li>{t('home.onboarding.step3')}</li>
      </ol>

      <button
        type="button"
        className="primary home-onboarding__cta"
        data-testid="home-onboarding-cta"
        /* manage=1：到知识库页直接把仓库管理器打开，省掉「找不到建库入口」这一步 */
        onClick={() => navigate('/knowledge?manage=1')}
      >
        {t('home.onboarding.cta')}
      </button>
    </div>
  );
}

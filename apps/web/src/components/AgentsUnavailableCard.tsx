import { useI18n } from '../i18n';

interface Props {
  onRetry: () => void;
}

/**
 * 「运行时列表取不到」的空状态卡片 —— 与 `NoRuntimeCard`（真的一个都没装）
 * 是**两种不同的处境**，必须分开，不能共用一张卡。
 *
 * 原因：`GET /api/agents` 失败时（daemon 没起来、请求被拒），agents 数组必然为空，
 * 而「空数组」正是「没装运行时」的判据。如果不区分，界面就会把「后端连不上」
 * 说成「未安装 AI 运行时」，把用户推去安装他明明已经装好的东西 —— 用户会以为
 * 自己的环境坏了，且没有任何恢复动作可做。
 *
 * 所以这里明确归因到「取不到」，并给一个能立刻恢复的动作（重试）。
 * 视觉沿用 `.home-no-runtime` 那套配方（同宽、同边框、同阴影、同入场动画），
 * 避免在同一个位置堆出第二种卡片样式。
 */
export function AgentsUnavailableCard({ onRetry }: Props) {
  const { t } = useI18n();

  return (
    <div className="home-no-runtime" data-testid="agents-unavailable-card">
      <div className="home-no-runtime__icon" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v6" />
          <path d="m4.93 10.93 1.41 1.41" />
          <path d="M2 18h2" />
          <path d="M20 18h2" />
          <path d="m19.07 10.93-1.41 1.41" />
          <path d="M22 22H2" />
          <path d="m8 6 4-4 4 4" />
          <path d="M16 18a4 4 0 0 0-8 0" />
        </svg>
      </div>
      <div className="home-no-runtime__title">{t('home.agentsUnavailableTitle')}</div>
      <div className="home-no-runtime__desc">{t('home.agentsUnavailableDesc')}</div>
      <button
        type="button"
        className="primary home-no-runtime__btn"
        data-testid="agents-retry-btn"
        onClick={onRetry}
      >
        {t('home.agentsRetry')}
      </button>
    </div>
  );
}

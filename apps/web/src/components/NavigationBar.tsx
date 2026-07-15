import { useNavigationHistory, navigationHistoryStore } from '../stores/navigationHistoryStore';
import { useI18n } from '../i18n';

const ROUTE_I18N_KEYS: Record<string, string> = {
  '/': 'nav.home',
  '/knowledge': 'nav.knowledge',
  '/graph': 'nav.graph',
  '/history': 'nav.history',
  '/settings': 'nav.settings',
};

function resolveLabel(rawLabel: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  const i18nKey = ROUTE_I18N_KEYS[rawLabel];
  if (i18nKey) return t(i18nKey);
  return rawLabel;
}

export function NavigationBar() {
  const { t } = useI18n();
  const { canGoBack, canGoForward, currentLabel, backLabel, forwardLabel } =
    useNavigationHistory();

  const resolvedCurrent = resolveLabel(currentLabel, t);
  const resolvedBack = resolveLabel(backLabel, t);
  const resolvedForward = resolveLabel(forwardLabel, t);

  return (
    <div className="nav-topbar" data-testid="nav-topbar">
      <div className="nav-topbar__nav">
        <button
          className="nav-topbar__btn"
          data-testid="nav-back"
          disabled={!canGoBack}
          onClick={() => navigationHistoryStore.back()}
          title={canGoBack ? t('nav.backTo', { label: resolvedBack }) : undefined}
          aria-label={t('nav.back')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          className="nav-topbar__btn"
          data-testid="nav-forward"
          disabled={!canGoForward}
          onClick={() => navigationHistoryStore.forward()}
          title={canGoForward ? t('nav.forwardTo', { label: resolvedForward }) : undefined}
          aria-label={t('nav.forward')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
      <div className="nav-topbar__divider" />
      <span className="nav-topbar__breadcrumb">{resolvedCurrent}</span>
    </div>
  );
}

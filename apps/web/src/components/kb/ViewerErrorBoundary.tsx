import { Component, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { I18nContextValue } from '../../i18n';

interface Props {
  children: ReactNode;
  onRetry?: () => void;
  onOpenExternal?: () => void;
}

interface ClassProps extends Props {
  t: I18nContextValue['t'];
}

interface State {
  error: Error | null;
}

class ViewerErrorBoundaryClass extends Component<ClassProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { t, onRetry, onOpenExternal, children } = this.props;
    if (this.state.error) {
      return (
        <div className="kb-load-error">
          <div className="kb-load-error-icon">⚠</div>
          <p className="kb-load-error-title">{t('kb.loadFailed')}</p>
          <p className="kb-load-error-hint">{this.state.error.message}</p>
          {onRetry && (
            <button className="kb-btn" onClick={onRetry}>{t('runtimes.retry')}</button>
          )}
          {onOpenExternal && (
            <button className="kb-btn" onClick={onOpenExternal}>{t('kb.openExternal')}</button>
          )}
        </div>
      );
    }
    return children;
  }
}

export function ViewerErrorBoundary(props: Props) {
  const { t } = useI18n();
  return <ViewerErrorBoundaryClass {...props} t={t} />;
}

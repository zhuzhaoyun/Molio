import { useI18n } from '../../i18n';
import { formatFileSize } from '../../utils/format';

interface Props {
  fileName: string;
  size: number;
  encoding?: string;
  canForce: boolean;
  onForce: () => void;
  onOpenExternal?: () => void;
  onCloseTab: () => void;
}

export function TooLargeCard({
  fileName,
  size,
  encoding,
  canForce,
  onForce,
  onOpenExternal,
  onCloseTab,
}: Props) {
  const { t } = useI18n();
  return (
    <div className="kb-content-area">
      <div className="kb-file-card">
        <div className="kb-file-card-icon">📄</div>
        <div className="kb-file-card-info">
          <h3>{fileName}</h3>
          <p>{formatFileSize(size)}{encoding ? ` · ${encoding}` : ''}</p>
          <p className="kb-file-card-hint">{t('kb.fileTooLargeHint', { size: formatFileSize(size) })}</p>
        </div>
        <div className="kb-file-card-actions">
          {canForce && (
            <button className="kb-btn" onClick={onForce} data-testid="kb-btn-force">
              {t('kb.forceLoad')}
            </button>
          )}
          {onOpenExternal && (
            <button className="kb-btn" onClick={onOpenExternal}>{t('kb.openExternal')}</button>
          )}
          <button className="kb-btn kb-btn-ghost" onClick={onCloseTab}>{t('kb.closeTab')}</button>
        </div>
      </div>
    </div>
  );
}

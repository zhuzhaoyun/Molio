/**
 * 副视图（分屏右格）头部：视图标识 + 关闭。v1 不做 ⇄ 切换——
 * 「换副视图」= 右键标签重新分屏（见 docs/2026-09-03-split-view-design.md）。
 */
import { useI18n } from '../../i18n';

interface CompanionHeaderProps {
  title: string;
  onClose: () => void;
}

export function CompanionHeader({ title, onClose }: CompanionHeaderProps) {
  const { t } = useI18n();
  return (
    <div className="kb-companion-header">
      <span className="kb-companion-header__label" data-testid="companion-title">{title}</span>
      <button
        type="button"
        className="kb-companion-header__close"
        data-testid="companion-close"
        aria-label={t('kb.close')}
        onClick={onClose}
      >×</button>
    </div>
  );
}

/**
 * `···` global menu: outline / stats / search / collapse all folders.
 * Phase 3 AI items are disabled placeholders. Pure presentation + callbacks.
 */
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import './KbMoreMenu.css';

interface KbMoreMenuProps {
  onOpenOutline: () => void;
  onOpenSearch: () => void;
  onScrollToStats: () => void;
  onCollapseAll: () => void;
}

export function KbMoreMenu({ onOpenOutline, onOpenSearch, onScrollToStats, onCollapseAll }: KbMoreMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside / ESC
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <div className="kb-more-menu" ref={ref}>
      <button
        type="button"
        className="kb-more-menu-btn"
        data-testid="kb-more-menu-btn"
        onClick={() => setOpen((o) => !o)}
        title={t('kb.moreMenuLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ···
      </button>
      {open && (
        <div className="kb-more-menu-dropdown" data-testid="kb-more-menu" role="menu">
          <button type="button" className="kb-more-item" data-testid="more-item-outline"
            role="menuitem" onClick={() => run(onOpenOutline)}>
            📋 {t('kb.moreMenuOutline')}
          </button>
          <button type="button" className="kb-more-item" data-testid="more-item-stats"
            role="menuitem" onClick={() => run(onScrollToStats)}>
            📊 {t('kb.moreMenuStats')}
          </button>
          <button type="button" className="kb-more-item" data-testid="more-item-search"
            role="menuitem" onClick={() => run(onOpenSearch)}>
            🔍 {t('kb.moreMenuSearch')}
          </button>
          <button type="button" className="kb-more-item" data-testid="more-item-collapse-all"
            role="menuitem" onClick={() => run(onCollapseAll)}>
            📂 {t('kb.moreMenuCollapseAll')}
          </button>
          <div className="kb-more-divider" />
          <button type="button" className="kb-more-item is-disabled" data-testid="more-item-ai-summary"
            role="menuitem" disabled title={t('kb.moreMenuComingSoon')}>
            🤖 {t('kb.moreMenuAiSummary')}
          </button>
          <button type="button" className="kb-more-item is-disabled" data-testid="more-item-ai-key-points"
            role="menuitem" disabled title={t('kb.moreMenuComingSoon')}>
            🤖 {t('kb.moreMenuAiKeyPoints')}
          </button>
          <button type="button" className="kb-more-item is-disabled" data-testid="more-item-ai-related"
            role="menuitem" disabled title={t('kb.moreMenuComingSoon')}>
            🤖 {t('kb.moreMenuAiRelated')}
          </button>
        </div>
      )}
    </div>
  );
}

import { useI18n } from '../../i18n';

interface PdfSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  total: number;
  activeIndex: number;
  searching: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function PdfSearchBar(props: PdfSearchBarProps) {
  const { t } = useI18n();
  const { query, onQueryChange, total, activeIndex, searching, onPrev, onNext, onClose } = props;
  const count = searching ? t('kb.pdf.searching')
    : total > 0 ? `${activeIndex + 1} / ${total}`
    : query.trim() ? t('kb.pdf.noMatches') : '';
  return (
    <div className="pdf-searchbar" data-testid="pdf-searchbar">
      <input
        data-testid="pdf-search-input"
        className="pdf-searchbar-input"
        type="text"
        value={query}
        placeholder={t('kb.pdf.searchPlaceholder')}
        onChange={(e) => onQueryChange(e.target.value)}
        autoFocus
      />
      <button type="button" className="kb-btn kb-btn-ghost" onClick={onPrev} data-testid="pdf-search-prev" title={t('kb.pdf.prevMatch')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button type="button" className="kb-btn kb-btn-ghost" onClick={onNext} data-testid="pdf-search-next" title={t('kb.pdf.nextMatch')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <span className="pdf-search-count" data-testid="pdf-search-count">{count}</span>
      <button type="button" className="kb-btn kb-btn-ghost" onClick={onClose} data-testid="pdf-search-close" title={t('kb.pdf.search')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

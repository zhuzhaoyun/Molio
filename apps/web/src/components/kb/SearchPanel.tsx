/**
 * 全文搜索浮层：debounce 300ms → api.searchFiles → 结果列表（高亮匹配词）。
 * 点击结果调用 onOpenFile(filePath)。
 */
import { useEffect, useRef, useState } from 'react';
import type { SearchResult } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import './SearchPanel.css';

interface SearchPanelProps {
  vaultId: string;
  onOpenFile: (filePath: string) => void;
  onClose: () => void;
}

export function SearchPanel({ vaultId, onOpenFile, onClose }: SearchPanelProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // debounce 搜索
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setTruncated(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    let isMounted = true;
    timer.current = setTimeout(async () => {
      try {
        const data = await api.searchFiles(vaultId, q);
        if (!isMounted) return;
        setResults(data.results);
        setTruncated(data.truncated);
      } catch {
        if (!isMounted) return;
        setResults([]);
        setTruncated(false);
      } finally {
        if (isMounted) setLoading(false);
      }
    }, 300);
    return () => {
      isMounted = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, vaultId]);

  const highlight = (snippet: string, q: string): [string, string, string] => {
    const idx = snippet.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return [snippet, '', ''];
    return [
      snippet.slice(0, idx),
      snippet.slice(idx, idx + q.length),
      snippet.slice(idx + q.length),
    ];
  };

  return (
    <div className="kb-search-overlay" data-testid="kb-search-panel" role="dialog">
      <div className="kb-search-box">
        <div className="kb-search-input-row">
          <span className="kb-search-icon">🔍</span>
          <input
            type="text"
            className="kb-search-input"
            data-testid="kb-search-input"
            autoFocus
            placeholder={t('kb.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="kb-search-close" data-testid="kb-search-close"
            onClick={onClose} aria-label="close">✕</button>
        </div>

        <div className="kb-search-results">
          {loading && <p className="kb-search-hint">{t('kb.searchLoading')}</p>}
          {!loading && query.trim() && results.length === 0 && (
            <p className="kb-search-hint">{t('kb.searchNoResults')}</p>
          )}
          {results.map((r) => {
            const [before, match, after] = highlight(r.snippet, query.trim());
            return (
              <button
                key={r.filePath}
                type="button"
                className="kb-search-result"
                data-testid="kb-search-result"
                onClick={() => onOpenFile(r.filePath)}
              >
                <div className="kb-search-result-file">📄 {r.fileName}</div>
                <div className="kb-search-result-snippet">
                  {before}<mark>{match}</mark>{after}
                </div>
              </button>
            );
          })}
          {truncated && <p className="kb-search-hint">{t('kb.searchTooMany')}</p>}
        </div>
      </div>
    </div>
  );
}

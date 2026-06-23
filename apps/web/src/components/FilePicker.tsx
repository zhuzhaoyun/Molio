import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { TreeNode } from '@molio/contracts';
import { api } from '../api/client';
import './FilePicker.css';

interface Props {
  vaultId: string;
  /** Initial filter text — pre-fills the search input. */
  filterText: string;
  onSelect: (filePath: string) => void;
  onClose: () => void;
}

/** Flatten tree into file-only list. */
function flattenFiles(nodes: TreeNode[]): TreeNode[] {
  const files: TreeNode[] = [];
  function walk(list: TreeNode[]) {
    for (const n of list) {
      if (n.type === 'file') files.push(n);
      if (n.children) walk(n.children);
    }
  }
  walk(nodes);
  return files;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return '';
}

export function FilePicker({ vaultId, filterText, onSelect, onClose }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(filterText);
  const [activeIdx, setActiveIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch file tree on mount
  useEffect(() => {
    let cancelled = false;
    api.getFileTree(vaultId)
      .then((t) => {
        if (!cancelled) { setTree(t); setLoading(false); }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [vaultId]);

  // Auto-focus search input
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Flatten + filter
  const files = useMemo(() => {
    const all = flattenFiles(tree);
    all.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    if (!searchQuery) return all.slice(0, 8);
    const q = searchQuery.toLowerCase();
    return all.filter(
      (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
    );
  }, [tree, searchQuery]);

  // Reset active index when files change
  useEffect(() => { setActiveIdx(0); }, [files]);

  // Keyboard navigation (document-level for Arrow/Enter/Escape)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((prev) => Math.min(prev + 1, files.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const f = files[activeIdx];
        if (f) onSelect(f.path);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [files, activeIdx, onSelect, onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  // Prevent Up/Down from moving cursor in search input (list nav handles it)
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
    }
  };

  if (loading) {
    return (
      <div className="file-picker-overlay">
        <div className="file-picker-empty">加载中…</div>
      </div>
    );
  }

  return (
    <div className="file-picker-overlay" data-testid="file-picker">
      {/* Search input */}
      <div className="file-picker-search-wrap">
        <input
          ref={searchRef}
          type="text"
          className="file-picker-search"
          data-testid="file-picker-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="搜索文件…"
        />
      </div>

      {/* File list */}
      <div ref={listRef}>
        {files.length === 0 ? (
          <div className="file-picker-empty">无匹配文件</div>
        ) : (
          files.map((f, i) => (
            <div
              key={f.path}
              className={`file-picker-item${i === activeIdx ? ' active' : ''}`}
              data-testid="file-picker-item"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(f.path);
              }}
            >
              <span className="file-picker-item-icon">📄</span>
              <span className="file-picker-item-name">{f.name}</span>
              <span className="file-picker-item-time">
                {f.modifiedAt ? timeAgo(f.modifiedAt) : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

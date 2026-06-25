import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { TreeNode } from '@molio/contracts';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { FolderIcon, FileDocIcon } from './FileIcons';
import './FilePicker.css';

interface Props {
  vaultId: string;
  /** Initial filter text — pre-fills the search input. */
  filterText: string;
  onSelect: (filePath: string, isDirectory: boolean) => void;
  onClose: () => void;
}

/** Flatten tree into a list of selectable nodes (files and directories). */
function flattenNodes(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  function walk(list: TreeNode[]) {
    for (const n of list) {
      out.push(n);
      if (n.children) walk(n.children);
    }
  }
  walk(nodes);
  return out;
}

/** Folder portion of a vault-relative path (without the filename), or '' at root. */
function folderPath(fullPath: string): string {
  const idx = fullPath.lastIndexOf('/');
  return idx === -1 ? '' : fullPath.slice(0, idx + 1);
}

type TFunc = (key: string, params?: Record<string, string | number>) => string;

function timeAgo(ms: number, t: TFunc): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('filePicker.justNow');
  if (mins < 60) return t('filePicker.mAgo', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('filePicker.hAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('filePicker.dAgo', { n: days });
  return t('filePicker.older');
}

export function FilePicker({ vaultId, filterText, onSelect, onClose }: Props) {
  const { t } = useI18n();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(filterText);
  const [activeIdx, setActiveIdx] = useState(0);
  const activeIdxRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep activeIdxRef in sync so the keydown handler can read the latest
  // index without activeIdx in its dependency array (avoids re-binding the
  // document listener on every ArrowUp/ArrowDown press).
  useEffect(() => { activeIdxRef.current = activeIdx; }, [activeIdx]);

  // Sync searchQuery when the parent-provided filterText changes (the parent
  // re-derives it from the textarea on every keystroke after the picker opens).
  useEffect(() => { setSearchQuery(filterText); }, [filterText]);

  // Fetch file tree on mount
  useEffect(() => {
    let cancelled = false;
    api.getFileTree(vaultId)
      .then((t) => {
        if (!cancelled) { setTree(t); setLoading(false); }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load files');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [vaultId]);

  // Auto-focus search input
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Build the selectable list. With no query, surface top-level directories
  // first (so folders are discoverable without typing) then recent files.
  // When searching, match any node — files or nested directories — by name/path.
  const files = useMemo(() => {
    if (!searchQuery) {
      const topDirs = tree
        .filter((n) => n.type === 'directory')
        .sort((a, b) => a.name.localeCompare(b.name));
      const recentFiles = flattenNodes(tree)
        .filter((n) => n.type === 'file')
        .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
        .slice(0, 8);
      return [...topDirs, ...recentFiles].slice(0, 12);
    }
    const q = searchQuery.toLowerCase();
    return flattenNodes(tree)
      .filter(
        (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        // Directories first so a folder named "概念" surfaces above files
        // that merely contain the word "概念".
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        if (a.type === 'directory') return a.path.localeCompare(b.path);
        return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
      })
      .slice(0, 50);
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
        const f = files[activeIdxRef.current];
        if (f) onSelect(f.path, f.type === 'directory');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [files, onSelect, onClose],
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
        <div className="file-picker-empty">{t('filePicker.loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-picker-overlay">
        <div className="file-picker-empty">{t('filePicker.loadError')}</div>
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
          placeholder={t('filePicker.searchPlaceholder')}
        />
      </div>

      {/* File list */}
      <div ref={listRef}>
        {files.length === 0 ? (
          <div className="file-picker-empty">{t('filePicker.noMatch')}</div>
        ) : (
          files.map((f, i) => (
            <div
              key={f.path}
              className={`file-picker-item${i === activeIdx ? ' active' : ''}`}
              data-testid="file-picker-item"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(f.path, f.type === 'directory');
              }}
            >
              <span className="file-picker-item-icon">
                {f.type === 'directory' ? <FolderIcon size={16} /> : <FileDocIcon size={15} />}
              </span>
              <div className="file-picker-item-text">
                <span className="file-picker-item-name">
                  {f.type === 'directory' ? `${f.name}/` : f.name}
                </span>
                {folderPath(f.path) && (
                  <span className="file-picker-item-dir" title={folderPath(f.path)}>
                    {folderPath(f.path)}
                  </span>
                )}
              </div>
              <span className="file-picker-item-time">
                {f.modifiedAt ? timeAgo(f.modifiedAt, t) : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

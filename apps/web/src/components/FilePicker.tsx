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
  /** Commit a reference (file, or a folder via its "引用" button / Shift+Enter). */
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

/** The node at `path` (e.g. 'a/b') in a tree, or undefined. */
function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

/** Direct children of the directory at `cwd` (root when cwd is ''). */
function childrenAt(tree: TreeNode[], cwd: string): TreeNode[] {
  if (cwd === '') return tree;
  return findNode(tree, cwd)?.children ?? [];
}

/** Parent path of a directory path, or '' for root. */
function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
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
  /** Current directory shown in browse mode ('' = vault root). */
  const [cwd, setCwd] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const activeIdxRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep activeIdxRef in sync so the keydown handler can read the latest
  // index without activeIdx in its dependency array.
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

  // Browse mode (no search): children of cwd, folders first then files.
  const browseItems = useMemo(() => {
    const kids = childrenAt(tree, cwd);
    const dirs = kids
      .filter((n) => n.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = kids
      .filter((n) => n.type === 'file')
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }, [tree, cwd]);

  // Search mode: flat filter across the WHOLE tree (matches any file/folder).
  const searchItems = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return flattenNodes(tree)
      .filter(
        (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        if (a.type === 'directory') return a.path.localeCompare(b.path);
        return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
      })
      .slice(0, 50);
  }, [tree, searchQuery]);

  const items = searchQuery ? searchItems : browseItems;

  // Breadcrumb segments up to cwd (clicking a crumb navigates there).
  const crumbs = useMemo(() => {
    if (!cwd) return [] as { label: string; path: string }[];
    const parts = cwd.split('/').filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      out.push({ label: part, path: acc });
    }
    return out;
  }, [cwd]);

  // Reset active index when items change
  useEffect(() => { setActiveIdx(0); }, [items.length, cwd, searchQuery]);

  const drillInto = useCallback((path: string) => {
    setCwd(path);
    setSearchQuery('');
    setActiveIdx(0);
  }, []);

  const goUp = useCallback(() => {
    setCwd((prev) => parentOf(prev));
    setSearchQuery('');
    setActiveIdx(0);
  }, []);

  /**
   * Primary action on a row:
   *  - folder  → drill in (navigate), unless shift (reference the folder)
   *  - file    → commit reference
   * Shift+Enter / the row's "引用" button always commit a folder reference.
   */
  const selectItem = useCallback(
    (node: TreeNode, referenceFolder: boolean) => {
      if (node.type === 'directory' && !referenceFolder) {
        drillInto(node.path);
      } else {
        onSelect(node.path, node.type === 'directory');
      }
    },
    [drillInto, onSelect],
  );

  // Keyboard navigation (document-level for Arrow/Enter/Shift+Enter/Escape)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (loading || error) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((prev) => Math.min(prev + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const node = items[activeIdxRef.current];
        if (node) selectItem(node, e.shiftKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // In search → clear search (back to browse); drilled → go up; else close.
        if (searchQuery) setSearchQuery('');
        else if (cwd) goUp();
        else onClose();
      }
    },
    [loading, error, items, searchQuery, cwd, selectItem, goUp, onClose],
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

  // Prevent Up/Down from moving cursor in the search input (list nav handles it)
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
    }
  };

  if (loading) {
    return (
      <div className="file-picker-overlay" data-testid="file-picker">
        <div className="file-picker-empty">{t('filePicker.loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-picker-overlay" data-testid="file-picker">
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
        {searchQuery && (
          <button
            type="button"
            className="file-picker-search-clear"
            data-testid="file-picker-search-clear"
            onClick={() => setSearchQuery('')}
            aria-label={t('filePicker.clearSearch')}
          >
            ×
          </button>
        )}
      </div>

      {/* Breadcrumb (browse only) */}
      {!searchQuery && (
        <div className="file-picker-breadcrumb" data-testid="file-picker-breadcrumb">
          <button
            type="button"
            className={`file-picker-crumb${cwd ? '' : ' active'}`}
            onClick={() => { setCwd(''); setActiveIdx(0); }}
          >
            {t('filePicker.root')}
          </button>
          {crumbs.map((c) => (
            <span key={c.path}>
              <span className="file-picker-crumb-sep">/</span>
              <button
                type="button"
                className="file-picker-crumb"
                onClick={() => { setCwd(c.path); setActiveIdx(0); }}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* File list */}
      <div ref={listRef}>
        {items.length === 0 ? (
          <div className="file-picker-empty">
            {searchQuery ? t('filePicker.noMatch') : t('filePicker.empty')}
          </div>
        ) : (
          items.map((n, i) => {
            const isDir = n.type === 'directory';
            return (
              <div
                key={n.path}
                className={`file-picker-item${i === activeIdx ? ' active' : ''}`}
                data-testid="file-picker-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectItem(n, false);
                }}
              >
                <span className="file-picker-item-icon">
                  {isDir ? <FolderIcon size={16} /> : <FileDocIcon size={15} />}
                </span>
                <div className="file-picker-item-text">
                  <span className="file-picker-item-name">
                    {isDir ? `${n.name}/` : n.name}
                  </span>
                  {folderPath(n.path) && (
                    <span className="file-picker-item-dir" title={folderPath(n.path)}>
                      {folderPath(n.path)}
                    </span>
                  )}
                </div>
                {/* Folder "reference, not drill" affordance — explicit commit.
                    Hover-revealed so it stays quiet until you want it */}
                {isDir && (
                  <button
                    type="button"
                    className="file-picker-ref-btn"
                    data-testid="file-picker-ref-btn"
                    title={t('filePicker.referenceFolder')}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(n.path, true);
                    }}
                  >
                    <span className="file-picker-ref-btn-glyph" aria-hidden="true">＋</span>
                    {t('filePicker.reference')}
                  </button>
                )}
                <span className="file-picker-item-time">
                  {n.modifiedAt ? timeAgo(n.modifiedAt, t) : ''}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Footer hint */}
      <div className="file-picker-hint" data-testid="file-picker-hint">
        {t('filePicker.hint')}
      </div>
    </div>
  );
}

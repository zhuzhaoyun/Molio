/**
 * Left file panel — toolbar, search, file tree, vault bar.
 * Owns the tree's expansion state so the collapse/expand-all toggle can read
 * and mutate it directly (no round-trip through the page).
 */

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { TreeNode } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { KbFileTree } from './KbFileTree';

type SortBy = 'name' | 'modified' | 'size';

const SORT_OPTIONS: SortBy[] = ['name', 'modified', 'size'];

interface KbFilePanelProps {
  width: number;
  tree: TreeNode[];
  selectedFile: string | null;
  searchQuery: string;
  vaultName: string;
  onSearchChange: (q: string) => void;
  onSelectFile: (path: string) => void;
  onNewFile: (parentPath?: string) => void;
  onNewFolder: (parentPath?: string) => void;
  onVaultClick: () => void;
  onAddToWiki?: (path: string) => void;
  /** Context menu handler — fired on right-click of any tree node */
  onContextMenu?: (node: TreeNode, e: React.MouseEvent) => void;
  /** Path of node being renamed (null = none) */
  renamingPath?: string | null;
  /** Confirm rename: (oldPath, newName) */
  onRenameComplete?: (oldPath: string, newName: string) => void;
  /** Cancel rename */
  onRenameCancel?: () => void;
  /** Called when files are dropped from the OS file manager. */
  onImportFiles?: (files: File[], targetDir: string) => void;
  /** Called when a file is dragged from one directory to another within the tree. */
  onMoveFile?: (srcPath: string, destDir: string) => void;
  children?: ReactNode;
}

export function KbFilePanel({
  width,
  tree,
  selectedFile,
  searchQuery,
  vaultName,
  onSearchChange,
  onSelectFile,
  onNewFile,
  onNewFolder,
  onVaultClick,
  onAddToWiki,
  onContextMenu,
  renamingPath,
  onRenameComplete,
  onRenameCancel,
  onImportFiles,
  onMoveFile,
  children,
}: KbFilePanelProps) {
  const { t } = useI18n();
  // Expansion state is owned here so the toggle button can read it directly.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const anyExpanded = expandedPaths.size > 0;

  // Sort order applied to the whole tree (directories always first, sorted by
  // name; files sorted by the chosen key). Persisted across re-renders.
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);

  // Bumped each time the user hits "locate" — KbFileTree scrolls the active
  // file into view when this token changes (see TreeNodeItem effect).
  const [revealToken, setRevealToken] = useState(0);

  // Drag-over state for external file import
  const [dragOver, setDragOver] = useState<{
    type: 'root' | 'node';
    path?: string;
  } | null>(null);
  const dragCounterRef = useRef(0);

  const sortedTree = useMemo(() => sortTree(tree, sortBy), [tree, sortBy]);

  const togglePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpandedPaths(new Set()), []);
  const expandAll = useCallback(
    () => setExpandedPaths(new Set(collectDirPaths(sortedTree))),
    [sortedTree],
  );

  // Locate the currently selected file in the tree: expand every ancestor
  // directory so the file item is rendered, then bump the reveal token so the
  // item scrolls itself into view.
  const locateFile = useCallback(() => {
    if (!selectedFile) return;
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      const parts = selectedFile.split('/');
      for (let i = 1; i < parts.length; i++) {
        next.add(parts.slice(0, i).join('/'));
      }
      return next;
    });
    setRevealToken((n) => n + 1);
  }, [selectedFile]);

  // ── External drag-and-drop handlers ──

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only handle external file drops (ignore internal drags)
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setDragOver({ type: 'root' });
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer.types.includes('Files')) return;
    // Default to root; the KbFileTree directory nodes will set "node" type
    // via onDragOverNode callback (bubbles up through CSS class changes)
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDragOver(null);
      // Clean up any lingering highlight when drag leaves the panel
      document.querySelectorAll('.kb-tree-group-label.drag-target').forEach((el) => {
        el.classList.remove('drag-target');
      });
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragOver(null);

    // Clean up any lingering drag-target class on directory labels
    document.querySelectorAll('.kb-tree-group-label.drag-target').forEach((el) => {
      el.classList.remove('drag-target');
    });

    // Check for folders — if any item in the file list is a directory, reject
    const { files } = e.dataTransfer;
    if (files.length === 0) return;

    // Determine target directory from drop position
    // The KbFileTree directory nodes set a data attribute during dragOver
    // We extract it from the event target
    let targetDir = '';
    const target = e.target as HTMLElement;
    const dirEl = target.closest('[data-drop-dir]');
    if (dirEl) {
      targetDir = dirEl.getAttribute('data-drop-dir') ?? '';
    }

    // Reject folders (browser can't distinguish — check for empty type)
    for (let i = 0; i < files.length; i++) {
      if (files[i].type === '' && files[i].name.indexOf('.') === -1) {
        // Likely a folder or file without extension — use size as heuristic:
        // folders dragged in have size 0 or very small
        // Actually, the browser gives us File objects for files only.
        // Folders from the OS are NOT included in dataTransfer.files.
        // So this check is moot — the browser already filters. Keep as safety.
        break;
      }
    }

    onImportFiles?.(Array.from(files), targetDir);
  }, [onImportFiles]);

  // Called by KbFileTree directory nodes during dragOver to update the panel's
  // drag indicator state for "drop on a specific directory".
  const handleNodeDragOver = useCallback((dirPath: string) => {
    setDragOver({ type: 'node', path: dirPath });
  }, []);

  const handleNodeDragLeave = useCallback(() => {
    setDragOver((prev) => prev?.type === 'node' ? { type: 'root' } : prev);
  }, []);

  // Close the sort menu on outside click / ESC (same pattern as the launcher)
  useEffect(() => {
    if (!sortMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSortMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [sortMenuOpen]);

  // Ingest status counts for the vault stats bar. Only shown once the vault
  // has version tracking (any node carries ingestStatus). wiki/ subtree is
  // excluded — those are wiki products, not ingest sources.
  const stats = useMemo(() => countIngestStatus(tree), [tree]);
  const showStats = stats.pending + stats.clean + stats.modified > 0;

  const sortLabel: Record<SortBy, string> = {
    name: t('kb.sortByName'),
    modified: t('kb.sortByModified'),
    size: t('kb.sortBySize'),
  };

  const dragClass = dragOver
    ? dragOver.type === 'node'
      ? 'drag-over-node'
      : 'drag-over-root'
    : '';

  return (
    <aside
      className={`kb-file-panel ${dragClass}`}
      style={{ width }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Toolbar */}
      <div className="kb-file-toolbar">
        <button type="button" title={t('kb.newNote')} onClick={() => {
          const parent = selectedFile ? selectedFile.includes('/') ? selectedFile.slice(0, selectedFile.lastIndexOf('/')) : undefined : undefined;
          onNewFile(parent);
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
        <button type="button" title={t('kb.newFolder')} onClick={() => {
          const parent = selectedFile ? selectedFile.includes('/') ? selectedFile.slice(0, selectedFile.lastIndexOf('/')) : undefined : undefined;
          onNewFolder(parent);
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <button
          type="button"
          title={selectedFile ? t('kb.locateFile') : t('kb.locateFileNeedFile')}
          onClick={locateFile}
          disabled={!selectedFile}
          data-testid="kb-btn-locate"
        >
          {/* crosshair — reveal current file in tree */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="7" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
            <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <div style={{ flex: 1 }} />
        {/* Sort order dropdown — directories always first; files by chosen key */}
        <div className="kb-sort-menu" ref={sortRef}>
          <button
            type="button"
            title={`${t('kb.sortLabel')}: ${sortLabel[sortBy]}`}
            onClick={() => setSortMenuOpen((o) => !o)}
            data-testid="kb-btn-sort"
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
          >
            {/* arrow-down-wide-narrow — sort */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 5h10" />
              <path d="M11 9h7" />
              <path d="M11 13h4" />
              <path d="m3 17 3 3 3-3" />
              <path d="M6 18V4" />
            </svg>
          </button>
          {sortMenuOpen && (
            <div className="kb-sort-dropdown" data-testid="kb-sort-dropdown" role="menu">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`kb-sort-item ${opt === sortBy ? 'is-active' : ''}`}
                  role="menuitemradio"
                  aria-checked={opt === sortBy}
                  data-testid={`kb-sort-${opt}`}
                  onClick={() => { setSortBy(opt); setSortMenuOpen(false); }}
                >
                  <span className="kb-sort-check">{opt === sortBy ? '✓' : ''}</span>
                  {sortLabel[opt]}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Collapse-all / Expand-all toggle — reflects actual tree state */}
        <button
          type="button"
          title={anyExpanded ? t('kb.collapseAll') : t('kb.expandAll')}
          onClick={anyExpanded ? collapseAll : expandAll}
          data-testid="kb-btn-collapse-all"
        >
          {anyExpanded ? (
            // chevrons-up (collapse)
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 13 12 7 18 13" />
              <polyline points="6 19 12 13 18 19" />
            </svg>
          ) : (
            // chevrons-down (expand)
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 7 12 13 18 7" />
              <polyline points="6 13 12 19 18 13" />
            </svg>
          )}
        </button>
      </div>

      {/* Search */}
      <div className="kb-search-bar">
        <input
          type="text"
          placeholder={t('kb.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {/* Ingest status summary — only when the vault has version tracking */}
      {showStats && (
        <div className="kb-ingest-stats" data-testid="kb-ingest-stats">
          <span className="kb-ingest-stats__item is-pending">待入库 {stats.pending}</span>
          <span className="kb-ingest-stats__sep">·</span>
          <span className="kb-ingest-stats__item is-clean">已入库 {stats.clean}</span>
          <span className="kb-ingest-stats__sep">·</span>
          <span className="kb-ingest-stats__item is-modified">待更新 {stats.modified}</span>
        </div>
      )}

      {/* File tree */}
      <div className="kb-tree-scroll">
        <KbFileTree
          nodes={sortedTree}
          selectedFile={selectedFile}
          searchQuery={searchQuery}
          expandedPaths={expandedPaths}
          revealToken={revealToken}
          onTogglePath={togglePath}
          onSelectFile={onSelectFile}
          onAddToWiki={onAddToWiki}
          onContextMenu={onContextMenu}
          renamingPath={renamingPath}
          onRenameComplete={onRenameComplete}
          onRenameCancel={onRenameCancel}
          onMoveFile={onMoveFile}
          onNodeDragOver={handleNodeDragOver}
          onNodeDragLeave={handleNodeDragLeave}
        />
      </div>

      {/* Vault bar */}
      <div className="kb-vault-bar" onClick={onVaultClick}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M2 7h12" />
          <circle cx="5" cy="10" r="0.8" fill="currentColor" />
        </svg>
        <span className="kb-vault-bar__name">{vaultName || 'No vault selected'}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="3 5 6 8 9 5" />
        </svg>
      </div>

      {/* Resize handle */}
      {children}
    </aside>
  );
}

/** Collect every directory path in the tree (for expand-all). */
function collectDirPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.type === 'directory') {
        paths.push(n.path);
        if (n.children) walk(n.children);
      }
    }
  };
  walk(nodes);
  return paths;
}

/**
 * Return a sorted copy of the tree. Directories always come first (sorted by
 * name); files are sorted by the chosen key. For `modified`/`size`, missing
 * values sort to the bottom; name sorts ascending, the rest descending
 * (newest / largest first). Does not mutate the input.
 */
function sortTree(nodes: TreeNode[], sortBy: SortBy): TreeNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (a.type === 'directory') return a.name.localeCompare(b.name, undefined, { numeric: true });
    if (sortBy === 'modified') {
      const av = a.modifiedAt ?? 0;
      const bv = b.modifiedAt ?? 0;
      return bv - av; // newest first
    }
    if (sortBy === 'size') {
      const av = a.size ?? 0;
      const bv = b.size ?? 0;
      return bv - av; // largest first
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return sorted.map((n) =>
    n.type === 'directory' && n.children ? { ...n, children: sortTree(n.children, sortBy) } : n,
  );
}

/**
 * Count ingest-status badges across the tree, excluding the wiki/ subtree
 * (wiki pages are products, not ingest sources).
 */
function countIngestStatus(nodes: TreeNode[]): { pending: number; clean: number; modified: number } {
  const counts = { pending: 0, clean: 0, modified: 0 };
  const walk = (list: TreeNode[], inWiki: boolean) => {
    for (const n of list) {
      const insideWiki = inWiki || n.path === 'wiki' || n.path.startsWith('wiki/');
      if (n.type === 'directory' && n.children) {
        walk(n.children, insideWiki);
        continue;
      }
      if (insideWiki) continue;
      if (n.ingestStatus === 'pending') counts.pending++;
      else if (n.ingestStatus === 'tracked-clean') counts.clean++;
      else if (n.ingestStatus === 'tracked-modified') counts.modified++;
    }
  };
  walk(nodes, false);
  return counts;
}

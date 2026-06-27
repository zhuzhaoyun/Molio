/**
 * Left file panel — toolbar, search, file tree, vault bar.
 * Owns the tree's expansion state so the collapse/expand-all toggle can read
 * and mutate it directly (no round-trip through the page).
 */

import type { ReactNode } from 'react';
import { useMemo, useState, useCallback } from 'react';
import type { TreeNode } from '@molio/contracts';
import { KbFileTree } from './KbFileTree';

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
  children,
}: KbFilePanelProps) {
  // Expansion state is owned here so the toggle button can read it directly.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const anyExpanded = expandedPaths.size > 0;

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
    () => setExpandedPaths(new Set(collectDirPaths(tree))),
    [tree],
  );

  // Ingest status counts for the vault stats bar. Only shown once the vault
  // has version tracking (any node carries ingestStatus). wiki/ subtree is
  // excluded — those are wiki products, not ingest sources.
  const stats = useMemo(() => countIngestStatus(tree), [tree]);
  const showStats = stats.pending + stats.clean + stats.modified > 0;

  return (
    <aside className="kb-file-panel" style={{ width }}>
      {/* Toolbar */}
      <div className="kb-file-toolbar">
        <button type="button" title="新建笔记" onClick={() => {
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
        <button type="button" title="新建子文件夹" onClick={() => {
          const parent = selectedFile ? selectedFile.includes('/') ? selectedFile.slice(0, selectedFile.lastIndexOf('/')) : undefined : undefined;
          onNewFolder(parent);
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <div style={{ flex: 1 }} />
        {/* Collapse-all / Expand-all toggle — reflects actual tree state */}
        <button
          type="button"
          title={anyExpanded ? '折叠全部' : '展开全部'}
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
          placeholder="Search files..."
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
          nodes={tree}
          selectedFile={selectedFile}
          searchQuery={searchQuery}
          expandedPaths={expandedPaths}
          onTogglePath={togglePath}
          onSelectFile={onSelectFile}
          onAddToWiki={onAddToWiki}
          onContextMenu={onContextMenu}
          renamingPath={renamingPath}
          onRenameComplete={onRenameComplete}
          onRenameCancel={onRenameCancel}
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

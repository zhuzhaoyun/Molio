/**
 * Left file panel — toolbar, search, file tree, vault bar.
 */

import type { ReactNode } from 'react';
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
  onBuildWiki?: () => void;
  onLintWiki?: () => void;
  /** Context menu handler — fired on right-click of any tree node */
  onContextMenu?: (node: TreeNode, e: React.MouseEvent) => void;
  /** Path of node being renamed (null = none) */
  renamingPath?: string | null;
  /** Confirm rename: (oldPath, newName) */
  onRenameComplete?: (oldPath: string, newName: string) => void;
  /** Cancel rename */
  onRenameCancel?: () => void;
  /** Incrementing counter; when it changes, collapse every directory in the tree. */
  collapseAllCounter?: number;
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
  onBuildWiki,
  onLintWiki,
  onContextMenu,
  renamingPath,
  onRenameComplete,
  onRenameCancel,
  collapseAllCounter,
  children,
}: KbFilePanelProps) {
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
        {onBuildWiki && (
          <button type="button" title="构建 Wiki" onClick={onBuildWiki} className="kb-toolbar-btn-accent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </button>
        )}
        {onLintWiki && (
          <button type="button" title="Wiki 健康检查" onClick={onLintWiki}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="11" />
              <line x1="11" y1="11" x2="14" y2="11" />
            </svg>
          </button>
        )}
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

      {/* File tree */}
      <div className="kb-tree-scroll">
        <KbFileTree
          nodes={tree}
          selectedFile={selectedFile}
          searchQuery={searchQuery}
          onSelectFile={onSelectFile}
          onAddToWiki={onAddToWiki}
          onContextMenu={onContextMenu}
          renamingPath={renamingPath}
          onRenameComplete={onRenameComplete}
          onRenameCancel={onRenameCancel}
          collapseAllCounter={collapseAllCounter}
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

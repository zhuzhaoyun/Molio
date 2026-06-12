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
  onNewFile: () => void;
  onNewFolder: () => void;
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
  children,
}: KbFilePanelProps) {
  return (
    <aside className="kb-file-panel" style={{ width }}>
      {/* Toolbar */}
      <div className="kb-file-toolbar">
        <button type="button" title="新建文件" onClick={onNewFile}>📄</button>
        <button type="button" title="新建文件夹" onClick={onNewFolder}>📁</button>
        <div style={{ flex: 1 }} />
        {onBuildWiki && (
          <button type="button" title="构建 Wiki" onClick={onBuildWiki} style={{ color: 'var(--accent)' }}>🏗</button>
        )}
        {onLintWiki && (
          <button type="button" title="Wiki 健康检查" onClick={onLintWiki}>🔍</button>
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

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
  onImport: () => void;
  onVaultClick: () => void;
  onRefresh: () => void;
  onAddToWiki?: (path: string) => void;
  onBuildWiki?: () => void;
  onLintWiki?: () => void;
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
  onImport,
  onVaultClick,
  onRefresh,
  onAddToWiki,
  onBuildWiki,
  onLintWiki,
  children,
}: KbFilePanelProps) {
  return (
    <aside className="kb-file-panel" style={{ width }}>
      {/* Toolbar */}
      <div className="kb-file-toolbar">
        <button title="New file" onClick={onNewFile}>📄</button>
        <button title="New folder" onClick={onNewFolder}>📁</button>
        <div style={{ flex: 1 }} />
        {onBuildWiki && (
          <button title="构建 Wiki" onClick={onBuildWiki} style={{ color: 'var(--accent)' }}>🏗</button>
        )}
        {onLintWiki && (
          <button title="Wiki 健康检查" onClick={onLintWiki}>🔍</button>
        )}
        <button title="Import knowledge" onClick={onImport} style={{ color: 'var(--accent)' }}>⤵</button>
        <button title="Refresh file tree" onClick={onRefresh}>🔄</button>
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

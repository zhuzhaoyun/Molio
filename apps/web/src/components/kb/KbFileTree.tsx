/**
 * Recursive file tree component for the Knowledge Base.
 * Supports: click-to-open, right-click context menu, inline rename.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { TreeNode } from '@molio/contracts';

interface KbFileTreeProps {
  nodes: TreeNode[];
  selectedFile: string | null;
  searchQuery: string;
  onSelectFile: (path: string) => void;
  onAddToWiki?: (path: string) => void;
  /** 右键菜单回调 (node, event) */
  onContextMenu?: (node: TreeNode, event: React.MouseEvent) => void;
  /** 内联重命名相关 */
  renamingPath: string | null;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  /** 当前 vault 的绝对路径（用于 IPC） */
  vaultPath: string | null;
}

export function KbFileTree({
  nodes,
  selectedFile,
  searchQuery,
  onSelectFile,
  onAddToWiki,
  onContextMenu,
  renamingPath,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  vaultPath,
}: KbFileTreeProps) {
  if (nodes.length === 0) {
    return (
      <div className="kb-empty-state" style={{ padding: '32px 16px' }}>
        <div className="kb-empty-icon">📂</div>
        <h3>Empty vault</h3>
        <p>Import files or create new ones to get started.</p>
      </div>
    );
  }

  const filtered = searchQuery ? filterTree(nodes, searchQuery.toLowerCase()) : nodes;

  return (
    <div>
      {filtered.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          selectedFile={selectedFile}
          searchQuery={searchQuery}
          onSelectFile={onSelectFile}
          onAddToWiki={onAddToWiki}
          onContextMenu={onContextMenu}
          renamingPath={renamingPath}
          renameValue={renameValue}
          onRenameChange={onRenameChange}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          vaultPath={vaultPath}
        />
      ))}
    </div>
  );
}

// ─── Tree node (recursive) ───

interface TreeNodeItemProps {
  node: TreeNode;
  selectedFile: string | null;
  searchQuery: string;
  onSelectFile: (path: string) => void;
  onAddToWiki?: (path: string) => void;
  onContextMenu?: (node: TreeNode, event: React.MouseEvent) => void;
  renamingPath: string | null;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  vaultPath: string | null;
}

function TreeNodeItem({
  node,
  selectedFile,
  searchQuery,
  onSelectFile,
  onAddToWiki,
  onContextMenu,
  renamingPath,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  vaultPath,
}: TreeNodeItemProps) {
  const [expanded, setExpanded] = useState(!!searchQuery);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  // Don't show "+" for items inside the wiki/ directory
  const isInsideWiki = node.path.startsWith('wiki/') || node.path === 'wiki';
  const showAddButton = onAddToWiki && !isInsideWiki;

  const handleAdd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAddToWiki?.(node.path);
  }, [onAddToWiki, node.path]);

  // 内联重命名相关
  const isRenaming = renamingPath === node.path && node.type === 'file';

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      // 选中文本（不含扩展名）
      const dot = node.name.lastIndexOf('.');
      const end = dot > 0 ? dot : node.name.length;
      renameInputRef.current.setSelectionRange(0, end);
    }
  }, [isRenaming, node.name]);

  if (node.type === 'directory') {
    return (
      <div className="kb-tree-group">
        <div className="kb-tree-group-label" onClick={toggle}>
          <span className={`kb-tree-chevron ${expanded ? '' : 'collapsed'}`}>▾</span>
          <span>{node.name}</span>
          {showAddButton && (
            <button
              type="button"
              className="wiki-tree-op"
              title="加入 Wiki"
              onClick={handleAdd}
            >+</button>
          )}
        </div>
        <div className={`kb-tree-children ${expanded ? '' : 'collapsed'}`}>
          {node.children?.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              searchQuery={searchQuery}
              onSelectFile={onSelectFile}
              onAddToWiki={onAddToWiki}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              renameValue={renameValue}
              onRenameChange={onRenameChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              vaultPath={vaultPath}
            />
          ))}
        </div>
      </div>
    );
  }

  // File node
  const isActive = selectedFile === node.path;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(node, e);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onRenameSubmit(node.path, renameValue);
    } else if (e.key === 'Escape') {
      onRenameCancel();
    }
  };

  return (
    <div
      className={`kb-tree-item ${isActive ? 'is-active' : ''} ${isRenaming ? 'is-renaming' : ''}`}
      onClick={() => !isRenaming && onSelectFile(node.path)}
      onContextMenu={handleContextMenu}
    >
      <span className="kb-tree-icon">📄</span>
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className="kb-tree-rename-input"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={() => onRenameSubmit(node.path, renameValue)}
          onKeyDown={handleRenameKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="kb-tree-name">{node.name}</span>
      )}
      {showAddButton && (
        <button
          type="button"
          className="wiki-tree-op"
          title="加入 Wiki"
          onClick={handleAdd}
        >+</button>
      )}
    </div>
  );
}

// ─── Search filter ───

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'directory') {
      const filteredChildren = node.children ? filterTree(node.children, query) : [];
      if (filteredChildren.length > 0 || node.name.toLowerCase().includes(query)) {
        result.push({ ...node, children: filteredChildren });
      }
    } else if (node.name.toLowerCase().includes(query)) {
      result.push(node);
    }
  }
  return result;
}

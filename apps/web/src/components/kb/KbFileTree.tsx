/**
 * Recursive file tree component for the Knowledge Base.
 * Supports: click-select, right-click context menu, inline rename.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { TreeNode } from '@molio/contracts';

interface KbFileTreeProps {
  nodes: TreeNode[];
  selectedFile: string | null;
  searchQuery: string;
  onSelectFile: (path: string) => void;
  onAddToWiki?: (path: string) => void;
  onContextMenu?: (node: TreeNode, e: React.MouseEvent) => void;
  /** Path of the node currently being renamed (null = not renaming) */
  renamingPath?: string | null;
  /** Called when the user confirms a rename (old path, new name only) */
  onRenameComplete?: (oldPath: string, newName: string) => void;
  /** Called when the user cancels rename (ESC / blur with no value) */
  onRenameCancel?: () => void;
  /** Incrementing counter; when it changes, collapse every directory. */
  collapseAllCounter?: number;
}

export function KbFileTree({
  nodes,
  selectedFile,
  searchQuery,
  onSelectFile,
  onAddToWiki,
  onContextMenu,
  renamingPath,
  onRenameComplete,
  onRenameCancel,
  collapseAllCounter,
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
          onRenameComplete={onRenameComplete}
          onRenameCancel={onRenameCancel}
          collapseAllCounter={collapseAllCounter}
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
  onContextMenu?: (node: TreeNode, e: React.MouseEvent) => void;
  renamingPath?: string | null;
  onRenameComplete?: (oldPath: string, newName: string) => void;
  onRenameCancel?: () => void;
  collapseAllCounter?: number;
}

function TreeNodeItem({
  node,
  selectedFile,
  searchQuery,
  onSelectFile,
  onAddToWiki,
  onContextMenu,
  renamingPath,
  onRenameComplete,
  onRenameCancel,
  collapseAllCounter,
}: TreeNodeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((e) => !e), []);

  useEffect(() => {
    if (collapseAllCounter === undefined) return;
    setExpanded(false);
  }, [collapseAllCounter]);

  // Don't show "+" for items inside the wiki/ directory
  const isInsideWiki = node.path.startsWith('wiki/') || node.path === 'wiki';
  const showAddButton = onAddToWiki && !isInsideWiki;

  const handleAdd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAddToWiki?.(node.path);
  }, [onAddToWiki, node.path]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(node, e);
  }, [onContextMenu, node]);

  const isRenaming = renamingPath === node.path;

  if (node.type === 'directory') {
    return (
      <div className="kb-tree-group">
        <div
          className="kb-tree-group-label"
          onClick={toggle}
          onContextMenu={handleContextMenu}
        >
          <span className={`kb-tree-chevron ${expanded ? '' : 'collapsed'}`}>▾</span>
          {isRenaming ? (
            <RenameInput
              initialValue={node.name}
              onConfirm={(newName) => onRenameComplete?.(node.path, newName)}
              onCancel={onRenameCancel}
            />
          ) : (
            <span>{node.name}</span>
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
        {expanded && (
          <div className="kb-tree-children">
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
                onRenameComplete={onRenameComplete}
                onRenameCancel={onRenameCancel}
                collapseAllCounter={collapseAllCounter}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
  const isActive = selectedFile === node.path;
  const itemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive) return;
    itemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isActive]);

  const handleFileContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(node, e);
  }, [onContextMenu, node]);

  return (
    <div
      ref={itemRef}
      className={`kb-tree-item ${isActive ? 'is-active' : ''}`}
      onClick={() => !isRenaming && onSelectFile(node.path)}
      onContextMenu={handleFileContextMenu}
    >
      <span className="kb-tree-icon">📄</span>
      {isRenaming ? (
        <RenameInput
          initialValue={node.name}
          onConfirm={(newName) => onRenameComplete?.(node.path, newName)}
          onCancel={onRenameCancel}
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

// ─── Inline rename input ───

interface RenameInputProps {
  initialValue: string;
  onConfirm: (newName: string) => void;
  onCancel?: () => void;
}

function RenameInput({ initialValue, onConfirm, onCancel }: RenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.value = initialValue;
      // Select filename without extension
      const dotIndex = initialValue.lastIndexOf('.');
      inputRef.current.setSelectionRange(0, dotIndex > 0 ? dotIndex : initialValue.length);
      inputRef.current.focus();
    }
  }, [initialValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = inputRef.current?.value.trim();
      if (val && val !== initialValue) {
        onConfirm(val);
      } else {
        onCancel?.();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel?.();
    }
    e.stopPropagation();
  }, [initialValue, onConfirm, onCancel]);

  const handleBlur = useCallback(() => {
    // Small delay to avoid race with Enter key
    setTimeout(() => {
      const val = inputRef.current?.value.trim();
      if (val && val !== initialValue) {
        onConfirm(val);
      } else {
        onCancel?.();
      }
    }, 100);
  }, [initialValue, onConfirm, onCancel]);

  return (
    <input
      ref={inputRef}
      type="text"
      className="kb-tree-rename-input"
      defaultValue={initialValue}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={(e) => e.stopPropagation()}
    />
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

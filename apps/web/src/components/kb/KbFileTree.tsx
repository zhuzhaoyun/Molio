/**
 * Recursive file tree component for the Knowledge Base.
 * Controlled expansion: the expanded set is owned by the parent (KbFilePanel)
 * so the collapse/expand-all toggle can read and mutate it directly.
 * Supports: click-select, right-click context menu, inline rename.
 */

import { useCallback, useRef, useEffect } from 'react';
import type { TreeNode, IngestStatus } from '@molio/contracts';

/** Directories that reject drag-and-drop operations. */
const PROTECTED_DIRS = ['wiki', 'docling_output'];

function isInsideProtected(nodePath: string): boolean {
  return PROTECTED_DIRS.some(
    d => nodePath === d || nodePath.startsWith(d + '/')
  );
}

interface KbFileTreeProps {
  nodes: TreeNode[];
  selectedFile: string | null;
  searchQuery: string;
  expandedPaths: Set<string>;
  /**
   * Incremented by the parent to request the active file scroll itself into
   * view (used by the "locate" button). The effect in TreeNodeItem depends on
   * this token, so a change re-runs the scroll even if the file was already
   * active.
   */
  revealToken?: number;
  onTogglePath: (path: string) => void;
  onSelectFile: (path: string) => void;
  onAddToWiki?: (path: string) => void;
  onContextMenu?: (node: TreeNode, e: React.MouseEvent) => void;
  /** Path of the node currently being renamed (null = not renaming) */
  renamingPath?: string | null;
  /** Called when the user confirms a rename (old path, new name only) */
  onRenameComplete?: (oldPath: string, newName: string) => void;
  /** Called when the user cancels rename (ESC / blur with no value) */
  onRenameCancel?: () => void;
  /** Called when a file is dropped on a directory (internal drag-move). */
  onMoveFile?: (srcPath: string, destDir: string) => void;
  /** Called when an external file drag hovers over a directory node. */
  onNodeDragOver?: (dirPath: string) => void;
  /** Called when an external file drag leaves a directory node. */
  onNodeDragLeave?: () => void;
}

export function KbFileTree({
  nodes,
  selectedFile,
  searchQuery,
  expandedPaths,
  revealToken,
  onTogglePath,
  onSelectFile,
  onAddToWiki,
  onContextMenu,
  renamingPath,
  onRenameComplete,
  onRenameCancel,
  onMoveFile,
  onNodeDragOver,
  onNodeDragLeave,
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
          expandedPaths={expandedPaths}
          revealToken={revealToken}
          onTogglePath={onTogglePath}
          onSelectFile={onSelectFile}
          onAddToWiki={onAddToWiki}
          onContextMenu={onContextMenu}
          renamingPath={renamingPath}
          onRenameComplete={onRenameComplete}
          onRenameCancel={onRenameCancel}
          onMoveFile={onMoveFile}
          onNodeDragOver={onNodeDragOver}
          onNodeDragLeave={onNodeDragLeave}
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
  expandedPaths: Set<string>;
  revealToken?: number;
  onTogglePath: (path: string) => void;
  onSelectFile: (path: string) => void;
  onAddToWiki?: (path: string) => void;
  onContextMenu?: (node: TreeNode, e: React.MouseEvent) => void;
  renamingPath?: string | null;
  onRenameComplete?: (oldPath: string, newName: string) => void;
  onRenameCancel?: () => void;
  onMoveFile?: (srcPath: string, destDir: string) => void;
  onNodeDragOver?: (dirPath: string) => void;
  onNodeDragLeave?: () => void;
}

function TreeNodeItem({
  node,
  selectedFile,
  searchQuery,
  expandedPaths,
  revealToken,
  onTogglePath,
  onSelectFile,
  onAddToWiki,
  onContextMenu,
  renamingPath,
  onRenameComplete,
  onRenameCancel,
  onMoveFile,
  onNodeDragOver,
  onNodeDragLeave,
}: TreeNodeItemProps) {
  const expanded = expandedPaths.has(node.path);

  // Don't show "+" for items inside protected directories
  const nodeProtected = isInsideProtected(node.path);
  const showAddButton = onAddToWiki && !nodeProtected;

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
    // Determine drop acceptance for this directory
    const acceptsDrop = onMoveFile && !nodeProtected;

    const handleDirDragOver = useCallback((e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) {
        // External drop — signal the panel + add highlight class directly
        if (acceptsDrop) {
          e.preventDefault();
          e.stopPropagation();
          (e.currentTarget as HTMLElement).classList.add('drag-target');
          onNodeDragOver?.(node.path);
        } else {
          e.dataTransfer.dropEffect = 'none';
        }
        return;
      }
      // Internal move handling (from Task 6)
      if (!acceptsDrop) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      (e.currentTarget as HTMLElement).classList.add('drag-target');
    }, [acceptsDrop, node.path, onNodeDragOver]);

    const handleDirDragLeave = useCallback((e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove('drag-target');
      onNodeDragLeave?.();
    }, [onNodeDragLeave]);

    // Clean up highlight class on drop (dragLeave may not fire after drop)
    const handleDirDrop = useCallback((e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove('drag-target');
      if (e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      const srcPath = e.dataTransfer.getData('text/plain');
      if (!srcPath || !acceptsDrop) return;
      // Guard: don't drop on self or child directory
      if (srcPath === node.path || node.path.startsWith(srcPath + '/')) return;
      onMoveFile?.(srcPath, node.path);
    }, [node.path, acceptsDrop, onMoveFile]);

    return (
      <div className="kb-tree-group">
        <div
          className="kb-tree-group-label"
          data-drop-dir={node.path}
          onClick={() => onTogglePath(node.path)}
          onContextMenu={handleContextMenu}
          onDragOver={handleDirDragOver}
          onDragLeave={handleDirDragLeave}
          onDrop={handleDirDrop}
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
          {(!nodeProtected && node.ingestStatus) || showAddButton ? (
            <div className="kb-tree-trailing">
              {!nodeProtected && <IngestBadge status={node.ingestStatus} />}
              {showAddButton && (
                <button
                  type="button"
                  className="wiki-tree-op"
                  title="加入 Wiki"
                  onClick={handleAdd}
                >+</button>
              )}
            </div>
          ) : null}
        </div>
        <div className={`kb-tree-children ${expanded ? '' : 'collapsed'}`}>
          {node.children?.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              searchQuery={searchQuery}
              expandedPaths={expandedPaths}
              revealToken={revealToken}
              onTogglePath={onTogglePath}
              onSelectFile={onSelectFile}
              onAddToWiki={onAddToWiki}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              onRenameComplete={onRenameComplete}
              onRenameCancel={onRenameCancel}
              onMoveFile={onMoveFile}
              onNodeDragOver={onNodeDragOver}
              onNodeDragLeave={onNodeDragLeave}
            />
          ))}
        </div>
      </div>
    );
  }

  // File node
  const isActive = selectedFile === node.path;
  const itemRef = useRef<HTMLDivElement>(null);
  const canDrag = !nodeProtected;

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!canDrag) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
  }, [canDrag, node.path]);

  // Scroll into view when the file becomes active, or when the parent bumps
  // revealToken (the "locate" button) — needed because locating a file that
  // is *already* active but buried under collapsed ancestors wouldn't fire
  // the isActive branch on its own.
  useEffect(() => {
    if (!isActive) return;
    itemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isActive, revealToken]);

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
      draggable={canDrag}
      onDragStart={handleDragStart}
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
      {(!nodeProtected && node.ingestStatus) || showAddButton ? (
        <div className="kb-tree-trailing">
          {!nodeProtected && <IngestBadge status={node.ingestStatus} />}
          {showAddButton && (
            <button
              type="button"
              className="wiki-tree-op"
              title="加入 Wiki"
              onClick={handleAdd}
            >+</button>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── Ingest status badge ───

const INGEST_BADGE: Record<IngestStatus, { cls: string; title: string }> = {
  'pending': { cls: 'kb-ingest-badge is-pending', title: '待入库' },
  'tracked-clean': { cls: 'kb-ingest-badge is-clean', title: '已入库' },
  'tracked-modified': { cls: 'kb-ingest-badge is-modified', title: '已入库·源已更新，建议重新 ingest' },
};

function IngestBadge({ status }: { status?: IngestStatus }) {
  if (!status) return null;
  const m = INGEST_BADGE[status];
  return (
    <span
      className={m.cls}
      title={m.title}
      data-testid={`ingest-badge-${status}`}
      aria-label={m.title}
    />
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

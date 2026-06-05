/**
 * Recursive file tree component for the Knowledge Base.
 */

import { useState, useCallback } from 'react';
import type { TreeNode } from '@molio/contracts';

interface KbFileTreeProps {
  nodes: TreeNode[];
  selectedFile: string | null;
  searchQuery: string;
  onSelectFile: (path: string) => void;
}

export function KbFileTree({ nodes, selectedFile, searchQuery, onSelectFile }: KbFileTreeProps) {
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
}

function TreeNodeItem({ node, selectedFile, searchQuery, onSelectFile }: TreeNodeItemProps) {
  const [expanded, setExpanded] = useState(true);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  if (node.type === 'directory') {
    return (
      <div className="kb-tree-group">
        <div className="kb-tree-group-label" onClick={toggle}>
          <span className={`kb-tree-chevron ${expanded ? '' : 'collapsed'}`}>▾</span>
          <span>{node.name}</span>
        </div>
        <div className={`kb-tree-children ${expanded ? '' : 'collapsed'}`}>
          {node.children?.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              searchQuery={searchQuery}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      </div>
    );
  }

  // File node
  const isActive = selectedFile === node.path;

  return (
    <div
      className={`kb-tree-item ${isActive ? 'is-active' : ''}`}
      onClick={() => onSelectFile(node.path)}
    >
      <span className="kb-tree-icon">📄</span>
      <span className="kb-tree-name">{node.name}</span>
    </div>
  );
}

// ─── Search filter ───

/**
 * Filter tree nodes by query — keep nodes whose name matches
 * and their parent directories.
 */
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

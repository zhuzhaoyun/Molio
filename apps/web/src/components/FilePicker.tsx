// apps/web/src/components/FilePicker.tsx
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { TreeNode } from '@molio/contracts';
import { api } from '../api/client';
import './FilePicker.css';

interface Props {
  vaultId: string;
  /** The text after '@' that the user has typed so far (for filtering). */
  filterText: string;
  onSelect: (filePath: string) => void;
  onClose: () => void;
}

/** Flatten tree into file-only list, sorted by modifiedAt desc. */
function flattenFiles(nodes: TreeNode[]): TreeNode[] {
  const files: TreeNode[] = [];
  function walk(list: TreeNode[]) {
    for (const n of list) {
      if (n.type === 'file') {
        files.push(n);
      }
      if (n.children) {
        walk(n.children);
      }
    }
  }
  walk(nodes);
  return files;
}

export function FilePicker({ vaultId, filterText, onSelect, onClose }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch file tree on mount
  useEffect(() => {
    let cancelled = false;
    api.getFileTree(vaultId)
      .then((t) => {
        if (!cancelled) {
          setTree(t);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [vaultId]);

  // Flatten + filter
  const files = useMemo(() => {
    const all = flattenFiles(tree);
    // Sort by modifiedAt desc (most recent first)
    all.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    if (!filterText) {
      // Show 8 most recent when no filter
      return all.slice(0, 8);
    }
    const q = filterText.toLowerCase();
    return all.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q),
    );
  }, [tree, filterText]);

  // Reset active index when files change
  useEffect(() => {
    setActiveIdx(0);
  }, [files]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((prev) => Math.min(prev + 1, files.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const f = files[activeIdx];
        if (f) onSelect(f.path);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [files, activeIdx, onSelect, onClose],
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

  if (loading) {
    return (
      <div className="file-picker-overlay">
        <div className="file-picker-empty">加载中…</div>
      </div>
    );
  }

  return (
    <div className="file-picker-overlay" data-testid="file-picker">
      <div className="file-picker-header">
        {filterText ? `搜索: "${filterText}"` : '最近文件'}
      </div>
      <div ref={listRef}>
        {files.length === 0 ? (
          <div className="file-picker-empty">无匹配文件</div>
        ) : (
          files.map((f, i) => (
            <div
              key={f.path}
              className={`file-picker-item${i === activeIdx ? ' active' : ''}`}
              data-testid="file-picker-item"
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur on textarea
                onSelect(f.path);
              }}
            >
              <span className="file-picker-item-icon">📄</span>
              <span className="file-picker-item-name">{f.name}</span>
              <span className="file-picker-item-path">{f.path}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

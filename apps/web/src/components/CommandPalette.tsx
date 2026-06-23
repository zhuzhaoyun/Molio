// apps/web/src/components/CommandPalette.tsx
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { Command, CommandAction } from '../commands/types';
import './CommandPalette.css';

interface Props {
  filterText: string;
  commands: Command[];
  onExecute: (action: CommandAction) => void;
  onClose: () => void;
}

export function CommandPalette({ filterText, commands, onExecute, onClose }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!filterText) return commands;
    const q = filterText.toLowerCase();
    return commands.filter(
      (c) =>
        c.id.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [commands, filterText]);

  // Reset active index when filtered list changes
  useEffect(() => {
    setActiveIdx(0);
  }, [filtered]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[activeIdx];
        if (cmd) onExecute(cmd.action);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, activeIdx, onExecute, onClose],
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

  return (
    <div className="cmd-palette-overlay" data-testid="cmd-palette">
      <div className="cmd-palette-header">命令</div>
      <div ref={listRef}>
        {filtered.length === 0 ? (
          <div className="file-picker-empty">无匹配命令</div>
        ) : (
          filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`cmd-palette-item${i === activeIdx ? ' active' : ''}`}
              data-testid="cmd-palette-item"
              onMouseDown={(e) => {
                e.preventDefault();
                onExecute(cmd.action);
              }}
            >
              <span className="cmd-palette-item-icon">{cmd.icon}</span>
              <div className="cmd-palette-item-body">
                <span className="cmd-palette-item-label">/{cmd.id}</span>
                <span className="cmd-palette-item-desc">{cmd.description}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

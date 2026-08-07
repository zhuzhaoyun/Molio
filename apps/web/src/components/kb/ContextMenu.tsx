/**
 * Floating context menu for right-click actions on file tree nodes.
 */

import { useEffect, useRef } from 'react';

export interface MenuItem {
  label?: string;
  /** Render as a separator when true */
  divider?: boolean;
  onClick?: () => void;
  /** Red text for destructive actions */
  danger?: boolean;
  /** Disabled (greyed out) */
  disabled?: boolean;
  /** Native tooltip (e.g. to explain why an item is disabled). */
  title?: string;
  /** data-testid for stable E2E selection */
  testid?: string;
}

interface ContextMenuProps {
  items: MenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Click outside to close — delay binding to avoid the right-click event itself
  useEffect(() => {
    let listenerAdded = false;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick);
      listenerAdded = true;
    }, 10);
    return () => {
      clearTimeout(timer);
      if (listenerAdded) {
        document.removeEventListener('click', handleClick);
      }
    };
  }, [onClose]);

  // Also close on scroll or window resize
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  // Viewport edge detection
  const menuWidth = 180;
  const itemHeight = 28;
  const menuHeight = items.length * itemHeight + 8;
  const x = position.x + menuWidth > window.innerWidth ? position.x - menuWidth : position.x;
  const y = position.y + menuHeight > window.innerHeight ? position.y - menuHeight : position.y;

  return (
    <div className="ctx-menu-overlay" onClick={onClose}>
      <div
        ref={menuRef}
        className="ctx-menu"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => {
          if (item.divider) {
            return <div key={i} className="ctx-menu-divider" />;
          }
          return (
            <button
              key={i}
              type="button"
              data-testid={item.testid}
              className={`ctx-menu-item${item.danger ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}`}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                item.onClick?.();
                onClose();
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

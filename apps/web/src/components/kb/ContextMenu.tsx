/**
 * 通用右键上下文菜单组件
 * 使用 Portal 渲染到 document.body，避免被 overflow: hidden 裁剪
 */

import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface ContextMenuProps {
  items: MenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 点击外部关闭
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 延迟绑定避免右键点击时立即触发关闭
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick);
    }, 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClick);
    };
  }, [onClose]);

  // 视口边界检测
  const menuWidth = 180;
  const menuHeight = items.length * 32 + 8;
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
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            className={`ctx-menu-item ${item.danger ? 'is-danger' : ''} ${item.disabled ? 'is-disabled' : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            disabled={item.disabled}
          >
            {item.icon && <span className="ctx-menu-icon">{item.icon}</span>}
            <span className="ctx-menu-label">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

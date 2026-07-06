/**
 * 通用工作区标签栏组件（Obsidian-style）
 *
 * 布局：左箭头 + 可横向滚动的 tab 列表 + 右箭头 + 下拉 ▾ + 右侧固定全局操作区。
 * active tab 变化时自动滚入可见区。箭头与下拉在后续 task 接入逻辑。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceTab } from '../../hooks/useKbTabs';

interface KbTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  actions?: ReactNode;
}


export function KbTabBar({ tabs, activeTabId, onActivate, onClose, actions }: KbTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on Esc or outside click (button + menu count as one unit).
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideMore = moreRef.current?.contains(target) ?? false;
      const insideDropdown = dropdownRef.current?.contains(target) ?? false;
      if (!insideMore && !insideDropdown) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [menuOpen]);

  const recompute = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 0);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  // Recompute overflow on mount, tab changes, and resize.
  useEffect(() => {
    recompute();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({
      left: dir * el.clientWidth * 0.8,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  };

  // Scroll the active tab into view whenever it changes or a tab is added.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeTabId, tabs.length]);

  if (tabs.length === 0 && !actions) return null;

  return (
    <div className="kb-workspace-tabs">
      <button
        type="button"
        className="kb-wtab-arrow"
        data-testid="kb-tab-arrow-left"
        hidden={!canLeft}
        tabIndex={-1}
        aria-label="向左滚动"
        onClick={() => scrollBy(-1)}
      >‹</button>
      <div className="kb-wtab-scroll" ref={scrollRef} onScroll={recompute}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`kb-wtab ${isActive ? 'is-active' : ''}`}
              ref={isActive ? activeRef : null}
              onClick={() => onActivate(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              title={tab.title}
            >
              <span className="kb-wtab-title">{tab.title}</span>
              <button
                type="button"
                className="kb-wtab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                title="关闭"
              >×</button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="kb-wtab-arrow"
        data-testid="kb-tab-arrow-right"
        hidden={!canRight}
        tabIndex={-1}
        aria-label="向右滚动"
        onClick={() => scrollBy(1)}
      >›</button>
      <button
        type="button"
        ref={moreRef}
        className="kb-wtab-more"
        data-testid="kb-tab-more"
        hidden={tabs.length === 0}
        aria-label="全部标签"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >▾</button>
      {menuOpen && (
        <div className="kb-tab-dropdown" data-testid="kb-tab-dropdown" ref={dropdownRef}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`kb-wtab-dropdown-item ${isActive ? 'is-active' : ''}`}
                data-testid="kb-tab-dropdown-item"
                onClick={() => { onActivate(tab.id); setMenuOpen(false); }}
                title={tab.title}
              >
                <span className="kb-wtab-dropdown-title">{tab.title}</span>
                <button
                  type="button"
                  className="kb-wtab-dropdown-close"
                  onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                  title="关闭"
                >×</button>
              </div>
            );
          })}
        </div>
      )}
      {actions && <div className="kb-wtab-actions">{actions}</div>}
    </div>
  );
}

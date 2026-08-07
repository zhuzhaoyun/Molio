/**
 * 通用工作区标签栏组件（Obsidian-style）
 *
 * 布局：左箭头 + 可横向滚动的 tab 列表 + 右箭头 + 下拉 ▾ + 右侧固定全局操作区。
 * active tab 变化时自动滚入可见区。箭头与下拉在后续 task 接入逻辑。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceTab } from '../../hooks/useKbTabs';
import { ContextMenu } from './ContextMenu';

interface KbTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Right-click a tab → open it in a new window (Electron IPC or browser popup). */
  onOpenInNewWindow?: (tab: WorkspaceTab) => void;
  actions?: ReactNode;
}

function tabDisplayTitle(tab: WorkspaceTab, allTabs: WorkspaceTab[]): { display: string; tooltip: string } {
  if (!tab.id.startsWith('file:')) {
    return { display: tab.title, tooltip: tab.title };
  }
  const relPath = tab.id.slice(5);
  const filename = relPath.split('/').pop() ?? relPath;
  const tooltip = relPath;
  const siblings = allTabs.filter(
    (t) => t.id.startsWith('file:') && (t.id.slice(5).split('/').pop() ?? '') === filename,
  );
  if (siblings.length <= 1) return { display: filename, tooltip };
  const slashIdx = relPath.lastIndexOf('/');
  const parentName = slashIdx > 0 ? relPath.slice(0, slashIdx).split('/').pop() : null;
  const candidate = parentName ? `${parentName}/${filename}` : filename;
  const stillCollide =
    siblings.filter((t) => {
      const p = t.id.slice(5);
      const si = p.lastIndexOf('/');
      const pn = si > 0 ? p.slice(0, si).split('/').pop() : null;
      return (pn ? `${pn}/${filename}` : filename) === candidate;
    }).length > 1;
  return { display: stillCollide ? relPath : candidate, tooltip };
}

export function KbTabBar({ tabs, activeTabId, onActivate, onClose, onOpenInNewWindow, actions }: KbTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ tab: WorkspaceTab; x: number; y: number } | null>(null);
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
          const { display, tooltip } = tabDisplayTitle(tab, tabs);
          return (
            <div
              key={tab.id}
              className={`kb-wtab ${isActive ? 'is-active' : ''}`}
              ref={isActive ? activeRef : null}
              onClick={() => onActivate(tab.id)}
              onContextMenu={(e) => {
                // Right-click on the close × shouldn't pop the tab's context menu.
                if ((e.target as HTMLElement).closest('.kb-wtab-close')) return;
                e.preventDefault();
                setCtxMenu({ tab, x: e.clientX, y: e.clientY });
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              title={tooltip}
            >
              <span className="kb-wtab-title">{display}</span>
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
            const { display, tooltip } = tabDisplayTitle(tab, tabs);
            return (
              <div
                key={tab.id}
                className={`kb-wtab-dropdown-item ${isActive ? 'is-active' : ''}`}
                data-testid="kb-tab-dropdown-item"
                onClick={() => { onActivate(tab.id); setMenuOpen(false); }}
                title={tooltip}
              >
                <span className="kb-wtab-dropdown-title">{display}</span>
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
      {ctxMenu && (
        <ContextMenu
          items={[
            { label: '在新窗口打开', testid: 'tab-open-in-new-window', onClick: () => onOpenInNewWindow?.(ctxMenu.tab) },
          ]}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
